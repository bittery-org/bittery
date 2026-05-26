use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, RwLock,
    },
};

use base64::Engine;
use rand::{random, RngCore};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{query, query_as, query_scalar, PgPool};
use std::sync::LazyLock;
use time::{format_description::well_known::Rfc3339, Duration, OffsetDateTime};
use ts_rs::TS;

use crate::{
    db::{self, models::*},
    error::AppError,
};

#[derive(Clone, Debug, Default)]
pub struct RequestMetadata {
    pub auth_token: Option<String>,
    pub client_id: Option<String>,
    pub app_platform: Option<String>,
    pub user_agent: Option<String>,
    pub ip_address: Option<String>,
}

#[derive(Clone, Debug)]
pub struct VerifiedSession {
    pub token: String,
    pub session_id: String,
    pub user_id: String,
    pub expires_at: OffsetDateTime,
    pub platform: String,
    pub client_id: Option<String>,
}

#[derive(Clone, Debug)]
struct SessionRecord {
    token: String,
    session_id: String,
    user_id: String,
    expires_at: OffsetDateTime,
    created_at: OffsetDateTime,
    last_active_at: OffsetDateTime,
    platform: String,
    client_id: Option<String>,
    device_name: Option<String>,
    ip_address: Option<String>,
    browser_name: Option<String>,
    browser_version: Option<String>,
    os_name: Option<String>,
    os_version: Option<String>,
}

#[derive(Clone)]
pub struct SessionService {
    backend: SessionBackend,
}

#[derive(Clone)]
enum SessionBackend {
    Memory(Arc<SessionServiceInner>),
    Postgres(PostgresSessionStore),
}

struct SessionServiceInner {
    sessions_by_token: RwLock<HashMap<String, SessionRecord>>,
    next_id: AtomicU64,
    seeded_session: SeededSession,
}

#[derive(Clone)]
struct PostgresSessionStore {
    pool: PgPool,
}

