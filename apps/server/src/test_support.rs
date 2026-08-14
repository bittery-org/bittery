use std::{
    future::Future,
    sync::atomic::{AtomicU64, Ordering},
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

fn load_dotenv_once() {
    static LOADED: OnceLock<()> = OnceLock::new();
    LOADED.get_or_init(|| {
        dotenvy::dotenv().ok();
    });
}

use axum::{
    body::{to_bytes, Body},
    http::{
        header::{AUTHORIZATION, CONTENT_TYPE},
        HeaderMap, HeaderValue, Method, Request, StatusCode,
    },
    Router,
};
use futures_util::FutureExt;
use serde_json::{json, Value};
use sqlx::{query, PgPool};
use tower::util::ServiceExt;
use url::Url;

use crate::integrations::storage::{
    ObjectStorage, PresignedUploadResult, StorageError, StorageObjectHead,
};
use crate::{create_app, db, AppState, EdgeHttpConfig};

#[derive(Default)]
pub(crate) struct RecordingObjectStorage {
    calls: std::sync::Mutex<Vec<String>>,
    fail: bool,
    public_base: Option<String>,
}

impl RecordingObjectStorage {
    pub(crate) fn succeeding(public_base: Option<&str>) -> Self {
        Self {
            calls: std::sync::Mutex::new(Vec::new()),
            fail: false,
            public_base: public_base.map(str::to_owned),
        }
    }
    pub(crate) fn failing() -> Self {
        Self {
            fail: true,
            ..Self::default()
        }
    }
    pub(crate) fn calls(&self) -> Vec<String> {
        self.calls.lock().expect("storage calls lock").clone()
    }
    fn record(&self, call: String) -> Result<(), StorageError> {
        self.calls.lock().expect("storage calls lock").push(call);
        if self.fail {
            Err(StorageError::MissingConfig)
        } else {
            Ok(())
        }
    }
}

#[async_trait::async_trait]
impl ObjectStorage for RecordingObjectStorage {
    async fn presign_upload(
        &self,
        key: &str,
        _content_type: &str,
        _content_length: Option<i64>,
        _expires: Option<u64>,
    ) -> Result<PresignedUploadResult, StorageError> {
        self.record(format!("presign_upload:{key}"))?;
        Ok(PresignedUploadResult {
            key: key.into(),
            upload_url: format!("https://upload.invalid/{key}"),
            public_url: self.public_url(key),
        })
    }
    async fn presign_download(
        &self,
        key: &str,
        _expires: Option<u64>,
    ) -> Result<String, StorageError> {
        self.record(format!("presign_download:{key}"))?;
        Ok(format!("https://download.invalid/{key}"))
    }
    async fn head(&self, key: &str) -> Result<Option<StorageObjectHead>, StorageError> {
        self.record(format!("head:{key}"))?;
        Ok(Some(StorageObjectHead {
            size: 1,
            content_type: None,
        }))
    }
    async fn delete(&self, key: &str) -> Result<(), StorageError> {
        self.record(format!("delete:{key}"))
    }
    fn public_url(&self, key: &str) -> Option<String> {
        self.public_base
            .as_ref()
            .map(|base| format!("{}/{key}", base.trim_end_matches('/')))
    }
}

const DATABASE_PREFIX: &str = "bittery_test_";
const MAX_POSTGRES_IDENTIFIER_LEN: usize = 63;

pub(crate) struct ApiTestResponse {
    pub status: StatusCode,
    #[allow(dead_code)]
    pub headers: HeaderMap,
    pub body: Value,
    pub body_bytes: usize,
}

impl ApiTestResponse {
    pub(crate) fn assert_contract_status(&self) {
        if self.status.is_success() {
            assert!(
                !self.body.get("status").is_some_and(Value::is_number),
                "success response unexpectedly used a problem body: {}",
                self.body
            );
            return;
        }

        assert_eq!(
            self.body["status"],
            json!(self.status.as_u16()),
            "problem status must match the HTTP status: {}",
            self.body
        );
        assert!(
            self.body["code"].is_string(),
            "problem response requires a stable code: {}",
            self.body
        );
    }
}

#[derive(Clone)]
pub(crate) struct ApiTestApp {
    pub pool: PgPool,
    pub state: AppState,
    router: Router,
}

pub(crate) fn create_test_router(state: AppState) -> Router {
    create_app(state, EdgeHttpConfig::default())
}

impl ApiTestApp {
    pub(crate) async fn api_bytes(
        &self,
        method: Method,
        uri: &str,
        body: Vec<u8>,
        headers: HeaderMap,
    ) -> ApiTestResponse {
        let mut builder = Request::builder().method(method.clone()).uri(uri);
        for (name, value) in &headers {
            builder = builder.header(name, value);
        }
        let response = self
            .router
            .clone()
            .oneshot(
                builder
                    .body(Body::from(body))
                    .expect("API test request should build"),
            )
            .await
            .expect("API test request should resolve");
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("API response body should be readable");
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes) }))
        };
        let response = ApiTestResponse {
            status,
            headers,
            body,
            body_bytes: bytes.len(),
        };
        validate_openapi_response(&method, uri, &response);
        response
    }

    pub(crate) async fn api_json(
        &self,
        method: Method,
        uri: &str,
        payload: Option<Value>,
        mut headers: HeaderMap,
    ) -> ApiTestResponse {
        if method == Method::PATCH {
            headers.insert(
                CONTENT_TYPE,
                HeaderValue::from_static("application/merge-patch+json"),
            );
        }
        let mut builder = Request::builder().method(method.clone()).uri(uri);
        for (name, value) in &headers {
            builder = builder.header(name, value);
        }
        let body = payload
            .map(|value| Body::from(value.to_string()))
            .unwrap_or_else(Body::empty);
        let response = self
            .router
            .clone()
            .oneshot(builder.body(body).expect("API test request should build"))
            .await
            .expect("API test request should resolve");
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("API response body should read");
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes) }))
        };

        let response = ApiTestResponse {
            status,
            headers,
            body,
            body_bytes: bytes.len(),
        };
        validate_openapi_response(&method, uri, &response);
        response
    }

    pub(crate) async fn issue_session(
        &self,
        user_id: &str,
    ) -> crate::services::session::VerifiedSession {
        let client_id = format!("integration-test-{}", next_test_client_id());
        self.state
            .sessions
            .issue_session_for_tests(user_id, "desktop", Some(client_id.as_str()))
            .await
    }

    pub(crate) async fn post_public_json(
        &self,
        path: &str,
        payload: Value,
        headers: HeaderMap,
    ) -> ApiTestResponse {
        let mut builder = Request::builder().method("POST").uri(path);
        for (name, value) in &headers {
            builder = builder.header(name, value);
        }

        let response = self
            .router
            .clone()
            .oneshot(
                builder
                    .body(Body::from(payload.to_string()))
                    .expect("public test request should build"),
            )
            .await
            .expect("public test request should resolve");

        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("public response body should be readable");
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes) }))
        };

        ApiTestResponse {
            status,
            headers,
            body,
            body_bytes: bytes.len(),
        }
    }
}

