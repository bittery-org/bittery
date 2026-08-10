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
use sqlx::{query, query_scalar, PgPool};
use tower::util::ServiceExt;
use url::Url;

use crate::{create_app, db, AppState, EdgeHttpConfig};

const DATABASE_PREFIX: &str = "bittery_test_";
const MAX_POSTGRES_IDENTIFIER_LEN: usize = 63;

pub(crate) struct ApiTestResponse {
    pub status: StatusCode,
    #[allow(dead_code)]
    pub headers: HeaderMap,
    pub body: Value,
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
        let mut builder = Request::builder().method(method).uri(uri);
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
        ApiTestResponse {
            status,
            headers,
            body,
        }
    }

    pub(crate) async fn api_json(
        &self,
        method: Method,
        uri: &str,
        payload: Option<Value>,
        headers: HeaderMap,
    ) -> ApiTestResponse {
        let mut builder = Request::builder().method(method).uri(uri);
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

        ApiTestResponse {
            status,
            headers,
            body,
        }
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

    pub(crate) async fn call_operation(
        &self,
        operation: &str,
        params: Value,
        mut headers: HeaderMap,
    ) -> ApiTestResponse {
        let operation_id = rest_operation_id(operation)
            .unwrap_or_else(|| panic!("{operation} was deliberately removed from the API"));
        let (method, path_template) = openapi_operation(operation_id);
        let mut body = params
            .as_array()
            .and_then(|values| values.first())
            .cloned()
            .unwrap_or_else(|| json!({}));
        let object = body
            .as_object_mut()
            .expect("named API operation parameters should be an object");
        let item_id = object
            .get("itemId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let mut path = path_template;
        while let Some(start) = path.find('{') {
            let end = path[start..]
                .find('}')
                .map(|offset| start + offset)
                .expect("OpenAPI path parameter should close");
            let name = &path[start + 1..end];
            let value = object
                .remove(name)
                .or_else(|| path_parameter_alias(name, object))
                .unwrap_or_else(|| panic!("{operation} requires path parameter {name}"));
            let value = value
                .as_str()
                .unwrap_or_else(|| panic!("{name} should be a string path parameter"));
            path.replace_range(start..=end, value);
        }

        if let Some(version) = object
            .remove("expectedVersion")
            .and_then(|value| value.as_i64())
        {
            headers.insert(
                "if-match",
                HeaderValue::from_str(&format!("\"{version}\""))
                    .expect("version ETag should be valid"),
            );
        } else if matches!(
            operation,
            "vault.toggleFavorite"
                | "vault.deleteItem"
                | "vault.restoreItem"
                | "vault.moveItem"
                | "vault.permanentlyDeleteItem"
        ) {
            if let Some(item_id) = item_id {
                if let Ok(version) =
                    query_scalar::<_, i32>("SELECT version FROM item WHERE id = $1")
                        .bind(item_id)
                        .fetch_one(&self.pool)
                        .await
                {
                    headers.insert(
                        "if-match",
                        HeaderValue::from_str(&format!("\"{version}\""))
                            .expect("version ETag should be valid"),
                    );
                }
            }
        }

        let payload = if method == Method::GET {
            path.push_str(&query_string(object));
            None
        } else if object.is_empty() {
            None
        } else {
            Some(body)
        };
        let response = self.api_json(method, &path, payload, headers).await;
        let normalized = if response.status.is_success() {
            let mut response_body = response.body;
            if operation == "auth.registrationStatus" {
                response_body = response_body["registration"].clone();
            }
            normalize_decimal_fields(&mut response_body);
            json!({ "result": { "Ok": response_body } })
        } else {
            let code = response.body["code"]
                .as_str()
                .unwrap_or("INTERNAL_SERVER_ERROR");
            let code = match code {
                "INTERNAL_ERROR" => "INTERNAL_SERVER_ERROR",
                "INVALID_REQUEST" | "INVALID_QUERY" => "BAD_REQUEST",
                "RATE_LIMITED" => "TOO_MANY_REQUESTS",
                code => code,
            };
            let mut message = response.body["detail"]
                .as_str()
                .or_else(|| response.body["title"].as_str())
                .map(str::to_string)
                .unwrap_or_else(|| format!("HTTP {}: {}", response.status, response.body));
            if message == "A valid bearer session is required." {
                message = "Authentication required".to_string();
            }
            json!({
                "result": { "Err": { "code": code, "message": &message } },
                "error": { "message": message, "data": { "code": code } }
            })
        };

        ApiTestResponse {
            status: StatusCode::OK,
            headers: response.headers,
            body: normalized,
        }
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
        }
    }
}

