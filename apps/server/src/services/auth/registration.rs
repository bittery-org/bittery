use super::{
    bad_request_handler_error, enforce_window_limit, hash_normalized_email,
    is_dev_auth_stub_enabled, jwt_signing_secret, request_ip_key, validate_hex_string,
    validate_resource_id, AuthSessionUserResponse, CheckEmailInput, CheckEmailResponse,
    LogoutResponse, PendingVaultKeyEntry, RegistrationStatusResponse,
    RequestSignupVerificationInput, SignupInput, SignupResponse, SignupWithInvitationInput,
    ValidatedKdfProfile, VerifySignupVerificationInput, VerifySignupVerificationResponse,
    JWT_ISSUER,
};
use bittery_crypto_core::normalize_email;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{query, query_as, query_scalar, FromRow, PgPool, Postgres};
use time::{Duration, OffsetDateTime};
use tracing::info;

const SIGNUP_VERIFICATION_JWT_AUDIENCE: &str = "bittery-signup-verification";
const SIGNUP_VERIFICATION_TTL_MINUTES: i64 = 15;

use super::login::load_auth_vault_keys_page;

use crate::{
    config::{bittery_mode, cloud_billing_enabled, cloud_public_signup_enabled},
    db::{
        enums::{BillingPlan, BillingStatus, TeamRole, TeamType},
        models::{DbTeamInvitationAcceptRow, DbVaultRoleRow},
    },
    error::AppError,
    repo::common::{generate_resource_id, hash_token},
    services::{
        billing::sync_team_seats_best_effort,
        rate_limit::{
            self, generic_ip_limit, rate_limited_error, signup_email_limit, signup_ip_limit,
            signup_verification_request_limit,
        },
        session::{format_rfc3339, now_utc, RequestMetadata},
        team_billing::team_management_enabled,
        vault_key::validate_encrypted_vault_key,
        verification_code::{
            LockoutVerificationCodeOutcome, VerificationCodeService, VerificationPurpose,
        },
    },
    AppState,
};

pub(super) fn deterministic_fake_hint(email: &str) -> String {
    let secret = jwt_signing_secret();
    let digest = Sha256::digest(format!("{secret}:{}", normalize_email(email)).as_bytes());
    format!("A3-{}", hex::encode_upper(&digest[..4]))
}

pub(super) fn validate_token(token: &str) -> Result<(), AppError> {
    if token.len() != 32
        || !token.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        })
    {
        return Err(bad_request_handler_error("Invalid token"));
    }
    Ok(())
}
pub(crate) async fn request_signup_verification(
    app_state: &AppState,
    request: &RequestMetadata,
    input: RequestSignupVerificationInput,
) -> Result<LogoutResponse, AppError> {
    let pool = &app_state.db_pool;
    let normalized_email = normalize_email(&input.email);

    // Two independent counters, as in `request_recovery_verification`: a composite
    // `email:ip` key would mint a fresh budget per pair, so rotating IPs for one
    // email (or emails from one IP) would bypass it. Each request both sends an
    // email and mints a new code, and minting a new code resets the per-code
    // attempt counter — so this is the outer bound on the brute-force budget, not
    // just an email-abuse limit.
    let limiter = app_state.rate_limiter.as_ref();
    enforce_window_limit(
        limiter,
        rate_limit::SCOPE_SIGNUP_VERIFY_REQUEST_EMAIL,
        &hash_normalized_email(&normalized_email),
        signup_verification_request_limit(),
    )
    .await?;
    enforce_window_limit(
        limiter,
        rate_limit::SCOPE_SIGNUP_VERIFY_REQUEST_IP,
        &request_ip_key(request),
        signup_verification_request_limit(),
    )
    .await?;

    if let Some(invitation_token) = input.invitation_token.as_deref() {
        let _ =
            get_pending_invitation_for_signup(pool, invitation_token, &normalized_email).await?;
    } else if bittery_mode() == "self-hosted" && has_any_registered_user(pool).await? {
        return Err(AppError::forbidden(
            "Public registration is disabled. Ask an admin for an invite link.",
        ));
    }

    if !requires_signup_email_verification() {
        return Ok(LogoutResponse { success: true });
    }

    VerificationCodeService::new(pool)
        .issue_and_deliver(
            VerificationPurpose::Signup {
                invitation_token: input.invitation_token.as_deref(),
            },
            &normalized_email,
        )
        .await?;

    Ok(LogoutResponse { success: true })
}