fn validate_openapi_response(method: &Method, uri: &str, response: &ApiTestResponse) {
    static DOCUMENT: OnceLock<Value> = OnceLock::new();
    let document = DOCUMENT.get_or_init(|| {
        serde_json::from_str(crate::openapi_json().as_str())
            .expect("generated OpenAPI should be valid JSON")
    });
    let request_path = uri
        .split('?')
        .next()
        .expect("request URI should have a path");
    let Some((path_template, operation)) = matching_operation(document, method, request_path)
    else {
        return;
    };
    let status = response.status.as_u16().to_string();
    let responses = operation["responses"]
        .as_object()
        .expect("OpenAPI responses should be an object");
    let declared = responses
        .get(&status)
        .or_else(|| responses.get("default"))
        .unwrap_or_else(|| {
            panic!("{method} {path_template} does not declare response status {status}")
        });
    if matches!(
        response.status,
        StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE
    ) {
        let retry_after = response
            .headers
            .get("retry-after")
            .unwrap_or_else(|| {
                panic!("{method} {path_template} status {status} requires Retry-After")
            })
            .to_str()
            .expect("Retry-After should contain visible ASCII")
            .parse::<u32>()
            .expect("Retry-After should use delta-seconds");
        assert!(
            (1..=crate::http::api::error::MAX_RETRY_AFTER_SECONDS).contains(&retry_after),
            "{method} {path_template} status {status} Retry-After must be bounded"
        );
    }
    let content = declared.get("content").and_then(Value::as_object);
    if response.body.is_null() && content.is_none_or(serde_json::Map::is_empty) {
        return;
    }
    let actual_content_type = response
        .headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .expect("a response with a contract body requires Content-Type");
    let media = content
        .and_then(|content| content.get(actual_content_type))
        .unwrap_or_else(|| {
            panic!(
                "{method} {path_template} status {status} does not declare {actual_content_type}"
            )
        });
    if let Some(schema) = media.get("schema") {
        if let Err(error) = validate_schema(document, schema, &response.body, "$") {
            panic!("{method} {path_template} status {status} response violates OpenAPI: {error}");
        }
    }
    if let Some(headers) = declared.get("headers").and_then(Value::as_object) {
        for name in headers
            .keys()
            .filter(|name| name.as_str() != "Idempotency-Replayed")
        {
            let value = response.headers.get(name).unwrap_or_else(|| {
                panic!("{method} {path_template} status {status} requires response header {name}")
            });
            if let Some(schema) = headers[name].get("schema") {
                let value = Value::String(
                    value
                        .to_str()
                        .expect("contract response headers should be visible ASCII")
                        .to_string(),
                );
                if let Err(error) = validate_schema(document, schema, &value, name) {
                    panic!(
                        "{method} {path_template} status {status} header violates OpenAPI: {error}"
                    );
                }
            }
        }
    }
}

