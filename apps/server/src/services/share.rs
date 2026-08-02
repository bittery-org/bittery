use rand::RngExt;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlx::{query, query_as, query_scalar, PgPool};
use ts_rs::TS;

use crate::{
    config::{bittery_mode, db_pool, format_timestamp},
    db::models::*,
    error::AppError,
    repo::{
        common::{generate_resource_id, insert_audit_event, load_scoped_item_access},
        share::{
            consume_share_link_access, count_active_share_links, load_allowed_emails_for_links,
            load_public_share_link_by_token, load_share_access_logs, load_share_links_for_item,
            log_share_access,
        },
    },
    services::rate_limit,
    services::session::hash_token,
    services::team_billing::{load_team_billing_entitlement, resolve_share_links_policy},
    services::verification_code::{
        LockoutVerificationCodeOutcome, VerificationCodeService, VerificationPurpose,
    },
    AppState,
};

const SHARE_LINKS_UNAVAILABLE_MESSAGE: &str =
    "Share links are not available on your current plan. Upgrade to continue.";
const MAX_VERIFICATION_CODES_PER_EMAIL: i64 = 5;
const DEFAULT_SHARE_LINK_DAILY_LIMIT: i64 = 50;

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
    /// The only time the raw token is ever disclosed. The database holds just its
    /// digest, so a link that is not copied here cannot be reconstructed later.
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

pub(crate) async fn create_share_link(
    app_state: &AppState,
    user_id: &str,
    input: CreateShareLinkInput,
) -> Result<CreateShareLinkResponse, AppError> {
    let pool = db_pool(app_state)?;
    let scoped_item = load_scoped_item_access(pool, user_id, &input.item_id).await?;
    let Some(scoped_item) = scoped_item else {
        return Err(not_found_error("Item not found"));
    };

    if scoped_item.role == "read-only" {
        return Err(forbidden_error("Read-only users cannot share items"));
    }

    let share_links_access = assert_share_links_entitlement(pool, user_id).await?;
    validate_create_share_input(&input)?;
    if app_state
        .rate_limiter
        .check_and_increment(
            rate_limit::SCOPE_SHARE_CREATE_DAILY,
            user_id,
            share_link_daily_limit(),
            rate_limit::share_create_daily_limit().window,
        )
        .await?
        .is_limited()
    {
        return Err(AppError::too_many_requests(
            "Daily share link limit reached",
        ));
    }

    let expires_at = calculate_expiration(&input.expires_in)?;
    let token = generate_secure_token();
    let share_link_id = generate_resource_id("share_link");
    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to create share link transaction");
        internal_error("Failed to create share link transaction")
    })?;

    if let Some(max_active_links) = share_links_access.max_active_links {
        let lock_scope = share_links_access.team_id.as_deref().unwrap_or(user_id);
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
            user_id,
            time::OffsetDateTime::now_utc(),
        )
        .await?;
        if active_share_links >= max_active_links {
            return Err(forbidden_error(&format!(
				"Your plan allows up to {max_active_links} active share links. Revoke a link or upgrade to continue.",
			)));
        }
    }

    // Only the SHA-256 digest is persisted; the raw token leaves the process once,
    // in this call's response, and is never recoverable from the database.
    query(
		"INSERT INTO share_link (id, item_id, created_by_id, token_hash, access_mode, is_one_time_use, encrypted_item_data, encryption_iv, encrypted_share_key, share_key_iv, max_access_count, expires_at) VALUES ($1, $2, $3, $4, $5::share_link_access_mode, $6, $7, $8, $9, $10, $11, $12)",
	)
	.bind(&share_link_id)
	.bind(&scoped_item.item_id)
	.bind(user_id)
	.bind(hash_token(&token))
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
			.bind(generate_resource_id("share_email"))
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

    record_share_audit_event(pool, user_id, "share_created", &share_link_id).await?;

    Ok(CreateShareLinkResponse {
        id: share_link_id,
        token,
        expires_at: format_timestamp(expires_at),
        base_share_url: base_share_url(),
    })
}

