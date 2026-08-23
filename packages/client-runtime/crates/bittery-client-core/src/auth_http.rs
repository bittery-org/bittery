use crate::{
    http_transport::{HttpDispatch, HttpHeader, HttpMethod, HttpResponse, HttpTransport},
    server_contract::{
        AuthVaultKeyResponse, CursorPageAuthVaultKeyResponse, FinishLoginRequest,
        FinishLoginResponse, LoginAttemptResponse, StartLoginRequest, TravelModeResponse,
    },
    RequestCancellation, RuntimeError, RuntimeErrorCode,
};
use serde::{de::DeserializeOwned, Serialize};
use std::collections::HashSet;
use url::{Host, Url};

const SMALL_AUTH_RESPONSE_BYTES: u32 = 64 * 1024;
const VAULT_KEY_RESPONSE_BYTES: u32 = 4 * 1024 * 1024;

pub(crate) enum AuthenticatedOutcome<T> {
    Ok(T),
    ReauthenticationRequired,
    Transient,
}

impl<T> AuthenticatedOutcome<T> {
    pub(crate) fn map<U>(self, map: impl FnOnce(T) -> U) -> AuthenticatedOutcome<U> {
        match self {
            Self::Ok(value) => AuthenticatedOutcome::Ok(map(value)),
            Self::ReauthenticationRequired => AuthenticatedOutcome::ReauthenticationRequired,
            Self::Transient => AuthenticatedOutcome::Transient,
        }
    }
}

pub(crate) struct RawJsonPage<T> {
    pub raw_body: Vec<u8>,
    pub value: T,
}

struct RawHttpResponse {
    status: u16,
    headers: Vec<HttpHeader>,
    body: Vec<u8>,
}
// Authentication is all-or-nothing. These maintainer-approved aggregate bounds cover the initial
// Finish-login page and every cursor page so a hostile Server cannot grow unique cursors forever.
const MAX_AUTH_VAULT_KEYS: usize = 21_000;
const MAX_AUTH_VAULT_KEY_BYTES: usize = 32 * 1024 * 1024;

#[doc(hidden)]
#[derive(Clone, Copy, Debug)]
pub enum ClientPlatform {
    Web,
    Desktop,
    Mobile,
    Extension,
}

impl ClientPlatform {
    fn as_str(self) -> &'static str {
        match self {
            Self::Web => "web",
            Self::Desktop => "desktop",
            Self::Mobile => "mobile",
            Self::Extension => "extension",
        }
    }
}

#[doc(hidden)]
#[derive(Clone, Debug)]
pub struct AuthClientConfig {
    pub(crate) client_id: String,
    pub(crate) platform: ClientPlatform,
    pub(crate) version: String,
}

impl AuthClientConfig {
    #[inline]
    pub fn new(
        client_id: String,
        platform: ClientPlatform,
        version: String,
    ) -> Result<Self, RuntimeError> {
        let config = Self {
            client_id,
            platform,
            version,
        };
        validate_config(&config)?;
        Ok(config)
    }
}

/// Typed authentication requests and response policy over the primitive host transport seam.
pub(crate) struct AuthHttpClient<'transport> {
    transport: &'transport HttpTransport,
    base_url: Url,
    config: AuthClientConfig,
}

impl<'transport> AuthHttpClient<'transport> {
    pub(crate) fn new(
        transport: &'transport HttpTransport,
        server_url: &str,
        insecure_transport_confirmed: bool,
        config: AuthClientConfig,
    ) -> Result<Self, RuntimeError> {
        validate_config(&config)?;
        let base_url = normalize_server_url(server_url, insecure_transport_confirmed)?;
        Ok(Self {
            transport,
            base_url,
            config,
        })
    }

    pub(crate) fn normalized_server_url(&self) -> String {
        self.base_url.as_str().trim_end_matches('/').to_owned()
    }

    pub(crate) async fn start_login(
        &self,
        request: &StartLoginRequest,
        cancellation: RequestCancellation,
    ) -> Result<LoginAttemptResponse, RuntimeError> {
        self.post_json(
            &["api", "v1", "auth", "login-attempts"],
            request,
            201,
            SMALL_AUTH_RESPONSE_BYTES,
            None,
            cancellation,
        )
        .await
    }

    pub(crate) async fn finish_login(
        &self,
        attempt_id: &str,
        request: &FinishLoginRequest,
        cancellation: RequestCancellation,
    ) -> Result<FinishLoginResponse, RuntimeError> {
        self.post_json(
            &["api", "v1", "auth", "login-attempts", attempt_id, "finish"],
            request,
            200,
            VAULT_KEY_RESPONSE_BYTES,
            None,
            cancellation,
        )
        .await
    }