fn matching_operation<'a>(
    document: &'a Value,
    method: &Method,
    request_path: &str,
) -> Option<(&'a str, &'a Value)> {
    let method = method.as_str().to_ascii_lowercase();
    document["paths"]
        .as_object()?
        .iter()
        .filter(|(template, _)| path_matches(template, request_path))
        .filter_map(|(template, item)| {
            item.get(&method).map(|operation| {
                let literal_segments = template
                    .split('/')
                    .filter(|segment| !segment.starts_with('{'))
                    .count();
                (literal_segments, template.as_str(), operation)
            })
        })
        .max_by_key(|(literal_segments, _, _)| *literal_segments)
        .map(|(_, template, operation)| (template, operation))
}

fn path_matches(template: &str, request_path: &str) -> bool {
    let template = template.trim_matches('/').split('/').collect::<Vec<_>>();
    let request = request_path
        .trim_matches('/')
        .split('/')
        .collect::<Vec<_>>();
    template.len() == request.len()
        && template.iter().zip(request).all(|(expected, actual)| {
            (!actual.is_empty() && expected.starts_with('{') && expected.ends_with('}'))
                || *expected == actual
        })
}

fn validate_schema(
    document: &Value,
    schema: &Value,
    instance: &Value,
    pointer: &str,
) -> Result<(), String> {
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        let target = document
            .pointer(reference.strip_prefix('#').ok_or_else(|| {
                format!("{pointer}: external schema reference is unsupported: {reference}")
            })?)
            .ok_or_else(|| format!("{pointer}: unresolved schema reference {reference}"))?;
        return validate_schema(document, target, instance, pointer);
    }
    if let Some(options) = schema.get("oneOf").and_then(Value::as_array) {
        let matches = options
            .iter()
            .filter(|option| validate_schema(document, option, instance, pointer).is_ok())
            .count();
        if matches != 1 {
            return Err(format!(
                "{pointer}: expected exactly one oneOf schema, matched {matches}"
            ));
        }
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        if !values.contains(instance) {
            return Err(format!(
                "{pointer}: value {instance} is outside enum {values:?}"
            ));
        }
    }
    if let Some(schema_type) = schema.get("type") {
        let accepts = match schema_type {
            Value::String(kind) => instance_has_type(instance, kind),
            Value::Array(kinds) => kinds
                .iter()
                .filter_map(Value::as_str)
                .any(|kind| instance_has_type(instance, kind)),
            _ => true,
        };
        if !accepts {
            return Err(format!(
                "{pointer}: {instance} does not match type {schema_type}"
            ));
        }
    }
    if let Some(object) = instance.as_object() {
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            for name in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(name) {
                    return Err(format!("{pointer}: missing required property {name}"));
                }
            }
        }
        if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
            for (name, value) in object {
                if let Some(property_schema) = properties.get(name) {
                    validate_schema(
                        document,
                        property_schema,
                        value,
                        &format!("{pointer}/{name}"),
                    )?;
                } else if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
                    return Err(format!("{pointer}: unexpected property {name}"));
                } else if let Some(additional_schema) = schema
                    .get("additionalProperties")
                    .filter(|value| value.is_object())
                {
                    validate_schema(
                        document,
                        additional_schema,
                        value,
                        &format!("{pointer}/{name}"),
                    )?;
                }
            }
        }
    }
    if let Some(array) = instance.as_array() {
        if let Some(minimum) = schema.get("minItems").and_then(Value::as_u64) {
            if array.len() < minimum as usize {
                return Err(format!("{pointer}: array is shorter than {minimum}"));
            }
        }
        if let Some(maximum) = schema.get("maxItems").and_then(Value::as_u64) {
            if array.len() > maximum as usize {
                return Err(format!("{pointer}: array is longer than {maximum}"));
            }
        }
        if let Some(item_schema) = schema.get("items") {
            for (index, value) in array.iter().enumerate() {
                validate_schema(document, item_schema, value, &format!("{pointer}/{index}"))?;
            }
        }
    }
    if let Some(value) = instance.as_str() {
        if let Some(minimum) = schema.get("minLength").and_then(Value::as_u64) {
            if value.chars().count() < minimum as usize {
                return Err(format!("{pointer}: string is shorter than {minimum}"));
            }
        }
        if let Some(maximum) = schema.get("maxLength").and_then(Value::as_u64) {
            if value.chars().count() > maximum as usize {
                return Err(format!("{pointer}: string is longer than {maximum}"));
            }
        }
        if let Some(pattern) = schema.get("pattern").and_then(Value::as_str) {
            let pattern = regex::Regex::new(pattern)
                .map_err(|error| format!("{pointer}: invalid contract pattern: {error}"))?;
            if !pattern.is_match(value) {
                return Err(format!("{pointer}: string does not match {pattern}"));
            }
        }
    }
    if let Some(value) = instance.as_f64() {
        if let Some(minimum) = schema.get("minimum").and_then(Value::as_f64) {
            if value < minimum {
                return Err(format!("{pointer}: number is less than {minimum}"));
            }
        }
        if let Some(maximum) = schema.get("maximum").and_then(Value::as_f64) {
            if value > maximum {
                return Err(format!("{pointer}: number is greater than {maximum}"));
            }
        }
    }
    Ok(())
}

