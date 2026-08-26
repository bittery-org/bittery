use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlx::{query, query_as, query_scalar, PgPool};

use crate::{
    config::{format_timestamp, DeploymentMode, ServerConfig},
    db::events::{generate_resource_id, hash_token, insert_audit_event, load_scoped_item_access},
    db::{
        enums::{ShareLinkAccessMode, ShareLinkStatus, VaultRole},
        models::*,
    },
    domains::auth::verification_code::{
        LockoutVerificationCodeOutcome, VerificationCodeService, VerificationPurpose,
    },
    domains::billing::entitlements::{load_team_billing_entitlement, resolve_share_links_policy},
    domains::shares::records::{
        consume_share_link_access, load_allowed_emails_for_links, load_public_share_link_by_token,
        load_share_access_logs, load_share_links_for_item, log_share_access,
    },
    error::AppError,
    shapes::{
        allowed_email_shape, email_verification_shape, public_share_access_shape,
        public_share_info_shape, share_access_log_shape, share_link_list_entry_shape,
        share_link_list_shape,
    },
    shared::{rate_limit, transaction::database_error},
    AppState,
};

const SHARE_LINKS_UNAVAILABLE_MESSAGE: &str =
    "Share links are not available on your current plan. Upgrade to continue.";
const MAX_VERIFICATION_CODES_PER_EMAIL: i64 = 5;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ItemIdInput {
    pub item_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct LinkIdInput {
    pub link_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CreateShareLinkInput {
    pub access_mode: ShareLinkAccessMode,
    pub expires_in: String,
    pub allowed_emails: Option<Vec<String>>,
    pub encrypted_item_data: String,
    pub encryption_iv: String,
    pub encrypted_share_key: String,
    pub share_key_iv: String,
}

allowed_email_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ShareAllowedEmailSummary
});

share_link_list_entry_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ShareLinkListEntry
}, email = ShareAllowedEmailSummary);

share_link_list_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ShareLinkListResponse
}, link = ShareLinkListEntry);

share_access_log_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ShareAccessLogResponse
});

#[derive(Debug, Clone, Serialize)]
pub struct SuccessResponse {
    pub success: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct PublicTokenInput {
    pub token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct RequestEmailVerificationInput {
    pub token: String,
    pub email: String,
}

email_verification_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RequestEmailVerificationResponse
});

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct VerifyEmailAndAccessInput {
    pub token: String,
    pub email: String,
    pub code: String,
}

public_share_info_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct PublicShareInfoResponse
});

public_share_access_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct PublicShareAccessResponse
});

struct VisibleShareLink {
    link: DbShareLinkRow,
    actor_role: VaultRole,
}

struct PublicShareLinkDetails {
    link: DbPublicShareLinkRow,
    allowed_emails: Vec<DbShareLinkAllowedEmailRow>,
}

struct ShareLinksAccess {
    enabled: bool,
}

pub(crate) async fn list_share_links_by_item(
    pool: &PgPool,
    server_config: &ServerConfig,
    user_id: &str,
    input: ItemIdInput,
) -> Result<ShareLinkListResponse, AppError> {
    assert_share_links_entitlement(pool, server_config.mode, user_id).await?;

    let scoped_item = load_scoped_item_access(pool, user_id, &input.item_id).await?;
    let Some(scoped_item) = scoped_item else {
        return Err(AppError::not_found("Item not found"));
    };

    let links = load_share_links_for_item(pool, &scoped_item.item_id).await?;
    let now = time::OffsetDateTime::now_utc();
    let visible_links = if scoped_item.role.can_manage() {
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
        base_share_url: base_share_url(server_config),
    })
}