fn rest_operation_id(name: &str) -> Option<&'static str> {
    Some(match name {
        "audit.teamEvents" => "listAuditEvents",
        "auth.changePassword" => "change_password",
        "auth.checkEmail" => "check_email",
        "auth.deleteAccount" => "delete_account",
        "auth.finishLogin" => "finish_login",
        "auth.getRecoveryData" => "recovery_data",
        "auth.listDevices" => "list_sessions",
        "auth.me" => "me",
        "auth.refreshSession" => "refresh_session",
        "auth.regenerateSecretKey" => "regenerate_secret_key",
        "auth.registrationStatus" => "getApiMetadata",
        "auth.renameDevice" => "rename_session",
        "auth.requestRecoveryVerification" => "request_recovery_verification",
        "auth.requestSignupVerification" => "request_signup_verification",
        "auth.resetPassword" => "reset_password",
        "auth.revokeDevice" => "revoke_session",
        "auth.signup" | "auth.signupWithInvitation" => "signup",
        "auth.startLogin" => "start_login",
        "auth.storeRecoveryKey" => "store_recovery_key",
        "auth.updateEmail" => "update_email",
        "auth.verifyRecoveryCode" => "verify_recovery",
        "auth.verifySignupVerification" => "verify_signup_verification",
        "billing.attachmentUsage" => "getAttachmentUsage",
        "billing.createCheckoutSession" => "createBillingCheckoutSession",
        "billing.createPortalSession" => "createBillingPortalSession",
        "billing.entitlements" => "getBillingEntitlements",
        "billing.previewAdditionalTeamSeat" => "previewAdditionalTeamSeat",
        "billing.status" => "getBillingStatus",
        "share.accessPublic" => "accessPublicShare",
        "share.create" => "createShareLink",
        "share.getAccessLogs" => "listShareAccessLogs",
        "share.getPublicInfo" => "getPublicShareInfo",
        "share.listByItem" => "listItemShareLinks",
        "share.requestEmailVerification" => "requestShareEmailVerification",
        "share.revoke" => "revokeShareLink",
        "share.verifyEmailAndAccess" => "verifyShareEmailAndAccess",
        "sync.bootstrapItems" => "bootstrapSync",
        "sync.getEventsSince" => "getSyncChanges",
        "team.create" => "createTeam",
        "team.createImageUpload" => "createTeamImageUpload",
        "team.delete" => "deleteTeam",
        "team.get" => "getTeam",
        "team.getLeaveRotationData" => "getTeamLeaveRotationData",
        "team.invitations.accept" => "acceptTeamInvitation",
        "team.invitations.acceptById" => "acceptTeamInvitationById",
        "team.invitations.cancel" => "cancelTeamInvitation",
        "team.invitations.decline" => "declineTeamInvitation",
        "team.invitations.declineById" => "declineTeamInvitationById",
        "team.invitations.getByToken" => "getTeamInvitation",
        "team.invitations.list" => "listTeamInvitations",
        "team.invitations.pending" => "listMyTeamInvitations",
        "team.invitations.resend" => "resendTeamInvitation",
        "team.invitations.send" => "sendTeamInvitation",
        "team.leave" => "leaveTeam",
        "team.list" => "getCurrentTeam",
        "team.members.getTeamRotationData" => "getTeamMemberRemovalRotationData",
        "team.members.list" => "listTeamMembers",
        "team.members.remove" => "removeTeamMember",
        "team.update" => "updateTeam",
        "team.vaults" => "listTeamVaults",
        "vault.bulkImportItems" => "bulkImportItems",
        "vault.convertType" => "convertVaultType",
        "vault.create" => "createVault",
        "vault.createAttachment" => "createAttachment",
        "vault.createAttachmentUpload" => "createAttachmentUpload",
        "vault.createImageUpload" => "createVaultImageUpload",
        "vault.createItem" => "createItem",
        "vault.delete" => "deleteVault",
        "vault.deleteAttachment" => "deleteAttachment",
        "vault.deleteItem" => "trashItem",
        "vault.get" => "getVault",
        "vault.getAttachmentDownloadUrl" => "createAttachmentDownloadUrl",
        "vault.getItem" => "getItem",
        "vault.list" => "listVaults",
        "vault.listAllDeletedItems" => "listAllTrashedItems",
        "vault.listAllItems" => "listAllItems",
        "vault.listAttachments" => "listAttachments",
        "vault.listDeletedItems" => "listTrashedVaultItems",
        "vault.listItems" => "listVaultItems",
        "vault.members.add" => "addVaultMember",
        "vault.members.availableTeamMembers" => "listAvailableTeamMembers",
        "vault.members.getRotationData" => "getVaultMemberRemovalRotationData",
        "vault.members.list" => "listVaultMembers",
        "vault.members.remove" => "removeVaultMember",
        "vault.members.updateRole" => "updateVaultMemberRole",
        "vault.moveItem" => "moveItem",
        "vault.permanentlyDeleteItem" => "permanentlyDeleteItem",
        "vault.restoreItem" => "restoreItem",
        "vault.stats" => "getVaultStats",
        "vault.toggleFavorite" => "setItemFavorite",
        "vault.update" => "updateVault",
        "vault.updateAttachment" => "updateAttachment",
        "vault.updateItem" => "updateItem",
        _ => return None,
    })
}