    pub(crate) async fn drain_vault_keys(
        &self,
        token: &str,
        initial_page: CursorPageAuthVaultKeyResponse,
        cancellation: RequestCancellation,
    ) -> Result<Vec<AuthVaultKeyResponse>, RuntimeError> {
        validate_bearer(token)?;
        let CursorPageAuthVaultKeyResponse {
            has_more,
            items,
            next_cursor: page_cursor,
        } = initial_page;
        let mut cursor = next_cursor(has_more, page_cursor, items.len())?;
        let mut vault_keys = VaultKeyAccumulator::new();
        vault_keys.append(items)?;
        let mut cursor_evidence = CursorEvidence::new();

        while let Some(current) = cursor {
            cursor_evidence.record(&current)?;
            let mut url = self.endpoint(&["api", "v1", "users", "me", "vault-keys"])?;
            url.query_pairs_mut().append_pair("cursor", &current);
            let page: CursorPageAuthVaultKeyResponse = self
                .get_json(
                    url,
                    200,
                    VAULT_KEY_RESPONSE_BYTES,
                    Some(token),
                    cancellation.clone(),
                )
                .await?;
            let CursorPageAuthVaultKeyResponse {
                has_more,
                items,
                next_cursor: page_cursor,
            } = page;
            cursor = next_cursor(has_more, page_cursor, items.len())?;
            vault_keys.append(items)?;
        }
        Ok(vault_keys.into_items())
    }

    pub(crate) async fn get_travel_mode(
        &self,
        token: &str,
        cancellation: RequestCancellation,
    ) -> Result<TravelModeResponse, RuntimeError> {
        validate_bearer(token)?;
        let url = self.endpoint(&["api", "v1", "travel-mode"])?;
        self.get_json(
            url,
            200,
            SMALL_AUTH_RESPONSE_BYTES,
            Some(token),
            cancellation,
        )
        .await
    }

    pub(crate) async fn refresh_session(
        &self,
        token: &str,
        cancellation: RequestCancellation,
    ) -> Result<AuthenticatedOutcome<crate::server_contract::RefreshSessionResponse>, RuntimeError>
    {
        validate_bearer(token)?;
        let url = self.endpoint(&["api", "v1", "sessions", "current", "refresh"])?;
        let raw = self
            .execute_raw(
                HttpMethod::Post,
                url,
                self.headers(Some(token))?,
                Vec::new(),
                SMALL_AUTH_RESPONSE_BYTES,
                cancellation,
            )
            .await?;
        match raw.status {
            200 => {
                require_json_content_type(&raw.headers)?;
                let value = serde_json::from_slice(&raw.body)
                    .map_err(|_| authentication_failure("Session refresh returned invalid JSON"))?;
                Ok(AuthenticatedOutcome::Ok(value))
            }
            401 => Ok(AuthenticatedOutcome::ReauthenticationRequired),
            _ => Ok(AuthenticatedOutcome::Transient),
        }
    }

