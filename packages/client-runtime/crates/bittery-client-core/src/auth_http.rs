use crate::{
    http_transport::{HttpDispatch, HttpHeader, HttpMethod, HttpResponse, HttpTransport},
    server_contract::{
        AuthVaultKeyResponse, CursorPageAuthVaultKeyResponse, FinishLoginRequest,
        FinishLoginResponse, KdfParamsResponse, LoginAttemptResponse, LoginUserResponse,
        StartLoginRequest, TravelModeResponse, VaultRole, VaultType,
    },
    RequestCancellation, RuntimeError, RuntimeErrorCode,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{collections::HashSet, net::IpAddr};

const SMALL_AUTH_RESPONSE_BYTES: u32 = 64 * 1024;
const VAULT_KEY_RESPONSE_BYTES: u32 = 4 * 1024 * 1024;

#[derive(Clone, Copy)]
pub(crate) enum ClientPlatform {
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

pub(crate) struct AuthClientMetadata {
    pub(crate) client_id: String,
    pub(crate) platform: ClientPlatform,
    pub(crate) version: String,
}

/// Typed authentication requests and response policy over the primitive host transport seam.
pub(crate) struct AuthHttpClient<'transport> {
    transport: &'transport HttpTransport,
    base_url: ServerBaseUrl,
    metadata: AuthClientMetadata,
}

impl<'transport> AuthHttpClient<'transport> {
    pub(crate) fn new(
        transport: &'transport HttpTransport,
        server_url: &str,
        insecure_transport_confirmed: bool,
        metadata: AuthClientMetadata,
    ) -> Result<Self, RuntimeError> {
        validate_metadata(&metadata)?;
        let base_url = normalize_server_url(server_url, insecure_transport_confirmed)?;
        Ok(Self {
            transport,
            base_url,
            metadata,
        })
    }

    pub(crate) fn normalized_server_url(&self) -> String {
        self.base_url.normalized.clone()
    }

    pub(crate) async fn start_login(
        &self,
        request: &StartLoginRequest,
        cancellation: RequestCancellation,
    ) -> Result<LoginAttemptResponse, RuntimeError> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct WireRequest<'a> {
            email: &'a str,
            client_public_key: &'a str,
        }

        self.post_json(
            &["api", "v1", "auth", "login-attempts"],
            &WireRequest {
                email: &request.email,
                client_public_key: &request.client_public_key,
            },
            201,
            SMALL_AUTH_RESPONSE_BYTES,
            None,
            cancellation,
        )
        .await
        .map(WireLoginAttemptResponse::into_contract)
    }

    pub(crate) async fn finish_login(
        &self,
        attempt_id: &str,
        request: &FinishLoginRequest,
        cancellation: RequestCancellation,
    ) -> Result<FinishLoginResponse, RuntimeError> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct WireRequest<'a> {
            client_public_key: &'a str,
            client_proof: &'a str,
        }

        self.post_json(
            &["api", "v1", "auth", "login-attempts", attempt_id, "finish"],
            &WireRequest {
                client_public_key: &request.client_public_key,
                client_proof: &request.client_proof,
            },
            200,
            VAULT_KEY_RESPONSE_BYTES,
            None,
            cancellation,
        )
        .await
        .map(WireFinishLoginResponse::into_contract)
    }

    pub(crate) async fn drain_vault_keys(
        &self,
        token: &str,
        initial_page: CursorPageAuthVaultKeyResponse,
        cancellation: RequestCancellation,
    ) -> Result<Vec<AuthVaultKeyResponse>, RuntimeError> {
        validate_bearer(token)?;
        let mut items = initial_page.items;
        let mut cursor = next_cursor(initial_page.has_more, initial_page.next_cursor)?;
        let mut seen = HashSet::new();

        while let Some(current) = cursor {
            if !seen.insert(current.clone()) {
                return Err(authentication_failure(
                    "Server returned a repeated Vault-key cursor",
                ));
            }
            let url = format!(
                "{}?cursor={}",
                self.endpoint(&["api", "v1", "users", "me", "vault-keys"]),
                encode_query_value(&current)
            );
            let page: WireVaultKeyPage = self
                .get_json(
                    url,
                    200,
                    VAULT_KEY_RESPONSE_BYTES,
                    Some(token),
                    cancellation.clone(),
                )
                .await?;
            items.extend(page.items.into_iter().map(WireVaultKey::into_contract));
            cursor = next_cursor(page.has_more, page.next_cursor)?;
        }
        Ok(items)
    }

    pub(crate) async fn get_travel_mode(
        &self,
        token: &str,
        cancellation: RequestCancellation,
    ) -> Result<TravelModeResponse, RuntimeError> {
        validate_bearer(token)?;
        let url = self.endpoint(&["api", "v1", "travel-mode"]);
        self.get_json(
            url,
            200,
            SMALL_AUTH_RESPONSE_BYTES,
            Some(token),
            cancellation,
        )
        .await
        .map(WireTravelModeResponse::into_contract)
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
            self.endpoint(path),
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
        url: String,
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
        url: String,
        headers: Vec<HttpHeader>,
        body: Vec<u8>,
        expected_status: u16,
        max_response_bytes: u32,
        cancellation: RequestCancellation,
    ) -> Result<Response, RuntimeError> {
        let response = self
            .transport
            .execute(
                HttpDispatch::new(method, url, headers, body, max_response_bytes),
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
                value: self.metadata.client_id.clone(),
            },
            HttpHeader {
                name: "Bittery-Client-Platform".to_owned(),
                value: self.metadata.platform.as_str().to_owned(),
            },
            HttpHeader {
                name: "Bittery-Client-Version".to_owned(),
                value: self.metadata.version.clone(),
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

    fn endpoint(&self, segments: &[&str]) -> String {
        let mut url = self.base_url.normalized.clone();
        for segment in segments {
            url.push('/');
            url.push_str(&encode_path_segment(segment));
        }
        url
    }
}

#[derive(Clone)]
struct ServerBaseUrl {
    normalized: String,
}

fn normalize_server_url(value: &str, confirmed: bool) -> Result<ServerBaseUrl, RuntimeError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(authentication_failure("Server URL is invalid"));
    }
    if !trimmed.is_ascii()
        || trimmed
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
        || trimmed.contains(['?', '#'])
    {
        return Err(authentication_failure("Server URL is invalid"));
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_owned()
    } else {
        let authority = trimmed.split('/').next().unwrap_or_default();
        let inferred_http = parse_authority(authority)
            .map(|authority| is_local_development_host(&authority.host))
            .unwrap_or(false);
        format!(
            "{}://{trimmed}",
            if inferred_http { "http" } else { "https" }
        )
    };
    let Some((scheme, remainder)) = candidate.split_once("://") else {
        return Err(authentication_failure("Server URL is invalid"));
    };
    let scheme = scheme.to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https") {
        return Err(authentication_failure("Server URL is invalid"));
    }
    let (authority_text, path) = remainder
        .split_once('/')
        .map_or((remainder, ""), |(authority, path)| (authority, path));
    let authority = parse_authority(authority_text)?;
    if scheme == "http" && !is_loopback_host(&authority.host) && !confirmed {
        return Err(authentication_failure(
            "Remote plain HTTP requires explicit confirmation",
        ));
    }
    let path = normalize_base_path(path)?;
    let default_port = matches!(
        (scheme.as_str(), authority.port),
        ("http", Some(80)) | ("https", Some(443))
    );
    let port = if default_port {
        String::new()
    } else {
        authority
            .port
            .map(|port| format!(":{port}"))
            .unwrap_or_default()
    };
    Ok(ServerBaseUrl {
        normalized: format!("{scheme}://{}{port}{path}", authority.serialized_host),
    })
}

