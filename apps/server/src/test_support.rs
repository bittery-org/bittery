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
        HeaderMap, HeaderValue, Request, StatusCode,
    },
    middleware, Router,
};
use futures_util::FutureExt;
use serde_json::{json, Value};
use sqlx::{query, PgPool};
use tower::util::ServiceExt;
use url::Url;

use crate::{
    create_public_http_router, create_rpc_router, db, rpc_request_context_middleware,
    rpc_request_guard_middleware, rpc_tracing_middleware, AppState,
};

const DATABASE_PREFIX: &str = "bittery_test_";
const MAX_POSTGRES_IDENTIFIER_LEN: usize = 63;

pub(crate) struct RpcTestResponse {
    pub status: StatusCode,
    #[allow(dead_code)]
    pub headers: HeaderMap,
    pub body: Value,
}

#[derive(Clone)]
pub(crate) struct RpcTestApp {
    pub pool: PgPool,
    pub state: AppState,
    router: Router,
}

impl RpcTestApp {
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

    pub(crate) async fn rpc_call(
        &self,
        method: &str,
        params: Value,
        headers: HeaderMap,
    ) -> RpcTestResponse {
        self.post_rpc_json(
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": method,
                "params": params,
            }),
            headers,
        )
        .await
    }

    pub(crate) async fn post_rpc_json(
        &self,
        payload: Value,
        headers: HeaderMap,
    ) -> RpcTestResponse {
        self.post_rpc_bytes(payload.to_string().into_bytes(), headers)
            .await
    }

    pub(crate) async fn post_rpc_bytes(
        &self,
        body: Vec<u8>,
        headers: HeaderMap,
    ) -> RpcTestResponse {
        let mut builder = Request::builder().method("POST").uri("/rpc");
        for (name, value) in &headers {
            builder = builder.header(name, value);
        }

        let response = self
            .router
            .clone()
            .oneshot(
                builder
                    .body(Body::from(body))
                    .expect("RPC test request should build"),
            )
            .await
            .expect("RPC test request should resolve");

        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("RPC response body should be readable");
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes) }))
        };

        RpcTestResponse {
            status,
            headers,
            body,
        }
    }

    pub(crate) async fn post_public_json(
        &self,
        path: &str,
        payload: Value,
        headers: HeaderMap,
    ) -> RpcTestResponse {
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

        RpcTestResponse {
            status,
            headers,
            body,
        }
    }
}

fn next_test_client_id() -> u64 {
    static NEXT_CLIENT_ID: AtomicU64 = AtomicU64::new(1);
    NEXT_CLIENT_ID.fetch_add(1, Ordering::Relaxed)
}

pub(crate) fn authenticated_json_headers(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert("x-app-platform", HeaderValue::from_static("desktop"));
    headers.insert("x-client-id", HeaderValue::from_static("integration-test"));
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
    seed_user_with_kdf(pool, user_id, name, email, 310_000).await;
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
    query(
		"INSERT INTO item (id, vault_id, category, encrypted_data, encryption_iv, last_modified_by) VALUES ($1, $2, $3::item_category, $4, $5, $6)",
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

pub(crate) async fn with_rpc_test_app<T, F, Fut>(test_name: &str, test_fn: F) -> T
where
    F: FnOnce(RpcTestApp) -> Fut,
    Fut: Future<Output = T>,
{
    let database = TestDatabase::create(test_name).await;
    let pool = db::connect(&database.database_url)
        .await
        .expect("test database should connect");
    db::run_migrations(&pool)
        .await
        .expect("test database migrations should run");

    let state = AppState::from_pool(pool.clone());
    let (qubit_service, _server_handle) = create_rpc_router().to_service(state.clone());
    let public_routes = create_public_http_router().with_state(state.clone());
    let rpc_routes = Router::new()
        .nest_service("/rpc", qubit_service)
        .route_layer(middleware::from_fn(rpc_tracing_middleware))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            rpc_request_context_middleware,
        ))
        .layer(middleware::from_fn(rpc_request_guard_middleware));
    let router = Router::new().merge(public_routes).merge(rpc_routes);

    let result = std::panic::AssertUnwindSafe(test_fn(RpcTestApp {
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

    #[tokio::test]
    async fn with_rpc_test_app_drops_database_after_panic() {
        let test_name = format!("cleanup_after_panic_{:016x}", random::<u64>());
        let database_name_like = format!("{}{test_name}%", DATABASE_PREFIX);

        assert_eq!(count_test_databases_matching(&database_name_like).await, 0);

        let panic_result = AssertUnwindSafe(with_rpc_test_app(&test_name, |_app| async move {
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
