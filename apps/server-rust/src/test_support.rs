use std::{
    future::Future,
    sync::atomic::{AtomicU64, Ordering},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    body::{to_bytes, Body},
    http::{
        header::{AUTHORIZATION, CONTENT_TYPE},
        HeaderMap, HeaderValue, Request, StatusCode,
    },
    middleware, Router,
};
use serde_json::{json, Value};
use sqlx::{query, PgPool};
use tower::util::ServiceExt;
use url::Url;

use crate::{
    create_rpc_router, db, rpc_request_context_middleware, rpc_request_guard_middleware, AppState,
};

pub(crate) struct RpcTestResponse {
    pub status: StatusCode,
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
    pub(crate) async fn issue_session(&self, user_id: &str) -> crate::auth::VerifiedSession {
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

pub(crate) fn acquire_env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) async fn seed_user(pool: &PgPool, user_id: &str, name: &str, email: &str) {
    query(
		"INSERT INTO \"user\" (id, name, email, email_verified, secret_key_hint, encrypted_master_key, recovery_key_hint, srp_salt, srp_verifier, public_key, encrypted_private_key) VALUES ($1, $2, $3, true, NULL, NULL, NULL, $4, $5, $6, $7)",
	)
	.bind(user_id)
	.bind(name)
	.bind(email)
	.bind("salt")
	.bind("verifier")
	.bind("public-key")
	.bind("encrypted-private-key")
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
    let router = Router::new()
        .nest_service("/rpc", qubit_service)
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            rpc_request_context_middleware,
        ))
        .layer(middleware::from_fn(rpc_request_guard_middleware));

    let result = test_fn(RpcTestApp {
        pool,
        state,
        router,
    })
    .await;

    database.cleanup().await;
    result
}

struct TestDatabase {
    admin_database_url: String,
    database_url: String,
    name: String,
}

impl TestDatabase {
    async fn create(test_name: &str) -> Self {
        dotenvy::dotenv().ok();
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

fn next_database_name(test_name: &str) -> String {
    const DATABASE_PREFIX: &str = "bittery_test_";
    const MAX_POSTGRES_IDENTIFIER_LEN: usize = 63;

    let sanitized = test_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect::<String>();
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