pub(crate) async fn verify_signup_verification(
    app_state: &AppState,
    request: &RequestMetadata,
    input: VerifySignupVerificationInput,
) -> Result<VerifySignupVerificationResponse, AppError> {
    let pool = &app_state.db_pool;
    let normalized_email = normalize_email(&input.email);
    let limiter = app_state.rate_limiter.as_ref();

    // Generic per-IP throttle guards against high-volume guessing spread across
    // many email addresses, which would otherwise dodge the per-email lock.
    enforce_window_limit(
        limiter,
        rate_limit::SCOPE_GENERIC_IP,
        &request_ip_key(request),
        generic_ip_limit(),
    )
    .await?;

    if let Some(invitation_token) = input.invitation_token.as_deref() {
        let _ =
            get_pending_invitation_for_signup(pool, invitation_token, &normalized_email).await?;
    }

    let verification_codes = VerificationCodeService::new(pool);
    let outcome = verification_codes
        .verify_with_lockout(
            VerificationPurpose::Signup {
                invitation_token: input.invitation_token.as_deref(),
            },
            &normalized_email,
            &input.code,
            limiter,
        )
        .await?;

    let success = match outcome {
        LockoutVerificationCodeOutcome::Valid { verification_id } => {
            verification_codes
                .consume(
                    VerificationPurpose::Signup {
                        invitation_token: input.invitation_token.as_deref(),
                    },
                    &verification_id,
                )
                .await?
        }
        LockoutVerificationCodeOutcome::Locked
        | LockoutVerificationCodeOutcome::LockoutTriggered => return Err(rate_limited_error()),
        LockoutVerificationCodeOutcome::Invalid | LockoutVerificationCodeOutcome::Exhausted => {
            false
        }
    };

    Ok(VerifySignupVerificationResponse {
        success,
        signup_verification_token: success
            .then(|| {
                create_signup_verification_token(
                    &normalized_email,
                    input.invitation_token.as_deref(),
                )
            })
            .transpose()?,
    })
}