pub(crate) async fn list_share_links_by_item(
    pool: &PgPool,
    user_id: &str,
    input: ItemIdInput,
) -> Result<ShareLinkListResponse, AppError> {
    assert_share_links_entitlement(pool, user_id).await?;

    let scoped_item = load_scoped_item_access(pool, user_id, &input.item_id).await?;
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
            .filter(|link| link.created_by_id == user_id)
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

pub(crate) async fn get_share_link(
    pool: &PgPool,
    user_id: &str,
    input: LinkIdInput,
) -> Result<ShareLinkDetailsResponse, AppError> {
    assert_share_links_entitlement(pool, user_id).await?;

    let visible_link = load_visible_share_link(pool, &input.link_id, user_id).await?;
    let Some(visible_link) = visible_link else {
        return Err(not_found_error("Share link not found"));
    };

    Ok(ShareLinkDetailsResponse {
        id: visible_link.link.id,
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

pub(crate) async fn revoke_share_link(
    pool: &PgPool,
    user_id: &str,
    input: LinkIdInput,
) -> Result<SuccessResponse, AppError> {
    let visible_link = load_visible_share_link(pool, &input.link_id, user_id).await?;
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
        || (visible_link.actor_role == "member" && visible_link.link.created_by_id != user_id)
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

    record_share_audit_event(pool, user_id, "share_revoked", &input.link_id).await?;

    Ok(SuccessResponse { success: true })
}

pub(crate) async fn update_share_link(
    pool: &PgPool,
    user_id: &str,
    input: UpdateShareLinkInput,
) -> Result<SuccessResponse, AppError> {
    assert_share_links_entitlement(pool, user_id).await?;

    let visible_link = load_visible_share_link(pool, &input.link_id, user_id).await?;
    let Some(visible_link) = visible_link else {
        return Err(not_found_error("Share link not found"));
    };

    if visible_link.actor_role == "read-only"
        || (visible_link.actor_role == "member" && visible_link.link.created_by_id != user_id)
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
			.bind(generate_resource_id("share_email"))
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

pub(crate) async fn get_share_access_logs(
    pool: &PgPool,
    user_id: &str,
    input: LinkIdInput,
) -> Result<Vec<ShareAccessLogResponse>, AppError> {
    assert_share_links_entitlement(pool, user_id).await?;

    let visible_link = load_visible_share_link(pool, &input.link_id, user_id).await?;
    if visible_link.is_none() {
        return Err(not_found_error("Share link not found"));
    }

    let logs = load_share_access_logs(pool, &input.link_id, 100).await?;

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

pub(crate) async fn get_public_info(
    pool: &PgPool,
    input: PublicTokenInput,
) -> Result<PublicShareInfoResponse, AppError> {
    validate_public_token(&input.token)?;
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

pub(crate) async fn access_public(
    pool: &PgPool,
    input: PublicTokenInput,
) -> Result<PublicShareAccessResponse, AppError> {
    validate_public_token(&input.token)?;
    let link = query_as::<_, DbPublicShareLinkRow>(
		"SELECT id, created_by_id, status::text AS status, access_mode::text AS access_mode, is_one_time_use, encrypted_item_data, encryption_iv, encrypted_share_key, share_key_iv, access_count, max_access_count, expires_at FROM share_link WHERE token_hash = $1 AND access_mode = 'anyone' LIMIT 1",
	)
	.bind(hash_token(&input.token))
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

pub(crate) async fn request_email_verification(
    app_state: &AppState,
    input: RequestEmailVerificationInput,
) -> Result<RequestEmailVerificationResponse, AppError> {
    let pool = db_pool(app_state)?;
    validate_public_token(&input.token)?;
    validate_email(&input.email)?;
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
        return Err(AppError::too_many_requests(
            "Too many verification attempts for this email. Contact the link creator.",
        ));
    }

    let existing_verification = query_as::<_, DbShareEmailVerificationRow>(
		"SELECT id, share_link_id, email, code_hash, attempts, max_attempts, expires_at, created_at, used_at FROM share_email_verification WHERE share_link_id = $1 AND email = $2 AND expires_at > $3 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
	)
	.bind(&details.link.id)
	.bind(&normalized_email)
	.bind(now)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load existing share email verification"); internal_error("Failed to load existing share email verification") })?;

    if let Some(existing_verification) = existing_verification {
        if (now - existing_verification.created_at) < time::Duration::minutes(1) {
            return Err(AppError::too_many_requests(
                "Please wait before requesting another code",
            ));
        }
    }

    let _code = VerificationCodeService::new(pool)
        .issue(
            VerificationPurpose::ShareEmail {
                share_link_id: &details.link.id,
            },
            &normalized_email,
        )
        .await?;

    Ok(RequestEmailVerificationResponse {
        success: true,
        message: "Verification code sent to your email".to_string(),
    })
}

pub(crate) async fn verify_email_and_access(
    app_state: &AppState,
    input: VerifyEmailAndAccessInput,
) -> Result<PublicShareAccessResponse, AppError> {
    let pool = db_pool(app_state)?;
    validate_public_token(&input.token)?;
    validate_email(&input.email)?;
    if !VerificationCodeService::is_valid_code(&input.code) {
        return Err(bad_request_error("Invalid or expired verification code"));
    }

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

    let verification_codes = VerificationCodeService::new(pool);
    let verification_id = match verification_codes
        .verify_with_lockout(
            VerificationPurpose::ShareEmail {
                share_link_id: &details.link.id,
            },
            &normalized_email,
            &input.code,
            app_state.rate_limiter.as_ref(),
        )
        .await?
    {
        LockoutVerificationCodeOutcome::Valid { verification_id } => verification_id,
        LockoutVerificationCodeOutcome::Exhausted => {
            log_share_access(
                pool,
                &details.link.id,
                Some(&input.email),
                false,
                Some("Max verification attempts exceeded"),
            )
            .await?;
            return Err(AppError::too_many_requests(
                "Maximum verification attempts exceeded. Please request a new code.",
            ));
        }
        LockoutVerificationCodeOutcome::Locked
        | LockoutVerificationCodeOutcome::LockoutTriggered => {
            log_share_access(
                pool,
                &details.link.id,
                Some(&input.email),
                false,
                Some("Verification lockout"),
            )
            .await?;
            return Err(rate_limit::rate_limited_error());
        }
        LockoutVerificationCodeOutcome::Invalid => {
            log_share_access(
                pool,
                &details.link.id,
                Some(&input.email),
                false,
                Some("Invalid or expired verification code"),
            )
            .await?;
            return Err(bad_request_error("Invalid or expired verification code"));
        }
    };

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

    if !verification_codes
        .consume(
            VerificationPurpose::ShareEmail {
                share_link_id: &details.link.id,
            },
            &verification_id,
        )
        .await?
    {
        log_share_access(
            pool,
            &details.link.id,
            Some(&input.email),
            false,
            Some("Invalid or expired verification code"),
        )
        .await?;
        return Err(bad_request_error("Invalid or expired verification code"));
    }

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

async fn load_visible_share_link(
    pool: &PgPool,
    link_id: &str,
    actor_user_id: &str,
) -> Result<Option<VisibleShareLink>, AppError> {
    let link = query_as::<_, DbShareLinkRow>(
		"SELECT sl.id, sl.item_id, sl.created_by_id, sl.status::text AS status, sl.access_mode::text AS access_mode, sl.is_one_time_use, sl.access_count, sl.max_access_count, sl.expires_at, sl.created_at, sl.last_accessed_at, i.vault_id FROM share_link sl INNER JOIN item i ON i.id = sl.item_id WHERE sl.id = $1 LIMIT 1",
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

/// `token` is the caller-supplied plaintext; both query variants below compare its
/// digest, because `share_link.token_hash` never holds the token itself.
async fn load_public_share_link_details_by_token(
    pool: &PgPool,
    token: &str,
    required_access_mode: Option<&str>,
) -> Result<Option<PublicShareLinkDetails>, AppError> {
    let token_hash = hash_token(token);
    let link = match required_access_mode {
		Some(access_mode) => query_as::<_, DbPublicShareLinkRow>(
			"SELECT id, created_by_id, status::text AS status, access_mode::text AS access_mode, is_one_time_use, encrypted_item_data, encryption_iv, encrypted_share_key, share_key_iv, access_count, max_access_count, expires_at FROM share_link WHERE token_hash = $1 AND access_mode = $2::share_link_access_mode LIMIT 1",
		)
		.bind(&token_hash)
		.bind(access_mode)
		.fetch_optional(pool)
		.await,
		None => query_as::<_, DbPublicShareLinkRow>(
			"SELECT id, created_by_id, status::text AS status, access_mode::text AS access_mode, is_one_time_use, encrypted_item_data, encryption_iv, encrypted_share_key, share_key_iv, access_count, max_access_count, expires_at FROM share_link WHERE token_hash = $1 LIMIT 1",
		)
		.bind(&token_hash)
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

async fn assert_share_links_entitlement(
    pool: &PgPool,
    user_id: &str,
) -> Result<ShareLinksAccess, AppError> {
    let access = resolve_share_links_access(pool, user_id).await?;
    if access.enabled {
        Ok(access)
    } else {
        Err(forbidden_error(SHARE_LINKS_UNAVAILABLE_MESSAGE))
    }
}

async fn has_share_links_entitlement(pool: &PgPool, user_id: &str) -> Result<bool, AppError> {
    Ok(resolve_share_links_access(pool, user_id).await?.enabled)
}

async fn resolve_share_links_access(
    pool: &PgPool,
    user_id: &str,
) -> Result<ShareLinksAccess, AppError> {
    let mode = bittery_mode();
    if mode == "self-hosted" {
        return Ok(ShareLinksAccess {
            enabled: true,
            max_active_links: None,
            team_id: None,
        });
    }

    let actor =
        load_team_billing_entitlement(pool, user_id, "Failed to load share link entitlements")
            .await?;

    let Some(actor) = actor else {
        return Ok(ShareLinksAccess {
            enabled: false,
            max_active_links: Some(0),
            team_id: None,
        });
    };

    let policy = resolve_share_links_policy(
        mode,
        actor.billing_plan.as_deref(),
        actor.billing_status.as_deref(),
    );
    let team_id = actor.team_id;

    if team_id.is_none() {
        return Ok(ShareLinksAccess {
            enabled: false,
            max_active_links: Some(0),
            team_id: None,
        });
    }

    Ok(ShareLinksAccess {
        enabled: policy.enabled,
        max_active_links: policy.max_active_links,
        team_id,
    })
}

async fn record_share_audit_event(
    pool: &PgPool,
    user_id: &str,
    action: &str,
    entity_id: &str,
) -> Result<(), AppError> {
    insert_audit_event(
        pool,
        &generate_resource_id("audit"),
        user_id,
        action,
        "share_link",
        entity_id,
        None,
    )
    .await
}

async fn get_public_share_state(
    pool: &PgPool,
    link: &DbPublicShareLinkRow,
) -> Result<PublicShareState, AppError> {
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

fn unique_email_ids(ids: &[String]) -> Result<Vec<String>, AppError> {
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

fn validate_create_share_input(input: &CreateShareLinkInput) -> Result<(), AppError> {
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

fn calculate_expiration(expires_in: &str) -> Result<time::OffsetDateTime, AppError> {
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

fn validate_public_token(token: &str) -> Result<(), AppError> {
    if token.len() != 32
        || !token
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err(not_found_error("Share link not found or invalid"));
    }
    Ok(())
}

fn validate_email(email: &str) -> Result<(), AppError> {
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

fn generate_secure_token() -> String {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut rng = rand::rng();
    (0..32)
        .map(|_| {
            let index = rng.random_range(0..ALPHABET.len());
            ALPHABET[index] as char
        })
        .collect()
}

fn share_link_daily_limit() -> i64 {
    std::env::var("SHARE_LINK_DAILY_LIMIT")
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_SHARE_LINK_DAILY_LIMIT)
}

fn email_regex() -> &'static Regex {
    static EMAIL_REGEX: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    EMAIL_REGEX.get_or_init(|| {
        Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$").expect("email regex should compile")
    })
}

fn not_found_error(message: &str) -> AppError {
    AppError::not_found(message)
}

fn forbidden_error(message: &str) -> AppError {
    AppError::forbidden(message)
}

fn bad_request_error(message: &str) -> AppError {
    AppError::bad_request(message)
}

fn internal_error(message: &str) -> AppError {
    AppError::internal(message)
}

#[cfg(test)]
#[path = "share_tests.rs"]
mod tests;