#[derive(Clone, Debug)]
pub struct SeededSession {
    pub token: String,
    pub session_id: String,
    pub user_id: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RefreshSessionResponse {
    pub token: String,
    pub session_id: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSessionResponse {
    pub id: String,
    pub device_name: Option<String>,
    pub platform: String,
    pub browser_name: Option<String>,
    pub browser_version: Option<String>,
    pub os_name: Option<String>,
    pub os_version: Option<String>,
    pub ip_address: Option<String>,
    pub last_active_at: String,
    pub created_at: String,
    pub is_current_session: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdInput {
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RenameDeviceInput {
    pub session_id: String,
    pub device_name: String,
}


#[derive(Clone, Debug)]
pub(crate) struct SessionSnapshot {
    pub(crate) id: String,
    pub(crate) user_id: String,
    pub(crate) expires_at: OffsetDateTime,
    pub(crate) created_at: OffsetDateTime,
    pub(crate) last_active_at: OffsetDateTime,
    pub(crate) platform: String,
    pub(crate) client_id: Option<String>,
    pub(crate) device_name: Option<String>,
    pub(crate) ip_address: Option<String>,
    pub(crate) browser_name: Option<String>,
    pub(crate) browser_version: Option<String>,
    pub(crate) os_name: Option<String>,
    pub(crate) os_version: Option<String>,
}


#[derive(Debug, Clone)]
pub(crate) struct CreatedSession {
    pub(crate) token: String,
    pub(crate) session_id: String,
    pub(crate) expires_at: OffsetDateTime,
}


impl SessionService {
    pub async fn from_database_url(database_url: &str) -> Result<Self, sqlx::Error> {
        let pool = db::connect(database_url).await?;
        Ok(Self::from_pool(pool))
    }

    pub fn from_pool(pool: PgPool) -> Self {
        Self {
            backend: SessionBackend::Postgres(PostgresSessionStore { pool }),
        }
    }

    pub fn with_dev_seed() -> Self {
        let initial_expiry = now_utc() + session_duration_for_platform("desktop");
        let issued_at = now_utc();
        let seeded_record = SessionRecord {
            token: "dev-session-token".to_string(),
            session_id: "dev-session-1".to_string(),
            user_id: "dev-user".to_string(),
            expires_at: initial_expiry,
            created_at: issued_at,
            last_active_at: issued_at,
            platform: "desktop".to_string(),
            client_id: None,
            device_name: Some("Development Device".to_string()),
            ip_address: None,
            browser_name: None,
            browser_version: None,
            os_name: None,
            os_version: None,
        };
        let seeded_session = SeededSession {
            token: seeded_record.token.clone(),
            session_id: seeded_record.session_id.clone(),
            user_id: seeded_record.user_id.clone(),
            expires_at: format_rfc3339(seeded_record.expires_at),
        };

        let mut sessions_by_token = HashMap::new();
        sessions_by_token.insert(seeded_record.token.clone(), seeded_record);

        Self {
            backend: SessionBackend::Memory(Arc::new(SessionServiceInner {
                sessions_by_token: RwLock::new(sessions_by_token),
                next_id: AtomicU64::new(2),
                seeded_session,
            })),
        }
    }

    pub fn seeded_session(&self) -> Option<SeededSession> {
        match &self.backend {
            SessionBackend::Memory(inner) => Some(inner.seeded_session.clone()),
            SessionBackend::Postgres(_) => None,
        }
    }

    pub async fn verify_token(&self, token: &str) -> Option<VerifiedSession> {
        match &self.backend {
            SessionBackend::Memory(inner) => verify_memory_token(inner, token),
            SessionBackend::Postgres(store) => store.verify_token(token).await,
        }
    }

    pub async fn refresh_session(
        &self,
        current_session: &VerifiedSession,
    ) -> Result<RefreshSessionResponse, AppError> {
        match &self.backend {
            SessionBackend::Memory(inner) => refresh_memory_session(inner, current_session),
            SessionBackend::Postgres(store) => store.refresh_session(current_session).await,
        }
    }

    pub async fn delete_session(&self, session_id: &str) -> Result<Vec<String>, AppError> {
        match &self.backend {
            SessionBackend::Memory(inner) => Ok(delete_memory_session(inner, session_id)),
            SessionBackend::Postgres(store) => store.delete_session(session_id).await,
        }
    }

    pub async fn delete_all_user_sessions(
        &self,
        user_id: &str,
    ) -> Result<Vec<String>, AppError> {
        match &self.backend {
            SessionBackend::Memory(inner) => Ok(delete_all_memory_sessions(inner, user_id)),
            SessionBackend::Postgres(store) => store.delete_all_user_sessions(user_id).await,
        }
    }

    pub async fn delete_other_user_sessions(
        &self,
        user_id: &str,
        current_session_id: &str,
    ) -> Result<Vec<String>, AppError> {
        match &self.backend {
            SessionBackend::Memory(inner) => Ok(delete_other_memory_sessions(
                inner,
                user_id,
                current_session_id,
            )),
            SessionBackend::Postgres(store) => {
                store
                    .delete_other_user_sessions(user_id, current_session_id)
                    .await
            }
        }
    }

    pub async fn list_devices(
        &self,
        user_id: &str,
        current_session_id: &str,
    ) -> Result<Vec<DeviceSessionResponse>, AppError> {
        match &self.backend {
            SessionBackend::Memory(inner) => {
                Ok(list_memory_devices(inner, user_id, current_session_id))
            }
            SessionBackend::Postgres(store) => {
                store.list_devices(user_id, current_session_id).await
            }
        }
    }

    pub(crate) async fn get_owned_session(
        &self,
        session_id: &str,
        user_id: &str,
    ) -> Result<Option<SessionSnapshot>, AppError> {
        match &self.backend {
            SessionBackend::Memory(inner) => {
                Ok(get_owned_memory_session(inner, session_id, user_id))
            }
            SessionBackend::Postgres(store) => store.get_owned_session(session_id, user_id).await,
        }
    }

    pub async fn revoke_device(
        &self,
        session_id: &str,
        user_id: &str,
    ) -> Result<Vec<String>, AppError> {
        match &self.backend {
            SessionBackend::Memory(inner) => Ok(revoke_memory_device(inner, session_id, user_id)),
            SessionBackend::Postgres(store) => store.revoke_device(session_id, user_id).await,
        }
    }

    pub async fn rename_device(
        &self,
        session_id: &str,
        user_id: &str,
        device_name: &str,
    ) -> Result<(), AppError> {
        match &self.backend {
            SessionBackend::Memory(inner) => {
                rename_memory_device(inner, session_id, user_id, device_name);
                Ok(())
            }
            SessionBackend::Postgres(store) => {
                store.rename_device(session_id, user_id, device_name).await
            }
        }
    }

    pub async fn heartbeat(&self, session_id: &str) -> Result<(), AppError> {
        match &self.backend {
            SessionBackend::Memory(inner) => {
                touch_memory_session(inner, session_id);
                Ok(())
            }
            SessionBackend::Postgres(store) => store.heartbeat(session_id).await,
        }
    }

    pub async fn create_session(
        &self,
        user_id: &str,
        request: &RequestMetadata,
    ) -> Result<CreatedSession, AppError> {
        match &self.backend {
            SessionBackend::Memory(inner) => Ok(issue_memory_session(inner, user_id, request)),
            SessionBackend::Postgres(store) => store.create_session(user_id, request).await,
        }
    }

    #[cfg(test)]
    pub(crate) async fn issue_session_for_tests(
        &self,
        user_id: &str,
        platform: &str,
        client_id: Option<&str>,
    ) -> VerifiedSession {
        match &self.backend {
            SessionBackend::Memory(inner) => {
                issue_memory_session_for_tests(inner, user_id, platform, client_id)
            }
            SessionBackend::Postgres(store) => {
                let request = RequestMetadata {
                    auth_token: None,
                    client_id: client_id.map(ToOwned::to_owned),
                    app_platform: Some(platform.to_string()),
                    user_agent: Some("integration-test".to_string()),
                    ip_address: Some("127.0.0.1".to_string()),
                };
                let created = store
                    .create_session(user_id, &request)
                    .await
                    .expect("test session issuance should succeed");
                store
                    .verify_token(&created.token)
                    .await
                    .expect("created test session should verify")
            }
        }
    }
}


impl Default for SessionService {
    fn default() -> Self {
        Self::with_dev_seed()
    }
}


impl PostgresSessionStore {
    async fn create_session(
        &self,
        user_id: &str,
        request: &RequestMetadata,
    ) -> Result<CreatedSession, AppError> {
        let platform = normalize_session_platform(request.app_platform.as_deref());
        let client_id = normalized_session_client_id(
            request.app_platform.as_deref(),
            request.client_id.clone(),
        );
        let issued_at = now_utc();
        let expires_at = issued_at + session_duration_for_platform(&platform);
        let token = generate_opaque_session_token();
        let session_id = hash_token(&token);

        let mut transaction = self.pool.begin().await.map_err(|e| {
            tracing::error!(error = %e, "Session store is unavailable");
            internal_handler_error("Session store is unavailable")
        })?;

        if client_id.is_some() {
            query("DELETE FROM session WHERE user_id = $1 AND platform = $2 AND client_id = $3")
                .bind(user_id)
                .bind(&platform)
                .bind(client_id.as_deref())
                .execute(transaction.as_mut())
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "Session store is unavailable");
                    internal_handler_error("Session store is unavailable")
                })?;
        }

        let device_info = request
            .user_agent
            .as_deref()
            .map(|ua| parse_user_agent(ua, request.app_platform.as_deref()));

        query(
            r#"
			INSERT INTO session (
				id,
				expires_at,
				created_at,
				updated_at,
				ip_address,
				user_agent,
				device_name,
				platform,
				client_id,
				device_info,
				browser_name,
				browser_version,
				os_name,
				os_version,
				last_active_at,
				user_id
			) VALUES (
				$1, $2, $3, $3, $4, $5, $6, $7, $8, NULL, $9, $10, $11, $12, $3, $13
			)
			"#,
        )
        .bind(&session_id)
        .bind(expires_at)
        .bind(issued_at)
        .bind(request.ip_address.as_deref())
        .bind(request.user_agent.as_deref())
        .bind(device_info.as_ref().map(|d| d.device_name.as_str()))
        .bind(&platform)
        .bind(client_id.as_deref())
        .bind(device_info.as_ref().and_then(|d| d.browser_name.as_deref()))
        .bind(
            device_info
                .as_ref()
                .and_then(|d| d.browser_version.as_deref()),
        )
        .bind(device_info.as_ref().and_then(|d| d.os_name.as_deref()))
        .bind(device_info.as_ref().and_then(|d| d.os_version.as_deref()))
        .bind(user_id)
        .execute(transaction.as_mut())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Session store is unavailable");
            internal_handler_error("Session store is unavailable")
        })?;

        transaction.commit().await.map_err(|e| {
            tracing::error!(error = %e, "Session store is unavailable");
            internal_handler_error("Session store is unavailable")
        })?;