pub(crate) async fn signup(
    app_state: &AppState,
    request: &RequestMetadata,
    input: SignupInput,
) -> Result<SignupResponse, AppError> {
    let kdf_profile = validate_signup_input(&input)?;
    let pool = &app_state.db_pool;
    let normalized_email = normalize_email(&input.email);

    let limiter = app_state.rate_limiter.as_ref();
    enforce_window_limit(
        limiter,
        rate_limit::SCOPE_SIGNUP_IP,
        &request_ip_key(request),
        signup_ip_limit(),
    )
    .await?;
    enforce_window_limit(
        limiter,
        rate_limit::SCOPE_SIGNUP_EMAIL,
        &hash_normalized_email(&normalized_email),
        signup_email_limit(),
    )
    .await?;

    let mode = bittery_mode();
    let self_hosted_mode = mode == "self-hosted";

    if self_hosted_mode && has_any_registered_user(pool).await? {
        return Err(AppError::forbidden(
            "Public registration is disabled. Ask an admin for an invite link.",
        ));
    }
    if mode == "cloud" && !cloud_public_signup_enabled() {
        return Err(AppError::forbidden(
            "Hosted beta signup is invite-only. Join the waitlist or ask for an invite link.",
        ));
    }

    if requires_signup_email_verification() {
        assert_valid_signup_verification_token(
            &input.signup_verification_token,
            &normalized_email,
            None,
        )
        .await?;
    }
    ensure_user_does_not_exist(pool, &normalized_email).await?;

    let selected_plan = if self_hosted_mode || !cloud_billing_enabled() {
        BillingPlan::Free
    } else {
        normalize_signup_plan(input.plan.as_deref())?
    };
    let team_type = if self_hosted_mode {
        TeamType::Organization
    } else {
        map_plan_to_team_type(selected_plan)
    };
    let team_name = signup_team_name(
        self_hosted_mode,
        team_type,
        input.organization_name.as_deref(),
    );
    let member_limit = if self_hosted_mode {
        None
    } else {
        plan_member_limit(selected_plan)
    };
    let billing_status = if selected_plan.is_paid() {
        BillingStatus::Incomplete
    } else {
        BillingStatus::None
    };
    let user_id = input
        .user_id
        .clone()
        .unwrap_or_else(|| generate_resource_id("user"));
    let team_id = generate_resource_id("team");
    let vault_id = input
        .vault_id
        .clone()
        .unwrap_or_else(|| generate_resource_id("vault"));

    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start signup transaction");
        AppError::internal("Failed to start signup transaction")
    })?;

    insert_user_account(
        &mut transaction,
        CreateUserParams {
            user_id: &user_id,
            email: &normalized_email,
            name: &input.name,
            email_verified: true,
            secret_key_hint: &input.secret_key_hint,
            srp_salt: &input.srp_salt,
            srp_verifier: &input.srp_verifier,
            public_key: &input.public_key,
            encrypted_private_key: &input.encrypted_private_key,
            encrypted_master_key: Some(&input.encrypted_master_key),
            recovery_key_hint: Some(&input.recovery_key_hint),
            kdf_profile,
        },
    )
    .await?;
    insert_team(
        &mut transaction,
        &team_id,
        &team_name,
        &user_id,
        team_type,
        member_limit,
        selected_plan,
        billing_status,
    )
    .await?;
    query("UPDATE \"user\" SET team_id = $1, role = 'owner' WHERE id = $2")
        .bind(&team_id)
        .bind(&user_id)
        .execute(transaction.as_mut())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to link user to team");
            AppError::internal("Failed to link user to team")
        })?;
    insert_personal_vault(
        &mut transaction,
        &vault_id,
        &user_id,
        &input.encrypted_vault_key,
    )
    .await?;

    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit signup");
        AppError::internal("Failed to commit signup")
    })?;

    let session = app_state.sessions.create_session(&user_id, request).await?;
    let vault_keys =
        load_auth_vault_keys_page(pool, app_state.object_storage.as_ref(), &user_id, None, 101)
            .await?;

    Ok(SignupResponse {
        success: true,
        user_id: user_id.clone(),
        token: session.token,
        session_id: session.session_id,
        expires_at: format_rfc3339(session.expires_at),
        user: AuthSessionUserResponse {
            id: user_id,
            email: normalized_email,
            name: input.name,
            secret_key_hint: input.secret_key_hint,
            public_key: input.public_key,
            encrypted_private_key: input.encrypted_private_key,
            team_id: Some(team_id),
            team_name: Some(team_name),
            team_type: Some(team_type),
            team_avatar_url: None,
            role: TeamRole::Owner,
        },
        vault_keys,
    })
}