    pub(crate) async fn bootstrap_page(
        &self,
        token: &str,
        request_cursor: Option<&str>,
        pinned_sync_cursor: Option<&str>,
        sync_cursor_captured: bool,
        cancellation: RequestCancellation,
    ) -> Result<
        AuthenticatedOutcome<RawJsonPage<crate::server_contract::BootstrapItemsResponse>>,
        RuntimeError,
    > {
        validate_bearer(token)?;
        let mut url = self.endpoint(&["api", "v1", "sync", "bootstrap"])?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("limit", "500");
            if let Some(cursor) = request_cursor {
                query.append_pair("cursor", cursor);
            }
            if sync_cursor_captured {
                query.append_pair("syncCursorCaptured", "true");
                if let Some(sync_cursor) = pinned_sync_cursor {
                    query.append_pair("syncCursor", sync_cursor);
                }
            }
        }
        self.get_authenticated_json(url, VAULT_KEY_RESPONSE_BYTES, token, cancellation)
            .await
    }

    pub(crate) async fn sync_changes(
        &self,
        token: &str,
        since_id: Option<&str>,
        cancellation: RequestCancellation,
    ) -> Result<AuthenticatedOutcome<crate::server_contract::SyncChangesResponse>, RuntimeError>
    {
        validate_bearer(token)?;
        let mut url = self.endpoint(&["api", "v1", "sync", "changes"])?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("limit", "100");
            if let Some(since_id) = since_id {
                query.append_pair("sinceId", since_id);
            }
        }
        Ok(self
            .get_authenticated_json(url, VAULT_KEY_RESPONSE_BYTES, token, cancellation)
            .await?
            .map(|page| page.value))
    }

    pub(crate) async fn fetch_item(
        &self,
        token: &str,
        item_id: &str,
        cancellation: RequestCancellation,
    ) -> Result<AuthenticatedOutcome<crate::server_contract::ItemResponseDto>, RuntimeError> {
        validate_bearer(token)?;
        validate_identifier(item_id, "Item")?;
        let url = self.endpoint(&["api", "v1", "items", item_id])?;
        Ok(self
            .get_authenticated_json(url, VAULT_KEY_RESPONSE_BYTES, token, cancellation)
            .await?
            .map(|page| page.value))
    }

    pub(crate) async fn sse_wakeup(
        &self,
        token: &str,
        cancellation: RequestCancellation,
    ) -> Result<AuthenticatedOutcome<Vec<u8>>, RuntimeError> {
        validate_bearer(token)?;
        let url = self.endpoint(&["api", "v1", "sync", "events"])?;
        let mut headers = self.headers(Some(token))?;
        headers.push(HttpHeader {
            name: "Accept".to_owned(),
            value: "text/event-stream".to_owned(),
        });
        let raw = self
            .execute_raw(
                HttpMethod::Get,
                url,
                headers,
                Vec::new(),
                VAULT_KEY_RESPONSE_BYTES,
                cancellation,
            )
            .await?;
        match raw.status {
            200 => Ok(AuthenticatedOutcome::Ok(raw.body)),
            401 => Ok(AuthenticatedOutcome::ReauthenticationRequired),
            _ => Ok(AuthenticatedOutcome::Transient),
        }
    }

    async fn get_authenticated_json<T: DeserializeOwned>(
        &self,
        url: Url,
        max_response_bytes: u32,
        token: &str,
        cancellation: RequestCancellation,
    ) -> Result<AuthenticatedOutcome<RawJsonPage<T>>, RuntimeError> {
        let raw = self
            .execute_raw(
                HttpMethod::Get,
                url,
                self.headers(Some(token))?,
                Vec::new(),
                max_response_bytes,
                cancellation,
            )
            .await?;
        match raw.status {
            200 => {
                require_json_content_type(&raw.headers)?;
                let value = serde_json::from_slice(&raw.body)
                    .map_err(|_| authentication_failure("Sync Server returned invalid JSON"))?;
                Ok(AuthenticatedOutcome::Ok(RawJsonPage {
                    raw_body: raw.body,
                    value,
                }))
            }
            401 => Ok(AuthenticatedOutcome::ReauthenticationRequired),
            _ => Ok(AuthenticatedOutcome::Transient),
        }
    }

    async fn execute_raw(
        &self,
        method: HttpMethod,
        url: Url,
        headers: Vec<HttpHeader>,
        body: Vec<u8>,
        max_response_bytes: u32,
        cancellation: RequestCancellation,
    ) -> Result<RawHttpResponse, RuntimeError> {
        let response = self
            .transport
            .execute(
                HttpDispatch::new(method, url.into(), headers, body, max_response_bytes),
                cancellation,
            )
            .await?;
        match response {
            HttpResponse::Completed {
                status,
                headers,
                body,
            } => Ok(RawHttpResponse {
                status,
                headers,
                body,
            }),
            HttpResponse::Cancelled => Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "request was cancelled",
            )),
            HttpResponse::NetworkFailure | HttpResponse::ResponseTooLarge => {
                Err(authentication_failure("Server request failed"))
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn post_json<Request, Response>(
        &self,
        path: &[&str],
        request: &Request,
        expected_status: u16,
        max_response_bytes: u32,
        bearer: Option<&str>,
        cancellation: RequestCancellation,
    ) -> Result<Response, RuntimeError>
    where
        Request: Serialize,
        Response: DeserializeOwned,
    {
        let body = serde_json::to_vec(request)
            .map_err(|_| invariant("Authentication request could not be serialized"))?;
        let mut headers = self.headers(bearer)?;
        headers.insert(
            0,
            HttpHeader {
                name: "Content-Type".to_owned(),
                value: "application/json".to_owned(),
            },
        );
        self.execute_json(
            HttpMethod::Post,
            self.endpoint(path)?,
            headers,
            body,
            expected_status,
            max_response_bytes,
            cancellation,
        )
        .await
    }

    async fn get_json<Response: DeserializeOwned>(
        &self,
        url: Url,
        expected_status: u16,
        max_response_bytes: u32,
        bearer: Option<&str>,
        cancellation: RequestCancellation,
    ) -> Result<Response, RuntimeError> {
        self.execute_json(
            HttpMethod::Get,
            url,
            self.headers(bearer)?,
            Vec::new(),
            expected_status,
            max_response_bytes,
            cancellation,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn execute_json<Response: DeserializeOwned>(
        &self,
        method: HttpMethod,
        url: Url,
        headers: Vec<HttpHeader>,
        body: Vec<u8>,
        expected_status: u16,
        max_response_bytes: u32,
        cancellation: RequestCancellation,
    ) -> Result<Response, RuntimeError> {
        let response = self
            .transport
            .execute(
                HttpDispatch::new(method, url.into(), headers, body, max_response_bytes),
                cancellation,
            )
            .await?;
        let HttpResponse::Completed {
            status,
            headers,
            body,
        } = response
        else {
            return Err(match response {
                HttpResponse::Cancelled => RuntimeError::new(
                    RuntimeErrorCode::Cancelled,
                    "Authentication request was cancelled",
                ),
                HttpResponse::NetworkFailure | HttpResponse::ResponseTooLarge => {
                    authentication_failure("Authentication Server request failed")
                }
                HttpResponse::Completed { .. } => unreachable!(),
            });
        };
        if status != expected_status {
            return Err(authentication_failure(
                "Authentication Server returned an unexpected status",
            ));
        }
        require_json_content_type(&headers)?;
        serde_json::from_slice(&body)
            .map_err(|_| authentication_failure("Authentication Server returned invalid JSON"))
    }

    fn headers(&self, bearer: Option<&str>) -> Result<Vec<HttpHeader>, RuntimeError> {
        let mut headers = vec![
            HttpHeader {
                name: "Bittery-Client-Id".to_owned(),
                value: self.config.client_id.clone(),
            },
            HttpHeader {
                name: "Bittery-Client-Platform".to_owned(),
                value: self.config.platform.as_str().to_owned(),
            },
            HttpHeader {
                name: "Bittery-Client-Version".to_owned(),
                value: self.config.version.clone(),
            },
        ];
        if let Some(token) = bearer {
            validate_bearer(token)?;
            headers.push(HttpHeader {
                name: "Authorization".to_owned(),
                value: format!("Bearer {token}"),
            });
        }
        Ok(headers)
    }

    fn endpoint(&self, segments: &[&str]) -> Result<Url, RuntimeError> {
        let mut url = self.base_url.clone();
        url.path_segments_mut()
            .map_err(|_| invariant("Normalized Server URL cannot own path segments"))?
            .extend(segments);
        Ok(url)
    }
}

struct CursorEvidence {
    seen: HashSet<String>,
    total_bytes: usize,
}

impl CursorEvidence {
    fn new() -> Self {
        Self {
            seen: HashSet::new(),
            total_bytes: 0,
        }
    }

    fn record(&mut self, cursor: &str) -> Result<(), RuntimeError> {
        self.record_with_limits(cursor, MAX_AUTH_VAULT_KEYS, MAX_AUTH_VAULT_KEY_BYTES)
    }

    fn record_with_limits(
        &mut self,
        cursor: &str,
        max_cursors: usize,
        max_bytes: usize,
    ) -> Result<(), RuntimeError> {
        if self.seen.contains(cursor) {
            return Err(authentication_failure(
                "Server returned a repeated Vault-key cursor",
            ));
        }
        if self.seen.len() >= max_cursors {
            return Err(authentication_failure(
                "Server returned too many Vault-key cursors",
            ));
        }
        let new_bytes = self
            .total_bytes
            .checked_add(cursor.len())
            .ok_or_else(|| authentication_failure("Server returned too much cursor data"))?;
        if new_bytes > max_bytes {
            return Err(authentication_failure(
                "Server returned too much cursor data",
            ));
        }
        self.total_bytes = new_bytes;
        self.seen.insert(cursor.to_owned());
        Ok(())
    }
}

struct VaultKeyAccumulator {
    items: Vec<AuthVaultKeyResponse>,
    // Exact serialized JSON-array size: opening/closing brackets, item bytes and separators.
    serialized_bytes: usize,
}

impl VaultKeyAccumulator {
    fn new() -> Self {
        Self {
            items: Vec::new(),
            serialized_bytes: 2,
        }
    }

    fn append(&mut self, incoming: Vec<AuthVaultKeyResponse>) -> Result<(), RuntimeError> {
        self.append_with_limits(incoming, MAX_AUTH_VAULT_KEYS, MAX_AUTH_VAULT_KEY_BYTES)
    }

    fn append_with_limits(
        &mut self,
        incoming: Vec<AuthVaultKeyResponse>,
        max_items: usize,
        max_bytes: usize,
    ) -> Result<(), RuntimeError> {
        let new_count = self
            .items
            .len()
            .checked_add(incoming.len())
            .ok_or_else(|| authentication_failure("Server returned too many Vault keys"))?;
        if new_count > max_items {
            return Err(authentication_failure(
                "Server returned too many Vault keys",
            ));
        }

        let mut additional_bytes = 0usize;
        for (index, item) in incoming.iter().enumerate() {
            let item_bytes = serde_json::to_vec(item)
                .map_err(|_| invariant("Vault key could not be measured"))?
                .len();
            let separator = usize::from(!self.items.is_empty() || index > 0);
            additional_bytes = additional_bytes
                .checked_add(separator)
                .and_then(|bytes| bytes.checked_add(item_bytes))
                .ok_or_else(|| authentication_failure("Server returned too much Vault-key data"))?;
        }
        let new_bytes = self
            .serialized_bytes
            .checked_add(additional_bytes)
            .ok_or_else(|| authentication_failure("Server returned too much Vault-key data"))?;
        if new_bytes > max_bytes {
            return Err(authentication_failure(
                "Server returned too much Vault-key data",
            ));
        }
        self.serialized_bytes = new_bytes;
        self.items.extend(incoming);
        Ok(())
    }

    fn into_items(self) -> Vec<AuthVaultKeyResponse> {
        self.items
    }
}

fn normalize_server_url(value: &str, confirmed: bool) -> Result<Url, RuntimeError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(authentication_failure("Server URL is invalid"));
    }
    let candidate = if has_explicit_scheme(trimmed) {
        trimmed.to_owned()
    } else {
        let parsed_http = Url::parse(&format!("http://{trimmed}"))
            .map_err(|_| authentication_failure("Server URL is invalid"))?;
        let inferred_http = parsed_http
            .host()
            .is_some_and(|host| is_loopback_host(&host) || is_unspecified_ipv4(&host));
        format!(
            "{}://{trimmed}",
            if inferred_http { "http" } else { "https" }
        )
    };
    let mut url =
        Url::parse(&candidate).map_err(|_| authentication_failure("Server URL is invalid"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(authentication_failure("Server URL is invalid"));
    }
    if url.scheme() == "http"
        && !url.host().is_some_and(|host| is_loopback_host(&host))
        && !confirmed
    {
        return Err(authentication_failure(
            "Remote plain HTTP requires explicit confirmation",
        ));
    }
    url.set_query(None);
    url.set_fragment(None);
    let normalized_path = url.path().trim_end_matches('/').to_owned();
    url.set_path(if normalized_path.is_empty() {
        "/"
    } else {
        &normalized_path
    });
    Ok(url)
}

fn has_explicit_scheme(value: &str) -> bool {
    let Some((scheme, _)) = value.split_once("://") else {
        return false;
    };
    !scheme.is_empty()
        && scheme.bytes().enumerate().all(|(index, byte)| match byte {
            b'a'..=b'z' | b'A'..=b'Z' => true,
            b'0'..=b'9' | b'+' | b'-' | b'.' => index > 0,
            _ => false,
        })
}

fn is_loopback_host(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(address) => address.is_loopback(),
        Host::Ipv6(address) => address.is_loopback(),
    }
}