struct ParsedAuthority {
    host: String,
    serialized_host: String,
    port: Option<u16>,
}

fn parse_authority(value: &str) -> Result<ParsedAuthority, RuntimeError> {
    if value.is_empty() || value.contains('@') {
        return Err(authentication_failure("Server URL is invalid"));
    }
    let (host, serialized_host, port) = if let Some(ipv6) = value.strip_prefix('[') {
        let Some((host, suffix)) = ipv6.split_once(']') else {
            return Err(authentication_failure("Server URL is invalid"));
        };
        let address = host
            .parse::<std::net::Ipv6Addr>()
            .map_err(|_| authentication_failure("Server URL is invalid"))?;
        let port = parse_port_suffix(suffix)?;
        (address.to_string(), format!("[{address}]"), port)
    } else {
        let (host, port) = match value.rsplit_once(':') {
            Some((host, port)) if !host.contains(':') => (host, Some(parse_port(port)?)),
            Some(_) => return Err(authentication_failure("Server URL is invalid")),
            None => (value, None),
        };
        if host.is_empty()
            || host.starts_with('.')
            || host.ends_with('.')
            || host.split('.').any(|label| {
                label.is_empty()
                    || label.starts_with('-')
                    || label.ends_with('-')
                    || !label
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
        {
            return Err(authentication_failure("Server URL is invalid"));
        }
        let host = host.to_ascii_lowercase();
        (host.clone(), host, port)
    };
    Ok(ParsedAuthority {
        host,
        serialized_host,
        port,
    })
}

fn parse_port_suffix(value: &str) -> Result<Option<u16>, RuntimeError> {
    if value.is_empty() {
        Ok(None)
    } else if let Some(port) = value.strip_prefix(':') {
        Ok(Some(parse_port(port)?))
    } else {
        Err(authentication_failure("Server URL is invalid"))
    }
}

fn parse_port(value: &str) -> Result<u16, RuntimeError> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(authentication_failure("Server URL is invalid"));
    }
    value
        .parse()
        .map_err(|_| authentication_failure("Server URL is invalid"))
}