pub(crate) async fn signup_with_invitation(
    app_state: &AppState,
    request: &RequestMetadata,
    input: SignupWithInvitationInput,
) -> Result<SignupResponse, AppError> {
    let kdf_profile = validate_signup_with_invitation_input(&input)?;
    let pool = &app_state.db_pool;
    // Unauthenticated endpoint: apply the generic per-IP throttle so it cannot be
    // hammered to probe invitation tokens / emails.
    enforce_window_limit(
        app_state.rate_limiter.as_ref(),
        rate_limit::SCOPE_GENERIC_IP,
        &request_ip_key(request),
        generic_ip_limit(),
    )
    .await?;
    let normalized_email = normalize_email(&input.email);
    let invitation = get_pending_signup_invitation(pool, &input.token, &normalized_email).await?;

    if requires_signup_email_verification() {
        assert_valid_signup_verification_token(
            &input.signup_verification_token,
            &normalized_email,
            Some(&input.token),
        )
        .await?;
    }
    ensure_user_does_not_exist(pool, &normalized_email).await?;

    if let Some(member_limit) = invitation.member_limit {
        let current_members =
            query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM \"user\" WHERE team_id = $1")
                .bind(&invitation.team_id)
                .fetch_one(pool)
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "Failed to load team members");
                    AppError::internal("Failed to load team members")
                })?;
        if current_members >= i64::from(member_limit) {
            return Err(AppError::bad_request("Team has reached member limit"));
        }
    }

    let pending_keys = parse_pending_vault_keys(invitation.pending_vault_keys.as_deref())?;
    assert_pending_vault_keys_authorized(
        pool,
        &invitation.team_id,
        &invitation.invited_by_id,
        &pending_keys,
    )
    .await?;

    let user_id = input
        .user_id
        .clone()
        .unwrap_or_else(|| generate_resource_id("user"));
    let personal_vault_id = input
        .vault_id
        .clone()
        .unwrap_or_else(|| generate_resource_id("vault"));
    let vault_role = invitation.role.vault_role();

    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start invited signup transaction");
        AppError::internal("Failed to start invited signup transaction")
    })?;

    insert_user_account(
        &mut transaction,
        CreateUserParams {
            user_id: &user_id,
            email: &normalized_email,
            name: &input.name,
            email_verified: true,
            secret_key_hint: &input.secret_key_hint,
            srp_salt: &input.srp_salt,
            srp_verifier: &input.srp_verifier,
            public_key: &input.public_key,
            encrypted_private_key: &input.encrypted_private_key,
            encrypted_master_key: Some(&input.encrypted_master_key),
            recovery_key_hint: Some(&input.recovery_key_hint),
            kdf_profile,
        },
    )
    .await?;
    query("UPDATE \"user\" SET team_id = $1, role = $2::team_role WHERE id = $3")
        .bind(&invitation.team_id)
        .bind(invitation.role)
        .bind(&user_id)
        .execute(transaction.as_mut())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to link invited user to team");
            AppError::internal("Failed to link invited user to team")
        })?;
    insert_personal_vault(
        &mut transaction,
        &personal_vault_id,
        &user_id,
        &input.encrypted_vault_key,
    )
    .await?;

    for pending_key in &pending_keys {
        validate_encrypted_vault_key(&pending_key.encrypted_vault_key)?;
        query(
			"INSERT INTO vault_key (id, vault_id, user_id, encrypted_vault_key, role) VALUES ($1, $2, $3, $4, $5::vault_role)",
		)
		.bind(generate_resource_id("vault_key"))
		.bind(&pending_key.vault_id)
		.bind(&user_id)
		.bind(&pending_key.encrypted_vault_key)
		.bind(vault_role)
		.execute(transaction.as_mut())
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to provision invited vault access"); AppError::internal("Failed to provision invited vault access") })?;
    }

    query("UPDATE team_invitation SET status = 'accepted', accepted_at = $1 WHERE id = $2")
        .bind(now_utc())
        .bind(&invitation.id)
        .execute(transaction.as_mut())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to accept invitation");
            AppError::internal("Failed to accept invitation")
        })?;

    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit invited signup");
        AppError::internal("Failed to commit invited signup")
    })?;

    sync_team_seats_best_effort(
        pool,
        app_state.billing_gateway.as_deref(),
        &invitation.team_id,
        invitation.billing_plan,
    )
    .await;

    let session = app_state.sessions.create_session(&user_id, request).await?;
    let vault_keys =
        load_auth_vault_keys_page(pool, app_state.object_storage.as_ref(), &user_id, None, 101)
            .await?;

    Ok(SignupResponse {
        success: true,
        user_id: user_id.clone(),
        token: session.token,
        session_id: session.session_id,
        expires_at: format_rfc3339(session.expires_at),
        user: AuthSessionUserResponse {
            id: user_id,
            email: normalized_email,
            name: input.name,
            secret_key_hint: input.secret_key_hint,
            public_key: input.public_key,
            encrypted_private_key: input.encrypted_private_key,
            team_id: Some(invitation.team_id),
            team_name: Some(invitation.team_name),
            team_type: Some(invitation.team_type),
            team_avatar_url: invitation
                .team_image_key
                .as_deref()
                .and_then(|key| app_state.object_storage.public_url(key)),
            role: invitation.role,
        },
        vault_keys,
    })
}
pub(crate) async fn registration_status(
    app_state: &AppState,
) -> Result<RegistrationStatusResponse, AppError> {
    let mode = bittery_mode().to_string();
    if mode == "cloud" {
        let allow_public_signup = cloud_public_signup_enabled();
        return Ok(RegistrationStatusResponse {
            mode,
            billing_enabled: cloud_billing_enabled(),
            allow_public_signup,
            requires_email_verification: true,
            reason: if allow_public_signup {
                None
            } else {
                Some("cloud_beta_invite_only".to_string())
            },
        });
    }

    let allow_public_signup = !has_any_registered_user(&app_state.db_pool).await?;

    Ok(RegistrationStatusResponse {
        mode,
        billing_enabled: false,
        allow_public_signup,
        requires_email_verification: false,
        reason: if allow_public_signup {
            None
        } else {
            Some("invite_only_after_bootstrap".to_string())
        },
    })
}