pub(crate) async fn revoke_share_link(
    pool: &PgPool,
    user_id: &str,
    input: LinkIdInput,
) -> Result<SuccessResponse, AppError> {
    let visible_link = load_visible_share_link(pool, &input.link_id, user_id).await?;
    let Some(visible_link) = visible_link else {
        return Err(AppError::not_found("Share link not found"));
    };

    let creator_role = query_scalar::<_, Option<VaultRole>>(
        "SELECT role::text AS role FROM vault_key WHERE vault_id = $1 AND user_id = $2 LIMIT 1",
    )
    .bind(&visible_link.link.vault_id)
    .bind(&visible_link.link.created_by_id)
    .fetch_one(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load share link creator role"))?
    .unwrap_or(VaultRole::Member);

    let revoker_outranks_creator = match visible_link.actor_role {
        VaultRole::Owner => true,
        VaultRole::Admin => creator_role != VaultRole::Owner,
        VaultRole::Member => visible_link.link.created_by_id == user_id,
        VaultRole::ReadOnly => false,
    };
    if !revoker_outranks_creator {
        return Err(AppError::forbidden(
            "You do not have permission to revoke this link",
        ));
    }

    query("UPDATE share_link SET status = 'revoked' WHERE id = $1")
        .bind(&input.link_id)
        .execute(pool)
        .await
        .map_err(|error| database_error(error, "Failed to revoke share link"))?;

    record_share_audit_event(pool, user_id, "share_revoked", &input.link_id).await?;

    Ok(SuccessResponse { success: true })
}

pub(crate) async fn get_share_access_logs(
    pool: &PgPool,
    deployment_mode: DeploymentMode,
    user_id: &str,
    input: LinkIdInput,
    cursor: Option<(time::OffsetDateTime, String)>,
    limit: i64,
) -> Result<Vec<ShareAccessLogResponse>, AppError> {
    assert_share_links_entitlement(pool, deployment_mode, user_id).await?;

    let visible_link = load_visible_share_link(pool, &input.link_id, user_id).await?;
    if visible_link.is_none() {
        return Err(AppError::not_found("Share link not found"));
    }

    let logs = load_share_access_logs(pool, &input.link_id, cursor, limit).await?;

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
    deployment_mode: DeploymentMode,
    input: PublicTokenInput,
) -> Result<PublicShareInfoResponse, AppError> {
    validate_public_token(&input.token)?;
    let link = load_public_share_link_by_token(pool, &input.token).await?;
    let Some(link) = link else {
        return Err(AppError::not_found("Share link not found or invalid"));
    };

    let public_state = get_public_share_state(pool, deployment_mode, &link).await?;
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
    deployment_mode: DeploymentMode,
    input: PublicTokenInput,
) -> Result<PublicShareAccessResponse, AppError> {
    validate_public_token(&input.token)?;
    let link = query_as::<_, DbPublicShareLinkRow>(
		"SELECT id, created_by_id, status::text AS status, access_mode::text AS access_mode, is_one_time_use, encrypted_item_data, encryption_iv, encrypted_share_key, share_key_iv, access_count, max_access_count, expires_at FROM share_link WHERE token_hash = $1 AND access_mode = 'anyone' LIMIT 1",
	)
	.bind(hash_token(&input.token))
	.fetch_optional(pool)
	.await
	.map_err(|error| database_error(error, "Failed to load public share link"))?;
    let Some(link) = link else {
        return Err(AppError::not_found("Share link not found"));
    };

    let public_state = get_public_share_state(pool, deployment_mode, &link).await?;
    if !public_state.valid && public_state.reason.as_deref() == Some("disabled") {
        log_share_access(
            pool,
            &link.id,
            None,
            false,
            Some("Share links disabled for creator plan"),
        )
        .await?;
        return Err(AppError::bad_request("This share link is no longer valid"));
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
        return Err(AppError::bad_request(format!(
            "This share link has been {}",
            link.status
        )));
    }
    if !public_state.valid && public_state.reason.as_deref() == Some("expired") {
        log_share_access(pool, &link.id, None, false, Some("Link expired")).await?;
        return Err(AppError::bad_request("This share link has expired"));
    }
    if !public_state.valid && public_state.reason.as_deref() == Some("exhausted") {
        log_share_access(pool, &link.id, None, false, Some("Access limit reached")).await?;
        return Err(AppError::bad_request("This share link has been exhausted"));
    }

    if !consume_share_link_access(pool, &link.id, time::OffsetDateTime::now_utc()).await? {
        log_share_access(pool, &link.id, None, false, Some("Access limit reached")).await?;
        return Err(AppError::bad_request(
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
    let pool = &app_state.db_pool;
    validate_public_token(&input.token)?;
    validate_email(&input.email)?;
    let details = load_public_share_link_details_by_token(
        pool,
        &input.token,
        Some(ShareLinkAccessMode::EmailRestricted),
    )
    .await?;
    let Some(details) = details else {
        return Err(AppError::not_found("Share link not found"));
    };

    let public_state =
        get_public_share_state(pool, app_state.config.server.mode, &details.link).await?;
    if !public_state.valid {
        return Err(AppError::bad_request("This share link is no longer valid"));
    }

    let now = time::OffsetDateTime::now_utc();
    let normalized_email = input.email.to_ascii_lowercase();
    let is_allowed = details
        .allowed_emails
        .iter()
        .any(|entry| entry.email.to_ascii_lowercase() == normalized_email);
    if !is_allowed {
        return Err(AppError::forbidden(
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
	.map_err(|error| database_error(error, "Failed to count share email verification codes"))?;
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
	.map_err(|error| database_error(error, "Failed to load existing share email verification"))?;

    if let Some(existing_verification) = existing_verification {
        if (now - existing_verification.created_at) < time::Duration::minutes(1) {
            return Err(AppError::too_many_requests(
                "Please wait before requesting another code",
            ));
        }
    }

    VerificationCodeService::new(pool, &app_state.config.auth, &app_state.config.rate_limit)
        .issue_and_deliver(
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
    let pool = &app_state.db_pool;
    validate_public_token(&input.token)?;
    validate_email(&input.email)?;
    if !VerificationCodeService::is_valid_code(&input.code) {
        return Err(AppError::bad_request(
            "Invalid or expired verification code",
        ));
    }

    let details = load_public_share_link_details_by_token(pool, &input.token, None).await?;
    let Some(details) = details else {
        return Err(AppError::not_found("Share link not found"));
    };

    let public_state =
        get_public_share_state(pool, app_state.config.server.mode, &details.link).await?;
    if !public_state.valid && public_state.reason.as_deref() == Some("disabled") {
        log_share_access(
            pool,
            &details.link.id,
            Some(&input.email),
            false,
            Some("Share links disabled for creator plan"),
        )
        .await?;
        return Err(AppError::bad_request("This share link is no longer valid"));
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
        return Err(AppError::bad_request("This share link is no longer valid"));
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
        return Err(AppError::forbidden(
            "This email is not authorized to access this link",
        ));
    }

    let verification_codes =
        VerificationCodeService::new(pool, &app_state.config.auth, &app_state.config.rate_limit);
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
            return Err(AppError::bad_request(
                "Invalid or expired verification code",
            ));
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
        return Err(AppError::bad_request(
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
        return Err(AppError::bad_request(
            "Invalid or expired verification code",
        ));
    }

    query(
		"UPDATE share_link_allowed_email SET verified = true, verified_at = $1 WHERE share_link_id = $2 AND lower(email) = lower($3)",
	)
	.bind(now)
	.bind(&details.link.id)
	.bind(&normalized_email)
	.execute(pool)
	.await
	.map_err(|error| database_error(error, "Failed to mark allowed email as verified"))?;

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
	.map_err(|error| database_error(error, "Failed to load share link"))?;

    let Some(link) = link else {
        return Ok(None);
    };

    let actor_role = query_scalar::<_, VaultRole>(
        "SELECT role::text AS role FROM vault_key WHERE vault_id = $1 AND user_id = $2 LIMIT 1",
    )
    .bind(&link.vault_id)
    .bind(actor_user_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load actor vault access"))?;

    let Some(actor_role) = actor_role else {
        return Ok(None);
    };
    let can_view = actor_role.can_manage() || link.created_by_id == actor_user_id;
    if !can_view {
        return Ok(None);
    }

    Ok(Some(VisibleShareLink { link, actor_role }))
}

/// `token` is the caller-supplied plaintext; both query variants below compare its
/// digest, because `share_link.token_hash` never holds the token itself.
async fn load_public_share_link_details_by_token(
    pool: &PgPool,
    token: &str,
    required_access_mode: Option<ShareLinkAccessMode>,
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
	.map_err(|error| database_error(error, "Failed to load public share link details"))?;

    let Some(link) = link else {
        return Ok(None);
    };
    let allowed_emails = query_as::<_, DbShareLinkAllowedEmailRow>(
		"SELECT id, share_link_id, email, verified, verified_at, created_at FROM share_link_allowed_email WHERE share_link_id = $1 ORDER BY created_at ASC",
	)
	.bind(&link.id)
	.fetch_all(pool)
	.await
	.map_err(|error| database_error(error, "Failed to load public share link allowed emails"))?;

    Ok(Some(PublicShareLinkDetails {
        link,
        allowed_emails,
    }))
}

async fn assert_share_links_entitlement(
    pool: &PgPool,
    deployment_mode: DeploymentMode,
    user_id: &str,
) -> Result<ShareLinksAccess, AppError> {
    let access = resolve_share_links_access(pool, deployment_mode, user_id).await?;
    if access.enabled {
        Ok(access)
    } else {
        Err(AppError::forbidden(SHARE_LINKS_UNAVAILABLE_MESSAGE))
    }
}

async fn has_share_links_entitlement(
    pool: &PgPool,
    deployment_mode: DeploymentMode,
    user_id: &str,
) -> Result<bool, AppError> {
    Ok(resolve_share_links_access(pool, deployment_mode, user_id)
        .await?
        .enabled)
}

async fn resolve_share_links_access(
    pool: &PgPool,
    deployment_mode: DeploymentMode,
    user_id: &str,
) -> Result<ShareLinksAccess, AppError> {
    let mode = deployment_mode.as_str();
    if deployment_mode.is_self_hosted() {
        return Ok(ShareLinksAccess { enabled: true });
    }

    let actor =
        load_team_billing_entitlement(pool, user_id, "Failed to load share link entitlements")
            .await?;

    let Some(actor) = actor else {
        return Ok(ShareLinksAccess { enabled: false });
    };

    let policy = resolve_share_links_policy(mode, actor.billing_plan, actor.billing_status);
    let team_id = actor.team_id;

    if team_id.is_none() {
        return Ok(ShareLinksAccess { enabled: false });
    }

    Ok(ShareLinksAccess {
        enabled: policy.enabled,
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
    deployment_mode: DeploymentMode,
    link: &DbPublicShareLinkRow,
) -> Result<PublicShareState, AppError> {
    if !has_share_links_entitlement(pool, deployment_mode, &link.created_by_id).await? {
        return Ok(PublicShareState {
            valid: false,
            reason: Some("disabled".to_string()),
        });
    }
    if link.status == ShareLinkStatus::Revoked {
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

pub(crate) fn validate_create_share_input(input: &CreateShareLinkInput) -> Result<(), AppError> {
    if input.encrypted_item_data.is_empty()
        || input.encryption_iv.is_empty()
        || input.encrypted_share_key.is_empty()
        || input.share_key_iv.is_empty()
    {
        return Err(AppError::bad_request("Missing encrypted share payload"));
    }
    if input.access_mode == ShareLinkAccessMode::EmailRestricted {
        let Some(allowed_emails) = input.allowed_emails.as_ref() else {
            return Err(AppError::bad_request(
                "At least one email address is required for email-restricted sharing",
            ));
        };
        if allowed_emails.is_empty() {
            return Err(AppError::bad_request(
                "At least one email address is required for email-restricted sharing",
            ));
        }
        if allowed_emails.len() > 100 {
            return Err(AppError::bad_request("Too many allowed emails"));
        }
        for email in allowed_emails {
            validate_email(email)?;
        }
    }

    Ok(())
}

pub(crate) fn calculate_expiration(expires_in: &str) -> Result<time::OffsetDateTime, AppError> {
    let duration = match expires_in {
        "1hour" => time::Duration::hours(1),
        "1day" => time::Duration::days(1),
        "7days" => time::Duration::days(7),
        "14days" => time::Duration::days(14),
        "30days" => time::Duration::days(30),
        _ => return Err(AppError::bad_request("Invalid expiration option")),
    };

    Ok(time::OffsetDateTime::now_utc() + duration)
}

fn validate_public_token(token: &str) -> Result<(), AppError> {
    if token.len() != 32
        || !token
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err(AppError::not_found("Share link not found or invalid"));
    }
    Ok(())
}

fn validate_email(email: &str) -> Result<(), AppError> {
    if email_regex().is_match(email) {
        Ok(())
    } else {
        Err(AppError::bad_request(format!(
            "Invalid email format: {email}"
        )))
    }
}

struct PublicShareState {
    valid: bool,
    reason: Option<String>,
}

fn base_share_url(server_config: &ServerConfig) -> String {
    let web_app_url = server_config
        .web_app_url
        .as_deref()
        .unwrap_or("https://app.bittery.com");
    format!("{}/share/", web_app_url.trim_end_matches('/'))
}

fn effective_share_link_status(
    link: &DbShareLinkRow,
    now: time::OffsetDateTime,
) -> ShareLinkStatus {
    if link.status != ShareLinkStatus::Active {
        return link.status;
    }
    if link.expires_at < now {
        ShareLinkStatus::Expired
    } else if link
        .max_access_count
        .is_some_and(|maximum| link.access_count >= maximum)
    {
        ShareLinkStatus::Exhausted
    } else {
        link.status
    }
}

fn email_regex() -> &'static Regex {
    static EMAIL_REGEX: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    EMAIL_REGEX.get_or_init(|| {
        Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$").expect("email regex should compile")
    })
}

pub(crate) mod http;
pub(crate) mod records;
pub(crate) mod shape;
#[cfg(test)]
#[path = "tests.rs"]
mod tests;