fn instance_has_type(instance: &Value, schema_type: &str) -> bool {
    match schema_type {
        "null" => instance.is_null(),
        "boolean" => instance.is_boolean(),
        "integer" => instance.as_i64().is_some() || instance.as_u64().is_some(),
        "number" => instance.is_number(),
        "string" => instance.is_string(),
        "array" => instance.is_array(),
        "object" => instance.is_object(),
        _ => true,
    }
}

fn next_test_client_id() -> u64 {
    static NEXT_CLIENT_ID: AtomicU64 = AtomicU64::new(1);
    NEXT_CLIENT_ID.fetch_add(1, Ordering::Relaxed)
}

pub(crate) fn authenticated_json_headers(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        "bittery-client-platform",
        HeaderValue::from_static("desktop"),
    );
    headers.insert(
        "bittery-client-id",
        HeaderValue::from_static("integration-test"),
    );
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}"))
            .expect("authorization header should be valid"),
    );
    headers
}

fn env_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

pub(crate) struct EnvLockGuard {
    _guard: tokio::sync::MutexGuard<'static, ()>,
}

pub(crate) fn acquire_env_lock() -> EnvLockGuard {
    static SYNC_RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    let runtime = SYNC_RT.get_or_init(|| {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("env lock runtime should build")
    });
    let guard = runtime.block_on(env_lock().lock());
    EnvLockGuard { _guard: guard }
}

pub(crate) async fn acquire_env_lock_async() -> EnvLockGuard {
    EnvLockGuard {
        _guard: env_lock().lock().await,
    }
}