fn openapi_operation(operation_id: &str) -> (Method, String) {
    let document: Value = serde_json::from_str(crate::openapi_json().as_str())
        .expect("generated OpenAPI should be valid JSON");
    for (path, methods) in document["paths"]
        .as_object()
        .expect("OpenAPI paths should be an object")
    {
        for (method, operation) in methods
            .as_object()
            .expect("OpenAPI path item should be an object")
        {
            if operation["operationId"] == operation_id {
                return (
                    Method::from_bytes(method.to_ascii_uppercase().as_bytes())
                        .expect("OpenAPI method should be valid"),
                    path.clone(),
                );
            }
        }
    }
    panic!("OpenAPI operation {operation_id} should exist");
}

fn path_parameter_alias(name: &str, object: &mut serde_json::Map<String, Value>) -> Option<Value> {
    let alias = match name {
        "attachmentId" | "invitationId" | "itemId" | "linkId" | "sessionId" | "teamId"
        | "userId" | "vaultId" => "id",
        _ => return None,
    };
    object.remove(alias)
}

fn query_string(object: &serde_json::Map<String, Value>) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (name, value) in object {
        match value {
            Value::Null => {}
            Value::Array(values) => {
                for value in values {
                    serializer.append_pair(name, value.as_str().unwrap_or(&value.to_string()));
                }
            }
            Value::String(value) => {
                serializer.append_pair(name, value);
            }
            value => {
                serializer.append_pair(name, &value.to_string());
            }
        }
    }
    let query = serializer.finish();
    if query.is_empty() {
        query
    } else {
        format!("?{query}")
    }
}

fn normalize_decimal_fields(value: &mut Value) {
    match value {
        Value::Array(values) => values.iter_mut().for_each(normalize_decimal_fields),
        Value::Object(values) => {
            for (name, value) in values {
                normalize_decimal_fields(value);
                let numeric_field = name.ends_with("Count")
                    || name.ends_with("Bytes")
                    || matches!(name.as_str(), "fileSize" | "storageUsed" | "storageLimit");
                if numeric_field {
                    if let Some(number) = value.as_str().and_then(|text| text.parse::<u64>().ok()) {
                        *value = json!(number);
                    }
                }
            }
        }
        _ => {}
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

    let state = AppState::from_pool(pool.clone());
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