        Ok(CreatedSession {
            token,
            session_id,
            expires_at,
        })
    }

    async fn verify_token(&self, token: &str) -> Option<VerifiedSession> {
        let hashed_id = hash_token(token);
        let session = sqlx::query_as::<_, DbSessionRecord>(
            r#"
			SELECT
				id,
				expires_at,
				created_at,
				last_active_at,
				user_id,
				ip_address,
				user_agent,
				device_name,
				platform,
				client_id,
				device_info,
				browser_name,
				browser_version,
				os_name,
				os_version
			FROM session
			WHERE id = $1 AND expires_at > NOW()
			LIMIT 1
			"#,
        )
        .bind(hashed_id)
        .fetch_optional(&self.pool)
        .await
        .ok()?;

        session.map(|row| VerifiedSession {
            token: token.to_string(),
            session_id: row.id,
            user_id: row.user_id,
            expires_at: row.expires_at,
            platform: normalize_session_platform(row.platform.as_deref()),
            client_id: normalized_session_client_id(row.platform.as_deref(), row.client_id),
        })
    }

    async fn refresh_session(
        &self,
        current_session: &VerifiedSession,
    ) -> Result<RefreshSessionResponse, AppError> {
        let mut transaction = self.pool.begin().await.map_err(|e| {
            tracing::error!(error = %e, "Session store is unavailable");
            internal_handler_error("Session store is unavailable")
        })?;

        let current = sqlx::query_as::<_, DbSessionRecord>(
            r#"
			SELECT
				id,
				expires_at,
				created_at,
				last_active_at,
				user_id,
				ip_address,
				user_agent,
				device_name,
				platform,
				client_id,
				device_info,
				browser_name,
				browser_version,
				os_name,
				os_version
			FROM session
			WHERE id = $1 AND expires_at > NOW()
			LIMIT 1
			FOR UPDATE
			"#,
        )
        .bind(&current_session.session_id)
        .fetch_optional(transaction.as_mut())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Session store is unavailable");
            internal_handler_error("Session store is unavailable")
        })?
        .ok_or_else(|| handler_unauthorized_error("Session expired"))?;

        let platform = normalize_session_platform(current.platform.as_deref());
        let client_id =
            normalized_session_client_id(current.platform.as_deref(), current.client_id);
        let next_expiry = now_utc() + session_duration_for_platform(&platform);
        let next_token = generate_opaque_session_token();
        let next_session_id = hash_token(&next_token);
        let issued_at = now_utc();

        let device_name = if client_id.is_some() {
            let grouped = sqlx::query_as::<_, DbSessionRecord>(
                r#"
				SELECT
					id,
					expires_at,
					created_at,
					last_active_at,
					user_id,
					ip_address,
					user_agent,
					device_name,
					platform,
					client_id,
					device_info,
					browser_name,
					browser_version,
					os_name,
					os_version
				FROM session
				WHERE user_id = $1 AND platform = $2 AND client_id = $3
				ORDER BY last_active_at DESC, created_at DESC, id DESC
				"#,
            )
            .bind(&current.user_id)
            .bind(&platform)
            .bind(client_id.as_deref())
            .fetch_all(transaction.as_mut())
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Session store is unavailable");
                internal_handler_error("Session store is unavailable")
            })?;

            grouped
                .into_iter()
                .find_map(|session| session.device_name)
                .or(current.device_name.clone())
        } else {
            current.device_name.clone()
        };

        if client_id.is_some() {
            sqlx::query(
                r#"DELETE FROM session WHERE user_id = $1 AND platform = $2 AND client_id = $3"#,
            )
            .bind(&current.user_id)
            .bind(&platform)
            .bind(client_id.as_deref())
            .execute(transaction.as_mut())
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Session store is unavailable");
                internal_handler_error("Session store is unavailable")
            })?;
        } else {
            sqlx::query(r#"DELETE FROM session WHERE id = $1"#)
                .bind(&current.id)
                .execute(transaction.as_mut())
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "Session store is unavailable");
                    internal_handler_error("Session store is unavailable")
                })?;
        }

        sqlx::query(
            r#"
			INSERT INTO session (
				id,
				expires_at,
				created_at,
				updated_at,
				ip_address,
				user_agent,
				device_name,
				platform,
				client_id,
				device_info,
				browser_name,
				browser_version,
				os_name,
				os_version,
				last_active_at,
				user_id
			) VALUES (
				$1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $3, $14
			)
			"#,
        )
        .bind(&next_session_id)
        .bind(next_expiry)
        .bind(issued_at)
        .bind(current.ip_address)
        .bind(current.user_agent)
        .bind(device_name)
        .bind(&platform)
        .bind(client_id.as_deref())
        .bind(current.device_info)
        .bind(current.browser_name)
        .bind(current.browser_version)
        .bind(current.os_name)
        .bind(current.os_version)
        .bind(&current.user_id)
        .execute(transaction.as_mut())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Session store is unavailable");
            internal_handler_error("Session store is unavailable")
        })?;

        transaction.commit().await.map_err(|e| {
            tracing::error!(error = %e, "Session store is unavailable");
            internal_handler_error("Session store is unavailable")
        })?;

        Ok(RefreshSessionResponse {
            token: next_token,
            session_id: next_session_id,
            expires_at: format_rfc3339(next_expiry),
        })
    }

    async fn delete_session(&self, session_id: &str) -> Result<Vec<String>, AppError> {
        query_scalar::<_, String>("DELETE FROM session WHERE id = $1 RETURNING id")
            .bind(session_id)
            .fetch_all(&self.pool)
            .await
            .map_err(|_| internal_handler_error("Session store is unavailable"))
    }

    async fn delete_all_user_sessions(&self, user_id: &str) -> Result<Vec<String>, AppError> {
        query_scalar::<_, String>("DELETE FROM session WHERE user_id = $1 RETURNING id")
            .bind(user_id)
            .fetch_all(&self.pool)
            .await
            .map_err(|_| internal_handler_error("Session store is unavailable"))
    }

    async fn delete_other_user_sessions(
        &self,
        user_id: &str,
        current_session_id: &str,
    ) -> Result<Vec<String>, AppError> {
        query_scalar::<_, String>(
            "DELETE FROM session WHERE user_id = $1 AND id != $2 RETURNING id",
        )
        .bind(user_id)
        .bind(current_session_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|_| internal_handler_error("Session store is unavailable"))
    }

    async fn list_devices(
        &self,
        user_id: &str,
        current_session_id: &str,
    ) -> Result<Vec<DeviceSessionResponse>, AppError> {
        let rows = query_as::<_, DbSessionRecord>(
            r#"
			SELECT
				id,
				expires_at,
				created_at,
				last_active_at,
				user_id,
				ip_address,
				user_agent,
				device_name,
				platform,
				client_id,
				device_info,
				browser_name,
				browser_version,
				os_name,
				os_version
			FROM session
			WHERE user_id = $1 AND expires_at > NOW()
			ORDER BY last_active_at ASC
			"#,
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Session store is unavailable");
            internal_handler_error("Session store is unavailable")
        })?;

        let sessions = rows
            .into_iter()
            .map(snapshot_from_db_session)
            .collect::<Vec<_>>();
        Ok(build_device_session_responses(sessions, current_session_id))
    }

    async fn get_owned_session(
        &self,
        session_id: &str,
        user_id: &str,
    ) -> Result<Option<SessionSnapshot>, AppError> {
        let row = query_as::<_, DbSessionRecord>(
            r#"
			SELECT
				id,
				expires_at,
				created_at,
				last_active_at,
				user_id,
				ip_address,
				user_agent,
				device_name,
				platform,
				client_id,
				device_info,
				browser_name,
				browser_version,
				os_name,
				os_version
			FROM session
			WHERE id = $1 AND user_id = $2
			LIMIT 1
			"#,
        )
        .bind(session_id)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Session store is unavailable");
            internal_handler_error("Session store is unavailable")
        })?;

        Ok(row.map(snapshot_from_db_session))
    }

    async fn revoke_device(
        &self,
        session_id: &str,
        user_id: &str,
    ) -> Result<Vec<String>, AppError> {
        let Some(existing_session) = self.get_owned_session(session_id, user_id).await? else {
            return Ok(Vec::new());
        };

        if is_grouped_client_session(&existing_session) {
            let grouped_sessions = query_scalar::<_, String>(
                "SELECT id FROM session WHERE user_id = $1 AND platform = $2 AND client_id = $3",
            )
            .bind(user_id)
            .bind(&existing_session.platform)
            .bind(existing_session.client_id.as_deref())
            .fetch_all(&self.pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Session store is unavailable");
                internal_handler_error("Session store is unavailable")
            })?;

            query("DELETE FROM session WHERE user_id = $1 AND platform = $2 AND client_id = $3")
                .bind(user_id)
                .bind(&existing_session.platform)
                .bind(existing_session.client_id.as_deref())
                .execute(&self.pool)
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "Session store is unavailable");
                    internal_handler_error("Session store is unavailable")
                })?;

            return Ok(grouped_sessions);
        }

        query("DELETE FROM session WHERE id = $1 AND user_id = $2")
            .bind(session_id)
            .bind(user_id)
            .execute(&self.pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Session store is unavailable");
                internal_handler_error("Session store is unavailable")
            })?;

        Ok(vec![existing_session.id])
    }

    async fn rename_device(
        &self,
        session_id: &str,
        user_id: &str,
        device_name: &str,
    ) -> Result<(), AppError> {
        let Some(existing_session) = self.get_owned_session(session_id, user_id).await? else {
            return Ok(());
        };

        if is_grouped_client_session(&existing_session) {
            query(
				"UPDATE session SET device_name = $1 WHERE user_id = $2 AND platform = $3 AND client_id = $4 AND expires_at > NOW()",
			)
			.bind(device_name)
			.bind(user_id)
			.bind(&existing_session.platform)
			.bind(existing_session.client_id.as_deref())
			.execute(&self.pool)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Session store is unavailable"); internal_handler_error("Session store is unavailable") })?;
            return Ok(());
        }

        query("UPDATE session SET device_name = $1 WHERE id = $2 AND user_id = $3")
            .bind(device_name)
            .bind(session_id)
            .bind(user_id)
            .execute(&self.pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Session store is unavailable");
                internal_handler_error("Session store is unavailable")
            })?;
        Ok(())
    }

    async fn heartbeat(&self, session_id: &str) -> Result<(), AppError> {
        query("UPDATE session SET last_active_at = $1 WHERE id = $2")
            .bind(now_utc())
            .bind(session_id)
            .execute(&self.pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Session store is unavailable");
                internal_handler_error("Session store is unavailable")
            })?;
        Ok(())
    }
}


