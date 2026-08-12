use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgPool;
use time::OffsetDateTime;

use crate::{
    config::format_timestamp,
    db::enums::{SyncEntityType, SyncEventType},
    error::AppError,
    repo::{
        common::insert_user_sync_event,
        travel_mode::{fetch_user_travel_mode, upsert_user_travel_mode, validate_vault_access},
    },
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TravelModeResponse {
    pub enabled: bool,
    pub hidden_vault_ids: Vec<String>,
    pub enabled_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct SetTravelModeHiddenVaultsInput {
    pub hidden_vault_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct EnableTravelModeInput {
    pub hidden_vault_ids: Vec<String>,
}

fn map_travel_mode_row(row: crate::repo::travel_mode::DbUserTravelModeRow) -> TravelModeResponse {
    TravelModeResponse {
        enabled: row.enabled,
        hidden_vault_ids: row.hidden_vault_ids,
        enabled_at: row.enabled_at.map(format_timestamp),
        updated_at: format_timestamp(row.updated_at),
    }
}

fn default_travel_mode_response() -> TravelModeResponse {
    TravelModeResponse {
        enabled: false,
        hidden_vault_ids: Vec::new(),
        enabled_at: None,
        updated_at: format_timestamp(OffsetDateTime::now_utc()),
    }
}

async fn insert_travel_mode_sync_event<'e>(
    executor: impl sqlx::Executor<'e, Database = sqlx::Postgres>,
    user_id: &str,
    client_id: Option<&str>,
    enabled: bool,
    hidden_vault_ids: &[String],
) -> Result<(), AppError> {
    let metadata = json!({
        "enabled": enabled,
        "hiddenVaultIds": hidden_vault_ids,
    });

    insert_user_sync_event(
        executor,
        SyncEventType::TravelModeUpdated,
        user_id,
        SyncEntityType::User,
        user_id,
        1,
        client_id,
        Some(&metadata.to_string()),
    )
    .await
}

pub async fn get_travel_mode(pool: &PgPool, user_id: &str) -> Result<TravelModeResponse, AppError> {
    let row = fetch_user_travel_mode(pool, user_id).await?;
    Ok(row
        .map(map_travel_mode_row)
        .unwrap_or_else(default_travel_mode_response))
}

async fn persist_travel_mode_with_sync_event(
    pool: &PgPool,
    user_id: &str,
    client_id: Option<&str>,
    enabled: bool,
    hidden_vault_ids: &[String],
    enabled_at: Option<OffsetDateTime>,
) -> Result<TravelModeResponse, AppError> {
    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start travel mode transaction");
        AppError::internal("Failed to save travel mode config")
    })?;

    let row = upsert_user_travel_mode(
        &mut *transaction,
        user_id,
        enabled,
        hidden_vault_ids,
        enabled_at,
    )
    .await?;

    insert_travel_mode_sync_event(
        &mut *transaction,
        user_id,
        client_id,
        enabled,
        &row.hidden_vault_ids,
    )
    .await?;

    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit travel mode transaction");
        AppError::internal("Failed to save travel mode config")
    })?;

    Ok(map_travel_mode_row(row))
}

pub async fn set_travel_mode_hidden_vaults(
    pool: &PgPool,
    user_id: &str,
    client_id: Option<&str>,
    input: SetTravelModeHiddenVaultsInput,
) -> Result<TravelModeResponse, AppError> {
    let existing = fetch_user_travel_mode(pool, user_id).await?;
    if existing.as_ref().is_some_and(|row| row.enabled) {
        return Err(AppError::bad_request(
            "Cannot change hidden vaults while travel mode is enabled",
        ));
    }

    validate_vault_access(pool, user_id, &input.hidden_vault_ids).await?;

    persist_travel_mode_with_sync_event(
        pool,
        user_id,
        client_id,
        false,
        &input.hidden_vault_ids,
        None,
    )
    .await
}

pub async fn enable_travel_mode(
    pool: &PgPool,
    user_id: &str,
    client_id: Option<&str>,
    input: EnableTravelModeInput,
) -> Result<TravelModeResponse, AppError> {
    validate_vault_access(pool, user_id, &input.hidden_vault_ids).await?;

    let now = OffsetDateTime::now_utc();
    persist_travel_mode_with_sync_event(
        pool,
        user_id,
        client_id,
        true,
        &input.hidden_vault_ids,
        Some(now),
    )
    .await
}