pub(crate) async fn check_email(
    app_state: &AppState,
    input: CheckEmailInput,
) -> Result<CheckEmailResponse, AppError> {
    let normalized_email = normalize_email(&input.email);
    let secret_key_hint = query_as::<_, DbCheckEmailRow>(
        "SELECT secret_key_hint FROM \"user\" WHERE LOWER(email) = $1 LIMIT 1",
    )
    .bind(&normalized_email)
    .fetch_optional(&app_state.db_pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load account");
        AppError::internal("Failed to load account")
    })?
    .and_then(|row| row.secret_key_hint)
    .unwrap_or_else(|| deterministic_fake_hint(&normalized_email));

    Ok(CheckEmailResponse {
        exists: true,
        secret_key_hint,
    })
}
async fn get_pending_invitation_for_signup(
    pool: &PgPool,
    invitation_token: &str,
    normalized_email: &str,
) -> Result<DbTeamInvitationAcceptRow, AppError> {
    let invitation = query_as::<_, DbTeamInvitationAcceptRow>(
        "SELECT ti.id, ti.team_id, t.name AS team_name, ti.email, ti.role::text AS role, ti.invited_by_id, ti.expires_at, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status, ti.pending_vault_keys FROM team_invitation ti INNER JOIN team t ON ti.team_id = t.id WHERE ti.token_hash = $1 AND ti.status = 'pending' LIMIT 1",
    )
    .bind(hash_token(invitation_token))
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load invitation");
        AppError::internal("Failed to load invitation")
    })?
    .ok_or_else(|| AppError::not_found("Invitation not found or already used"))?;

    if !team_management_enabled(
        bittery_mode(),
        Some(invitation.billing_plan),
        Some(invitation.billing_status),
    ) {
        return Err(AppError::forbidden(
            "This team cannot accept invitations on its current plan or billing status.",
        ));
    }
    if invitation.expires_at < OffsetDateTime::now_utc() {
        return Err(AppError::bad_request("Invitation has expired"));
    }
    if !emails_match(&invitation.email, normalized_email) {
        return Err(AppError::bad_request("Email does not match invitation"));
    }

    Ok(invitation)
}

async fn assert_valid_signup_verification_token(
    signup_verification_token: &str,
    email: &str,
    invitation_token: Option<&str>,
) -> Result<(), AppError> {
    let Some((token_email, token_invitation)) =
        verify_signup_verification_token(signup_verification_token).await
    else {
        return Err(AppError::unauthorized("Invalid signup verification"));
    };
    if token_email != email || token_invitation.as_deref() != invitation_token {
        return Err(AppError::unauthorized("Invalid signup verification"));
    }

    Ok(())
}

async fn ensure_user_does_not_exist(pool: &PgPool, email: &str) -> Result<(), AppError> {
    let existing =
        query_scalar::<_, String>("SELECT id FROM \"user\" WHERE LOWER(email) = $1 LIMIT 1")
            .bind(email)
            .fetch_optional(pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to check account");
                AppError::internal("Failed to check account")
            })?;
    if existing.is_some() {
        return Err(AppError::bad_request("Unable to create account"));
    }
    Ok(())
}

async fn get_pending_signup_invitation(
    pool: &PgPool,
    invitation_token: &str,
    normalized_email: &str,
) -> Result<DbSignupInvitationRow, AppError> {
    let invitation = query_as::<_, DbSignupInvitationRow>(
        "SELECT ti.id, ti.team_id, t.name AS team_name, t.type::text AS team_type, t.image_key AS team_image_key, ti.email, ti.role::text AS role, ti.invited_by_id, ti.expires_at, t.member_limit, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status, ti.pending_vault_keys FROM team_invitation ti INNER JOIN team t ON ti.team_id = t.id WHERE ti.token_hash = $1 AND ti.status = 'pending' LIMIT 1",
    )
    .bind(hash_token(invitation_token))
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load invitation");
        AppError::internal("Failed to load invitation")
    })?
    .ok_or_else(|| AppError::not_found("Invitation not found or already used"))?;

    if !team_management_enabled(
        bittery_mode(),
        Some(invitation.billing_plan),
        Some(invitation.billing_status),
    ) {
        return Err(AppError::forbidden(
            "This team cannot accept invitations on its current plan or billing status.",
        ));
    }
    if invitation.expires_at < OffsetDateTime::now_utc() {
        return Err(AppError::bad_request("Invitation has expired"));
    }
    if !emails_match(&invitation.email, normalized_email) {
        return Err(AppError::bad_request("Email does not match invitation"));
    }

    Ok(invitation)
}