fn verify_memory_token(inner: &Arc<SessionServiceInner>, token: &str) -> Option<VerifiedSession> {
    let sessions = inner.sessions_by_token.read().ok()?;
    let session = sessions.get(token)?;

    if session.expires_at <= now_utc() {
        return None;
    }

    Some(VerifiedSession {
        token: session.token.clone(),
        session_id: session.session_id.clone(),
        user_id: session.user_id.clone(),
        expires_at: session.expires_at,
        platform: session.platform.clone(),
        client_id: session.client_id.clone(),
    })
}

fn refresh_memory_session(
    inner: &Arc<SessionServiceInner>,
    current_session: &VerifiedSession,
) -> Result<RefreshSessionResponse, AppError> {
    if current_session.expires_at <= now_utc() {
        return Err(handler_unauthorized_error("Session expired"));
    }

    let next_id = inner.next_id.fetch_add(1, Ordering::Relaxed);
    let next_expiry = now_utc() + session_duration_for_platform(&current_session.platform);
    let issued_at = now_utc();
    let next_record = SessionRecord {
        token: format!("dev-session-token-{next_id}"),
        session_id: format!("dev-session-{next_id}"),
        user_id: current_session.user_id.clone(),
        expires_at: next_expiry,
        created_at: issued_at,
        last_active_at: issued_at,
        platform: current_session.platform.clone(),
        client_id: current_session.client_id.clone(),
        device_name: None,
        ip_address: None,
        browser_name: None,
        browser_version: None,
        os_name: None,
        os_version: None,
    };

    let mut sessions = inner.sessions_by_token.write().map_err(|e| {
        tracing::error!(error = %e, "Session store is unavailable");
        internal_handler_error("Session store is unavailable")
    })?;

    match sessions.remove(&current_session.token) {
        Some(existing) if existing.expires_at > now_utc() => {
            sessions.insert(next_record.token.clone(), next_record.clone());
        }
        _ => {
            return Err(handler_unauthorized_error("Session expired"));
        }
    }

    Ok(RefreshSessionResponse {
        token: next_record.token,
        session_id: next_record.session_id,
        expires_at: format_rfc3339(next_record.expires_at),
    })
}

fn list_memory_devices(
    inner: &Arc<SessionServiceInner>,
    user_id: &str,
    current_session_id: &str,
) -> Vec<DeviceSessionResponse> {
    let sessions = inner
        .sessions_by_token
        .read()
        .expect("memory session store poisoned")
        .values()
        .filter(|record| record.user_id == user_id && record.expires_at > now_utc())
        .cloned()
        .map(snapshot_from_memory_session)
        .collect::<Vec<_>>();

    build_device_session_responses(sessions, current_session_id)
}

fn get_owned_memory_session(
    inner: &Arc<SessionServiceInner>,
    session_id: &str,
    user_id: &str,
) -> Option<SessionSnapshot> {
    inner
        .sessions_by_token
        .read()
        .ok()?
        .values()
        .find(|record| record.session_id == session_id && record.user_id == user_id)
        .cloned()
        .map(snapshot_from_memory_session)
}