fn is_unspecified_ipv4(host: &Host<&str>) -> bool {
    matches!(host, Host::Ipv4(address) if address.is_unspecified())
}

fn validate_config(config: &AuthClientConfig) -> Result<(), RuntimeError> {
    for value in [&config.client_id, &config.version] {
        if value.is_empty()
            || value
                .as_bytes()
                .iter()
                .any(|byte| byte.is_ascii_control() || matches!(byte, b'\r' | b'\n'))
        {
            return Err(authentication_failure(
                "Authentication client configuration is invalid",
            ));
        }
    }
    Ok(())
}

fn validate_identifier(value: &str, label: &str) -> Result<(), RuntimeError> {
    if value.is_empty() {
        Err(invariant("Sync identifier is empty"))
    } else {
        let _ = label;
        Ok(())
    }
}

fn validate_bearer(token: &str) -> Result<(), RuntimeError> {
    if token.is_empty()
        || token
            .as_bytes()
            .iter()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        return Err(invariant("Authentication bearer token is invalid"));
    }
    Ok(())
}

fn require_json_content_type(headers: &[HttpHeader]) -> Result<(), RuntimeError> {
    let mut values = headers
        .iter()
        .filter(|header| header.name.eq_ignore_ascii_case("content-type"));
    let Some(value) = values.next() else {
        return Err(authentication_failure(
            "Authentication Server response is not JSON",
        ));
    };
    if values.next().is_some() {
        return Err(authentication_failure(
            "Authentication Server response has ambiguous content type",
        ));
    }
    let mut parts = value.value.split(';');
    if !parts
        .next()
        .is_some_and(|media_type| media_type.trim().eq_ignore_ascii_case("application/json"))
        || parts.any(|parameter| !parameter.trim().eq_ignore_ascii_case("charset=utf-8"))
    {
        return Err(authentication_failure(
            "Authentication Server response is not JSON",
        ));
    }
    Ok(())
}