fn normalize_base_path(value: &str) -> Result<String, RuntimeError> {
    let path = value.trim_end_matches('/');
    if path.is_empty() {
        return Ok(String::new());
    }
    for segment in path.split('/') {
        if segment.is_empty()
            || matches!(segment, "." | "..")
            || !valid_encoded_path_segment(segment)
        {
            return Err(authentication_failure("Server URL is invalid"));
        }
    }
    Ok(format!("/{path}"))
}

fn valid_encoded_path_segment(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'%' {
            if index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit()
            {
                return false;
            }
            let encoded = &value[index + 1..index + 3];
            if encoded.eq_ignore_ascii_case("2e") || encoded.eq_ignore_ascii_case("2f") {
                return false;
            }
            index += 3;
            continue;
        }
        if !(byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'.'
                    | b'_'
                    | b'~'
                    | b'!'
                    | b'$'
                    | b'&'
                    | b'\''
                    | b'('
                    | b')'
                    | b'*'
                    | b'+'
                    | b','
                    | b';'
                    | b'='
                    | b':'
                    | b'@'
            ))
        {
            return false;
        }
        index += 1;
    }
    true
}

fn encode_path_segment(value: &str) -> String {
    percent_encode(value, false)
}

fn encode_query_value(value: &str) -> String {
    percent_encode(value, true)
}

fn percent_encode(value: &str, form_query: bool) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else if form_query && byte == b' ' {
            encoded.push('+');
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[(byte >> 4) as usize]));
            encoded.push(char::from(HEX[(byte & 0x0f) as usize]));
        }
    }
    encoded
}