fn revoke_memory_device(
    inner: &Arc<SessionServiceInner>,
    session_id: &str,
    user_id: &str,
) -> Vec<String> {
    let Some(existing_session) = get_owned_memory_session(inner, session_id, user_id) else {
        return Vec::new();
    };

    let mut sessions = inner
        .sessions_by_token
        .write()
        .expect("memory session store poisoned");

    if is_grouped_client_session(&existing_session) {
        let revoked_ids = sessions
            .values()
            .filter(|record| {
                record.user_id == user_id
                    && record.platform == existing_session.platform
                    && record.client_id == existing_session.client_id
            })
            .map(|record| record.session_id.clone())
            .collect::<Vec<_>>();

        sessions.retain(|_, record| {
            !(record.user_id == user_id
                && record.platform == existing_session.platform
                && record.client_id == existing_session.client_id)
        });

        return revoked_ids;
    }

    sessions.retain(|_, record| !(record.user_id == user_id && record.session_id == session_id));
    vec![existing_session.id]
}

fn rename_memory_device(
    inner: &Arc<SessionServiceInner>,
    session_id: &str,
    user_id: &str,
    device_name: &str,
) {
    let Some(existing_session) = get_owned_memory_session(inner, session_id, user_id) else {
        return;
    };

    let mut sessions = inner
        .sessions_by_token
        .write()
        .expect("memory session store poisoned");

    for record in sessions.values_mut() {
        if is_grouped_client_session(&existing_session) {
            if record.user_id == user_id
                && record.platform == existing_session.platform
                && record.client_id == existing_session.client_id
                && record.expires_at > now_utc()
            {
                record.device_name = Some(device_name.to_string());
            }
        } else if record.user_id == user_id && record.session_id == session_id {
            record.device_name = Some(device_name.to_string());
        }
    }
}

fn touch_memory_session(inner: &Arc<SessionServiceInner>, session_id: &str) {
    let mut sessions = inner
        .sessions_by_token
        .write()
        .expect("memory session store poisoned");
    if let Some(record) = sessions
        .values_mut()
        .find(|record| record.session_id == session_id)
    {
        record.last_active_at = now_utc();
    }
}

fn delete_memory_session(inner: &Arc<SessionServiceInner>, session_id: &str) -> Vec<String> {
    let mut sessions = inner
        .sessions_by_token
        .write()
        .expect("memory session store poisoned");
    let mut revoked_ids = Vec::new();
    sessions.retain(|_, record| {
        let keep = record.session_id != session_id;
        if !keep {
            revoked_ids.push(record.session_id.clone());
        }
        keep
    });
    revoked_ids
}

fn delete_all_memory_sessions(inner: &Arc<SessionServiceInner>, user_id: &str) -> Vec<String> {
    let mut sessions = inner
        .sessions_by_token
        .write()
        .expect("memory session store poisoned");
    let mut revoked_ids = Vec::new();
    sessions.retain(|_, record| {
        let keep = record.user_id != user_id;
        if !keep {
            revoked_ids.push(record.session_id.clone());
        }
        keep
    });
    revoked_ids
}

fn delete_other_memory_sessions(
    inner: &Arc<SessionServiceInner>,
    user_id: &str,
    current_session_id: &str,
) -> Vec<String> {
    let mut sessions = inner
        .sessions_by_token
        .write()
        .expect("memory session store poisoned");
    let mut revoked_ids = Vec::new();
    sessions.retain(|_, record| {
        let keep = record.user_id != user_id || record.session_id == current_session_id;
        if !keep {
            revoked_ids.push(record.session_id.clone());
        }
        keep
    });
    revoked_ids
}

fn issue_memory_session(
    inner: &Arc<SessionServiceInner>,
    user_id: &str,
    request: &RequestMetadata,
) -> CreatedSession {
    let next_id = inner.next_id.fetch_add(1, Ordering::Relaxed);
    let issued_at = now_utc();
    let platform = normalize_session_platform(request.app_platform.as_deref());
    let client_id =
        normalized_session_client_id(request.app_platform.as_deref(), request.client_id.clone());
    let token = format!("session-token-{next_id}-{:#x}", random::<u64>());
    let session_id = hash_token(&token);
    let record = SessionRecord {
        token: token.clone(),
        session_id: session_id.clone(),
        user_id: user_id.to_string(),
        expires_at: issued_at + session_duration_for_platform(&platform),
        created_at: issued_at,
        last_active_at: issued_at,
        platform: platform.clone(),
        client_id: client_id.clone(),
        device_name: None,
        ip_address: None,
        browser_name: None,
        browser_version: None,
        os_name: None,
        os_version: None,
    };

    let mut sessions = inner
        .sessions_by_token
        .write()
        .expect("session store should be writable");
    if client_id.is_some() {
        sessions.retain(|_, existing| {
            !(existing.user_id == user_id
                && existing.platform == platform
                && existing.client_id == client_id)
        });
    }
    sessions.insert(token.clone(), record.clone());

    CreatedSession {
        token,
        session_id,
        expires_at: record.expires_at,
    }
}

#[cfg(test)]
fn issue_memory_session_for_tests(
    inner: &Arc<SessionServiceInner>,
    user_id: &str,
    platform: &str,
    client_id: Option<&str>,
) -> VerifiedSession {
    let next_id = inner.next_id.fetch_add(1, Ordering::Relaxed);
    let issued_at = now_utc();
    let record = SessionRecord {
        token: format!("test-token-{next_id}"),
        session_id: format!("test-session-{next_id}"),
        user_id: user_id.to_string(),
        expires_at: now_utc() + session_duration_for_platform(platform),
        created_at: issued_at,
        last_active_at: issued_at,
        platform: platform.to_string(),
        client_id: client_id.map(ToOwned::to_owned),
        device_name: None,
        ip_address: None,
        browser_name: None,
        browser_version: None,
        os_name: None,
        os_version: None,
    };

    inner
        .sessions_by_token
        .write()
        .expect("session store should be writable")
        .insert(record.token.clone(), record.clone());

    VerifiedSession {
        token: record.token,
        session_id: record.session_id,
        user_id: record.user_id,
        expires_at: record.expires_at,
        platform: record.platform,
        client_id: record.client_id,
    }
}

fn session_duration_for_platform(platform: &str) -> Duration {
    match platform {
        "web" => Duration::hours(24),
        "extension" => Duration::days(7),
        "ios" | "android" | "mobile" | "desktop" => Duration::days(30),
        _ => Duration::days(30),
    }
}

fn normalize_session_platform(platform: Option<&str>) -> String {
    match platform.map(|value| value.trim().to_lowercase()) {
        None => "desktop".to_string(),
        Some(normalized) if normalized == "ios" || normalized == "android" => "mobile".to_string(),
        Some(normalized)
            if normalized == "web"
                || normalized == "desktop"
                || normalized == "mobile"
                || normalized == "extension" =>
        {
            normalized
        }
        Some(_) => "desktop".to_string(),
    }
}

