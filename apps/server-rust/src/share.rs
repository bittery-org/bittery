use std::collections::HashMap;

use chrono::{Local, TimeZone, Utc};
use rand::random;
use rand::Rng;
use qubit::{
	builder::IntoResponse,
	handler,
	server::{ErrorCode, Router, RpcError},
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlx::{query, query_as, query_scalar, PgPool};
use ts_rs::TS;

use crate::{auth::RefreshSessionContext, db::models::*, AppState};
use crate::auth::AppContext;

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
	let mut transaction = pool
		.begin()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to create share link transaction"); internal_error("Failed to create share link transaction") })?;

	if let Some(max_active_links) = share_links_access.max_active_links {
		let lock_scope = share_links_access
			.team_id
			.as_deref()
			.unwrap_or(&ctx.session.user_id);
		query("SELECT pg_advisory_xact_lock(hashtext($1))")
			.bind(format!("share-links:{lock_scope}"))
			.execute(&mut *transaction)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to lock share link scope"); internal_error("Failed to lock share link scope") })?;

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
		"INSERT INTO share_link (id, item_id, created_by_id, token, access_mode, is_one_time_use, encrypted_item_data, encryption_iv, encrypted_share_key, share_key_iv, max_access_count, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
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

	transaction
		.commit()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to commit share link transaction"); internal_error("Failed to commit share link transaction") })?;

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
	.map_err(|e| { tracing::error!(error = %e, "Failed to load share link creator role"); internal_error("Failed to load share link creator role") })?
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
		.map_err(|e| { tracing::error!(error = %e, "Failed to revoke share link"); internal_error("Failed to revoke share link") })?;

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
		query(
			"UPDATE share_link SET is_one_time_use = $1, max_access_count = $2 WHERE id = $3",
		)
		.bind(is_one_time_use)
		.bind(if is_one_time_use { Some(1_i32) } else { None })
		.bind(&input.link_id)
		.execute(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to update share link"); internal_error("Failed to update share link") })?;
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
		log_share_access(pool, &link.id, None, false, Some("Share links disabled for creator plan")).await?;
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
		return Err(bad_request_error(&format!("This share link has been {}", link.status)));
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
		return Err(bad_request_error("This share link has reached its access limit"));
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
	let details = load_public_share_link_details_by_token(pool, &input.token, Some("email-restricted")).await?;
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
			message:
				"Too many verification attempts for this email. Contact the link creator."
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
		log_share_access(pool, &details.link.id, Some(&input.email), false, Some("Share links disabled for creator plan")).await?;
		return Err(bad_request_error("This share link is no longer valid"));
	}
	if !public_state.valid {
		log_share_access(pool, &details.link.id, Some(&input.email), false, Some("Link no longer valid")).await?;
		return Err(bad_request_error("This share link is no longer valid"));
	}

	let now = time::OffsetDateTime::now_utc();
	let normalized_email = input.email.to_ascii_lowercase();
	let is_still_allowed = details
		.allowed_emails
		.iter()
		.any(|entry| entry.email.to_ascii_lowercase() == normalized_email);
	if !is_still_allowed {
		log_share_access(pool, &details.link.id, Some(&input.email), false, Some("Email no longer authorized for this link")).await?;
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
				.map_err(|e| { tracing::error!(error = %e, "Failed to increment verification attempts"); internal_error("Failed to increment verification attempts") })?;

			if any_verification.attempts + 1 >= any_verification.max_attempts {
				query("UPDATE share_email_verification SET used_at = $1 WHERE id = $2")
					.bind(now)
					.bind(&any_verification.id)
					.execute(pool)
					.await
					.map_err(|e| { tracing::error!(error = %e, "Failed to exhaust verification code"); internal_error("Failed to exhaust verification code") })?;
			}
		}

		log_share_access(pool, &details.link.id, Some(&input.email), false, Some("Invalid or expired verification code")).await?;
		return Err(bad_request_error("Invalid or expired verification code"));
	};

	if verification.attempts >= verification.max_attempts {
		log_share_access(pool, &details.link.id, Some(&input.email), false, Some("Max verification attempts exceeded")).await?;
		return Err(ShareRpcError {
			code: "TOO_MANY_REQUESTS".to_string(),
			message:
				"Maximum verification attempts exceeded. Please request a new code."
					.to_string(),
		});
	}

	if !consume_share_link_access(pool, &details.link.id, now).await? {
		log_share_access(pool, &details.link.id, Some(&input.email), false, Some("Access limit reached")).await?;
		return Err(bad_request_error("This share link has reached its access limit"));
	}

	query("UPDATE share_email_verification SET used_at = $1 WHERE id = $2")
		.bind(now)
		.bind(&verification.id)
		.execute(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to mark verification as used"); internal_error("Failed to mark verification as used") })?;

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

	let actor_role = query_scalar::<_, Option<String>>(
		"SELECT role::text AS role FROM vault_key WHERE vault_id = $1 AND user_id = $2 LIMIT 1",
	)
	.bind(&link.vault_id)
	.bind(actor_user_id)
	.fetch_one(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load actor vault access"); internal_error("Failed to load actor vault access") })?;

	let Some(actor_role) = actor_role else {
		return Ok(None);
	};
	let can_view = actor_role == "owner" || actor_role == "admin" || link.created_by_id == actor_user_id;
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
			"SELECT id, created_by_id, token, status::text AS status, access_mode::text AS access_mode, is_one_time_use, encrypted_item_data, encryption_iv, encrypted_share_key, share_key_iv, access_count, max_access_count, expires_at FROM share_link WHERE token = $1 AND access_mode = $2 LIMIT 1",
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

	Ok(Some(PublicShareLinkDetails { link, allowed_emails }))
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
	if token.len() != 32 || !token.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-') {
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
		.filter(|value| !value.trim().is_empty())
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
	EMAIL_REGEX.get_or_init(|| Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$").expect("email regex should compile"))
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