#[derive(Clone, Copy)]
struct CreateUserParams<'a> {
    user_id: &'a str,
    email: &'a str,
    name: &'a str,
    email_verified: bool,
    secret_key_hint: &'a str,
    srp_salt: &'a str,
    srp_verifier: &'a str,
    public_key: &'a str,
    encrypted_private_key: &'a str,
    encrypted_master_key: Option<&'a str>,
    recovery_key_hint: Option<&'a str>,
    kdf_profile: ValidatedKdfProfile,
}

async fn insert_user_account(
    transaction: &mut sqlx::Transaction<'_, Postgres>,
    params: CreateUserParams<'_>,
) -> Result<(), AppError> {
    query(
        "INSERT INTO \"user\" (id, email, name, email_verified, secret_key_hint, srp_salt, srp_verifier, public_key, encrypted_private_key, encrypted_master_key, recovery_key_hint, kdf_algorithm, kdf_iterations, kdf_schema_version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
    )
    .bind(params.user_id)
    .bind(params.email)
    .bind(params.name)
    .bind(params.email_verified)
    .bind(params.secret_key_hint)
    .bind(params.srp_salt)
    .bind(params.srp_verifier)
    .bind(params.public_key)
    .bind(params.encrypted_private_key)
    .bind(params.encrypted_master_key)
    .bind(params.recovery_key_hint)
    .bind(params.kdf_profile.algorithm)
    .bind(params.kdf_profile.iterations)
    .bind(params.kdf_profile.schema_version)
    .execute(transaction.as_mut())
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to create user account");
        AppError::bad_request("Unable to create account")
    })?;

    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn insert_team(
    transaction: &mut sqlx::Transaction<'_, Postgres>,
    team_id: &str,
    team_name: &str,
    owner_id: &str,
    team_type: TeamType,
    member_limit: Option<i32>,
    billing_plan: BillingPlan,
    billing_status: BillingStatus,
) -> Result<(), AppError> {
    query(
        "INSERT INTO team (id, name, owner_id, type, member_limit, billing_plan, billing_status) VALUES ($1, $2, $3, $4::team_type, $5, $6::billing_plan, $7::billing_status)",
    )
    .bind(team_id)
    .bind(team_name)
    .bind(owner_id)
    .bind(team_type)
    .bind(member_limit)
    .bind(billing_plan)
    .bind(billing_status)
    .execute(transaction.as_mut())
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to create team");
        AppError::internal("Failed to create team")
    })?;

    Ok(())
}

async fn insert_personal_vault(
    transaction: &mut sqlx::Transaction<'_, Postgres>,
    vault_id: &str,
    user_id: &str,
    encrypted_vault_key: &str,
) -> Result<(), AppError> {
    validate_encrypted_vault_key(encrypted_vault_key)?;
    query(
        "INSERT INTO vault (id, name, type, icon, created_by_id) VALUES ($1, 'Personal', 'personal'::vault_type, 'lock', $2)",
    )
    .bind(vault_id)
    .bind(user_id)
    .execute(transaction.as_mut())
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to create personal vault");
        AppError::internal("Failed to create personal vault")
    })?;
    query(
        "INSERT INTO vault_key (id, vault_id, user_id, encrypted_vault_key, role) VALUES ($1, $2, $3, $4, 'owner')",
    )
    .bind(generate_resource_id("vault_key"))
    .bind(vault_id)
    .bind(user_id)
    .bind(encrypted_vault_key)
    .execute(transaction.as_mut())
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to create personal vault key");
        AppError::internal("Failed to create personal vault key")
    })?;

    Ok(())
}

/// Signup keeps accepting the plan as free text, trimmed and case-folded, so a client that
/// sends `" Personal "` still works. The value is closed from here on.
pub(super) fn normalize_signup_plan(plan: Option<&str>) -> Result<BillingPlan, AppError> {
    let Some(plan) = plan else {
        return Ok(BillingPlan::Personal);
    };
    plan.trim()
        .to_ascii_lowercase()
        .parse()
        .map_err(|_| AppError::bad_request("Invalid plan"))
}