/// Sets env vars for the duration of a test and restores them on drop, so an
/// assertion failure unwinding out of the test body cannot poison later tests.
pub(crate) struct EnvVarGuard {
    previous: Vec<(String, Option<String>)>,
}

impl EnvVarGuard {
    pub(crate) fn set(vars: &[(&str, &str)]) -> Self {
        let mut previous = Vec::new();
        for (key, value) in vars {
            previous.push(((*key).to_string(), std::env::var(key).ok()));
            unsafe { std::env::set_var(key, value) };
        }
        Self { previous }
    }

    pub(crate) fn remove(keys: &[&str]) -> Self {
        let previous = keys
            .iter()
            .map(|key| ((*key).to_string(), std::env::var(key).ok()))
            .collect();
        for key in keys {
            unsafe { std::env::remove_var(key) };
        }
        Self { previous }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        for (key, previous) in &self.previous {
            match previous {
                Some(value) => unsafe { std::env::set_var(key, value) },
                None => unsafe { std::env::remove_var(key) },
            }
        }
    }
}

pub(crate) async fn seed_user(pool: &PgPool, user_id: &str, name: &str, email: &str) {
    seed_user_with_kdf(pool, user_id, name, email, 600_000).await;
}

pub(crate) async fn seed_user_with_kdf(
    pool: &PgPool,
    user_id: &str,
    name: &str,
    email: &str,
    kdf_iterations: i32,
) {
    query(
		"INSERT INTO \"user\" (id, name, email, email_verified, secret_key_hint, encrypted_master_key, recovery_key_hint, srp_salt, srp_verifier, public_key, encrypted_private_key, kdf_algorithm, kdf_iterations, kdf_schema_version) VALUES ($1, $2, $3, true, NULL, NULL, NULL, $4, $5, $6, $7, 'pbkdf2-sha256', $8, 1)",
	)
	.bind(user_id)
	.bind(name)
	.bind(email)
	.bind("salt")
	.bind("verifier")
	.bind("public-key")
	.bind("encrypted-private-key")
	.bind(kdf_iterations)
	.execute(pool)
	.await
	.expect("user should seed");
}

pub(crate) async fn seed_team(
    pool: &PgPool,
    team_id: &str,
    name: &str,
    owner_user_id: &str,
    team_type: &str,
    billing_plan: &str,
    billing_status: &str,
) {
    query(
		"INSERT INTO team (id, name, owner_id, type, billing_plan, billing_status) VALUES ($1, $2, $3, $4::team_type, $5::billing_plan, $6::billing_status)",
	)
	.bind(team_id)
	.bind(name)
	.bind(owner_user_id)
	.bind(team_type)
	.bind(billing_plan)
	.bind(billing_status)
	.execute(pool)
	.await
	.expect("team should seed");
}

pub(crate) async fn assign_user_to_team(pool: &PgPool, user_id: &str, team_id: &str, role: &str) {
    query("UPDATE \"user\" SET team_id = $1, role = $2::team_role WHERE id = $3")
        .bind(team_id)
        .bind(role)
        .bind(user_id)
        .execute(pool)
        .await
        .expect("user team should update");
}

pub(crate) async fn seed_vault(
    pool: &PgPool,
    vault_id: &str,
    name: &str,
    vault_type: &str,
    created_by_id: &str,
    team_id: Option<&str>,
) {
    query(
		"INSERT INTO vault (id, name, type, created_by_id, team_id) VALUES ($1, $2, $3::vault_type, $4, $5)",
	)
	.bind(vault_id)
	.bind(name)
	.bind(vault_type)
	.bind(created_by_id)
	.bind(team_id)
	.execute(pool)
	.await
	.expect("vault should seed");
}

pub(crate) async fn seed_vault_key(
    pool: &PgPool,
    vault_key_id: &str,
    vault_id: &str,
    user_id: &str,
    encrypted_vault_key: &str,
    role: &str,
) {
    query(
		"INSERT INTO vault_key (id, vault_id, user_id, encrypted_vault_key, role) VALUES ($1, $2, $3, $4, $5::vault_role)",
	)
	.bind(vault_key_id)
	.bind(vault_id)
	.bind(user_id)
	.bind(encrypted_vault_key)
	.bind(role)
	.execute(pool)
	.await
	.expect("vault key should seed");
}

