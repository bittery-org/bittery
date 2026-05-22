use std::collections::HashMap;

use chrono::{Local, TimeZone, Utc};
use qubit::{
    builder::IntoResponse,
    handler,
    server::{ErrorCode, Router, RpcError},
};
use rand::random;
use rand::Rng;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlx::{query, query_as, query_scalar, PgPool};
use ts_rs::TS;

use crate::auth::AppContext;
use crate::{auth::RefreshSessionContext, db::models::*, AppState};

const SHARE_LINKS_UNAVAILABLE_MESSAGE: &str =
    "Share links are not available on your current plan. Upgrade to continue.";
const MAX_VERIFICATION_CODES_PER_EMAIL: i64 = 5;
const DEFAULT_SHARE_LINK_DAILY_LIMIT: i64 = 50;

#[derive(Debug, Clone, Serialize, TS)]
pub struct ShareRpcError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ItemIdInput {
    pub item_id: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct LinkIdInput {
    pub link_id: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct UpdateShareLinkInput {
    pub link_id: String,
    pub is_one_time_use: Option<bool>,
    pub add_emails: Option<Vec<String>>,
    pub remove_email_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CreateShareLinkInput {
    pub item_id: String,
    pub access_mode: String,
    #[serde(default)]
    pub is_one_time_use: bool,
    pub expires_in: String,
    pub allowed_emails: Option<Vec<String>>,
    pub encrypted_item_data: String,
    pub encryption_iv: String,
    pub encrypted_share_key: String,
    pub share_key_iv: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CreateShareLinkResponse {
    pub id: String,
    pub token: String,
    pub expires_at: String,
    pub base_share_url: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ShareAllowedEmailSummary {
    pub email: String,
    pub verified: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ShareAllowedEmailDetails {
    pub id: String,
    pub email: String,
    pub verified: bool,
    pub verified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ShareLinkListEntry {
    pub id: String,
    pub token: String,
    pub status: String,
    pub access_mode: String,
    pub is_one_time_use: bool,
    pub access_count: i32,
    pub max_access_count: Option<i32>,
    pub allowed_emails: Vec<ShareAllowedEmailSummary>,
    pub expires_at: String,
    pub created_at: String,
    pub last_accessed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ShareLinkListResponse {
    pub links: Vec<ShareLinkListEntry>,
    pub base_share_url: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ShareLinkDetailsResponse {
    pub id: String,
    pub token: String,
    pub status: String,
    pub access_mode: String,
    pub is_one_time_use: bool,
    pub access_count: i32,
    pub max_access_count: Option<i32>,
    pub allowed_emails: Vec<ShareAllowedEmailDetails>,
    pub expires_at: String,
    pub created_at: String,
    pub last_accessed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ShareAccessLogResponse {
    pub id: String,
    pub accessed_by_email: Option<String>,
    pub ip_address: Option<String>,
    pub user_agent: Option<String>,
    pub success: bool,
    pub failure_reason: Option<String>,
    pub accessed_at: String,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct SuccessResponse {
    pub success: bool,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct PublicTokenInput {
    pub token: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct RequestEmailVerificationInput {
    pub token: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RequestEmailVerificationResponse {
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct VerifyEmailAndAccessInput {
    pub token: String,
    pub email: String,
    pub code: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PublicShareInfoResponse {
    pub valid: bool,
    pub reason: Option<String>,
    pub access_mode: String,
    pub is_one_time_use: Option<bool>,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PublicShareAccessResponse {
    pub encrypted_item_data: String,
    pub encryption_iv: String,
    pub encrypted_share_key: String,
    pub share_key_iv: String,
}

struct VisibleShareLink {
    link: DbShareLinkRow,
    allowed_emails: Vec<DbShareLinkAllowedEmailRow>,
    actor_role: String,
}

struct PublicShareLinkDetails {
    link: DbPublicShareLinkRow,
    allowed_emails: Vec<DbShareLinkAllowedEmailRow>,
}

struct ShareLinksAccess {
    enabled: bool,
    max_active_links: Option<i64>,
    team_id: Option<String>,
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn create(
    ctx: RefreshSessionContext,
    input: CreateShareLinkInput,
) -> Result<CreateShareLinkResponse, ShareRpcError> {
    let pool = db_pool(&ctx)?;
    let scoped_item = load_scoped_item_access(pool, &ctx.session.user_id, &input.item_id).await?;
    let Some(scoped_item) = scoped_item else {
        return Err(not_found_error("Item not found"));
    };

    if scoped_item.role == "read-only" {
        return Err(forbidden_error("Read-only users cannot share items"));
    }

    let share_links_access = assert_share_links_entitlement(pool, &ctx.session.user_id).await?;
    validate_create_share_input(&input)?;
    check_and_increment_share_rate_limit(pool, &ctx.session.user_id).await?;

    let expires_at = calculate_expiration(&input.expires_in)?;
    let token = generate_secure_token();
    let share_link_id = generate_share_id("share_link");
    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to create share link transaction");
        internal_error("Failed to create share link transaction")
    })?;

    if let Some(max_active_links) = share_links_access.max_active_links {
        let lock_scope = share_links_access
            .team_id
            .as_deref()
            .unwrap_or(&ctx.session.user_id);
        query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(format!("share-links:{lock_scope}"))
            .execute(&mut *transaction)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to lock share link scope");
                internal_error("Failed to lock share link scope")
            })?;

        let active_share_links = count_active_share_links(
            &mut transaction,
            share_links_access.team_id.as_deref(),
            &ctx.session.user_id,
            time::OffsetDateTime::now_utc(),
        )
        .await?;
        if active_share_links >= max_active_links {
            return Err(forbidden_error(&format!(
				"Your plan allows up to {max_active_links} active share links. Revoke a link or upgrade to continue.",
			)));
        }
    }

    query(
		"INSERT INTO share_link (id, item_id, created_by_id, token, access_mode, is_one_time_use, encrypted_item_data, encryption_iv, encrypted_share_key, share_key_iv, max_access_count, expires_at) VALUES ($1, $2, $3, $4, $5::share_link_access_mode, $6, $7, $8, $9, $10, $11, $12)",
	)
	.bind(&share_link_id)
	.bind(&scoped_item.item_id)
	.bind(&ctx.session.user_id)
	.bind(&token)
	.bind(&input.access_mode)
	.bind(input.is_one_time_use)
	.bind(&input.encrypted_item_data)
	.bind(&input.encryption_iv)
	.bind(&input.encrypted_share_key)
	.bind(&input.share_key_iv)
	.bind(if input.is_one_time_use { Some(1_i32) } else { None })
	.bind(expires_at)
	.execute(&mut *transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to insert share link"); internal_error("Failed to insert share link") })?;

    if input.access_mode == "email-restricted" {
        for email in input.allowed_emails.as_ref().into_iter().flatten() {
            query(
				"INSERT INTO share_link_allowed_email (id, share_link_id, email) VALUES ($1, $2, $3)",
			)
			.bind(generate_share_id("share_email"))
			.bind(&share_link_id)
			.bind(email.to_ascii_lowercase())
			.execute(&mut *transaction)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to insert share link allowed email"); internal_error("Failed to insert share link allowed email") })?;
        }
    }

    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit share link transaction");
        internal_error("Failed to commit share link transaction")
    })?;

    record_share_audit_event(pool, &ctx.session.user_id, "share_created", &share_link_id).await?;

    Ok(CreateShareLinkResponse {
        id: share_link_id,
        token,
        expires_at: format_timestamp(expires_at),
        base_share_url: base_share_url(),
    })
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn listByItem(
    ctx: RefreshSessionContext,
    input: ItemIdInput,
) -> Result<ShareLinkListResponse, ShareRpcError> {
    let pool = db_pool(&ctx)?;
    assert_share_links_entitlement(pool, &ctx.session.user_id).await?;

    let scoped_item = load_scoped_item_access(pool, &ctx.session.user_id, &input.item_id).await?;
    let Some(scoped_item) = scoped_item else {
        return Err(not_found_error("Item not found"));
    };

    let links = load_share_links_for_item(pool, &scoped_item.item_id).await?;
    let now = time::OffsetDateTime::now_utc();
    let visible_links = if scoped_item.role == "owner" || scoped_item.role == "admin" {
        links
    } else {
        links
            .into_iter()
            .filter(|link| link.created_by_id == ctx.session.user_id)
            .collect()
    };
    let link_ids = visible_links
        .iter()
        .map(|link| link.id.clone())
        .collect::<Vec<_>>();
    let allowed_emails_by_link = load_allowed_emails_for_links(pool, &link_ids).await?;

    Ok(ShareLinkListResponse {
        links: visible_links
            .into_iter()
            .map(|link| {
                let status = effective_share_link_status(&link, now);
                let allowed_emails = allowed_emails_by_link
                    .get(&link.id)
                    .cloned()
                    .unwrap_or_default();
                ShareLinkListEntry {
                    id: link.id,
                    token: link.token,
                    status,
                    access_mode: link.access_mode,
                    is_one_time_use: link.is_one_time_use,
                    access_count: link.access_count,
                    max_access_count: link.max_access_count,
                    allowed_emails: allowed_emails
                        .into_iter()
                        .map(|email| ShareAllowedEmailSummary {
                            email: email.email,
                            verified: email.verified,
                        })
                        .collect(),
                    expires_at: format_timestamp(link.expires_at),
                    created_at: format_timestamp(link.created_at),
                    last_accessed_at: link.last_accessed_at.map(format_timestamp),
                }
            })
            .collect(),
        base_share_url: base_share_url(),
    })
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn get(
    ctx: RefreshSessionContext,
    input: LinkIdInput,
) -> Result<ShareLinkDetailsResponse, ShareRpcError> {
    let pool = db_pool(&ctx)?;
    assert_share_links_entitlement(pool, &ctx.session.user_id).await?;

    let visible_link = load_visible_share_link(pool, &input.link_id, &ctx.session.user_id).await?;
    let Some(visible_link) = visible_link else {
        return Err(not_found_error("Share link not found"));
    };

    Ok(ShareLinkDetailsResponse {
        id: visible_link.link.id,
        token: visible_link.link.token,
        status: visible_link.link.status,
        access_mode: visible_link.link.access_mode,
        is_one_time_use: visible_link.link.is_one_time_use,
        access_count: visible_link.link.access_count,
        max_access_count: visible_link.link.max_access_count,
        allowed_emails: visible_link
            .allowed_emails
            .into_iter()
            .map(|email| ShareAllowedEmailDetails {
                id: email.id,
                email: email.email,
                verified: email.verified,
                verified_at: email.verified_at.map(format_timestamp),
            })
            .collect(),
        expires_at: format_timestamp(visible_link.link.expires_at),
        created_at: format_timestamp(visible_link.link.created_at),
        last_accessed_at: visible_link.link.last_accessed_at.map(format_timestamp),
    })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn revoke(
    ctx: RefreshSessionContext,
    input: LinkIdInput,
) -> Result<SuccessResponse, ShareRpcError> {
    let pool = db_pool(&ctx)?;
    let visible_link = load_visible_share_link(pool, &input.link_id, &ctx.session.user_id).await?;
    let Some(visible_link) = visible_link else {
        return Err(not_found_error("Share link not found"));
    };

    let creator_role = query_scalar::<_, Option<String>>(
        "SELECT role::text AS role FROM vault_key WHERE vault_id = $1 AND user_id = $2 LIMIT 1",
    )
    .bind(&visible_link.link.vault_id)
    .bind(&visible_link.link.created_by_id)
    .fetch_one(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load share link creator role");
        internal_error("Failed to load share link creator role")
    })?
    .unwrap_or_else(|| "member".to_string());

    if visible_link.actor_role == "read-only"
        || (visible_link.actor_role == "member"
            && visible_link.link.created_by_id != ctx.session.user_id)
        || (visible_link.actor_role == "admin" && creator_role == "owner")
    {
        return Err(forbidden_error(
            "You do not have permission to revoke this link",
        ));
    }

    query("UPDATE share_link SET status = 'revoked' WHERE id = $1")
        .bind(&input.link_id)
        .execute(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to revoke share link");
            internal_error("Failed to revoke share link")
        })?;

    record_share_audit_event(pool, &ctx.session.user_id, "share_revoked", &input.link_id).await?;

    Ok(SuccessResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn update(
    ctx: RefreshSessionContext,
    input: UpdateShareLinkInput,
) -> Result<SuccessResponse, ShareRpcError> {
    let pool = db_pool(&ctx)?;
    assert_share_links_entitlement(pool, &ctx.session.user_id).await?;

    let visible_link = load_visible_share_link(pool, &input.link_id, &ctx.session.user_id).await?;
    let Some(visible_link) = visible_link else {
        return Err(not_found_error("Share link not found"));
    };

    if visible_link.actor_role == "read-only"
        || (visible_link.actor_role == "member"
            && visible_link.link.created_by_id != ctx.session.user_id)
    {
        return Err(forbidden_error("Access denied"));
    }

    if let Some(is_one_time_use) = input.is_one_time_use {
        query("UPDATE share_link SET is_one_time_use = $1, max_access_count = $2 WHERE id = $3")
            .bind(is_one_time_use)
            .bind(if is_one_time_use { Some(1_i32) } else { None })
            .bind(&input.link_id)
            .execute(pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to update share link");
                internal_error("Failed to update share link")
            })?;
    }

    if let Some(add_emails) = input.add_emails.as_ref() {
        if add_emails.len() > 100 {
            return Err(bad_request_error("Too many emails to add"));
        }
        for email in add_emails {
            if !email_regex().is_match(email) {
                return Err(bad_request_error(&format!("Invalid email format: {email}")));
            }
        }

        for email in add_emails {
            query(
				"INSERT INTO share_link_allowed_email (id, share_link_id, email) VALUES ($1, $2, $3)",
			)
			.bind(generate_share_id("share_email"))
			.bind(&input.link_id)
			.bind(email.to_ascii_lowercase())
			.execute(pool)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to add allowed email"); internal_error("Failed to add allowed email") })?;
        }
    }

    if let Some(remove_email_ids) = input.remove_email_ids.as_ref() {
        if remove_email_ids.len() > 100 {
            return Err(bad_request_error("Too many email ids to remove"));
        }
        let unique_ids = unique_email_ids(remove_email_ids)?;
        if !unique_ids.is_empty() {
            let removed_emails = query_as::<_, DbShareLinkAllowedEmailDeleteRow>(
				"DELETE FROM share_link_allowed_email WHERE share_link_id = $1 AND id = ANY($2) RETURNING id, email",
			)
			.bind(&input.link_id)
			.bind(&unique_ids)
			.fetch_all(pool)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to remove allowed emails"); internal_error("Failed to remove allowed emails") })?;

            if removed_emails.len() != unique_ids.len() {
                return Err(bad_request_error(
                    "One or more removeEmailIds are invalid for this share link",
                ));
            }

            let revoked_emails = removed_emails
                .into_iter()
                .map(|row| row.email.to_ascii_lowercase())
                .collect::<Vec<_>>();

            query(
				"UPDATE share_email_verification SET used_at = $1 WHERE share_link_id = $2 AND email = ANY($3) AND used_at IS NULL",
			)
			.bind(time::OffsetDateTime::now_utc())
			.bind(&input.link_id)
			.bind(&revoked_emails)
			.execute(pool)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to invalidate removed email verifications"); internal_error("Failed to invalidate removed email verifications") })?;
        }
    }

    Ok(SuccessResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn getAccessLogs(
    ctx: RefreshSessionContext,
    input: LinkIdInput,
) -> Result<Vec<ShareAccessLogResponse>, ShareRpcError> {
    let pool = db_pool(&ctx)?;
    assert_share_links_entitlement(pool, &ctx.session.user_id).await?;

    let visible_link = load_visible_share_link(pool, &input.link_id, &ctx.session.user_id).await?;
    if visible_link.is_none() {
        return Err(not_found_error("Share link not found"));
    }

    let logs = query_as::<_, DbShareAccessLogRow>(
		"SELECT id, accessed_by_email, ip_address, user_agent, success, failure_reason, accessed_at FROM share_access_log WHERE share_link_id = $1 ORDER BY accessed_at DESC LIMIT 100",
	)
	.bind(&input.link_id)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load share access logs"); internal_error("Failed to load share access logs") })?;

    Ok(logs
        .into_iter()
        .map(|log| ShareAccessLogResponse {
            id: log.id,
            accessed_by_email: log.accessed_by_email,
            ip_address: log.ip_address,
            user_agent: log.user_agent,
            success: log.success,
            failure_reason: log.failure_reason,
            accessed_at: format_timestamp(log.accessed_at),
        })
        .collect())
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn getPublicInfo(
    ctx: AppContext,
    input: PublicTokenInput,
) -> Result<PublicShareInfoResponse, ShareRpcError> {
    validate_public_token(&input.token)?;
    let pool = ctx
        .app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| internal_error("Database is not configured"))?;
    let link = load_public_share_link_by_token(pool, &input.token).await?;
    let Some(link) = link else {
        return Err(not_found_error("Share link not found or invalid"));
    };

    let public_state = get_public_share_state(pool, &link).await?;
    if !public_state.valid {
        return Ok(PublicShareInfoResponse {
            valid: false,
            reason: public_state.reason,
            access_mode: link.access_mode,
            is_one_time_use: None,
            expires_at: None,
        });
    }

    Ok(PublicShareInfoResponse {
        valid: true,
        reason: None,
        access_mode: link.access_mode,
        is_one_time_use: Some(link.is_one_time_use),
        expires_at: Some(format_timestamp(link.expires_at)),
    })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn accessPublic(
    ctx: AppContext,
    input: PublicTokenInput,
) -> Result<PublicShareAccessResponse, ShareRpcError> {
    validate_public_token(&input.token)?;
    let pool = ctx
        .app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| internal_error("Database is not configured"))?;
    let link = query_as::<_, DbPublicShareLinkRow>(
		"SELECT id, created_by_id, token, status::text AS status, access_mode::text AS access_mode, is_one_time_use, encrypted_item_data, encryption_iv, encrypted_share_key, share_key_iv, access_count, max_access_count, expires_at FROM share_link WHERE token = $1 AND access_mode = 'anyone' LIMIT 1",
	)
	.bind(&input.token)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load public share link"); internal_error("Failed to load public share link") })?;
    let Some(link) = link else {
        return Err(not_found_error("Share link not found"));
    };

    let public_state = get_public_share_state(pool, &link).await?;
    if !public_state.valid && public_state.reason.as_deref() == Some("disabled") {
        log_share_access(
            pool,
            &link.id,
            None,
            false,
            Some("Share links disabled for creator plan"),
        )
        .await?;
        return Err(bad_request_error("This share link is no longer valid"));
    }
    if !public_state.valid && public_state.reason.as_deref() == Some("revoked") {
        log_share_access(
            pool,
            &link.id,
            None,
            false,
            Some(&format!("Link status: {}", link.status)),
        )
        .await?;
        return Err(bad_request_error(&format!(
            "This share link has been {}",
            link.status
        )));
    }
    if !public_state.valid && public_state.reason.as_deref() == Some("expired") {
        log_share_access(pool, &link.id, None, false, Some("Link expired")).await?;
        return Err(bad_request_error("This share link has expired"));
    }
    if !public_state.valid && public_state.reason.as_deref() == Some("exhausted") {
        log_share_access(pool, &link.id, None, false, Some("Access limit reached")).await?;
        return Err(bad_request_error("This share link has been exhausted"));
    }

    if !consume_share_link_access(pool, &link.id, time::OffsetDateTime::now_utc()).await? {
        log_share_access(pool, &link.id, None, false, Some("Access limit reached")).await?;
        return Err(bad_request_error(
            "This share link has reached its access limit",
        ));
    }

    log_share_access(pool, &link.id, None, true, None).await?;

    Ok(PublicShareAccessResponse {
        encrypted_item_data: link.encrypted_item_data,
        encryption_iv: link.encryption_iv,
        encrypted_share_key: link.encrypted_share_key,
        share_key_iv: link.share_key_iv,
    })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn requestEmailVerification(
    ctx: AppContext,
    input: RequestEmailVerificationInput,
) -> Result<RequestEmailVerificationResponse, ShareRpcError> {
    validate_public_token(&input.token)?;
    validate_email(&input.email)?;
    let pool = ctx
        .app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| internal_error("Database is not configured"))?;
    let details =
        load_public_share_link_details_by_token(pool, &input.token, Some("email-restricted"))
            .await?;
    let Some(details) = details else {
        return Err(not_found_error("Share link not found"));
    };

    let public_state = get_public_share_state(pool, &details.link).await?;
    if !public_state.valid {
        return Err(bad_request_error("This share link is no longer valid"));
    }

    let now = time::OffsetDateTime::now_utc();
    let normalized_email = input.email.to_ascii_lowercase();
    let is_allowed = details
        .allowed_emails
        .iter()
        .any(|entry| entry.email.to_ascii_lowercase() == normalized_email);
    if !is_allowed {
        return Err(forbidden_error(
            "This email is not authorized to access this link",
        ));
    }

    let total_codes = query_scalar::<_, i64>(
		"SELECT COUNT(*)::bigint FROM share_email_verification WHERE share_link_id = $1 AND email = $2",
	)
	.bind(&details.link.id)
	.bind(&normalized_email)
	.fetch_one(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to count share email verification codes"); internal_error("Failed to count share email verification codes") })?;
    if total_codes >= MAX_VERIFICATION_CODES_PER_EMAIL {
        return Err(ShareRpcError {
            code: "TOO_MANY_REQUESTS".to_string(),
            message: "Too many verification attempts for this email. Contact the link creator."
                .to_string(),
        });
    }

    let existing_verification = query_as::<_, DbShareEmailVerificationRow>(
		"SELECT id, share_link_id, email, code, attempts, max_attempts, expires_at, created_at, used_at FROM share_email_verification WHERE share_link_id = $1 AND email = $2 AND expires_at > $3 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
	)
	.bind(&details.link.id)
	.bind(&normalized_email)
	.bind(now)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load existing share email verification"); internal_error("Failed to load existing share email verification") })?;

    if let Some(existing_verification) = existing_verification {
        if (now - existing_verification.created_at) < time::Duration::minutes(1) {
            return Err(ShareRpcError {
                code: "TOO_MANY_REQUESTS".to_string(),
                message: "Please wait before requesting another code".to_string(),
            });
        }
    }

    let code = generate_verification_code();
    let expires_at = now + time::Duration::minutes(15);
    query(
		"INSERT INTO share_email_verification (id, share_link_id, email, code, expires_at) VALUES ($1, $2, $3, $4, $5)",
	)
	.bind(generate_share_id("share_verification"))
	.bind(&details.link.id)
	.bind(&normalized_email)
	.bind(&code)
	.bind(expires_at)
	.execute(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to insert share email verification"); internal_error("Failed to insert share email verification") })?;

    Ok(RequestEmailVerificationResponse {
        success: true,
        message: "Verification code sent to your email".to_string(),
    })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn verifyEmailAndAccess(
    ctx: AppContext,
    input: VerifyEmailAndAccessInput,
) -> Result<PublicShareAccessResponse, ShareRpcError> {
    validate_public_token(&input.token)?;
    validate_email(&input.email)?;
    if input.code.len() != 6 {
        return Err(bad_request_error("Invalid or expired verification code"));
    }

    let pool = ctx
        .app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| internal_error("Database is not configured"))?;
    let details = load_public_share_link_details_by_token(pool, &input.token, None).await?;
    let Some(details) = details else {
        return Err(not_found_error("Share link not found"));
    };

    let public_state = get_public_share_state(pool, &details.link).await?;
    if !public_state.valid && public_state.reason.as_deref() == Some("disabled") {
        log_share_access(
            pool,
            &details.link.id,
            Some(&input.email),
            false,
            Some("Share links disabled for creator plan"),
        )
        .await?;
        return Err(bad_request_error("This share link is no longer valid"));
    }
    if !public_state.valid {
        log_share_access(
            pool,
            &details.link.id,
            Some(&input.email),
            false,
            Some("Link no longer valid"),
        )
        .await?;
        return Err(bad_request_error("This share link is no longer valid"));
    }

    let now = time::OffsetDateTime::now_utc();
    let normalized_email = input.email.to_ascii_lowercase();
    let is_still_allowed = details
        .allowed_emails
        .iter()
        .any(|entry| entry.email.to_ascii_lowercase() == normalized_email);
    if !is_still_allowed {
        log_share_access(
            pool,
            &details.link.id,
            Some(&input.email),
            false,
            Some("Email no longer authorized for this link"),
        )
        .await?;
        return Err(forbidden_error(
            "This email is not authorized to access this link",
        ));
    }

    let verification = query_as::<_, DbShareEmailVerificationRow>(
		"SELECT id, share_link_id, email, code, attempts, max_attempts, expires_at, created_at, used_at FROM share_email_verification WHERE share_link_id = $1 AND email = $2 AND code = $3 AND expires_at > $4 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
	)
	.bind(&details.link.id)
	.bind(&normalized_email)
	.bind(&input.code)
	.bind(now)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load verification code"); internal_error("Failed to load verification code") })?;

    let verification = if let Some(verification) = verification {
        verification
    } else {
        let any_verification = query_as::<_, DbShareEmailVerificationRow>(
			"SELECT id, share_link_id, email, code, attempts, max_attempts, expires_at, created_at, used_at FROM share_email_verification WHERE share_link_id = $1 AND email = $2 AND expires_at > $3 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
		)
		.bind(&details.link.id)
		.bind(&normalized_email)
		.bind(now)
		.fetch_optional(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load fallback verification code"); internal_error("Failed to load fallback verification code") })?;

        if let Some(any_verification) = any_verification {
            query("UPDATE share_email_verification SET attempts = $1 WHERE id = $2")
                .bind(any_verification.attempts + 1)
                .bind(&any_verification.id)
                .execute(pool)
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "Failed to increment verification attempts");
                    internal_error("Failed to increment verification attempts")
                })?;

            if any_verification.attempts + 1 >= any_verification.max_attempts {
                query("UPDATE share_email_verification SET used_at = $1 WHERE id = $2")
                    .bind(now)
                    .bind(&any_verification.id)
                    .execute(pool)
                    .await
                    .map_err(|e| {
                        tracing::error!(error = %e, "Failed to exhaust verification code");
                        internal_error("Failed to exhaust verification code")
                    })?;
            }
        }

        log_share_access(
            pool,
            &details.link.id,
            Some(&input.email),
            false,
            Some("Invalid or expired verification code"),
        )
        .await?;
        return Err(bad_request_error("Invalid or expired verification code"));
    };

    if verification.attempts >= verification.max_attempts {
        log_share_access(
            pool,
            &details.link.id,
            Some(&input.email),
            false,
            Some("Max verification attempts exceeded"),
        )
        .await?;
        return Err(ShareRpcError {
            code: "TOO_MANY_REQUESTS".to_string(),
            message: "Maximum verification attempts exceeded. Please request a new code."
                .to_string(),
        });
    }

    if !consume_share_link_access(pool, &details.link.id, now).await? {
        log_share_access(
            pool,
            &details.link.id,
            Some(&input.email),
            false,
            Some("Access limit reached"),
        )
        .await?;
        return Err(bad_request_error(
            "This share link has reached its access limit",
        ));
    }

    query("UPDATE share_email_verification SET used_at = $1 WHERE id = $2")
        .bind(now)
        .bind(&verification.id)
        .execute(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to mark verification as used");
            internal_error("Failed to mark verification as used")
        })?;

    query(
		"UPDATE share_link_allowed_email SET verified = true, verified_at = $1 WHERE share_link_id = $2 AND lower(email) = lower($3)",
	)
	.bind(now)
	.bind(&details.link.id)
	.bind(&normalized_email)
	.execute(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to mark allowed email as verified"); internal_error("Failed to mark allowed email as verified") })?;

    log_share_access(pool, &details.link.id, Some(&input.email), true, None).await?;

    Ok(PublicShareAccessResponse {
        encrypted_item_data: details.link.encrypted_item_data,
        encryption_iv: details.link.encryption_iv,
        encrypted_share_key: details.link.encrypted_share_key,
        share_key_iv: details.link.share_key_iv,
    })
}

pub fn create_share_router() -> Router<AppState> {
    Router::new()
        .handler(create)
        .handler(listByItem)
        .handler(get)
        .handler(revoke)
        .handler(update)
        .handler(getAccessLogs)
        .handler(getPublicInfo)
        .handler(requestEmailVerification)
        .handler(verifyEmailAndAccess)
        .handler(accessPublic)
}

async fn load_scoped_item_access(
    pool: &PgPool,
    actor_user_id: &str,
    item_id: &str,
) -> Result<Option<DbScopedItemAccessRow>, ShareRpcError> {
    query_as::<_, DbScopedItemAccessRow>(
		"SELECT i.id AS item_id, i.vault_id, vk.role::text AS role FROM item i INNER JOIN vault_key vk ON vk.vault_id = i.vault_id AND vk.user_id = $1 WHERE i.id = $2 LIMIT 1",
	)
	.bind(actor_user_id)
	.bind(item_id)
	.fetch_optional(pool)
	.await
	.map_err(|_| internal_error("Failed to load scoped item access"))
}

async fn load_share_links_for_item(
    pool: &PgPool,
    item_id: &str,
) -> Result<Vec<DbShareLinkRow>, ShareRpcError> {
    query_as::<_, DbShareLinkRow>(
		"SELECT sl.id, sl.item_id, sl.created_by_id, sl.token, sl.status::text AS status, sl.access_mode::text AS access_mode, sl.is_one_time_use, sl.access_count, sl.max_access_count, sl.expires_at, sl.created_at, sl.last_accessed_at, i.vault_id FROM share_link sl INNER JOIN item i ON i.id = sl.item_id WHERE sl.item_id = $1 ORDER BY sl.created_at DESC",
	)
	.bind(item_id)
	.fetch_all(pool)
	.await
	.map_err(|_| internal_error("Failed to load share links"))
}

async fn load_visible_share_link(
    pool: &PgPool,
    link_id: &str,
    actor_user_id: &str,
) -> Result<Option<VisibleShareLink>, ShareRpcError> {
    let link = query_as::<_, DbShareLinkRow>(
		"SELECT sl.id, sl.item_id, sl.created_by_id, sl.token, sl.status::text AS status, sl.access_mode::text AS access_mode, sl.is_one_time_use, sl.access_count, sl.max_access_count, sl.expires_at, sl.created_at, sl.last_accessed_at, i.vault_id FROM share_link sl INNER JOIN item i ON i.id = sl.item_id WHERE sl.id = $1 LIMIT 1",
	)
	.bind(link_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load share link"); internal_error("Failed to load share link") })?;

    let Some(link) = link else {
        return Ok(None);
    };

    let actor_role = query_scalar::<_, String>(
        "SELECT role::text AS role FROM vault_key WHERE vault_id = $1 AND user_id = $2 LIMIT 1",
    )
    .bind(&link.vault_id)
    .bind(actor_user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load actor vault access");
        internal_error("Failed to load actor vault access")
    })?;

    let Some(actor_role) = actor_role else {
        return Ok(None);
    };
    let can_view =
        actor_role == "owner" || actor_role == "admin" || link.created_by_id == actor_user_id;
    if !can_view {
        return Ok(None);
    }

    let allowed_emails = query_as::<_, DbShareLinkAllowedEmailRow>(
		"SELECT id, share_link_id, email, verified, verified_at, created_at FROM share_link_allowed_email WHERE share_link_id = $1 ORDER BY created_at ASC",
	)
	.bind(link_id)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load share link allowed emails"); internal_error("Failed to load share link allowed emails") })?;

    Ok(Some(VisibleShareLink {
        link,
        allowed_emails,
        actor_role,
    }))
}

async fn load_public_share_link_by_token(
    pool: &PgPool,
    token: &str,
) -> Result<Option<DbPublicShareLinkRow>, ShareRpcError> {
    query_as::<_, DbPublicShareLinkRow>(
		"SELECT id, created_by_id, token, status::text AS status, access_mode::text AS access_mode, is_one_time_use, encrypted_item_data, encryption_iv, encrypted_share_key, share_key_iv, access_count, max_access_count, expires_at FROM share_link WHERE token = $1 LIMIT 1",
	)
	.bind(token)
	.fetch_optional(pool)
	.await
	.map_err(|_| internal_error("Failed to load public share link"))
}

async fn load_public_share_link_details_by_token(
    pool: &PgPool,
    token: &str,
    required_access_mode: Option<&str>,
) -> Result<Option<PublicShareLinkDetails>, ShareRpcError> {
    let link = match required_access_mode {
		Some(access_mode) => query_as::<_, DbPublicShareLinkRow>(
			"SELECT id, created_by_id, token, status::text AS status, access_mode::text AS access_mode, is_one_time_use, encrypted_item_data, encryption_iv, encrypted_share_key, share_key_iv, access_count, max_access_count, expires_at FROM share_link WHERE token = $1 AND access_mode = $2::share_link_access_mode LIMIT 1",
		)
		.bind(token)
		.bind(access_mode)
		.fetch_optional(pool)
		.await,
		None => query_as::<_, DbPublicShareLinkRow>(
			"SELECT id, created_by_id, token, status::text AS status, access_mode::text AS access_mode, is_one_time_use, encrypted_item_data, encryption_iv, encrypted_share_key, share_key_iv, access_count, max_access_count, expires_at FROM share_link WHERE token = $1 LIMIT 1",
		)
		.bind(token)
		.fetch_optional(pool)
		.await,
	}
	.map_err(|e| { tracing::error!(error = %e, "Failed to load public share link details"); internal_error("Failed to load public share link details") })?;

    let Some(link) = link else {
        return Ok(None);
    };
    let allowed_emails = query_as::<_, DbShareLinkAllowedEmailRow>(
		"SELECT id, share_link_id, email, verified, verified_at, created_at FROM share_link_allowed_email WHERE share_link_id = $1 ORDER BY created_at ASC",
	)
	.bind(&link.id)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load public share link allowed emails"); internal_error("Failed to load public share link allowed emails") })?;

    Ok(Some(PublicShareLinkDetails {
        link,
        allowed_emails,
    }))
}

async fn load_allowed_emails_for_links(
    pool: &PgPool,
    link_ids: &[String],
) -> Result<HashMap<String, Vec<DbShareLinkAllowedEmailRow>>, ShareRpcError> {
    if link_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = query_as::<_, DbShareLinkAllowedEmailRow>(
		"SELECT id, share_link_id, email, verified, verified_at, created_at FROM share_link_allowed_email WHERE share_link_id = ANY($1) ORDER BY created_at ASC",
	)
	.bind(link_ids)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load share link allowed emails"); internal_error("Failed to load share link allowed emails") })?;

    let mut grouped = HashMap::new();
    for row in rows {
        grouped
            .entry(row.share_link_id.clone())
            .or_insert_with(Vec::new)
            .push(row);
    }

    Ok(grouped)
}

async fn assert_share_links_entitlement(
    pool: &PgPool,
    user_id: &str,
) -> Result<ShareLinksAccess, ShareRpcError> {
    let access = resolve_share_links_access(pool, user_id).await?;
    if access.enabled {
        Ok(access)
    } else {
        Err(forbidden_error(SHARE_LINKS_UNAVAILABLE_MESSAGE))
    }
}

async fn has_share_links_entitlement(pool: &PgPool, user_id: &str) -> Result<bool, ShareRpcError> {
    Ok(resolve_share_links_access(pool, user_id).await?.enabled)
}

async fn resolve_share_links_access(
    pool: &PgPool,
    user_id: &str,
) -> Result<ShareLinksAccess, ShareRpcError> {
    if bittery_mode() == "self-hosted" {
        return Ok(ShareLinksAccess {
            enabled: true,
            max_active_links: None,
            team_id: None,
        });
    }

    let actor = query_as::<_, DbTeamBillingEntitlementRow>(
		"SELECT u.team_id, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load share link entitlements"); internal_error("Failed to load share link entitlements") })?;

    let Some(actor) = actor else {
        return Ok(ShareLinksAccess {
            enabled: false,
            max_active_links: Some(0),
            team_id: None,
        });
    };
    let Some(team_id) = actor.team_id else {
        return Ok(ShareLinksAccess {
            enabled: false,
            max_active_links: Some(0),
            team_id: None,
        });
    };
    let Some(billing_plan) = actor.billing_plan else {
        return Ok(ShareLinksAccess {
            enabled: false,
            max_active_links: Some(0),
            team_id: Some(team_id),
        });
    };
    let Some(billing_status) = actor.billing_status else {
        return Ok(ShareLinksAccess {
            enabled: false,
            max_active_links: Some(0),
            team_id: Some(team_id),
        });
    };

    let is_active = matches!(billing_status.as_str(), "active" | "trialing");
    let paid_inactive = billing_plan != "free" && !is_active;
    let enabled = matches!(billing_plan.as_str(), "personal" | "family" | "team") && !paid_inactive;
    let max_active_links = match billing_plan.as_str() {
        "personal" => Some(5),
        "family" | "team" => None,
        _ => Some(0),
    };

    Ok(ShareLinksAccess {
        enabled,
        max_active_links,
        team_id: Some(team_id),
    })
}

async fn record_share_audit_event(
    pool: &PgPool,
    user_id: &str,
    action: &str,
    entity_id: &str,
) -> Result<(), ShareRpcError> {
    query(
		"INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
	)
	.bind(generate_share_id("audit"))
	.bind(user_id)
	.bind(action)
	.bind("share_link")
	.bind(entity_id)
	.bind(time::OffsetDateTime::now_utc())
	.execute(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to record share audit event"); internal_error("Failed to record share audit event") })?;

    Ok(())
}

async fn log_share_access(
    pool: &PgPool,
    share_link_id: &str,
    email: Option<&str>,
    success: bool,
    failure_reason: Option<&str>,
) -> Result<(), ShareRpcError> {
    query(
		"INSERT INTO share_access_log (id, share_link_id, accessed_by_email, ip_address, user_agent, success, failure_reason, accessed_at) VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6)",
	)
	.bind(generate_share_id("share_access"))
	.bind(share_link_id)
	.bind(email)
	.bind(success)
	.bind(failure_reason)
	.bind(time::OffsetDateTime::now_utc())
	.execute(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to record share access log"); internal_error("Failed to record share access log") })?;

    Ok(())
}

async fn get_public_share_state(
    pool: &PgPool,
    link: &DbPublicShareLinkRow,
) -> Result<PublicShareState, ShareRpcError> {
    if !has_share_links_entitlement(pool, &link.created_by_id).await? {
        return Ok(PublicShareState {
            valid: false,
            reason: Some("disabled".to_string()),
        });
    }
    if link.status == "revoked" {
        return Ok(PublicShareState {
            valid: false,
            reason: Some("revoked".to_string()),
        });
    }
    if link.expires_at < time::OffsetDateTime::now_utc() {
        return Ok(PublicShareState {
            valid: false,
            reason: Some("expired".to_string()),
        });
    }
    if let Some(max_access_count) = link.max_access_count {
        if link.access_count >= max_access_count {
            return Ok(PublicShareState {
                valid: false,
                reason: Some("exhausted".to_string()),
            });
        }
    }

    Ok(PublicShareState {
        valid: true,
        reason: None,
    })
}

async fn consume_share_link_access(
    pool: &PgPool,
    share_link_id: &str,
    now: time::OffsetDateTime,
) -> Result<bool, ShareRpcError> {
    let updated_rows = query(
		"UPDATE share_link SET access_count = access_count + 1, last_accessed_at = $2, status = CASE WHEN max_access_count IS NOT NULL AND access_count + 1 >= max_access_count THEN 'exhausted'::share_link_status ELSE status END WHERE id = $1 AND status = 'active' AND expires_at > $2 AND (max_access_count IS NULL OR access_count < max_access_count)",
	)
	.bind(share_link_id)
	.bind(now)
	.execute(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to consume share link access"); internal_error("Failed to consume share link access") })?
	.rows_affected();

    Ok(updated_rows > 0)
}

async fn check_and_increment_share_rate_limit(
    pool: &PgPool,
    user_id: &str,
) -> Result<(), ShareRpcError> {
    let namespace = "share_create_daily";
    let now = time::OffsetDateTime::now_utc();
    let window_start = start_of_local_day();
    let limit = share_link_daily_limit();

    query(
		"INSERT INTO rate_limit_state (scope, key, subject, count, window_start_at, updated_at) VALUES ($1, $2, $3, 0, $4, $5) ON CONFLICT DO NOTHING",
	)
	.bind(namespace)
	.bind(user_id)
	.bind(user_id)
	.bind(window_start)
	.bind(now)
	.execute(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to initialize share rate limit state"); internal_error("Failed to initialize share rate limit state") })?;

    let count = query_scalar::<_, Option<i32>>(
		"UPDATE rate_limit_state SET count = CASE WHEN window_start_at IS NULL OR window_start_at < $3 THEN 1 ELSE count + 1 END, window_start_at = CASE WHEN window_start_at IS NULL OR window_start_at < $3 THEN $3 ELSE window_start_at END, updated_at = $4 WHERE scope = $1 AND key = $2 AND ((window_start_at IS NULL OR window_start_at < $3) OR count < $5) RETURNING count",
	)
	.bind(namespace)
	.bind(user_id)
	.bind(window_start)
	.bind(now)
	.bind(limit as i32)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to increment share rate limit window"); internal_error("Failed to increment share rate limit window") })?;

    if count.flatten().is_none() {
        return Err(ShareRpcError {
            code: "TOO_MANY_REQUESTS".to_string(),
            message: "Daily share link limit reached".to_string(),
        });
    }

    Ok(())
}

async fn count_active_share_links(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    team_id: Option<&str>,
    user_id: &str,
    now: time::OffsetDateTime,
) -> Result<i64, ShareRpcError> {
    let count = match team_id {
		Some(team_id) => query_scalar::<_, i64>(
			"SELECT COUNT(*)::bigint FROM share_link sl INNER JOIN \"user\" u ON sl.created_by_id = u.id WHERE u.team_id = $1 AND sl.status = 'active' AND sl.expires_at > $2 AND (sl.max_access_count IS NULL OR sl.access_count < sl.max_access_count)",
		)
		.bind(team_id)
		.bind(now)
		.fetch_one(&mut **transaction)
		.await,
		None => query_scalar::<_, i64>(
			"SELECT COUNT(*)::bigint FROM share_link WHERE created_by_id = $1 AND status = 'active' AND expires_at > $2 AND (max_access_count IS NULL OR access_count < max_access_count)",
		)
		.bind(user_id)
		.bind(now)
		.fetch_one(&mut **transaction)
		.await,
	}
	.map_err(|e| { tracing::error!(error = %e, "Failed to count active share links"); internal_error("Failed to count active share links") })?;

    Ok(count)
}

fn unique_email_ids(ids: &[String]) -> Result<Vec<String>, ShareRpcError> {
    let mut unique = Vec::new();
    for id in ids {
        if unique.iter().any(|existing| existing == id) {
            return Err(bad_request_error(
                "Duplicate removeEmailIds are not allowed",
            ));
        }
        unique.push(id.clone());
    }
    Ok(unique)
}

fn validate_create_share_input(input: &CreateShareLinkInput) -> Result<(), ShareRpcError> {
    if input.access_mode != "anyone" && input.access_mode != "email-restricted" {
        return Err(bad_request_error("Invalid access mode"));
    }
    if input.encrypted_item_data.is_empty()
        || input.encryption_iv.is_empty()
        || input.encrypted_share_key.is_empty()
        || input.share_key_iv.is_empty()
    {
        return Err(bad_request_error("Missing encrypted share payload"));
    }
    if input.access_mode == "email-restricted" {
        let Some(allowed_emails) = input.allowed_emails.as_ref() else {
            return Err(bad_request_error(
                "At least one email address is required for email-restricted sharing",
            ));
        };
        if allowed_emails.is_empty() {
            return Err(bad_request_error(
                "At least one email address is required for email-restricted sharing",
            ));
        }
        if allowed_emails.len() > 100 {
            return Err(bad_request_error("Too many allowed emails"));
        }
        for email in allowed_emails {
            validate_email(email)?;
        }
    }

    Ok(())
}

fn calculate_expiration(expires_in: &str) -> Result<time::OffsetDateTime, ShareRpcError> {
    let duration = match expires_in {
        "1hour" => time::Duration::hours(1),
        "1day" => time::Duration::days(1),
        "7days" => time::Duration::days(7),
        "14days" => time::Duration::days(14),
        "30days" => time::Duration::days(30),
        _ => return Err(bad_request_error("Invalid expiration option")),
    };

    Ok(time::OffsetDateTime::now_utc() + duration)
}

fn validate_public_token(token: &str) -> Result<(), ShareRpcError> {
    if token.len() != 32
        || !token
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err(not_found_error("Share link not found or invalid"));
    }
    Ok(())
}

fn validate_email(email: &str) -> Result<(), ShareRpcError> {
    if email_regex().is_match(email) {
        Ok(())
    } else {
        Err(bad_request_error(&format!("Invalid email format: {email}")))
    }
}

struct PublicShareState {
    valid: bool,
    reason: Option<String>,
}

fn base_share_url() -> String {
    let web_app_url = std::env::var("WEB_APP_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "https://app.bittery.com".to_string());
    format!("{}/share/", web_app_url.trim_end_matches('/'))
}

fn db_pool(ctx: &RefreshSessionContext) -> Result<&PgPool, ShareRpcError> {
    ctx.app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| internal_error("Database is not configured"))
}

fn bittery_mode() -> &'static str {
    match std::env::var("BITTERY_MODE") {
        Ok(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            if normalized == "self-hosted"
                || normalized == "self_hosted"
                || normalized == "selfhosted"
            {
                "self-hosted"
            } else {
                "cloud"
            }
        }
        Err(_) => "cloud",
    }
}

fn effective_share_link_status(link: &DbShareLinkRow, now: time::OffsetDateTime) -> String {
    if link.status == "active" && link.expires_at < now {
        "expired".to_string()
    } else if link.status == "active"
        && link.max_access_count.is_some()
        && link.access_count >= link.max_access_count.unwrap_or_default()
    {
        "exhausted".to_string()
    } else {
        link.status.clone()
    }
}

#[cfg(test)]
mod tests {
    use axum::http::{header::CONTENT_TYPE, HeaderMap, HeaderValue, StatusCode};
    use serde_json::{json, Value};
    use sqlx::{query, query_as, query_scalar, FromRow};

    use super::*;
    use crate::test_support::{
        acquire_env_lock, assign_user_to_team, authenticated_json_headers, seed_item, seed_team,
        seed_user, seed_vault, seed_vault_key, with_rpc_test_app,
    };

    struct ShareActorFixture {
        user_id: String,
        item_id: String,
    }

    struct ShareRouterFixture {
        owner_user_id: String,
        admin_user_id: String,
        member_user_id: String,
        read_only_user_id: String,
        outsider_user_id: String,
        item_id: String,
        owner_link_id: String,
        email_link_id: String,
        email_link_token: String,
        member_link_id: String,
        read_only_link_id: String,
        one_time_link_id: String,
        one_time_token: String,
        revoked_token: String,
        allowed_email_id: String,
        allowed_email: String,
        removable_email_id: String,
        removable_email: String,
        request_email: String,
        verification_code: String,
    }

    const FIXTURE_ENCRYPTED_ITEM_DATA: &str = "fixture-encrypted-item-data";
    const FIXTURE_ENCRYPTION_IV: &str = "fixture-item-iv";
    const FIXTURE_ENCRYPTED_SHARE_KEY: &str = "fixture-encrypted-share-key";
    const FIXTURE_SHARE_KEY_IV: &str = "fixture-share-key-iv";

    fn sample_create_share_input() -> CreateShareLinkInput {
        CreateShareLinkInput {
            item_id: "item_123".to_string(),
            access_mode: "anyone".to_string(),
            is_one_time_use: false,
            expires_in: "1day".to_string(),
            allowed_emails: None,
            encrypted_item_data: "encrypted-item-data".to_string(),
            encryption_iv: "item-iv".to_string(),
            encrypted_share_key: "encrypted-share-key".to_string(),
            share_key_iv: "share-key-iv".to_string(),
        }
    }

    fn sample_share_link_row() -> DbShareLinkRow {
        let now = time::OffsetDateTime::now_utc();
        DbShareLinkRow {
            id: "share_link_123".to_string(),
            item_id: "item_123".to_string(),
            created_by_id: "user_123".to_string(),
            token: "sharetoken1234567890ABCDEFGH1234".to_string(),
            status: "active".to_string(),
            access_mode: "anyone".to_string(),
            is_one_time_use: false,
            access_count: 0,
            max_access_count: None,
            expires_at: now + time::Duration::days(1),
            created_at: now,
            last_accessed_at: None,
            vault_id: "vault_123".to_string(),
        }
    }

    fn set_env_var(name: &str, value: Option<&str>) {
        match value {
            Some(value) => unsafe { std::env::set_var(name, value) },
            None => unsafe { std::env::remove_var(name) },
        }
    }

    fn restore_env_var(name: &str, previous: Option<String>) {
        match previous.as_deref() {
            Some(value) => unsafe { std::env::set_var(name, value) },
            None => unsafe { std::env::remove_var(name) },
        }
    }

    fn with_env_vars<T>(
        bittery_mode_value: Option<&str>,
        web_app_url_value: Option<&str>,
        share_link_daily_limit_value: Option<&str>,
        test_fn: impl FnOnce() -> T,
    ) -> T {
        let _guard = acquire_env_lock();
        let previous_mode = std::env::var("BITTERY_MODE").ok();
        let previous_web_app_url = std::env::var("WEB_APP_URL").ok();
        let previous_share_link_daily_limit = std::env::var("SHARE_LINK_DAILY_LIMIT").ok();

        set_env_var("BITTERY_MODE", bittery_mode_value);
        set_env_var("WEB_APP_URL", web_app_url_value);
        set_env_var("SHARE_LINK_DAILY_LIMIT", share_link_daily_limit_value);

        let result = test_fn();

        restore_env_var("BITTERY_MODE", previous_mode);
        restore_env_var("WEB_APP_URL", previous_web_app_url);
        restore_env_var("SHARE_LINK_DAILY_LIMIT", previous_share_link_daily_limit);

        result
    }

    #[derive(FromRow)]
    struct ShareLinkTestRow {
        id: String,
        created_by_id: String,
        access_mode: String,
        is_one_time_use: bool,
        max_access_count: Option<i32>,
    }

    #[derive(FromRow)]
    struct ShareLinkStateRow {
        status: String,
        access_count: i32,
        max_access_count: Option<i32>,
        is_one_time_use: bool,
        last_accessed_at: Option<time::OffsetDateTime>,
    }

    #[derive(FromRow)]
    struct ShareAllowedEmailStateRow {
        email: String,
        verified: bool,
        verified_at: Option<time::OffsetDateTime>,
    }

    #[derive(FromRow)]
    struct ShareVerificationStateRow {
        attempts: i32,
        used_at: Option<time::OffsetDateTime>,
    }

    #[test]
    fn validate_create_share_input_accepts_anyone_and_rejects_invalid_email_restrictions() {
        assert!(validate_create_share_input(&sample_create_share_input()).is_ok());

        let mut missing_allowed_emails = sample_create_share_input();
        missing_allowed_emails.access_mode = "email-restricted".to_string();
        let error = validate_create_share_input(&missing_allowed_emails)
            .expect_err("email-restricted shares should require allowed emails");
        assert_eq!(error.code, "BAD_REQUEST");
        assert_eq!(
            error.message,
            "At least one email address is required for email-restricted sharing"
        );

        let mut invalid_email_input = sample_create_share_input();
        invalid_email_input.access_mode = "email-restricted".to_string();
        invalid_email_input.allowed_emails = Some(vec!["not-an-email".to_string()]);
        let error = validate_create_share_input(&invalid_email_input)
            .expect_err("invalid email addresses should be rejected");
        assert_eq!(error.code, "BAD_REQUEST");
        assert_eq!(error.message, "Invalid email format: not-an-email");
    }

    #[test]
    fn calculate_expiration_supports_known_values_and_rejects_unknown_values() {
        let before = time::OffsetDateTime::now_utc();
        let expires_at =
            calculate_expiration("1day").expect("known expiration options should be accepted");
        let after = time::OffsetDateTime::now_utc();

        assert!(expires_at >= before + time::Duration::days(1));
        assert!(expires_at <= after + time::Duration::days(1));

        let error = calculate_expiration("2weeks")
            .expect_err("unknown expiration options should be rejected");
        assert_eq!(error.code, "BAD_REQUEST");
        assert_eq!(error.message, "Invalid expiration option");
    }

    #[test]
    fn validate_public_token_requires_expected_length_and_charset() {
        assert!(validate_public_token("AbCdEf1234567890AbCdEf1234567890").is_ok());

        let short_error =
            validate_public_token("short").expect_err("short tokens should be rejected");
        assert_eq!(short_error.code, "NOT_FOUND");
        assert_eq!(short_error.message, "Share link not found or invalid");

        let invalid_char_error = validate_public_token("AbCdEf1234567890AbCdEf123456789!")
            .expect_err("tokens with invalid characters should be rejected");
        assert_eq!(invalid_char_error.code, "NOT_FOUND");
        assert_eq!(
            invalid_char_error.message,
            "Share link not found or invalid"
        );
    }

    #[test]
    fn unique_email_ids_preserves_order_and_rejects_duplicates() {
        let unique_ids = unique_email_ids(&[
            "email_1".to_string(),
            "email_2".to_string(),
            "email_3".to_string(),
        ])
        .expect("unique ids should be accepted");
        assert_eq!(
            unique_ids,
            vec![
                "email_1".to_string(),
                "email_2".to_string(),
                "email_3".to_string(),
            ]
        );

        let error = unique_email_ids(&["email_1".to_string(), "email_1".to_string()])
            .expect_err("duplicate ids should be rejected");
        assert_eq!(error.code, "BAD_REQUEST");
        assert_eq!(error.message, "Duplicate removeEmailIds are not allowed");
    }

    #[test]
    fn effective_share_link_status_reports_expired_and_exhausted_states() {
        let now = time::OffsetDateTime::now_utc();

        let mut expired_link = sample_share_link_row();
        expired_link.expires_at = now - time::Duration::minutes(1);
        assert_eq!(effective_share_link_status(&expired_link, now), "expired");

        let mut exhausted_link = sample_share_link_row();
        exhausted_link.max_access_count = Some(1);
        exhausted_link.access_count = 1;
        assert_eq!(
            effective_share_link_status(&exhausted_link, now),
            "exhausted"
        );

        let revoked_link = DbShareLinkRow {
            status: "revoked".to_string(),
            ..sample_share_link_row()
        };
        assert_eq!(effective_share_link_status(&revoked_link, now), "revoked");
    }

    #[test]
    fn base_share_url_uses_trimmed_env_value_and_default_fallback() {
        with_env_vars(None, Some(" https://app.example.com/ "), None, || {
            assert_eq!(base_share_url(), "https://app.example.com/share/");
        });

        with_env_vars(None, Some("   "), None, || {
            assert_eq!(base_share_url(), "https://app.bittery.com/share/");
        });
    }

    #[test]
    fn bittery_mode_normalizes_self_hosted_aliases_and_defaults_to_cloud() {
        with_env_vars(Some("self_hosted"), None, None, || {
            assert_eq!(bittery_mode(), "self-hosted");
        });

        with_env_vars(Some("SELFHOSTED"), None, None, || {
            assert_eq!(bittery_mode(), "self-hosted");
        });

        with_env_vars(Some("cloud"), None, None, || {
            assert_eq!(bittery_mode(), "cloud");
        });

        with_env_vars(None, None, None, || {
            assert_eq!(bittery_mode(), "cloud");
        });
    }

    #[test]
    fn share_link_daily_limit_uses_positive_env_value_or_default() {
        with_env_vars(None, None, Some("75"), || {
            assert_eq!(share_link_daily_limit(), 75);
        });

        with_env_vars(None, None, Some("0"), || {
            assert_eq!(share_link_daily_limit(), DEFAULT_SHARE_LINK_DAILY_LIMIT);
        });

        with_env_vars(None, None, Some("not-a-number"), || {
            assert_eq!(share_link_daily_limit(), DEFAULT_SHARE_LINK_DAILY_LIMIT);
        });
    }

    fn share_token(fill: char) -> String {
        std::iter::repeat(fill).take(32).collect()
    }

    fn unauthenticated_json_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert("x-app-platform", HeaderValue::from_static("desktop"));
        headers.insert("x-client-id", HeaderValue::from_static("integration-test"));
        headers
    }

    fn assert_handler_error(body: &Value, code: &str, message: &str) {
        assert_eq!(body["jsonrpc"], json!("2.0"));
        assert_eq!(body["result"]["Err"]["code"], json!(code));
        assert_eq!(body["result"]["Err"]["message"], json!(message));
    }

    fn assert_rpc_error(body: &Value, code: &str, message: &str) {
        assert_eq!(body["jsonrpc"], json!("2.0"));
        assert_eq!(body["error"]["message"], json!(message));
        assert_eq!(body["error"]["data"]["code"], json!(code));
    }

    fn assert_invalid_params_error(body: &Value) {
        assert_eq!(body["jsonrpc"], json!("2.0"));
        assert!(
            body["error"].is_object(),
            "unexpected invalid params body: {body}"
        );
        let message = body["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .to_ascii_lowercase();
        assert!(
            message.contains("invalid params"),
            "unexpected invalid params message: {body}",
        );
    }

    #[tokio::test]
    async fn protected_share_handlers_require_authentication() {
        with_rpc_test_app("share_handlers_require_authentication", |app| async move {
            let fixture = build_share_router_fixture(&app.pool).await;

            let protected_calls = vec![
                (
                    "share.create",
                    json!([{
                        "itemId": fixture.item_id.clone(),
                        "accessMode": "anyone",
                        "isOneTimeUse": false,
                        "expiresIn": "1day",
                        "allowedEmails": null,
                        "encryptedItemData": FIXTURE_ENCRYPTED_ITEM_DATA,
                        "encryptionIv": FIXTURE_ENCRYPTION_IV,
                        "encryptedShareKey": FIXTURE_ENCRYPTED_SHARE_KEY,
                        "shareKeyIv": FIXTURE_SHARE_KEY_IV
                    }]),
                ),
                (
                    "share.listByItem",
                    json!([{ "itemId": fixture.item_id.clone() }]),
                ),
                (
                    "share.get",
                    json!([{ "linkId": fixture.owner_link_id.clone() }]),
                ),
                (
                    "share.revoke",
                    json!([{ "linkId": fixture.owner_link_id.clone() }]),
                ),
                (
                    "share.update",
                    json!([{ "linkId": fixture.email_link_id.clone() }]),
                ),
                (
                    "share.getAccessLogs",
                    json!([{ "linkId": fixture.owner_link_id.clone() }]),
                ),
            ];

            for (method, params) in protected_calls {
                let response = app
                    .rpc_call(method, params, unauthenticated_json_headers())
                    .await;
                assert_eq!(
                    response.status,
                    StatusCode::OK,
                    "unexpected status for {method}"
                );
                assert_rpc_error(&response.body, "UNAUTHORIZED", "Authentication required");
            }
        })
        .await;
    }

    #[tokio::test]
    async fn share_handlers_reject_malformed_params() {
        with_rpc_test_app("share_handlers_reject_malformed_params", |app| async move {
            let fixture = build_share_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let headers = authenticated_json_headers(&session.token);
            let malformed_calls = vec![
                "share.create",
                "share.listByItem",
                "share.get",
                "share.revoke",
                "share.update",
                "share.getAccessLogs",
                "share.getPublicInfo",
                "share.requestEmailVerification",
                "share.verifyEmailAndAccess",
                "share.accessPublic",
            ];

            for method in malformed_calls {
                let response = app.rpc_call(method, json!([{}]), headers.clone()).await;
                assert_eq!(
                    response.status,
                    StatusCode::OK,
                    "unexpected status for {method}"
                );
                assert_invalid_params_error(&response.body);
            }
        })
        .await;
    }

    #[tokio::test]
    async fn create_share_via_rpc_rejects_read_only_users() {
        with_rpc_test_app("share_create_read_only_forbidden", |app| async move {
            let fixture = build_share_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.read_only_user_id).await;

            let response = app
                .rpc_call(
                    "share.create",
                    json!([{
                        "itemId": fixture.item_id,
                        "accessMode": "anyone",
                        "isOneTimeUse": false,
                        "expiresIn": "1day",
                        "allowedEmails": null,
                        "encryptedItemData": FIXTURE_ENCRYPTED_ITEM_DATA,
                        "encryptionIv": FIXTURE_ENCRYPTION_IV,
                        "encryptedShareKey": FIXTURE_ENCRYPTED_SHARE_KEY,
                        "shareKeyIv": FIXTURE_SHARE_KEY_IV
                    }]),
                    authenticated_json_headers(&session.token),
                )
                .await;

            assert_eq!(response.status, StatusCode::OK);
            assert_handler_error(
                &response.body,
                "FORBIDDEN",
                "Read-only users cannot share items",
            );

            let share_link_count = query_scalar::<_, i64>(
                "SELECT COUNT(*)::bigint FROM share_link WHERE created_by_id = $1",
            )
            .bind(&fixture.read_only_user_id)
            .fetch_one(&app.pool)
            .await
            .expect("read-only share link count should load");

            assert_eq!(share_link_count, 1);
        })
        .await;
    }

    #[tokio::test]
    async fn list_by_item_returns_visible_links_for_owners_and_members() {
        with_rpc_test_app("share_list_by_item_visibility", |app| async move {
            let fixture = build_share_router_fixture(&app.pool).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let member_session = app.issue_session(&fixture.member_user_id).await;

            let owner_response = app
                .rpc_call(
                    "share.listByItem",
                    json!([{ "itemId": fixture.item_id.clone() }]),
                    authenticated_json_headers(&owner_session.token),
                )
                .await;
            assert_eq!(owner_response.status, StatusCode::OK);
            let owner_links = owner_response.body["result"]["Ok"]["links"]
                .as_array()
                .expect("owner links should be an array");
            let owner_link_ids = owner_links
                .iter()
                .map(|link| link["id"].as_str().expect("link id should be present"))
                .collect::<Vec<_>>();
            assert_eq!(owner_links.len(), 6);
            for expected_id in [
                fixture.owner_link_id.as_str(),
                fixture.email_link_id.as_str(),
                fixture.member_link_id.as_str(),
                fixture.read_only_link_id.as_str(),
                fixture.one_time_link_id.as_str(),
            ] {
                assert!(owner_link_ids.contains(&expected_id));
            }

            let member_response = app
                .rpc_call(
                    "share.listByItem",
                    json!([{ "itemId": fixture.item_id }]),
                    authenticated_json_headers(&member_session.token),
                )
                .await;
            assert_eq!(member_response.status, StatusCode::OK);
            let member_links = member_response.body["result"]["Ok"]["links"]
                .as_array()
                .expect("member links should be an array");
            assert_eq!(member_links.len(), 1);
            assert_eq!(
                member_links[0]["id"],
                json!(fixture.member_link_id),
                "members should only see links they created",
            );
        })
        .await;
    }

    #[tokio::test]
    async fn list_by_item_returns_not_found_for_inaccessible_items() {
        with_rpc_test_app("share_list_by_item_not_found", |app| async move {
            let fixture = build_share_router_fixture(&app.pool).await;
            let outsider_session = app.issue_session(&fixture.outsider_user_id).await;

            let response = app
                .rpc_call(
                    "share.listByItem",
                    json!([{ "itemId": fixture.item_id }]),
                    authenticated_json_headers(&outsider_session.token),
                )
                .await;

            assert_eq!(response.status, StatusCode::OK);
            assert_handler_error(&response.body, "NOT_FOUND", "Item not found");
        })
        .await;
    }

    #[tokio::test]
    async fn get_share_link_returns_details_for_visible_links_and_not_found_for_hidden_links() {
        with_rpc_test_app("share_get_visibility", |app| async move {
            let fixture = build_share_router_fixture(&app.pool).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let member_session = app.issue_session(&fixture.member_user_id).await;

            let owner_response = app
                .rpc_call(
                    "share.get",
                    json!([{ "linkId": fixture.email_link_id.clone() }]),
                    authenticated_json_headers(&owner_session.token),
                )
                .await;

            assert_eq!(owner_response.status, StatusCode::OK);
            assert_eq!(
                owner_response.body["result"]["Ok"]["id"],
                json!(fixture.email_link_id)
            );
            assert_eq!(
                owner_response.body["result"]["Ok"]["token"],
                json!(fixture.email_link_token)
            );
            assert_eq!(
                owner_response.body["result"]["Ok"]["accessMode"],
                json!("email-restricted")
            );
            let allowed_emails = owner_response.body["result"]["Ok"]["allowedEmails"]
                .as_array()
                .expect("allowed emails should be present");
            assert_eq!(allowed_emails.len(), 3);
            assert!(allowed_emails
                .iter()
                .any(|entry| entry["email"] == json!(fixture.allowed_email)));

            let hidden_response = app
                .rpc_call(
                    "share.get",
                    json!([{ "linkId": fixture.owner_link_id }]),
                    authenticated_json_headers(&member_session.token),
                )
                .await;

            assert_eq!(hidden_response.status, StatusCode::OK);
            assert_handler_error(&hidden_response.body, "NOT_FOUND", "Share link not found");
        })
        .await;
    }

    #[tokio::test]
    async fn revoke_share_link_enforces_role_rules_and_updates_status() {
        with_rpc_test_app("share_revoke_paths", |app| async move {
            let fixture = build_share_router_fixture(&app.pool).await;
            let admin_session = app.issue_session(&fixture.admin_user_id).await;
            let member_session = app.issue_session(&fixture.member_user_id).await;
            let outsider_session = app.issue_session(&fixture.outsider_user_id).await;

            let forbidden_response = app
                .rpc_call(
                    "share.revoke",
                    json!([{ "linkId": fixture.owner_link_id.clone() }]),
                    authenticated_json_headers(&admin_session.token),
                )
                .await;
            assert_eq!(forbidden_response.status, StatusCode::OK);
            assert_handler_error(
                &forbidden_response.body,
                "FORBIDDEN",
                "You do not have permission to revoke this link",
            );

            let success_response = app
                .rpc_call(
                    "share.revoke",
                    json!([{ "linkId": fixture.member_link_id.clone() }]),
                    authenticated_json_headers(&member_session.token),
                )
                .await;
            assert_eq!(success_response.status, StatusCode::OK);
            assert_eq!(
                success_response.body["result"]["Ok"]["success"],
                json!(true)
            );

            let status = query_scalar::<_, String>(
                "SELECT status::text AS status FROM share_link WHERE id = $1",
            )
            .bind(&fixture.member_link_id)
            .fetch_one(&app.pool)
            .await
            .expect("revoked share link status should load");
            assert_eq!(status, "revoked");

            let hidden_response = app
                .rpc_call(
                    "share.revoke",
                    json!([{ "linkId": fixture.owner_link_id }]),
                    authenticated_json_headers(&outsider_session.token),
                )
                .await;
            assert_eq!(hidden_response.status, StatusCode::OK);
            assert_handler_error(&hidden_response.body, "NOT_FOUND", "Share link not found");
        })
        .await;
    }

    #[tokio::test]
    async fn update_share_link_updates_access_and_email_membership() {
        with_rpc_test_app("share_update_success", |app| async move {
			let fixture = build_share_router_fixture(&app.pool).await;
			let owner_session = app.issue_session(&fixture.owner_user_id).await;
			let added_email = "added@example.com";

			let response = app
				.rpc_call(
					"share.update",
					json!([{
						"linkId": fixture.email_link_id.clone(),
						"isOneTimeUse": true,
						"addEmails": [added_email],
						"removeEmailIds": [fixture.removable_email_id.clone()]
					}]),
					authenticated_json_headers(&owner_session.token),
				)
				.await;

			assert_eq!(response.status, StatusCode::OK);
			assert_eq!(response.body["result"]["Ok"]["success"], json!(true));

			let link_state = query_as::<_, ShareLinkStateRow>(
				"SELECT status::text AS status, access_count, max_access_count, is_one_time_use, last_accessed_at FROM share_link WHERE id = $1 LIMIT 1",
			)
			.bind(&fixture.email_link_id)
			.fetch_one(&app.pool)
			.await
			.expect("updated share link state should load");
			assert_eq!(link_state.status, "active");
			assert!(link_state.is_one_time_use);
			assert_eq!(link_state.max_access_count, Some(1));

			let allowed_emails = query_scalar::<_, String>(
				"SELECT email FROM share_link_allowed_email WHERE share_link_id = $1 ORDER BY email ASC",
			)
			.bind(&fixture.email_link_id)
			.fetch_all(&app.pool)
			.await
			.expect("updated allowed emails should load");
			assert_eq!(
				allowed_emails,
				vec![
					added_email.to_string(),
					fixture.allowed_email.clone(),
					fixture.request_email.clone(),
				],
			);

			let removed_verification = query_as::<_, ShareVerificationStateRow>(
				"SELECT attempts, used_at FROM share_email_verification WHERE share_link_id = $1 AND email = $2 LIMIT 1",
			)
			.bind(&fixture.email_link_id)
			.bind(&fixture.removable_email)
			.fetch_one(&app.pool)
			.await
			.expect("removed verification should load");
			assert!(removed_verification.used_at.is_some());
		})
		.await;
    }

    #[tokio::test]
    async fn update_share_link_rejects_read_only_actors_and_invalid_emails() {
        with_rpc_test_app("share_update_rejections", |app| async move {
            let fixture = build_share_router_fixture(&app.pool).await;
            let read_only_session = app.issue_session(&fixture.read_only_user_id).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;

            let forbidden_response = app
                .rpc_call(
                    "share.update",
                    json!([{ "linkId": fixture.read_only_link_id.clone(), "isOneTimeUse": true }]),
                    authenticated_json_headers(&read_only_session.token),
                )
                .await;
            assert_eq!(forbidden_response.status, StatusCode::OK);
            assert_handler_error(&forbidden_response.body, "FORBIDDEN", "Access denied");

            let invalid_email_response = app
                .rpc_call(
                    "share.update",
                    json!([{
                        "linkId": fixture.email_link_id.clone(),
                        "addEmails": ["not-an-email"]
                    }]),
                    authenticated_json_headers(&owner_session.token),
                )
                .await;
            assert_eq!(invalid_email_response.status, StatusCode::OK);
            assert_handler_error(
                &invalid_email_response.body,
                "BAD_REQUEST",
                "Invalid email format: not-an-email",
            );
        })
        .await;
    }

    #[tokio::test]
    async fn get_access_logs_returns_entries_and_not_found_for_hidden_links() {
        with_rpc_test_app("share_access_logs_paths", |app| async move {
            let fixture = build_share_router_fixture(&app.pool).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let member_session = app.issue_session(&fixture.member_user_id).await;

            let success_response = app
                .rpc_call(
                    "share.getAccessLogs",
                    json!([{ "linkId": fixture.owner_link_id.clone() }]),
                    authenticated_json_headers(&owner_session.token),
                )
                .await;
            assert_eq!(success_response.status, StatusCode::OK);
            let logs = success_response.body["result"]["Ok"]
                .as_array()
                .expect("share access logs should be an array");
            assert_eq!(logs.len(), 2);
            assert_eq!(logs[0]["accessedByEmail"], json!("viewer@example.com"));
            assert_eq!(logs[0]["success"], json!(true));
            assert_eq!(logs[1]["failureReason"], json!("Invalid code"));

            let hidden_response = app
                .rpc_call(
                    "share.getAccessLogs",
                    json!([{ "linkId": fixture.owner_link_id }]),
                    authenticated_json_headers(&member_session.token),
                )
                .await;
            assert_eq!(hidden_response.status, StatusCode::OK);
            assert_handler_error(&hidden_response.body, "NOT_FOUND", "Share link not found");
        })
        .await;
    }

    #[tokio::test]
    async fn get_public_info_returns_valid_and_invalid_states() {
        with_rpc_test_app("share_public_info_paths", |app| async move {
            let fixture = build_share_router_fixture(&app.pool).await;

            let valid_response = app
                .rpc_call(
                    "share.getPublicInfo",
                    json!([{ "token": fixture.one_time_token.clone() }]),
                    unauthenticated_json_headers(),
                )
                .await;
            assert_eq!(valid_response.status, StatusCode::OK);
            assert_eq!(valid_response.body["result"]["Ok"]["valid"], json!(true));
            assert_eq!(
                valid_response.body["result"]["Ok"]["accessMode"],
                json!("anyone")
            );
            assert_eq!(
                valid_response.body["result"]["Ok"]["isOneTimeUse"],
                json!(true)
            );
            assert!(valid_response.body["result"]["Ok"]["expiresAt"].is_string());

            let revoked_response = app
                .rpc_call(
                    "share.getPublicInfo",
                    json!([{ "token": fixture.revoked_token.clone() }]),
                    unauthenticated_json_headers(),
                )
                .await;
            assert_eq!(revoked_response.status, StatusCode::OK);
            assert_eq!(revoked_response.body["result"]["Ok"]["valid"], json!(false));
            assert_eq!(
                revoked_response.body["result"]["Ok"]["reason"],
                json!("revoked")
            );
            assert_eq!(
                revoked_response.body["result"]["Ok"]["isOneTimeUse"],
                Value::Null
            );

            let missing_response = app
                .rpc_call(
                    "share.getPublicInfo",
                    json!([{ "token": share_token('9') }]),
                    unauthenticated_json_headers(),
                )
                .await;
            assert_eq!(missing_response.status, StatusCode::OK);
            assert_handler_error(
                &missing_response.body,
                "NOT_FOUND",
                "Share link not found or invalid",
            );
        })
        .await;
    }

    #[tokio::test]
    async fn access_public_returns_payload_and_exhausts_one_time_links() {
        with_rpc_test_app("share_access_public_one_time", |app| async move {
			let fixture = build_share_router_fixture(&app.pool).await;

			let success_response = app
				.rpc_call(
					"share.accessPublic",
					json!([{ "token": fixture.one_time_token.clone() }]),
					unauthenticated_json_headers(),
				)
				.await;
			assert_eq!(success_response.status, StatusCode::OK);
			assert_eq!(
				success_response.body["result"]["Ok"]["encryptedItemData"],
				json!(FIXTURE_ENCRYPTED_ITEM_DATA),
			);
			assert_eq!(
				success_response.body["result"]["Ok"]["encryptedShareKey"],
				json!(FIXTURE_ENCRYPTED_SHARE_KEY),
			);

			let link_state = query_as::<_, ShareLinkStateRow>(
				"SELECT status::text AS status, access_count, max_access_count, is_one_time_use, last_accessed_at FROM share_link WHERE id = $1 LIMIT 1",
			)
			.bind(&fixture.one_time_link_id)
			.fetch_one(&app.pool)
			.await
			.expect("one-time share link state should load");
			assert_eq!(link_state.status, "exhausted");
			assert_eq!(link_state.access_count, 1);
			assert_eq!(link_state.max_access_count, Some(1));
			assert!(link_state.is_one_time_use);
			assert!(link_state.last_accessed_at.is_some());

			let exhausted_response = app
				.rpc_call(
					"share.accessPublic",
					json!([{ "token": fixture.one_time_token.clone() }]),
					unauthenticated_json_headers(),
				)
				.await;
			assert_eq!(exhausted_response.status, StatusCode::OK);
			assert_handler_error(
				&exhausted_response.body,
				"BAD_REQUEST",
				"This share link has been exhausted",
			);

			let access_log_count = query_scalar::<_, i64>(
				"SELECT COUNT(*)::bigint FROM share_access_log WHERE share_link_id = $1",
			)
			.bind(&fixture.one_time_link_id)
			.fetch_one(&app.pool)
			.await
			.expect("share access log count should load");
			assert_eq!(access_log_count, 2);
		})
		.await;
    }

    #[tokio::test]
    async fn access_public_rejects_non_public_and_revoked_links() {
        with_rpc_test_app("share_access_public_rejections", |app| async move {
            let fixture = build_share_router_fixture(&app.pool).await;

            let email_restricted_response = app
                .rpc_call(
                    "share.accessPublic",
                    json!([{ "token": fixture.email_link_token.clone() }]),
                    unauthenticated_json_headers(),
                )
                .await;
            assert_eq!(email_restricted_response.status, StatusCode::OK);
            assert_handler_error(
                &email_restricted_response.body,
                "NOT_FOUND",
                "Share link not found",
            );

            let revoked_response = app
                .rpc_call(
                    "share.accessPublic",
                    json!([{ "token": fixture.revoked_token }]),
                    unauthenticated_json_headers(),
                )
                .await;
            assert_eq!(revoked_response.status, StatusCode::OK);
            assert_handler_error(
                &revoked_response.body,
                "BAD_REQUEST",
                "This share link has been revoked",
            );
        })
        .await;
    }

    #[tokio::test]
    async fn request_email_verification_persists_codes_for_allowed_emails_and_rejects_invalid_access(
    ) {
        with_rpc_test_app("share_request_email_verification_paths", |app| async move {
            let fixture = build_share_router_fixture(&app.pool).await;

            let success_response = app
                .rpc_call(
                    "share.requestEmailVerification",
                    json!([{
                        "token": fixture.email_link_token.clone(),
                        "email": fixture.request_email.clone()
                    }]),
                    unauthenticated_json_headers(),
                )
                .await;
            assert_eq!(success_response.status, StatusCode::OK);
            assert_eq!(
                success_response.body["result"]["Ok"]["success"],
                json!(true)
            );
            assert_eq!(
                success_response.body["result"]["Ok"]["message"],
                json!("Verification code sent to your email"),
            );

            let verification_count = query_scalar::<_, i64>(
				"SELECT COUNT(*)::bigint FROM share_email_verification WHERE share_link_id = $1 AND email = $2",
			)
			.bind(&fixture.email_link_id)
			.bind(&fixture.request_email)
			.fetch_one(&app.pool)
			.await
			.expect("verification count should load");
            assert_eq!(verification_count, 1);

            let forbidden_response = app
                .rpc_call(
                    "share.requestEmailVerification",
                    json!([{
                        "token": fixture.email_link_token.clone(),
                        "email": "intruder@example.com"
                    }]),
                    unauthenticated_json_headers(),
                )
                .await;
            assert_eq!(forbidden_response.status, StatusCode::OK);
            assert_handler_error(
                &forbidden_response.body,
                "FORBIDDEN",
                "This email is not authorized to access this link",
            );

            let not_found_response = app
                .rpc_call(
                    "share.requestEmailVerification",
                    json!([{
                        "token": fixture.one_time_token,
                        "email": fixture.request_email
                    }]),
                    unauthenticated_json_headers(),
                )
                .await;
            assert_eq!(not_found_response.status, StatusCode::OK);
            assert_handler_error(
                &not_found_response.body,
                "NOT_FOUND",
                "Share link not found",
            );
        })
        .await;
    }

    #[tokio::test]
    async fn verify_email_and_access_returns_payload_and_marks_email_verified() {
        with_rpc_test_app("share_verify_email_success", |app| async move {
			let fixture = build_share_router_fixture(&app.pool).await;

			let response = app
				.rpc_call(
					"share.verifyEmailAndAccess",
					json!([{
						"token": fixture.email_link_token.clone(),
						"email": fixture.allowed_email.clone(),
						"code": fixture.verification_code.clone()
					}]),
					unauthenticated_json_headers(),
				)
				.await;

			assert_eq!(response.status, StatusCode::OK);
			assert_eq!(
				response.body["result"]["Ok"]["encryptedItemData"],
				json!(FIXTURE_ENCRYPTED_ITEM_DATA),
			);
			assert_eq!(
				response.body["result"]["Ok"]["shareKeyIv"],
				json!(FIXTURE_SHARE_KEY_IV),
			);

			let allowed_email_state = query_as::<_, ShareAllowedEmailStateRow>(
				"SELECT email, verified, verified_at FROM share_link_allowed_email WHERE id = $1 LIMIT 1",
			)
			.bind(&fixture.allowed_email_id)
			.fetch_one(&app.pool)
			.await
			.expect("allowed email state should load");
			assert_eq!(allowed_email_state.email, fixture.allowed_email);
			assert!(allowed_email_state.verified);
			assert!(allowed_email_state.verified_at.is_some());

			let verification_state = query_as::<_, ShareVerificationStateRow>(
				"SELECT attempts, used_at FROM share_email_verification WHERE share_link_id = $1 AND email = $2 LIMIT 1",
			)
			.bind(&fixture.email_link_id)
			.bind(&allowed_email_state.email)
			.fetch_one(&app.pool)
			.await
			.expect("verification state should load");
			assert_eq!(verification_state.attempts, 0);
			assert!(verification_state.used_at.is_some());

			let link_state = query_as::<_, ShareLinkStateRow>(
				"SELECT status::text AS status, access_count, max_access_count, is_one_time_use, last_accessed_at FROM share_link WHERE id = $1 LIMIT 1",
			)
			.bind(&fixture.email_link_id)
			.fetch_one(&app.pool)
			.await
			.expect("email-restricted link state should load");
			assert_eq!(link_state.status, "active");
			assert_eq!(link_state.access_count, 1);
		})
		.await;
    }

    #[tokio::test]
    async fn verify_email_and_access_rejects_invalid_codes_and_increments_attempts() {
        with_rpc_test_app("share_verify_email_invalid_code", |app| async move {
			let fixture = build_share_router_fixture(&app.pool).await;

			let response = app
				.rpc_call(
					"share.verifyEmailAndAccess",
					json!([{
						"token": fixture.email_link_token.clone(),
						"email": fixture.allowed_email.clone(),
						"code": "000000"
					}]),
					unauthenticated_json_headers(),
				)
				.await;

			assert_eq!(response.status, StatusCode::OK);
			assert_handler_error(
				&response.body,
				"BAD_REQUEST",
				"Invalid or expired verification code",
			);

			let verification_state = query_as::<_, ShareVerificationStateRow>(
				"SELECT attempts, used_at FROM share_email_verification WHERE share_link_id = $1 AND email = $2 LIMIT 1",
			)
			.bind(&fixture.email_link_id)
			.bind(&fixture.allowed_email)
			.fetch_one(&app.pool)
			.await
			.expect("verification attempts should load");
			assert_eq!(verification_state.attempts, 1);
			assert!(verification_state.used_at.is_none());
		})
		.await;
    }

    #[tokio::test]
    async fn create_share_via_rpc_persists_link_and_allowed_emails() {
        with_rpc_test_app("share_create_happy_path", |app| async move {
			let fixture = build_share_actor_fixture(&app.pool).await;
			let session = app.issue_session(&fixture.user_id).await;
			let expected_base_share_url = format!(
				"{}/share/",
				std::env::var("WEB_APP_URL")
					.ok()
					.filter(|value| !value.trim().is_empty())
					.unwrap_or_else(|| "https://app.bittery.com".to_string())
					.trim_end_matches('/'),
			);

			let response = app
				.rpc_call(
					"share.create",
					json!([{
						"itemId": fixture.item_id,
						"accessMode": "email-restricted",
						"isOneTimeUse": true,
						"expiresIn": "1day",
						"allowedEmails": ["bob@example.com", "alice@example.com"],
						"encryptedItemData": "encrypted-item-data",
						"encryptionIv": "item-iv",
						"encryptedShareKey": "encrypted-share-key",
						"shareKeyIv": "share-key-iv"
					}]),
					authenticated_json_headers(&session.token),
				)
				.await;

			assert_eq!(response.status, StatusCode::OK);
			assert_eq!(response.body["jsonrpc"], json!("2.0"));
			assert_eq!(response.body["result"]["Ok"]["baseShareUrl"], json!(expected_base_share_url));

			let link_id = response.body["result"]["Ok"]["id"]
				.as_str()
				.expect("share link id should be present");

			let stored_link = query_as::<_, ShareLinkTestRow>(
				"SELECT id, created_by_id, access_mode::text AS access_mode, is_one_time_use, max_access_count FROM share_link WHERE id = $1 LIMIT 1",
			)
			.bind(link_id)
			.fetch_one(&app.pool)
			.await
			.expect("share link should be stored");

			assert_eq!(stored_link.id, link_id);
			assert_eq!(stored_link.created_by_id, fixture.user_id);
			assert_eq!(stored_link.access_mode, "email-restricted");
			assert!(stored_link.is_one_time_use);
			assert_eq!(stored_link.max_access_count, Some(1));

			let allowed_emails = query_scalar::<_, String>(
				"SELECT email FROM share_link_allowed_email WHERE share_link_id = $1 ORDER BY email ASC",
			)
			.bind(link_id)
			.fetch_all(&app.pool)
			.await
			.expect("allowed emails should be stored");

			assert_eq!(allowed_emails, vec!["alice@example.com", "bob@example.com"]);
		})
		.await;
    }

    #[tokio::test]
    async fn create_share_via_rpc_rejects_invalid_access_mode() {
        with_rpc_test_app("share_create_invalid_access_mode", |app| async move {
            let fixture = build_share_actor_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.user_id).await;

            let response = app
                .rpc_call(
                    "share.create",
                    json!([{
                        "itemId": fixture.item_id,
                        "accessMode": "invalid-mode",
                        "isOneTimeUse": false,
                        "expiresIn": "1day",
                        "allowedEmails": null,
                        "encryptedItemData": "encrypted-item-data",
                        "encryptionIv": "item-iv",
                        "encryptedShareKey": "encrypted-share-key",
                        "shareKeyIv": "share-key-iv"
                    }]),
                    authenticated_json_headers(&session.token),
                )
                .await;

            assert_eq!(response.status, StatusCode::OK);
            assert_eq!(response.body["result"]["Err"]["code"], json!("BAD_REQUEST"));
            assert_eq!(
                response.body["result"]["Err"]["message"],
                json!("Invalid access mode")
            );

            let share_link_count =
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM share_link")
                    .fetch_one(&app.pool)
                    .await
                    .expect("share link count should load");

            assert_eq!(share_link_count, 0);
        })
        .await;
    }

    #[tokio::test]
    async fn rpc_guard_rejects_non_json_share_requests() {
        with_rpc_test_app("share_rpc_guard_non_json", |app| async move {
            let mut headers = HeaderMap::new();
            headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/plain"));

            let response = app.post_rpc_bytes(b"not-json".to_vec(), headers).await;

            assert_eq!(response.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
            assert_eq!(response.body["error"], json!("Unsupported Media Type"));
        })
        .await;
    }

    async fn build_share_actor_fixture(pool: &PgPool) -> ShareActorFixture {
        let user_id = "user_share_owner".to_string();
        let team_id = "team_share_owner".to_string();
        let vault_id = "vault_share_owner".to_string();
        let item_id = "item_share_owner".to_string();

        seed_user(pool, &user_id, "Share Owner", "owner@example.com").await;
        seed_team(
            pool,
            &team_id,
            "Personal Team",
            &user_id,
            "personal",
            "personal",
            "active",
        )
        .await;
        assign_user_to_team(pool, &user_id, &team_id, "owner").await;
        seed_vault(
            pool,
            &vault_id,
            "Personal Vault",
            "personal",
            &user_id,
            Some(&team_id),
        )
        .await;
        seed_vault_key(
            pool,
            "vault_key_share_owner",
            &vault_id,
            &user_id,
            "encrypted-vault-key",
            "owner",
        )
        .await;
        seed_item(
            pool,
            &item_id,
            &vault_id,
            "login",
            "encrypted-item",
            "item-iv",
            &user_id,
        )
        .await;

        ShareActorFixture { user_id, item_id }
    }

    async fn build_share_router_fixture(pool: &PgPool) -> ShareRouterFixture {
        let owner_user_id = "share_owner_user".to_string();
        let admin_user_id = "share_admin_user".to_string();
        let member_user_id = "share_member_user".to_string();
        let read_only_user_id = "share_read_only_user".to_string();
        let outsider_user_id = "share_outsider_user".to_string();
        let team_id = "share_team_main".to_string();
        let vault_id = "share_vault_main".to_string();
        let item_id = "share_item_main".to_string();

        seed_user(
            pool,
            &owner_user_id,
            "Share Owner",
            "share-owner@example.com",
        )
        .await;
        seed_user(
            pool,
            &admin_user_id,
            "Share Admin",
            "share-admin@example.com",
        )
        .await;
        seed_user(
            pool,
            &member_user_id,
            "Share Member",
            "share-member@example.com",
        )
        .await;
        seed_user(
            pool,
            &read_only_user_id,
            "Share Read Only",
            "share-read-only@example.com",
        )
        .await;
        seed_user(
            pool,
            &outsider_user_id,
            "Share Outsider",
            "share-outsider@example.com",
        )
        .await;

        seed_team(
            pool,
            &team_id,
            "Share Team",
            &owner_user_id,
            "organization",
            "team",
            "active",
        )
        .await;
        assign_user_to_team(pool, &owner_user_id, &team_id, "owner").await;
        assign_user_to_team(pool, &admin_user_id, &team_id, "admin").await;
        assign_user_to_team(pool, &member_user_id, &team_id, "member").await;
        assign_user_to_team(pool, &read_only_user_id, &team_id, "member").await;
        assign_user_to_team(pool, &outsider_user_id, &team_id, "member").await;

        seed_vault(
            pool,
            &vault_id,
            "Share Vault",
            "team",
            &owner_user_id,
            Some(&team_id),
        )
        .await;
        seed_vault_key(
            pool,
            "share_vault_key_owner",
            &vault_id,
            &owner_user_id,
            "encrypted-vault-key-owner",
            "owner",
        )
        .await;
        seed_vault_key(
            pool,
            "share_vault_key_admin",
            &vault_id,
            &admin_user_id,
            "encrypted-vault-key-admin",
            "admin",
        )
        .await;
        seed_vault_key(
            pool,
            "share_vault_key_member",
            &vault_id,
            &member_user_id,
            "encrypted-vault-key-member",
            "member",
        )
        .await;
        seed_vault_key(
            pool,
            "share_vault_key_read_only",
            &vault_id,
            &read_only_user_id,
            "encrypted-vault-key-read-only",
            "read-only",
        )
        .await;

        seed_item(
            pool,
            &item_id,
            &vault_id,
            "login",
            "encrypted-item",
            "item-iv",
            &owner_user_id,
        )
        .await;

        let owner_link_id = "share_link_owner".to_string();
        let owner_token = share_token('1');
        let email_link_id = "share_link_email".to_string();
        let email_link_token = share_token('2');
        let member_link_id = "share_link_member".to_string();
        let member_token = share_token('3');
        let read_only_link_id = "share_link_read_only".to_string();
        let read_only_token = share_token('4');
        let one_time_link_id = "share_link_one_time".to_string();
        let one_time_token = share_token('5');
        let revoked_link_id = "share_link_revoked".to_string();
        let revoked_token = share_token('6');
        let now = time::OffsetDateTime::now_utc();

        seed_share_link(
            pool,
            &owner_link_id,
            &item_id,
            &owner_user_id,
            &owner_token,
            "anyone",
            "active",
            false,
            0,
            None,
            now + time::Duration::days(2),
        )
        .await;
        seed_share_link(
            pool,
            &email_link_id,
            &item_id,
            &owner_user_id,
            &email_link_token,
            "email-restricted",
            "active",
            false,
            0,
            None,
            now + time::Duration::days(2),
        )
        .await;
        seed_share_link(
            pool,
            &member_link_id,
            &item_id,
            &member_user_id,
            &member_token,
            "anyone",
            "active",
            false,
            0,
            None,
            now + time::Duration::days(2),
        )
        .await;
        seed_share_link(
            pool,
            &read_only_link_id,
            &item_id,
            &read_only_user_id,
            &read_only_token,
            "anyone",
            "active",
            false,
            0,
            None,
            now + time::Duration::days(2),
        )
        .await;
        seed_share_link(
            pool,
            &one_time_link_id,
            &item_id,
            &owner_user_id,
            &one_time_token,
            "anyone",
            "active",
            true,
            0,
            Some(1),
            now + time::Duration::days(2),
        )
        .await;
        seed_share_link(
            pool,
            &revoked_link_id,
            &item_id,
            &owner_user_id,
            &revoked_token,
            "anyone",
            "revoked",
            false,
            0,
            None,
            now + time::Duration::days(2),
        )
        .await;

        let allowed_email_id = "share_allowed_email_primary".to_string();
        let allowed_email = "allowed@example.com".to_string();
        let removable_email_id = "share_allowed_email_removable".to_string();
        let removable_email = "remove@example.com".to_string();
        let request_email = "request@example.com".to_string();
        let verification_code = "123456".to_string();

        seed_share_allowed_email(
            pool,
            &allowed_email_id,
            &email_link_id,
            &allowed_email,
            false,
            None,
        )
        .await;
        seed_share_allowed_email(
            pool,
            &removable_email_id,
            &email_link_id,
            &removable_email,
            false,
            None,
        )
        .await;
        seed_share_allowed_email(
            pool,
            "share_allowed_email_request",
            &email_link_id,
            &request_email,
            false,
            None,
        )
        .await;

        seed_share_access_log(
            pool,
            "share_access_log_success",
            &owner_link_id,
            Some("viewer@example.com"),
            true,
            None,
            now - time::Duration::minutes(1),
        )
        .await;
        seed_share_access_log(
            pool,
            "share_access_log_failure",
            &owner_link_id,
            Some("blocked@example.com"),
            false,
            Some("Invalid code"),
            now - time::Duration::minutes(2),
        )
        .await;

        seed_share_email_verification(
            pool,
            "share_verification_primary",
            &email_link_id,
            &allowed_email,
            &verification_code,
            0,
            5,
            now + time::Duration::minutes(15),
            now - time::Duration::minutes(2),
            None,
        )
        .await;
        seed_share_email_verification(
            pool,
            "share_verification_removable",
            &email_link_id,
            &removable_email,
            "654321",
            0,
            5,
            now + time::Duration::minutes(15),
            now - time::Duration::minutes(3),
            None,
        )
        .await;

        ShareRouterFixture {
            owner_user_id,
            admin_user_id,
            member_user_id,
            read_only_user_id,
            outsider_user_id,
            item_id,
            owner_link_id,
            email_link_id,
            email_link_token,
            member_link_id,
            read_only_link_id,
            one_time_link_id,
            one_time_token,
            revoked_token,
            allowed_email_id,
            allowed_email,
            removable_email_id,
            removable_email,
            request_email,
            verification_code,
        }
    }

    async fn seed_share_link(
        pool: &PgPool,
        id: &str,
        item_id: &str,
        created_by_id: &str,
        token: &str,
        access_mode: &str,
        status: &str,
        is_one_time_use: bool,
        access_count: i32,
        max_access_count: Option<i32>,
        expires_at: time::OffsetDateTime,
    ) {
        query(
			"INSERT INTO share_link (id, item_id, created_by_id, token, status, access_mode, is_one_time_use, encrypted_item_data, encryption_iv, encrypted_share_key, share_key_iv, access_count, max_access_count, expires_at) VALUES ($1, $2, $3, $4, $5::share_link_status, $6::share_link_access_mode, $7, $8, $9, $10, $11, $12, $13, $14)",
		)
		.bind(id)
		.bind(item_id)
		.bind(created_by_id)
		.bind(token)
		.bind(status)
		.bind(access_mode)
		.bind(is_one_time_use)
		.bind(FIXTURE_ENCRYPTED_ITEM_DATA)
		.bind(FIXTURE_ENCRYPTION_IV)
		.bind(FIXTURE_ENCRYPTED_SHARE_KEY)
		.bind(FIXTURE_SHARE_KEY_IV)
		.bind(access_count)
		.bind(max_access_count)
		.bind(expires_at)
		.execute(pool)
		.await
		.expect("share link should seed");
    }

    async fn seed_share_allowed_email(
        pool: &PgPool,
        id: &str,
        share_link_id: &str,
        email: &str,
        verified: bool,
        verified_at: Option<time::OffsetDateTime>,
    ) {
        query(
			"INSERT INTO share_link_allowed_email (id, share_link_id, email, verified, verified_at) VALUES ($1, $2, $3, $4, $5)",
		)
		.bind(id)
		.bind(share_link_id)
		.bind(email)
		.bind(verified)
		.bind(verified_at)
		.execute(pool)
		.await
		.expect("share allowed email should seed");
    }

    async fn seed_share_access_log(
        pool: &PgPool,
        id: &str,
        share_link_id: &str,
        accessed_by_email: Option<&str>,
        success: bool,
        failure_reason: Option<&str>,
        accessed_at: time::OffsetDateTime,
    ) {
        query(
			"INSERT INTO share_access_log (id, share_link_id, accessed_by_email, ip_address, user_agent, success, failure_reason, accessed_at) VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6)",
		)
		.bind(id)
		.bind(share_link_id)
		.bind(accessed_by_email)
		.bind(success)
		.bind(failure_reason)
		.bind(accessed_at)
		.execute(pool)
		.await
		.expect("share access log should seed");
    }

    async fn seed_share_email_verification(
        pool: &PgPool,
        id: &str,
        share_link_id: &str,
        email: &str,
        code: &str,
        attempts: i32,
        max_attempts: i32,
        expires_at: time::OffsetDateTime,
        created_at: time::OffsetDateTime,
        used_at: Option<time::OffsetDateTime>,
    ) {
        query(
			"INSERT INTO share_email_verification (id, share_link_id, email, code, attempts, max_attempts, expires_at, created_at, used_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
		)
		.bind(id)
		.bind(share_link_id)
		.bind(email)
		.bind(code)
		.bind(attempts)
		.bind(max_attempts)
		.bind(expires_at)
		.bind(created_at)
		.bind(used_at)
		.execute(pool)
		.await
		.expect("share email verification should seed");
    }
}

fn format_timestamp(value: time::OffsetDateTime) -> String {
    value
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| value.unix_timestamp().to_string())
}

fn generate_share_id(prefix: &str) -> String {
    format!("{prefix}_{:016x}", random::<u64>())
}

fn generate_secure_token() -> String {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| {
            let index = rng.gen_range(0..ALPHABET.len());
            ALPHABET[index] as char
        })
        .collect()
}

fn generate_verification_code() -> String {
    rand::thread_rng().gen_range(100000..=999999).to_string()
}

fn share_link_daily_limit() -> i64 {
    std::env::var("SHARE_LINK_DAILY_LIMIT")
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_SHARE_LINK_DAILY_LIMIT)
}

fn start_of_local_day() -> time::OffsetDateTime {
    let local_now = Local::now();
    let naive_midnight = local_now
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .expect("midnight should be representable");
    let local_midnight = Local
        .from_local_datetime(&naive_midnight)
        .earliest()
        .or_else(|| Local.from_local_datetime(&naive_midnight).latest())
        .expect("local midnight should resolve");
    let utc_midnight = local_midnight.with_timezone(&Utc);
    time::OffsetDateTime::from_unix_timestamp(utc_midnight.timestamp())
        .unwrap_or_else(|_| time::OffsetDateTime::now_utc())
}

fn email_regex() -> &'static Regex {
    static EMAIL_REGEX: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    EMAIL_REGEX.get_or_init(|| {
        Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$").expect("email regex should compile")
    })
}

fn not_found_error(message: &str) -> ShareRpcError {
    ShareRpcError {
        code: "NOT_FOUND".to_string(),
        message: message.to_string(),
    }
}

fn forbidden_error(message: &str) -> ShareRpcError {
    ShareRpcError {
        code: "FORBIDDEN".to_string(),
        message: message.to_string(),
    }
}

fn bad_request_error(message: &str) -> ShareRpcError {
    ShareRpcError {
        code: "BAD_REQUEST".to_string(),
        message: message.to_string(),
    }
}

fn internal_error(message: &str) -> ShareRpcError {
    ShareRpcError {
        code: "INTERNAL_SERVER_ERROR".to_string(),
        message: message.to_string(),
    }
}

impl From<ShareRpcError> for RpcError {
    fn from(value: ShareRpcError) -> Self {
        let code = match value.code.as_str() {
            "NOT_FOUND" => ErrorCode::ServerError(404),
            "FORBIDDEN" => ErrorCode::ServerError(403),
            "BAD_REQUEST" => ErrorCode::InvalidParams,
            _ => ErrorCode::InternalError,
        };

        RpcError {
            code,
            message: value.message,
            data: None,
        }
    }
}

impl IntoResponse for ShareRpcError {
    type Output = <RpcError as IntoResponse>::Output;

    fn into_response(self) -> jsonrpsee::ResponsePayload<'static, Self::Output> {
        RpcError::from(self).into_response()
    }
}