pub(super) fn map_plan_to_team_type(plan: BillingPlan) -> TeamType {
    match plan {
        BillingPlan::Family => TeamType::Family,
        BillingPlan::Team => TeamType::Organization,
        BillingPlan::Free | BillingPlan::Personal => TeamType::Personal,
    }
}

pub(super) fn plan_member_limit(plan: BillingPlan) -> Option<i32> {
    match plan {
        BillingPlan::Free | BillingPlan::Personal => Some(1),
        BillingPlan::Family => Some(6),
        BillingPlan::Team => None,
    }
}

pub(super) fn signup_team_name(
    self_hosted_mode: bool,
    team_type: TeamType,
    organization_name: Option<&str>,
) -> String {
    let provided = organization_name
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if self_hosted_mode {
        return provided.unwrap_or("Bittery Instance").to_string();
    }
    if let Some(name) = provided {
        return name.to_string();
    }
    if team_type == TeamType::Family {
        "My Family".to_string()
    } else {
        "My Team".to_string()
    }
}

fn validate_signup_input(input: &SignupInput) -> Result<ValidatedKdfProfile, AppError> {
    if let Some(user_id) = input.user_id.as_deref() {
        validate_resource_id(user_id)?;
    }
    if let Some(vault_id) = input.vault_id.as_deref() {
        validate_resource_id(vault_id)?;
    }
    validate_hex_string(&input.srp_salt, "Invalid SRP salt")?;
    validate_hex_string(&input.srp_verifier, "Invalid SRP verifier")?;
    validate_encrypted_vault_key(&input.encrypted_vault_key)?;
    ValidatedKdfProfile::try_from(&input.kdf_params)
}

fn validate_signup_with_invitation_input(
    input: &SignupWithInvitationInput,
) -> Result<ValidatedKdfProfile, AppError> {
    validate_token(&input.token)?;
    if let Some(user_id) = input.user_id.as_deref() {
        validate_resource_id(user_id)?;
    }
    if let Some(vault_id) = input.vault_id.as_deref() {
        validate_resource_id(vault_id)?;
    }
    validate_hex_string(&input.srp_salt, "Invalid SRP salt")?;
    validate_hex_string(&input.srp_verifier, "Invalid SRP verifier")?;
    validate_encrypted_vault_key(&input.encrypted_vault_key)?;
    ValidatedKdfProfile::try_from(&input.kdf_params)
}

pub(super) fn parse_pending_vault_keys(
    raw_pending_vault_keys: Option<&str>,
) -> Result<Vec<PendingVaultKeyEntry>, AppError> {
    let Some(raw_value) = raw_pending_vault_keys else {
        return Ok(Vec::new());
    };
    if raw_value.trim().is_empty() {
        return Ok(Vec::new());
    }
    let parsed = serde_json::from_str::<Vec<PendingVaultKeyEntry>>(raw_value)
        .map_err(|_| bad_request_handler_error("Invalid pendingVaultKeys payload"))?;
    let mut seen_vault_ids = std::collections::HashSet::with_capacity(parsed.len());
    for (index, entry) in parsed.iter().enumerate() {
        if entry.vault_id.trim().is_empty()
            || validate_encrypted_vault_key(&entry.encrypted_vault_key).is_err()
        {
            return Err(bad_request_handler_error(&format!(
                "Invalid pendingVaultKeys entry at index {index}",
            )));
        }
        if !seen_vault_ids.insert(entry.vault_id.trim().to_string()) {
            return Err(bad_request_handler_error(
                "Duplicate vault IDs are not allowed in pendingVaultKeys",
            ));
        }
    }
    Ok(parsed
        .into_iter()
        .map(|entry| PendingVaultKeyEntry {
            vault_id: entry.vault_id.trim().to_string(),
            encrypted_vault_key: entry.encrypted_vault_key.trim().to_string(),
        })
        .collect())
}