pub(crate) async fn seed_item(
    pool: &PgPool,
    item_id: &str,
    vault_id: &str,
    category: &str,
    encrypted_data: &str,
    encryption_iv: &str,
    last_modified_by: &str,
) {
    // A freshly seeded item sits at version 1, so its ciphertext is bound to encryption
    // version 1 and to the seeding user — the same context item creation writes in production.
    query(
		"INSERT INTO item (id, vault_id, category, encrypted_data, encryption_iv, last_modified_by, encryption_version, encrypted_by_user_id) VALUES ($1, $2, $3::item_category, $4, $5, $6, 1, $6)",
	)
	.bind(item_id)
	.bind(vault_id)
	.bind(category)
	.bind(encrypted_data)
	.bind(encryption_iv)
	.bind(last_modified_by)
	.execute(pool)
	.await
	.expect("item should seed");
}

/// Provision an empty test database WITHOUT running migrations.
///
/// Used by migration-level tests that need to apply the migration chain
/// manually (e.g. to reproduce a legacy row shape before a backfill migration).
pub(crate) async fn with_raw_test_db<T, F, Fut>(test_name: &str, test_fn: F) -> T
where
    F: FnOnce(PgPool) -> Fut,
    Fut: Future<Output = T>,
{
    let database = TestDatabase::create(test_name).await;
    let pool = db::connect(&database.database_url)
        .await
        .expect("test database should connect");

    let result = std::panic::AssertUnwindSafe(test_fn(pool))
        .catch_unwind()
        .await;

    database.cleanup().await;

    match result {
        Ok(result) => result,
        Err(panic_payload) => std::panic::resume_unwind(panic_payload),
    }
}

pub(crate) async fn with_api_test_app<T, F, Fut>(test_name: &str, test_fn: F) -> T
where
    F: FnOnce(ApiTestApp) -> Fut,
    Fut: Future<Output = T>,
{
    let database = TestDatabase::create(test_name).await;
    let pool = db::connect(&database.database_url)
        .await
        .expect("test database should connect");
    db::run_migrations(&pool)
        .await
        .expect("test database migrations should run");

    let state = AppState::from_pool(pool.clone()).with_object_storage(
        crate::integrations::storage::object_storage_from_env()
            .expect("test storage configuration should be complete"),
    );
    let router = create_test_router(state.clone());

    let result = std::panic::AssertUnwindSafe(test_fn(ApiTestApp {
        pool,
        state,
        router,
    }))
    .catch_unwind()
    .await;

    database.cleanup().await;

    match result {
        Ok(result) => result,
        Err(panic_payload) => std::panic::resume_unwind(panic_payload),
    }
}

struct TestDatabase {
    admin_database_url: String,
    database_url: String,
    name: String,
}

impl TestDatabase {
    async fn create(test_name: &str) -> Self {
        load_dotenv_once();
        let base_database_url = std::env::var("DATABASE_URL")
            .expect("DATABASE_URL must be set to run server integration tests");
        let admin_database_url = admin_database_url(&base_database_url);
        let name = next_database_name(test_name);
        let database_url = database_url_for_name(&base_database_url, &name);
        let admin_pool = db::connect(&admin_database_url)
            .await
            .expect("admin database should connect");

        query(&format!("CREATE DATABASE {name}"))
            .execute(&admin_pool)
            .await
            .expect("test database should be created");

        Self {
            admin_database_url,
            database_url,
            name,
        }
    }

    async fn cleanup(self) {
        let admin_pool = db::connect(&self.admin_database_url)
            .await
            .expect("admin database should reconnect for cleanup");

        query(
			"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
		)
		.bind(&self.name)
		.execute(&admin_pool)
		.await
		.expect("test database connections should terminate");

        query(&format!("DROP DATABASE IF EXISTS {}", self.name))
            .execute(&admin_pool)
            .await
            .expect("test database should drop");
    }
}

fn admin_database_url(database_url: &str) -> String {
    let mut url = Url::parse(database_url).expect("DATABASE_URL should be a valid URL");
    url.set_path("/postgres");
    url.to_string()
}