fn is_local_development_host(host: &str) -> bool {
    is_loopback_host(host) || host == "0.0.0.0"
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .strip_prefix('[')
            .and_then(|value| value.strip_suffix(']'))
            .unwrap_or(host)
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn validate_metadata(metadata: &AuthClientMetadata) -> Result<(), RuntimeError> {
    for value in [&metadata.client_id, &metadata.version] {
        if value.is_empty()
            || value
                .as_bytes()
                .iter()
                .any(|byte| byte.is_ascii_control() || matches!(byte, b'\r' | b'\n'))
        {
            return Err(invariant("Authentication client metadata is invalid"));
        }
    }
    Ok(())
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

fn next_cursor(has_more: bool, cursor: Option<String>) -> Result<Option<String>, RuntimeError> {
    match (has_more, cursor) {
        (true, Some(cursor)) if !cursor.is_empty() => Ok(Some(cursor)),
        (true, _) => Err(authentication_failure(
            "Server returned an incomplete Vault-key page",
        )),
        (false, _) => Ok(None),
    }
}

fn invariant(message: &'static str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

fn authentication_failure(message: &'static str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::AuthenticationUnavailable, message)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireKdfParams {
    algorithm: String,
    iterations: i32,
    schema_version: i32,
}

impl WireKdfParams {
    fn into_contract(self) -> KdfParamsResponse {
        KdfParamsResponse {
            algorithm: self.algorithm,
            iterations: self.iterations,
            schema_version: self.schema_version,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireLoginAttemptResponse {
    attempt_id: String,
    kdf_params: WireKdfParams,
    salt: String,
    server_public_key: String,
}

impl WireLoginAttemptResponse {
    fn into_contract(self) -> LoginAttemptResponse {
        LoginAttemptResponse {
            attempt_id: self.attempt_id,
            kdf_params: self.kdf_params.into_contract(),
            salt: self.salt,
            server_public_key: self.server_public_key,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireLoginUser {
    email: String,
    encrypted_private_key: String,
    id: String,
    name: String,
    public_key: String,
    secret_key_hint: String,
    team_avatar_url: Option<String>,
    team_name: Option<String>,
}

impl WireLoginUser {
    fn into_contract(self) -> LoginUserResponse {
        LoginUserResponse {
            email: self.email,
            encrypted_private_key: self.encrypted_private_key,
            id: self.id,
            name: self.name,
            public_key: self.public_key,
            secret_key_hint: self.secret_key_hint,
            team_avatar_url: self.team_avatar_url,
            team_name: self.team_name,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireVaultKey {
    encrypted_vault_key: String,
    role: VaultRole,
    vault_icon: Option<String>,
    vault_id: String,
    vault_image_url: Option<String>,
    vault_name: String,
    vault_type: VaultType,
}

impl WireVaultKey {
    fn into_contract(self) -> AuthVaultKeyResponse {
        AuthVaultKeyResponse {
            encrypted_vault_key: self.encrypted_vault_key,
            role: self.role,
            vault_icon: self.vault_icon,
            vault_id: self.vault_id,
            vault_image_url: self.vault_image_url,
            vault_name: self.vault_name,
            vault_type: self.vault_type,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireVaultKeyPage {
    has_more: bool,
    items: Vec<WireVaultKey>,
    next_cursor: Option<String>,
}

impl WireVaultKeyPage {
    fn into_contract(self) -> CursorPageAuthVaultKeyResponse {
        CursorPageAuthVaultKeyResponse {
            has_more: self.has_more,
            items: self
                .items
                .into_iter()
                .map(WireVaultKey::into_contract)
                .collect(),
            next_cursor: self.next_cursor,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireFinishLoginResponse {
    expires_at: String,
    server_proof: String,
    session_id: String,
    token: String,
    user: WireLoginUser,
    vault_keys: WireVaultKeyPage,
}

impl WireFinishLoginResponse {
    fn into_contract(self) -> FinishLoginResponse {
        FinishLoginResponse {
            expires_at: self.expires_at,
            server_proof: self.server_proof,
            session_id: self.session_id,
            token: self.token,
            user: self.user.into_contract(),
            vault_keys: self.vault_keys.into_contract(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireTravelModeResponse {
    enabled: bool,
    enabled_at: Option<String>,
    hidden_vault_ids: Vec<String>,
    updated_at: String,
}

impl WireTravelModeResponse {
    fn into_contract(self) -> TravelModeResponse {
        TravelModeResponse {
            enabled: self.enabled,
            enabled_at: self.enabled_at,
            hidden_vault_ids: self.hidden_vault_ids,
            updated_at: self.updated_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http_transport::SerializedHttpExecutor;
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

    fn metadata() -> AuthClientMetadata {
        AuthClientMetadata {
            client_id: "client-7".into(),
            platform: ClientPlatform::Web,
            version: "0.5.2".into(),
        }
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
            ("[::1]:3000", false, "http://[::1]:3000"),
            (
                "vault.example.test/base/",
                false,
                "https://vault.example.test/base",
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
            "https://vault.example.test?tenant=one",
            "https://vault.example.test#fragment",
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
            json!({ "hasMore": true, "items": [], "nextCursor": "cursor-1" }),
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
                        items: vec![],
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
                        items: vec![],
                        next_cursor: Some("cursor-1".into()),
                    },
                    RequestCancellation::new(),
                )
                .await,
        );
        assert_eq!(repeated.code, RuntimeErrorCode::AuthenticationUnavailable);
        assert_eq!(executor.requests().len(), 1);
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
                    "kdfParams": { "algorithm": "pbkdf2", "iterations": 1, "schemaVersion": 1 },
                    "salt": "salt",
                    "serverPublicKey": "key",
                    "unexpected": true
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