fn next_cursor(
    has_more: bool,
    cursor: Option<String>,
    item_count: usize,
) -> Result<Option<String>, RuntimeError> {
    match (has_more, cursor, item_count) {
        (true, _, 0) => Err(authentication_failure(
            "Server returned a Vault-key continuation without progress",
        )),
        (true, Some(cursor), _) if !cursor.is_empty() => Ok(Some(cursor)),
        (true, _, _) => Err(authentication_failure(
            "Server returned an incomplete Vault-key page",
        )),
        (false, _, _) => Ok(None),
    }
}

fn invariant(message: &'static str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

fn authentication_failure(message: &'static str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::AuthenticationUnavailable, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http_transport::SerializedHttpExecutor;
    use crate::server_contract::{VaultRole, VaultType};
    use async_trait::async_trait;
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};

    struct ScriptedExecutor {
        responses: Mutex<Vec<String>>,
        requests: Mutex<Vec<String>>,
    }

    impl ScriptedExecutor {
        fn new(responses: Vec<String>) -> Self {
            Self {
                responses: Mutex::new(responses.into_iter().rev().collect()),
                requests: Mutex::new(Vec::new()),
            }
        }

        fn requests(&self) -> Vec<Value> {
            self.requests
                .lock()
                .unwrap()
                .iter()
                .map(|request| serde_json::from_str(request).unwrap())
                .collect()
        }
    }

    #[async_trait]
    impl SerializedHttpExecutor for ScriptedExecutor {
        async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
            self.requests.lock().unwrap().push(request_json);
            self.responses.lock().unwrap().pop().ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "test script exhausted",
                )
            })
        }

        fn cancel(&self, _dispatch_id: &str) {}
    }

    fn completed(status: u16, content_type: &str, body: Value) -> String {
        serde_json::to_string(&json!({
            "type": "completed",
            "status": status,
            "headers": [{ "name": "Content-Type", "value": content_type }],
            "body": serde_json::to_vec(&body).unwrap(),
        }))
        .unwrap()
    }

    fn metadata() -> AuthClientConfig {
        AuthClientConfig::new("client-7".into(), ClientPlatform::Web, "0.5.2".into()).unwrap()
    }

    fn vault_key(id: &str) -> Value {
        json!({
            "encryptedVaultKey": format!("wrapped-{id}"),
            "role": "owner",
            "vaultIcon": null,
            "vaultId": id,
            "vaultImageUrl": null,
            "vaultName": format!("Vault {id}"),
            "vaultType": "personal"
        })
    }

    fn contract_vault_key(id: &str, encrypted_vault_key: &str) -> AuthVaultKeyResponse {
        AuthVaultKeyResponse {
            encrypted_vault_key: encrypted_vault_key.into(),
            role: VaultRole::Owner,
            vault_icon: None,
            vault_id: id.into(),
            vault_image_url: None,
            vault_name: format!("Vault {id}"),
            vault_type: VaultType::Personal,
        }
    }

    fn expect_error<T>(result: Result<T, RuntimeError>) -> RuntimeError {
        match result {
            Ok(_) => panic!("expected authentication request to fail"),
            Err(error) => error,
        }
    }

    fn finish_response() -> Value {
        json!({
            "expiresAt": "2026-08-23T12:00:00Z",
            "serverProof": "server-proof",
            "sessionId": "session-1",
            "token": "fresh-token",
            "user": {
                "email": "alice@example.test",
                "encryptedPrivateKey": "private-key",
                "id": "user-1",
                "name": "Alice",
                "publicKey": "public-key",
                "secretKeyHint": "A3-ONE",
                "teamAvatarUrl": null,
                "teamName": "Alice"
            },
            "vaultKeys": {
                "hasMore": true,
                "items": [vault_key("vault-1")],
                "nextCursor": "cursor one/+"
            }
        })
    }

    #[tokio::test]
    async fn owns_exact_auth_exchange_requests_and_drains_every_vault_key_page() {
        let executor = Arc::new(ScriptedExecutor::new(vec![
            completed(
                201,
                "application/json",
                json!({
                    "attemptId": "attempt /?",
                    "kdfParams": { "algorithm": "pbkdf2", "iterations": 600000, "schemaVersion": 1 },
                    "salt": "salt",
                    "serverPublicKey": "server-public-key"
                }),
            ),
            completed(200, "application/json; charset=utf-8", finish_response()),
            completed(
                200,
                "application/json",
                json!({
                    "hasMore": true,
                    "items": [vault_key("vault-2")],
                    "nextCursor": "cursor/two"
                }),
            ),
            completed(
                200,
                "application/json",
                json!({
                    "hasMore": false,
                    "items": [vault_key("vault-3")],
                    "nextCursor": null
                }),
            ),
            completed(
                200,
                "application/json",
                json!({
                    "enabled": true,
                    "enabledAt": "2026-08-23T10:00:00Z",
                    "hiddenVaultIds": ["vault-3"],
                    "updatedAt": "2026-08-23T10:00:00Z"
                }),
            ),
        ]));
        let transport = HttpTransport::new(executor.clone());
        let client = AuthHttpClient::new(
            &transport,
            " HTTPS://Vault.Example.test/bittery/// ",
            false,
            metadata(),
        )
        .unwrap();
        assert_eq!(
            client.normalized_server_url(),
            "https://vault.example.test/bittery"
        );

        let attempt = client
            .start_login(
                &StartLoginRequest {
                    client_public_key: "client-public-key".into(),
                    email: "alice@example.test".into(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        let finish = client
            .finish_login(
                &attempt.attempt_id,
                &FinishLoginRequest {
                    client_proof: "client-proof".into(),
                    client_public_key: "client-public-key".into(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        let vault_keys = client
            .drain_vault_keys(&finish.token, finish.vault_keys, RequestCancellation::new())
            .await
            .unwrap();
        let travel_mode = client
            .get_travel_mode(&finish.token, RequestCancellation::new())
            .await
            .unwrap();

        assert_eq!(vault_keys.len(), 3);
        assert!(travel_mode.enabled);
        let requests = executor.requests();
        assert_eq!(requests.len(), 5);
        assert_eq!(requests[0]["method"], "POST");
        assert_eq!(
            requests[0]["url"],
            "https://vault.example.test/bittery/api/v1/auth/login-attempts"
        );
        assert_eq!(
            String::from_utf8(
                serde_json::from_value::<Vec<u8>>(requests[0]["body"].clone()).unwrap()
            )
            .unwrap(),
            r#"{"email":"alice@example.test","clientPublicKey":"client-public-key"}"#
        );
        assert_eq!(
            String::from_utf8(
                serde_json::from_value::<Vec<u8>>(requests[1]["body"].clone()).unwrap()
            )
            .unwrap(),
            r#"{"clientPublicKey":"client-public-key","clientProof":"client-proof"}"#
        );
        assert_eq!(
            requests[1]["url"],
            "https://vault.example.test/bittery/api/v1/auth/login-attempts/attempt%20%2F%3F/finish"
        );
        assert_eq!(
            requests[2]["url"],
            "https://vault.example.test/bittery/api/v1/users/me/vault-keys?cursor=cursor+one%2F%2B"
        );
        assert_eq!(
            requests[3]["url"],
            "https://vault.example.test/bittery/api/v1/users/me/vault-keys?cursor=cursor%2Ftwo"
        );
        assert_eq!(
            requests[4]["url"],
            "https://vault.example.test/bittery/api/v1/travel-mode"
        );
        assert_eq!(requests[0]["maxResponseBytes"], SMALL_AUTH_RESPONSE_BYTES);
        assert_eq!(requests[1]["maxResponseBytes"], VAULT_KEY_RESPONSE_BYTES);
        assert_eq!(requests[2]["maxResponseBytes"], VAULT_KEY_RESPONSE_BYTES);
        assert_eq!(requests[4]["maxResponseBytes"], SMALL_AUTH_RESPONSE_BYTES);

        let public_headers = requests[0]["headers"].as_array().unwrap();
        assert_eq!(
            public_headers,
            &vec![
                json!({"name":"Content-Type","value":"application/json"}),
                json!({"name":"Bittery-Client-Id","value":"client-7"}),
                json!({"name":"Bittery-Client-Platform","value":"web"}),
                json!({"name":"Bittery-Client-Version","value":"0.5.2"}),
            ]
        );
        for request in &requests[2..] {
            assert_eq!(
                request["headers"].as_array().unwrap().last().unwrap(),
                &json!({"name":"Authorization","value":"Bearer fresh-token"})
            );
        }
    }

    #[test]
    fn normalizes_defaults_and_rejects_invalid_or_unconfirmed_urls_before_invocation() {
        let executor = Arc::new(ScriptedExecutor::new(vec![]));
        let transport = HttpTransport::new(executor.clone());

        for (input, confirmed, expected) in [
            ("localhost:3000", false, "http://localhost:3000"),
            ("127.0.0.1:3000/", false, "http://127.0.0.1:3000"),
            ("127.1:3000/", false, "http://127.0.0.1:3000"),
            ("[::1]:3000", false, "http://[::1]:3000"),
            (
                "bücher.example/bittery",
                false,
                "https://xn--bcher-kva.example/bittery",
            ),
            (
                "vault.example.test/base/",
                false,
                "https://vault.example.test/base",
            ),
            (
                "https://vault.example.test:443/base//nested///?tenant=one#section",
                false,
                "https://vault.example.test/base//nested",
            ),
            (
                "https://vault.example.test/root/../bittery/./",
                false,
                "https://vault.example.test/bittery",
            ),
            ("0.0.0.0:3000", true, "http://0.0.0.0:3000"),
            (
                "http://vault.example.test",
                true,
                "http://vault.example.test",
            ),
        ] {
            let client = AuthHttpClient::new(&transport, input, confirmed, metadata()).unwrap();
            assert_eq!(client.normalized_server_url(), expected);
        }

        for input in [
            "",
            "ftp://vault.example.test",
            "0.0.0.0:3000",
            "https://user@vault.example.test",
            "http://vault.example.test",
        ] {
            assert!(AuthHttpClient::new(&transport, input, false, metadata()).is_err());
        }
        assert!(executor.requests().is_empty());
    }

    #[tokio::test]
    async fn rejects_missing_and_repeated_vault_key_cursors_fail_closed() {
        let executor = Arc::new(ScriptedExecutor::new(vec![completed(
            200,
            "application/json",
            json!({
                "hasMore": true,
                "items": [vault_key("vault-2")],
                "nextCursor": "cursor-1"
            }),
        )]));
        let transport = HttpTransport::new(executor.clone());
        let client =
            AuthHttpClient::new(&transport, "https://vault.example.test", false, metadata())
                .unwrap();
        let missing = expect_error(
            client
                .drain_vault_keys(
                    "fresh-token",
                    CursorPageAuthVaultKeyResponse {
                        has_more: true,
                        items: vec![contract_vault_key("vault-1", "wrapped-1")],
                        next_cursor: None,
                    },
                    RequestCancellation::new(),
                )
                .await,
        );
        assert_eq!(missing.code, RuntimeErrorCode::AuthenticationUnavailable);
        assert!(executor.requests().is_empty());

        let repeated = expect_error(
            client
                .drain_vault_keys(
                    "fresh-token",
                    CursorPageAuthVaultKeyResponse {
                        has_more: true,
                        items: vec![contract_vault_key("vault-1", "wrapped-1")],
                        next_cursor: Some("cursor-1".into()),
                    },
                    RequestCancellation::new(),
                )
                .await,
        );
        assert_eq!(repeated.code, RuntimeErrorCode::AuthenticationUnavailable);
        assert_eq!(executor.requests().len(), 1);

        let empty_executor = Arc::new(ScriptedExecutor::new(vec![completed(
            200,
            "application/json",
            json!({ "hasMore": true, "items": [], "nextCursor": "fresh-cursor-2" }),
        )]));
        let empty_transport = HttpTransport::new(empty_executor.clone());
        let empty_client = AuthHttpClient::new(
            &empty_transport,
            "https://vault.example.test",
            false,
            metadata(),
        )
        .unwrap();
        let no_progress = expect_error(
            empty_client
                .drain_vault_keys(
                    "fresh-token",
                    CursorPageAuthVaultKeyResponse {
                        has_more: true,
                        items: vec![contract_vault_key("vault-1", "wrapped-1")],
                        next_cursor: Some("fresh-cursor-1".into()),
                    },
                    RequestCancellation::new(),
                )
                .await,
        );
        assert_eq!(
            no_progress.code,
            RuntimeErrorCode::AuthenticationUnavailable
        );
        assert_eq!(empty_executor.requests().len(), 1);
    }

    #[test]
    fn cursor_evidence_rejects_repetition_count_and_byte_overflow_at_exact_boundaries() {
        let mut exact = CursorEvidence::new();
        exact.record_with_limits("one", 2, 6).unwrap();
        exact.record_with_limits("two", 2, 6).unwrap();
        assert_eq!(exact.seen.len(), 2);
        assert_eq!(exact.total_bytes, 6);

        let repeated = exact.record_with_limits("one", usize::MAX, usize::MAX);
        assert_eq!(
            repeated.unwrap_err().code,
            RuntimeErrorCode::AuthenticationUnavailable
        );
        let too_many = exact.record_with_limits("three", 2, usize::MAX);
        assert_eq!(
            too_many.unwrap_err().code,
            RuntimeErrorCode::AuthenticationUnavailable
        );
        assert_eq!(exact.seen.len(), 2);
        assert_eq!(exact.total_bytes, 6);

        let mut oversized = CursorEvidence::new();
        let too_large = oversized.record_with_limits("abc", usize::MAX, 2);
        assert_eq!(
            too_large.unwrap_err().code,
            RuntimeErrorCode::AuthenticationUnavailable
        );
        assert!(oversized.seen.is_empty());
        assert_eq!(oversized.total_bytes, 0);
    }

    #[test]
    fn aggregate_vault_key_count_and_serialized_bytes_are_exact_and_all_or_nothing() {
        assert_eq!(MAX_AUTH_VAULT_KEYS, 21_000);
        assert_eq!(MAX_AUTH_VAULT_KEY_BYTES, 32 * 1024 * 1024);

        let first = contract_vault_key("one", "wrapped-one");
        let second = contract_vault_key("two", "wrapped-two");
        let exact_two_bytes = serde_json::to_vec(&vec![first.clone(), second.clone()])
            .unwrap()
            .len();
        let mut accumulator = VaultKeyAccumulator::new();
        accumulator
            .append_with_limits(vec![first, second], 2, exact_two_bytes)
            .unwrap();
        assert_eq!(accumulator.items.len(), 2);
        assert_eq!(accumulator.serialized_bytes, exact_two_bytes);

        let count_error = accumulator
            .append_with_limits(
                vec![contract_vault_key("three", "wrapped-three")],
                2,
                usize::MAX,
            )
            .unwrap_err();
        assert_eq!(
            count_error.code,
            RuntimeErrorCode::AuthenticationUnavailable
        );
        assert_eq!(accumulator.items.len(), 2);

        let mut byte_limited = VaultKeyAccumulator::new();
        let one = contract_vault_key("one", "wrapped-one");
        let exact_one_byte_limit = serde_json::to_vec(&vec![one.clone()]).unwrap().len();
        byte_limited
            .append_with_limits(vec![one], usize::MAX, exact_one_byte_limit)
            .unwrap();
        let byte_error = byte_limited
            .append_with_limits(
                vec![contract_vault_key("two", "wrapped-two")],
                usize::MAX,
                exact_one_byte_limit,
            )
            .unwrap_err();
        assert_eq!(byte_error.code, RuntimeErrorCode::AuthenticationUnavailable);
        assert_eq!(byte_limited.items.len(), 1);
        assert_eq!(byte_limited.serialized_bytes, exact_one_byte_limit);
    }

    #[tokio::test]
    async fn rejects_redirect_opaque_wrong_content_type_and_malformed_json() {
        for response in [
            completed(302, "application/json", json!({})),
            completed(0, "application/json", json!({})),
            completed(201, "text/html", json!({})),
            completed(
                201,
                "application/json",
                json!({
                    "attemptId": "attempt-1",
                    "kdfParams": {
                        "algorithm": "pbkdf2",
                        "iterations": 1,
                        "schemaVersion": 1,
                        "unexpectedNested": true
                    },
                    "salt": "salt",
                    "serverPublicKey": "key"
                }),
            ),
            r#"{"type":"networkFailure"}"#.to_owned(),
            r#"{"type":"responseTooLarge"}"#.to_owned(),
        ] {
            let executor = Arc::new(ScriptedExecutor::new(vec![response]));
            let transport = HttpTransport::new(executor);
            let client =
                AuthHttpClient::new(&transport, "https://vault.example.test", false, metadata())
                    .unwrap();
            let error = expect_error(
                client
                    .start_login(
                        &StartLoginRequest {
                            client_public_key: "key".into(),
                            email: "alice@example.test".into(),
                        },
                        RequestCancellation::new(),
                    )
                    .await,
            );
            assert_eq!(error.code, RuntimeErrorCode::AuthenticationUnavailable);
        }
    }

    #[tokio::test]
    async fn rejects_ambiguous_content_type_invalid_bearer_and_host_oversize() {
        let ambiguous = serde_json::to_string(&json!({
            "type": "completed",
            "status": 201,
            "headers": [
                { "name": "Content-Type", "value": "application/json" },
                { "name": "content-type", "value": "application/json" }
            ],
            "body": serde_json::to_vec(&json!({})).unwrap()
        }))
        .unwrap();
        let oversized = serde_json::to_string(&json!({
            "type": "completed",
            "status": 201,
            "headers": [{ "name": "Content-Type", "value": "application/json" }],
            "body": vec![b' '; SMALL_AUTH_RESPONSE_BYTES as usize + 1]
        }))
        .unwrap();

        for response in [ambiguous, oversized] {
            let executor = Arc::new(ScriptedExecutor::new(vec![response]));
            let transport = HttpTransport::new(executor);
            let client =
                AuthHttpClient::new(&transport, "https://vault.example.test", false, metadata())
                    .unwrap();
            assert!(client
                .start_login(
                    &StartLoginRequest {
                        client_public_key: "key".into(),
                        email: "alice@example.test".into(),
                    },
                    RequestCancellation::new(),
                )
                .await
                .is_err());
        }

        let executor = Arc::new(ScriptedExecutor::new(vec![]));
        let transport = HttpTransport::new(executor.clone());
        let client =
            AuthHttpClient::new(&transport, "https://vault.example.test", false, metadata())
                .unwrap();
        let error = expect_error(
            client
                .get_travel_mode("bad token", RequestCancellation::new())
                .await,
        );
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        assert!(executor.requests().is_empty());
    }
}