fn database_url_for_name(database_url: &str, name: &str) -> String {
    let mut url = Url::parse(database_url).expect("DATABASE_URL should be a valid URL");
    url.set_path(&format!("/{name}"));
    url.to_string()
}

fn sanitize_test_name(test_name: &str) -> String {
    test_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect()
}

fn next_database_name(test_name: &str) -> String {
    let sanitized = sanitize_test_name(test_name);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time should be after unix epoch")
        .as_millis();
    let sequence = next_test_database_sequence();
    let suffix = format!("_{millis:x}_{sequence:x}");
    let available_name_len =
        MAX_POSTGRES_IDENTIFIER_LEN.saturating_sub(DATABASE_PREFIX.len() + suffix.len());
    let truncated = sanitized
        .chars()
        .take(available_name_len)
        .collect::<String>();
    format!("{DATABASE_PREFIX}{truncated}{suffix}")
}

fn next_test_database_sequence() -> u64 {
    static NEXT_DATABASE_SEQUENCE: AtomicU64 = AtomicU64::new(1);
    NEXT_DATABASE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use std::panic::AssertUnwindSafe;

    use futures_util::FutureExt;
    use rand::random;
    use sqlx::query_scalar;

    use super::*;

    #[test]
    fn openapi_path_matching_requires_real_nonempty_path_segments() {
        assert!(path_matches(
            "/api/v1/vaults/{vaultId}/items/{itemId}",
            "/api/v1/vaults/vault_fixture/items/item_fixture"
        ));
        assert!(!path_matches(
            "/api/v1/vaults/{vaultId}/items/{itemId}",
            "/api/v1/vaults//items/item_fixture"
        ));
        assert!(!path_matches(
            "/api/v1/vaults/{vaultId}/items/{itemId}",
            "/api/v1/vaults/vault_fixture/items"
        ));
    }

    #[test]
    fn response_schema_validation_resolves_refs_and_required_properties() {
        let document = json!({
            "components": { "schemas": {
                "Response": {
                    "type": "object",
                    "required": ["id"],
                    "properties": { "id": { "type": "string", "minLength": 1 } },
                    "additionalProperties": false
                }
            }}
        });
        let schema = json!({ "$ref": "#/components/schemas/Response" });

        assert!(validate_schema(&document, &schema, &json!({ "id": "item_1" }), "$").is_ok());
        assert!(validate_schema(&document, &schema, &json!({}), "$").is_err());
        assert!(validate_schema(
            &document,
            &schema,
            &json!({ "id": "item_1", "unknown": true }),
            "$"
        )
        .is_err());
    }

    #[test]
    fn response_schema_validation_keeps_one_of_exclusive() {
        let document = json!({});
        let schema = json!({
            "oneOf": [
                { "type": "object" },
                { "type": "object" }
            ]
        });

        assert!(validate_schema(&document, &schema, &json!({}), "$").is_err());
    }

    #[tokio::test]
    async fn with_api_test_app_drops_database_after_panic() {
        let test_name = format!("cleanup_after_panic_{:016x}", random::<u64>());
        let database_name_like = format!("{}{test_name}%", DATABASE_PREFIX);

        assert_eq!(count_test_databases_matching(&database_name_like).await, 0);

        let panic_result = AssertUnwindSafe(with_api_test_app(&test_name, |_app| async move {
            panic!("intentional panic to verify cleanup");
        }))
        .catch_unwind()
        .await;

        assert!(panic_result.is_err());
        assert_eq!(count_test_databases_matching(&database_name_like).await, 0);
    }

    async fn count_test_databases_matching(pattern: &str) -> i64 {
        load_dotenv_once();
        let base_database_url = std::env::var("DATABASE_URL")
            .expect("DATABASE_URL must be set to run server integration tests");
        let admin_pool = db::connect(&admin_database_url(&base_database_url))
            .await
            .expect("admin database should connect");

        query_scalar::<_, i64>("SELECT COUNT(*)::BIGINT FROM pg_database WHERE datname LIKE $1")
            .bind(pattern)
            .fetch_one(&admin_pool)
            .await
            .expect("test databases should count")
    }
}