fn normalized_session_client_id(
    _platform: Option<&str>,
    client_id: Option<String>,
) -> Option<String> {
    client_id.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

pub(crate) fn generate_opaque_session_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub(crate) fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    hex::encode(digest)
}

pub(crate) fn format_rfc3339(value: OffsetDateTime) -> String {
    value
        .format(&Rfc3339)
        .expect("rfc3339 formatting should succeed")
}

fn snapshot_from_db_session(row: DbSessionRecord) -> SessionSnapshot {
    SessionSnapshot {
        id: row.id,
        user_id: row.user_id,
        expires_at: row.expires_at,
        created_at: row.created_at,
        last_active_at: row.last_active_at,
        platform: normalize_session_platform(row.platform.as_deref()),
        client_id: normalized_session_client_id(row.platform.as_deref(), row.client_id),
        device_name: row.device_name,
        ip_address: row.ip_address,
        browser_name: row.browser_name,
        browser_version: row.browser_version,
        os_name: row.os_name,
        os_version: row.os_version,
    }
}

fn snapshot_from_memory_session(record: SessionRecord) -> SessionSnapshot {
    SessionSnapshot {
        id: record.session_id,
        user_id: record.user_id,
        expires_at: record.expires_at,
        created_at: record.created_at,
        last_active_at: record.last_active_at,
        platform: record.platform,
        client_id: record.client_id,
        device_name: record.device_name,
        ip_address: record.ip_address,
        browser_name: record.browser_name,
        browser_version: record.browser_version,
        os_name: record.os_name,
        os_version: record.os_version,
    }
}

fn build_device_session_responses(
    sessions: Vec<SessionSnapshot>,
    current_session_id: &str,
) -> Vec<DeviceSessionResponse> {
    let mut logical_sessions = Vec::new();
    let mut grouped_sessions = HashMap::<(String, String), Vec<SessionSnapshot>>::new();

    for session in sessions {
        if is_grouped_client_session(&session) {
            let client_id = session
                .client_id
                .clone()
                .expect("grouped session has client id");
            grouped_sessions
                .entry((session.platform.clone(), client_id))
                .or_default()
                .push(session);
        } else {
            logical_sessions.push(session);
        }
    }

    for group in grouped_sessions.values() {
        let representative = group
            .iter()
            .find(|candidate| candidate.id == current_session_id)
            .cloned()
            .or_else(|| {
                let mut sorted = group.clone();
                sorted.sort_by(compare_session_recency);
                sorted.into_iter().next()
            });

        if let Some(representative) = representative {
            logical_sessions.push(representative);
        }
    }

    logical_sessions.sort_by(compare_session_recency);
    logical_sessions
        .into_iter()
        .map(|session| DeviceSessionResponse {
            id: session.id.clone(),
            device_name: session.device_name,
            platform: session.platform,
            browser_name: session.browser_name,
            browser_version: session.browser_version,
            os_name: session.os_name,
            os_version: session.os_version,
            ip_address: session.ip_address,
            last_active_at: format_rfc3339(session.last_active_at),
            created_at: format_rfc3339(session.created_at),
            is_current_session: session.id == current_session_id,
        })
        .collect()
}

pub(crate) fn is_grouped_client_session(value: &SessionSnapshot) -> bool {
    value.client_id.is_some()
}

fn compare_session_recency(left: &SessionSnapshot, right: &SessionSnapshot) -> std::cmp::Ordering {
    right
        .last_active_at
        .cmp(&left.last_active_at)
        .then_with(|| right.created_at.cmp(&left.created_at))
        .then_with(|| right.id.cmp(&left.id))
}


pub(crate) fn now_utc() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

fn handler_unauthorized_error(message: &str) -> AppError {
    AppError::unauthorized(message)
}

fn internal_handler_error(message: &str) -> AppError {
    AppError::internal(message)
}

// ---------------------------------------------------------------------------
// User-Agent parsing (mirrors packages/device/src/index.ts)
// ---------------------------------------------------------------------------

struct ParsedDeviceInfo {
    device_name: String,
    browser_name: Option<String>,
    browser_version: Option<String>,
    os_name: Option<String>,
    os_version: Option<String>,
}

fn parse_user_agent(user_agent: &str, app_platform: Option<&str>) -> ParsedDeviceInfo {
    let ua = user_agent.to_ascii_lowercase();

    let (os_name, os_version) = detect_os(user_agent, &ua);
    let (browser_name, browser_version) = detect_browser(user_agent, &ua);
    let platform = detect_platform(&ua, app_platform);

    let device_name = build_device_name(
        &platform,
        os_name.as_deref(),
        os_version.as_deref(),
        browser_name.as_deref(),
    );

    ParsedDeviceInfo {
        device_name,
        browser_name,
        browser_version,
        os_name,
        os_version,
    }
}

fn detect_os(user_agent: &str, ua: &str) -> (Option<String>, Option<String>) {
    static RE_IOS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)OS (\d+[._]\d+(?:[._]\d+)?)").unwrap());
    static RE_WINDOWS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Windows NT (\d+\.?\d*)").unwrap());
    static RE_MACOS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Mac OS X (\d+[._]\d+(?:[._]\d+)?)").unwrap());
    static RE_ANDROID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Android (\d+\.?\d*\.?\d*)").unwrap());

    if ua.contains("iphone") || ua.contains("ipad") {
        let os_name = if ua.contains("ipad") { "iPadOS" } else { "iOS" };
        let version = RE_IOS
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().replace('_', "."));
        return (Some(os_name.to_string()), version);
    }
    if ua.contains("windows") {
        let version = RE_WINDOWS
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| match m.as_str() {
                "10.0" => "10/11".to_string(),
                "6.3" => "8.1".to_string(),
                "6.2" => "8".to_string(),
                "6.1" => "7".to_string(),
                "6.0" => "Vista".to_string(),
                "5.1" => "XP".to_string(),
                other => other.to_string(),
            });
        return (Some("Windows".to_string()), version);
    }
    if ua.contains("mac os x") || ua.contains("macos") {
        let version = RE_MACOS
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().replace('_', "."));
        return (Some("macOS".to_string()), version);
    }
    if ua.contains("android") {
        let version = RE_ANDROID
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Android".to_string()), version);
    }
    if ua.contains("linux") {
        return (Some("Linux".to_string()), None);
    }
    if ua.contains("cros") {
        return (Some("Chrome OS".to_string()), None);
    }
    (None, None)
}