pub async fn disable_travel_mode(
    pool: &PgPool,
    user_id: &str,
    client_id: Option<&str>,
) -> Result<TravelModeResponse, AppError> {
    let existing = fetch_user_travel_mode(pool, user_id).await?;
    let hidden_vault_ids = existing
        .as_ref()
        .map(|row| row.hidden_vault_ids.clone())
        .unwrap_or_default();

    persist_travel_mode_with_sync_event(pool, user_id, client_id, false, &hidden_vault_ids, None)
        .await
}

#[cfg(test)]
mod tests {
    use rand::random;
    use sqlx::{query, Row};

    use crate::test_support::{seed_user, seed_vault, seed_vault_key, with_api_test_app};

    use super::*;

    async fn seed_travel_mode_fixture(pool: &PgPool, test_name: &str) -> (String, String, String) {
        let user_id = format!("user_travel_{test_name}_{:016x}", random::<u64>());
        let email = format!("travel-{test_name}@example.com");
        let vault_id = format!("vault_travel_{test_name}_{:016x}", random::<u64>());

        seed_user(pool, &user_id, &email, "Travel User").await;
        seed_vault(
            pool,
            &vault_id,
            "Sensitive Vault",
            "personal",
            &user_id,
            None,
        )
        .await;
        let vault_key_id = format!("vk_{vault_id}");
        seed_vault_key(
            pool,
            &vault_key_id,
            &vault_id,
            &user_id,
            "encrypted-key",
            "owner",
        )
        .await;

        (user_id, email, vault_id)
    }

    #[tokio::test]
    async fn travel_mode_enable_disable_and_validation() {
        let test_name = format!("travel_mode_flow_{:016x}", random::<u64>());
        let fixture_name = test_name.clone();
        with_api_test_app(&test_name, move |app| async move {
            let pool = app.pool.clone();
            let (user_id, _email, vault_id) =
                seed_travel_mode_fixture(&pool, &fixture_name).await;

            let initial = get_travel_mode(&pool, &user_id).await.expect("get initial");
            assert!(!initial.enabled);
            assert!(initial.hidden_vault_ids.is_empty());

            let invalid = set_travel_mode_hidden_vaults(
                &pool,
                &user_id,
                None,
                SetTravelModeHiddenVaultsInput {
                    hidden_vault_ids: vec!["vault_does_not_exist".to_string()],
                },
            )
            .await;
            assert!(invalid.is_err());

            let configured = set_travel_mode_hidden_vaults(
                &pool,
                &user_id,
                None,
                SetTravelModeHiddenVaultsInput {
                    hidden_vault_ids: vec![vault_id.clone()],
                },
            )
            .await
            .expect("set hidden vaults");
            assert_eq!(configured.hidden_vault_ids, vec![vault_id.clone()]);

            let enabled = enable_travel_mode(
                &pool,
                &user_id,
                Some("client-1"),
                EnableTravelModeInput {
                    hidden_vault_ids: vec![vault_id.clone()],
                },
            )
            .await
            .expect("enable travel mode");
            assert!(enabled.enabled);
            assert!(enabled.enabled_at.is_some());

            let blocked = set_travel_mode_hidden_vaults(
                &pool,
                &user_id,
                None,
                SetTravelModeHiddenVaultsInput {
                    hidden_vault_ids: vec![],
                },
            )
            .await;
            assert!(blocked.is_err());

            let disabled = disable_travel_mode(&pool, &user_id, Some("client-1"))
                .await
                .expect("disable travel mode");
            assert!(!disabled.enabled);
            assert_eq!(disabled.hidden_vault_ids, vec![vault_id.clone()]);

            let event_count: i64 = query(
                "SELECT COUNT(*) FROM sync_event WHERE user_id = $1 AND event_type = 'travel_mode_updated'::sync_event_type",
            )
            .bind(&user_id)
            .fetch_one(&pool)
            .await
            .expect("count events")
            .get(0);

            assert_eq!(event_count, 3);
        })
        .await;
    }
}