async fn assert_pending_vault_keys_authorized(
    pool: &PgPool,
    team_id: &str,
    inviter_id: &str,
    pending_vault_keys: &[PendingVaultKeyEntry],
) -> Result<(), AppError> {
    if pending_vault_keys.is_empty() {
        return Ok(());
    }
    let vault_ids: Vec<String> = pending_vault_keys
        .iter()
        .map(|entry| entry.vault_id.clone())
        .collect();
    let team_vault_count = query_scalar::<_, i64>(
        "SELECT COUNT(*)::bigint FROM vault WHERE team_id = $1 AND id = ANY($2)",
    )
    .bind(team_id)
    .bind(&vault_ids)
    .fetch_one(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to validate pendingVaultKeys vaults");
        AppError::internal("Failed to validate pendingVaultKeys vaults")
    })?;
    if team_vault_count != vault_ids.len() as i64 {
        return Err(AppError::bad_request(
            "pendingVaultKeys contains vaults outside the invited team",
        ));
    }
    let authorized_roles = query_as::<_, DbVaultRoleRow>(
        "SELECT vault_id, role::text AS role FROM vault_key WHERE user_id = $1 AND vault_id = ANY($2)",
    )
    .bind(inviter_id)
    .bind(&vault_ids)
    .fetch_all(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to validate inviter vault access");
        AppError::internal("Failed to validate inviter vault access")
    })?;
    let authorized_vault_ids: std::collections::HashSet<String> = authorized_roles
        .into_iter()
        .filter(|record| record.role.can_manage())
        .map(|record| record.vault_id)
        .collect();
    if authorized_vault_ids.len() != vault_ids.len() {
        return Err(AppError::forbidden(
            "You do not have permission to grant access for one or more vaults",
        ));
    }
    Ok(())
}

async fn has_any_registered_user(pool: &PgPool) -> Result<bool, AppError> {
    let user_id = query_scalar::<_, String>("SELECT id FROM \"user\" LIMIT 1")
        .fetch_optional(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to load registration status");
            AppError::internal("Failed to load registration status")
        })?;
    Ok(user_id.is_some())
}

fn emails_match(invitation_email: &str, normalized_email: &str) -> bool {
    invitation_email.trim().to_lowercase() == normalized_email
}

fn requires_signup_email_verification() -> bool {
    bittery_mode() != "self-hosted"
}
fn create_signup_verification_token(
    email: &str,
    invitation_token: Option<&str>,
) -> Result<String, AppError> {
    let issued_at = now_utc().unix_timestamp() as usize;
    let expires_at =
        (now_utc() + Duration::minutes(SIGNUP_VERIFICATION_TTL_MINUTES)).unix_timestamp() as usize;
    let claims = SignupVerificationTokenClaims {
        email: email.to_string(),
        invitation_token: invitation_token.map(ToOwned::to_owned),
        token_type: "signup_verification".to_string(),
        iss: JWT_ISSUER.to_string(),
        aud: SIGNUP_VERIFICATION_JWT_AUDIENCE.to_string(),
        exp: expires_at,
        iat: issued_at,
    };

    let token = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(jwt_signing_secret().as_bytes()),
    )
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to create signup verification token");
        AppError::internal("Failed to create signup verification token")
    })?;
    if is_dev_auth_stub_enabled() {
        info!(
            email = %email,
            token = %token,
            invitation_token = invitation_token.unwrap_or("<none>"),
            "[auth] Signup verification token issued"
        );
    }
    Ok(token)
}

pub async fn verify_signup_verification_token(token: &str) -> Option<(String, Option<String>)> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_audience(&[SIGNUP_VERIFICATION_JWT_AUDIENCE]);
    validation.set_issuer(&[JWT_ISSUER]);

    decode::<SignupVerificationTokenClaims>(
        token,
        &DecodingKey::from_secret(jwt_signing_secret().as_bytes()),
        &validation,
    )
    .ok()
    .and_then(|data| {
        if data.claims.token_type != "signup_verification" {
            None
        } else {
            Some((data.claims.email, data.claims.invitation_token))
        }
    })
}
#[derive(Clone, Debug, FromRow)]
struct DbSignupInvitationRow {
    id: String,
    team_id: String,
    team_name: String,
    team_type: TeamType,
    team_image_key: Option<String>,
    email: String,
    role: TeamRole,
    invited_by_id: String,
    expires_at: OffsetDateTime,
    member_limit: Option<i32>,
    billing_plan: BillingPlan,
    billing_status: BillingStatus,
    pending_vault_keys: Option<String>,
}
#[derive(Debug, sqlx::FromRow)]
struct DbCheckEmailRow {
    secret_key_hint: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SignupVerificationTokenClaims {
    email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    invitation_token: Option<String>,
    #[serde(rename = "type")]
    token_type: String,
    iss: String,
    aud: String,
    exp: usize,
    iat: usize,
}