fn detect_browser(user_agent: &str, ua: &str) -> (Option<String>, Option<String>) {
    static RE_EDGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Edg/(\d+\.?\d*\.?\d*)").unwrap());
    static RE_OPERA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?:OPR|Opera)/(\d+\.?\d*\.?\d*)").unwrap());
    static RE_BRAVE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Brave/(\d+\.?\d*\.?\d*)").unwrap());
    static RE_VIVALDI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Vivaldi/(\d+\.?\d*\.?\d*)").unwrap());
    static RE_FIREFOX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?:Firefox|FxiOS)/(\d+\.?\d*\.?\d*)").unwrap());
    static RE_SAFARI_VER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Version/(\d+\.?\d*\.?\d*)").unwrap());
    static RE_CHROME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?:Chrome|CriOS)/(\d+\.?\d*\.?\d*)").unwrap());

    if ua.contains("edg/") {
        let ver = RE_EDGE
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Edge".to_string()), ver);
    }
    if ua.contains("opr/") || ua.contains("opera") {
        let ver = RE_OPERA
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Opera".to_string()), ver);
    }
    if ua.contains("brave") {
        let ver = RE_BRAVE
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Brave".to_string()), ver);
    }
    if ua.contains("vivaldi") {
        let ver = RE_VIVALDI
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Vivaldi".to_string()), ver);
    }
    if ua.contains("firefox") || ua.contains("fxios") {
        let ver = RE_FIREFOX
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Firefox".to_string()), ver);
    }
    if ua.contains("safari") && !ua.contains("chrome") && !ua.contains("chromium") {
        let ver = RE_SAFARI_VER
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Safari".to_string()), ver);
    }
    if ua.contains("chrome") || ua.contains("crios") {
        let ver = RE_CHROME
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Chrome".to_string()), ver);
    }
    (None, None)
}

fn detect_platform(ua: &str, app_platform: Option<&str>) -> String {
    match app_platform {
        Some("desktop") => return "desktop".to_string(),
        Some("ios") => return "ios".to_string(),
        Some("android") => return "android".to_string(),
        Some("extension") => return "extension".to_string(),
        _ => {}
    }
    if ua.contains("iphone") || ua.contains("ipad") || (ua.contains("ios") && ua.contains("mobile"))
    {
        return "ios".to_string();
    }
    if ua.contains("android") {
        return "android".to_string();
    }
    "web".to_string()
}

fn build_device_name(
    platform: &str,
    os_name: Option<&str>,
    os_version: Option<&str>,
    browser_name: Option<&str>,
) -> String {
    match platform {
        "desktop" => {
            if let Some(os) = os_name {
                format!("Bittery Desktop on {os}")
            } else {
                "Bittery Desktop".to_string()
            }
        }
        "extension" => {
            let browser_label = browser_name.unwrap_or("Browser");
            let os_label = os_name.map(|os| format!(" on {os}")).unwrap_or_default();
            format!("Bittery Extension ({browser_label}{os_label})")
        }
        "ios" => {
            let os_label = os_name.unwrap_or("iOS");
            if let Some(ver) = os_version {
                format!("Bittery on {os_label} {ver}")
            } else {
                format!("Bittery on {os_label}")
            }
        }
        "android" => {
            let os_label = if let Some(ver) = os_version {
                format!("Android {ver}")
            } else {
                "Android".to_string()
            };
            format!("Bittery on {os_label}")
        }
        _ => {
            let mut parts = Vec::new();
            if let Some(browser) = browser_name {
                parts.push(browser.to_string());
            }
            if let Some(os) = os_name {
                parts.push(format!("on {os}"));
            }
            if parts.is_empty() {
                "Unknown Device".to_string()
            } else {
                parts.join(" ")
            }
        }
    }
}



#[cfg(test)]
mod tests {
    use super::*;
    use time::{Duration, OffsetDateTime};

    #[test]
    fn session_platform_helpers_normalize_inputs_and_web_client_ids() {
        assert_eq!(normalize_session_platform(None), "desktop");
        assert_eq!(normalize_session_platform(Some(" web ")), "web");
        assert_eq!(normalize_session_platform(Some(" iOS ")), "mobile");
        assert_eq!(normalize_session_platform(Some("unknown")), "desktop");

        assert_eq!(session_duration_for_platform("web"), Duration::hours(24));
        assert_eq!(
            session_duration_for_platform("extension"),
            Duration::days(7)
        );
        assert_eq!(session_duration_for_platform("desktop"), Duration::days(30));

        assert_eq!(
            normalized_session_client_id(Some("web"), Some(" browser-1 ".to_string())).as_deref(),
            Some("browser-1"),
        );
        assert_eq!(
            normalized_session_client_id(Some("desktop"), Some("desktop-client".to_string())),
            Some("desktop-client".to_string()),
        );
        assert_eq!(
            normalized_session_client_id(Some("web"), Some("   ".to_string())),
            None,
        );
    }



    #[test]
    fn device_helpers_prefer_explicit_platform_and_build_expected_labels() {
        assert_eq!(
            detect_platform("mozilla/5.0 (iphone)", Some("extension")),
            "extension"
        );
        assert_eq!(detect_platform("mozilla/5.0 (iphone)", None), "ios");
        assert_eq!(detect_platform("mozilla/5.0 (android)", None), "android");
        assert_eq!(detect_platform("mozilla/5.0 (macintosh)", None), "web");

        assert_eq!(
            build_device_name("extension", Some("macOS"), None, Some("Safari")),
            "Bittery Extension (Safari on macOS)",
        );
        assert_eq!(
            build_device_name("ios", Some("iOS"), Some("17.5"), None),
            "Bittery on iOS 17.5",
        );
        assert_eq!(
            build_device_name("web", Some("Windows"), None, Some("Chrome")),
            "Chrome on Windows",
        );
        assert_eq!(build_device_name("web", None, None, None), "Unknown Device");
    }



    #[tokio::test]
    async fn refresh_rotates_the_previous_session() {
        let sessions = SessionService::default();
        let seeded = sessions
            .seeded_session()
            .expect("memory backend should seed");
        let current = sessions
            .verify_token(&seeded.token)
            .await
            .expect("seeded session should be valid");

        let next = sessions
            .refresh_session(&current)
            .await
            .expect("refresh should succeed");

        assert_ne!(next.session_id, seeded.session_id);
        assert!(sessions.verify_token(&seeded.token).await.is_none());
        assert!(sessions.verify_token(&next.token).await.is_some());
    }

    #[tokio::test]
    async fn refresh_preserves_platform_duration_policy() {
        let sessions = SessionService::default();
        let current = sessions
            .issue_session_for_tests("extension-user", "extension", Some("extension-client"))
            .await;

        let next = sessions
            .refresh_session(&current)
            .await
            .expect("refresh should succeed");
        let refreshed = sessions
            .verify_token(&next.token)
            .await
            .expect("refreshed token should remain valid");

        assert_eq!(refreshed.platform, "extension");
        assert_eq!(refreshed.client_id.as_deref(), Some("extension-client"));

        let remaining_days = (refreshed.expires_at - time::OffsetDateTime::now_utc()).whole_days();
        assert!(remaining_days >= 6);
        assert!(remaining_days <= 7);
    }

    #[tokio::test]
    async fn expired_sessions_cannot_be_refreshed() {
        let sessions = SessionService::default();
        let mut expired = sessions
            .issue_session_for_tests("expired-user", "desktop", None)
            .await;
        expired.expires_at = time::OffsetDateTime::now_utc() - time::Duration::minutes(1);

        let error = sessions
            .refresh_session(&expired)
            .await
            .expect_err("expired session should fail");

        assert_eq!(error.message, "Session expired");
    }

    #[tokio::test]
    async fn delete_session_removes_only_the_target_session() {
        let sessions = SessionService::default();
        let seeded = sessions
            .seeded_session()
            .expect("memory backend should seed");
        let other = sessions
            .issue_session_for_tests("dev-user", "desktop", None)
            .await;

        sessions
            .delete_session(&seeded.session_id)
            .await
            .expect("delete_session should succeed");

        assert!(sessions.verify_token(&seeded.token).await.is_none());
        assert!(sessions.verify_token(&other.token).await.is_some());
    }

    #[tokio::test]
    async fn delete_all_user_sessions_keeps_other_users_signed_in() {
        let sessions = SessionService::default();
        let target = sessions
            .issue_session_for_tests("target-user", "desktop", None)
            .await;
        let other = sessions
            .issue_session_for_tests("other-user", "desktop", None)
            .await;

        sessions
            .delete_all_user_sessions("target-user")
            .await
            .expect("delete_all_user_sessions should succeed");

        assert!(sessions.verify_token(&target.token).await.is_none());
        assert!(sessions.verify_token(&other.token).await.is_some());
    }

    #[tokio::test]
    async fn list_devices_collapses_grouped_web_sessions() {
        let sessions = SessionService::default();
        let current = sessions
            .issue_session_for_tests("user-a", "desktop", None)
            .await;
        let web_a = sessions
            .issue_session_for_tests("user-a", "web", Some("web-group"))
            .await;
        let web_b = sessions
            .issue_session_for_tests("user-a", "web", Some("web-group"))
            .await;

        if let SessionBackend::Memory(inner) = &sessions.backend {
            let mut records = inner
                .sessions_by_token
                .write()
                .expect("memory session store should be writable");
            for record in records.values_mut() {
                if record.session_id == web_a.session_id {
                    record.last_active_at = OffsetDateTime::now_utc() - Duration::days(2);
                }
                if record.session_id == web_b.session_id {
                    record.last_active_at = OffsetDateTime::now_utc() - Duration::days(1);
                }
            }
        }

        let devices = sessions
            .list_devices("user-a", &current.session_id)
            .await
            .expect("list_devices should succeed");

        let web_ids = devices
            .iter()
            .filter(|device| device.platform == "web")
            .map(|device| device.id.clone())
            .collect::<Vec<_>>();

        assert_eq!(web_ids, vec![web_b.session_id]);
        assert!(devices
            .iter()
            .any(|device| device.id == current.session_id && device.is_current_session));
    }

    #[tokio::test]
    async fn create_session_reuses_existing_desktop_client_id() {
        let sessions = SessionService::default();
        let request = RequestMetadata {
            auth_token: None,
            client_id: Some("desktop-device-1".to_string()),
            app_platform: Some("desktop".to_string()),
            user_agent: Some("integration-test".to_string()),
            ip_address: Some("127.0.0.1".to_string()),
        };

        let first = sessions
            .create_session("user-desktop", &request)
            .await
            .expect("first session should be created");
        let second = sessions
            .create_session("user-desktop", &request)
            .await
            .expect("second session should be created");

        assert!(sessions.verify_token(&first.token).await.is_none());
        assert!(sessions.verify_token(&second.token).await.is_some());

        let devices = sessions
            .list_devices("user-desktop", &second.session_id)
            .await
            .expect("list_devices should succeed");

        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].id, second.session_id);
        assert_eq!(devices[0].platform, "desktop");
        assert!(devices[0].is_current_session);
    }

    #[tokio::test]
    async fn rename_device_updates_active_grouped_web_sessions() {
        let sessions = SessionService::default();
        let grouped_a = sessions
            .issue_session_for_tests("user-b", "web", Some("rename-group"))
            .await;
        let grouped_b = sessions
            .issue_session_for_tests("user-b", "web", Some("rename-group"))
            .await;

        sessions
            .rename_device(&grouped_a.session_id, "user-b", "Unified Browser")
            .await
            .expect("rename_device should succeed");

        let devices = sessions
            .list_devices("user-b", &grouped_a.session_id)
            .await
            .expect("list_devices should succeed");

        assert!(devices
            .iter()
            .filter(|device| device.platform == "web")
            .all(|device| device.device_name.as_deref() == Some("Unified Browser")));
        assert!(sessions.verify_token(&grouped_b.token).await.is_some());
    }

    #[tokio::test]
    async fn revoke_device_revokes_grouped_web_sessions() {
        let sessions = SessionService::default();
        let grouped_a = sessions
            .issue_session_for_tests("user-c", "web", Some("revoke-group"))
            .await;
        let grouped_b = sessions
            .issue_session_for_tests("user-c", "web", Some("revoke-group"))
            .await;

        let revoked = sessions
            .revoke_device(&grouped_a.session_id, "user-c")
            .await
            .expect("revoke_device should succeed");

        assert_eq!(revoked.len(), 2);
        assert!(sessions.verify_token(&grouped_a.token).await.is_none());
        assert!(sessions.verify_token(&grouped_b.token).await.is_none());
    }

    #[tokio::test]
    async fn heartbeat_updates_last_active_timestamp() {
        let sessions = SessionService::default();
        let current = sessions
            .issue_session_for_tests("user-d", "desktop", None)
            .await;
        let before = sessions
            .list_devices("user-d", &current.session_id)
            .await
            .expect("list_devices should succeed")
            .into_iter()
            .find(|device| device.id == current.session_id)
            .expect("current device should exist")
            .last_active_at;

        sessions
            .heartbeat(&current.session_id)
            .await
            .expect("heartbeat should succeed");

        let after = sessions
            .list_devices("user-d", &current.session_id)
            .await
            .expect("list_devices should succeed")
            .into_iter()
            .find(|device| device.id == current.session_id)
            .expect("current device should exist")
            .last_active_at;

        assert!(after >= before);
    }
}
