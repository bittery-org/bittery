use axum::{
    body::Body,
    http::{
        header::{AUTHORIZATION, CONTENT_TYPE},
        HeaderMap, HeaderValue, Request, StatusCode,
    },
};
use bittery_crypto_core::srp6a::SrpClient;
use serde_json::json;
use sqlx::{query, query_scalar, PgPool};
use std::future::Future;

use super::{
    deterministic_fake_hint, header_value, normalize_email, normalize_signup_plan,
    parse_bearer_token, parse_pending_vault_keys, plan_member_limit, signup_team_name,
    validate_hex_string, validate_login_attempt_id, validate_resource_id, validate_token,
};
use crate::services::session::now_utc;
use crate::test_support::{
    assign_user_to_team, authenticated_json_headers, seed_team, seed_user, seed_vault,
    seed_vault_key, with_rpc_test_app, RpcTestApp,
};
use time::{Duration, OffsetDateTime};

const TEST_SRP_ITERATIONS: u32 = 1_000;

#[derive(Clone)]
struct AuthCryptoFixture {
    auth_password: String,
    srp_salt: String,
    srp_verifier: String,
    secret_key_hint: String,
    public_key: String,
    encrypted_private_key: String,
    encrypted_master_key: String,
    recovery_key_hint: String,
    encrypted_vault_key: String,
}

struct AuthAccountFixture {
    user_id: String,
    email: String,
    vault_id: String,
}

struct AuthInvitationFixture {
    team_id: String,
    team_vault_id: String,
    invitation_token: String,
    invited_email: String,
}

struct LoginEphemeralFixture {
    public_key: String,
    secret: String,
}

#[tokio::test]
async fn auth_public_signup_login_and_logout_flow() {
    with_auth_test_env_async(Some("cloud"), async {
        with_rpc_test_app(
            "auth_public_signup_login_and_logout_flow",
            |app| async move {
                let email = "MixedCase.Auth@example.com";
                let normalized_email = normalize_email(email);
                let crypto = build_auth_crypto_fixture("public-signup", "signup-password-123");

                let registration = app
                    .rpc_call(
                        "auth.registrationStatus",
                        json!([]),
                        unauthenticated_json_headers(),
                    )
                    .await;
                assert_eq!(registration.status, StatusCode::OK);
                assert_eq!(registration.body["result"]["Ok"]["mode"], json!("cloud"));
                assert_eq!(
                    registration.body["result"]["Ok"]["allowPublicSignup"],
                    json!(true)
                );
                assert_eq!(
                    registration.body["result"]["Ok"]["requiresEmailVerification"],
                    json!(true)
                );

                let unknown_email = app
                    .rpc_call(
                        "auth.checkEmail",
                        json!([{ "email": email }]),
                        unauthenticated_json_headers(),
                    )
                    .await;
                assert_eq!(unknown_email.status, StatusCode::OK);
                assert_eq!(unknown_email.body["result"]["Ok"]["exists"], json!(true));
                assert_eq!(
                    unknown_email.body["result"]["Ok"]["secretKeyHint"],
                    json!(deterministic_fake_hint(&normalized_email)),
                );

                let request_verification = app
                    .rpc_call(
                        "auth.requestSignupVerification",
                        json!([{ "email": email, "invitationToken": null }]),
                        unauthenticated_json_headers(),
                    )
                    .await;
                assert_eq!(request_verification.status, StatusCode::OK);
                assert_eq!(
                    request_verification.body["result"]["Ok"]["success"],
                    json!(true)
                );

                let code = latest_signup_verification_code(&app.pool, email, None).await;

                let wrong_code = app
                    .rpc_call(
                        "auth.verifySignupVerification",
                        json!([{ "email": email, "code": "000000", "invitationToken": null }]),
                        unauthenticated_json_headers(),
                    )
                    .await;
                assert_eq!(wrong_code.status, StatusCode::OK);
                assert_eq!(wrong_code.body["result"]["Ok"]["success"], json!(false));
                assert_eq!(
                    wrong_code.body["result"]["Ok"]["signupVerificationToken"],
                    json!(null)
                );

                let verify = app
                    .rpc_call(
                        "auth.verifySignupVerification",
                        json!([{ "email": email, "code": code, "invitationToken": null }]),
                        unauthenticated_json_headers(),
                    )
                    .await;
                assert_eq!(verify.status, StatusCode::OK);
                assert_eq!(verify.body["result"]["Ok"]["success"], json!(true));
                let signup_verification_token = verify.body["result"]["Ok"]
                    ["signupVerificationToken"]
                    .as_str()
                    .expect("signup verification token should be returned")
                    .to_string();

                let signup = app
                    .rpc_call(
                        "auth.signup",
                        json!([{
                            "email": email,
                            "signupVerificationToken": signup_verification_token,
                            "name": "Auth Public User",
                            "plan": "personal",
                            "organizationName": null,
                            "secretKeyHint": crypto.secret_key_hint,
                            "srpSalt": crypto.srp_salt,
                            "srpVerifier": crypto.srp_verifier,
                            "publicKey": crypto.public_key,
                            "encryptedPrivateKey": crypto.encrypted_private_key,
                            "encryptedMasterKey": crypto.encrypted_master_key,
                            "recoveryKeyHint": crypto.recovery_key_hint,
                            "encryptedVaultKey": crypto.encrypted_vault_key,
                        }]),
                        unauthenticated_json_headers(),
                    )
                    .await;
                assert_eq!(signup.status, StatusCode::OK);
                assert_eq!(signup.body["result"]["Ok"]["success"], json!(true));
                assert_eq!(
                    signup.body["result"]["Ok"]["user"]["email"],
                    json!(normalized_email)
                );
                assert_eq!(
                    signup.body["result"]["Ok"]["user"]["teamType"],
                    json!("personal")
                );
                let signup_token = signup.body["result"]["Ok"]["token"]
                    .as_str()
                    .expect("signup token should exist")
                    .to_string();

                let me = app
                    .rpc_call(
                        "auth.me",
                        json!([]),
                        authenticated_json_headers(&signup_token),
                    )
                    .await;
                assert_eq!(me.status, StatusCode::OK);
                assert_eq!(me.body["result"]["Ok"]["email"], json!(normalized_email));
                assert_eq!(me.body["result"]["Ok"]["hasRecoveryKey"], json!(true));

                let existing_email = app
                    .rpc_call(
                        "auth.checkEmail",
                        json!([{ "email": normalized_email }]),
                        unauthenticated_json_headers(),
                    )
                    .await;
                assert_eq!(existing_email.status, StatusCode::OK);
                assert_eq!(
                    existing_email.body["result"]["Ok"]["secretKeyHint"],
                    json!(crypto.secret_key_hint),
                );

                let malformed_start = app
                    .rpc_call(
                        "auth.startLogin",
                        json!([{ "email": normalized_email, "clientPublicKey": "not-hex" }]),
                        unauthenticated_json_headers(),
                    )
                    .await;
                assert_eq!(malformed_start.status, StatusCode::OK);
                assert_handler_error(
                    &malformed_start.body,
                    "BAD_REQUEST",
                    "Invalid client public key",
                );

                let ephemeral = build_login_ephemeral_fixture();
                let start_login = app
					.rpc_call(
						"auth.startLogin",
						json!([{ "email": normalized_email, "clientPublicKey": ephemeral.public_key }]),
						unauthenticated_json_headers(),
					)
					.await;
                assert_eq!(start_login.status, StatusCode::OK);
                let start_ok = &start_login.body["result"]["Ok"];
                let start_salt = start_ok["salt"].as_str().expect("salt should be returned");
                let server_public_key = start_ok["serverPublicKey"]
                    .as_str()
                    .expect("server public key should be returned");
                let client_proof = derive_login_proof(
                    &ephemeral,
                    start_salt,
                    server_public_key,
                    &crypto.auth_password,
                    TEST_SRP_ITERATIONS,
                );

                let finish_login = app
                    .rpc_call(
                        "auth.finishLogin",
                        json!([{
                            "attemptId": start_ok["attemptId"],
                            "clientPublicKey": ephemeral.public_key,
                            "clientProof": client_proof,
                        }]),
                        unauthenticated_json_headers(),
                    )
                    .await;
                assert_eq!(finish_login.status, StatusCode::OK);
                assert_eq!(
                    finish_login.body["result"]["Ok"]["user"]["email"],
                    json!(normalized_email)
                );
                let login_token = finish_login.body["result"]["Ok"]["token"]
                    .as_str()
                    .expect("login token should exist")
                    .to_string();

                let refreshed = app
                    .rpc_call(
                        "auth.refreshSession",
                        json!([]),
                        authenticated_json_headers(&login_token),
                    )
                    .await;
                assert_eq!(refreshed.status, StatusCode::OK);
                let refreshed_token = refreshed.body["result"]["Ok"]["token"]
                    .as_str()
                    .expect("refresh token should exist")
                    .to_string();
                assert_ne!(refreshed_token, login_token);

                let logout = app
                    .rpc_call(
                        "auth.logout",
                        json!([]),
                        authenticated_json_headers(&refreshed_token),
                    )
                    .await;
                assert_eq!(logout.status, StatusCode::OK);
                assert_eq!(logout.body["result"]["Ok"]["success"], json!(true));

                let me_after_logout = app
                    .rpc_call(
                        "auth.me",
                        json!([]),
                        authenticated_json_headers(&refreshed_token),
                    )
                    .await;
                assert_eq!(me_after_logout.status, StatusCode::OK);
                assert_rpc_error(
                    &me_after_logout.body,
                    "UNAUTHORIZED",
                    "Authentication required",
                );
            },
        )
        .await;
    })
    .await;
}

#[tokio::test]
async fn auth_cloud_public_signup_can_be_disabled_for_beta() {
    with_auth_test_env_async(Some("cloud"), async {
        unsafe { std::env::set_var("BITTERY_CLOUD_PUBLIC_SIGNUP", "false") };
        with_rpc_test_app("auth_cloud_public_signup_disabled", |app| async move {
            let registration = app
                .rpc_call(
                    "auth.registrationStatus",
                    json!([]),
                    unauthenticated_json_headers(),
                )
                .await;
            assert_eq!(registration.status, StatusCode::OK);
            assert_eq!(registration.body["result"]["Ok"]["mode"], json!("cloud"));
            assert_eq!(
                registration.body["result"]["Ok"]["allowPublicSignup"],
                json!(false)
            );
            assert_eq!(
                registration.body["result"]["Ok"]["reason"],
                json!("cloud_beta_invite_only")
            );

            let email = "beta-disabled@example.com";
            let crypto = build_auth_crypto_fixture("beta-disabled", "signup-password-123");
            let signup_verification_token =
                issue_signup_verification_token(&app, email, None).await;
            let signup = app
                .rpc_call(
                    "auth.signup",
                    json!([{
                        "email": email,
                        "signupVerificationToken": signup_verification_token,
                        "name": "Beta Disabled User",
                        "plan": "free",
                        "organizationName": null,
                        "secretKeyHint": crypto.secret_key_hint,
                        "srpSalt": crypto.srp_salt,
                        "srpVerifier": crypto.srp_verifier,
                        "publicKey": crypto.public_key,
                        "encryptedPrivateKey": crypto.encrypted_private_key,
                        "encryptedMasterKey": crypto.encrypted_master_key,
                        "recoveryKeyHint": crypto.recovery_key_hint,
                        "encryptedVaultKey": crypto.encrypted_vault_key,
                    }]),
                    unauthenticated_json_headers(),
                )
                .await;
            assert_eq!(signup.status, StatusCode::OK);
            assert_handler_error(
                &signup.body,
                "FORBIDDEN",
                "Hosted beta signup is invite-only. Join the waitlist or ask for an invite link.",
            );
        })
        .await;
    })
    .await;
}

#[tokio::test]
async fn auth_cloud_invitation_signup_still_works_when_public_signup_disabled() {
    with_auth_test_env_async(Some("cloud"), async {
        unsafe { std::env::set_var("BITTERY_CLOUD_PUBLIC_SIGNUP", "false") };
        with_rpc_test_app("auth_invitation_signup_public_disabled", |app| async move {
            let fixture = build_auth_invitation_fixture(&app.pool, "beta_disabled").await;
            let crypto = build_auth_crypto_fixture("beta-invite", "invite-success-pass");
            let signup_verification_token = issue_signup_verification_token(
                &app,
                &fixture.invited_email,
                Some(&fixture.invitation_token),
            )
            .await;

            let signup = app
                .rpc_call(
                    "auth.signupWithInvitation",
                    json!([{
                        "token": fixture.invitation_token,
                        "email": fixture.invited_email,
                        "signupVerificationToken": signup_verification_token,
                        "name": "Invited Beta User",
                        "secretKeyHint": crypto.secret_key_hint,
                        "srpSalt": crypto.srp_salt,
                        "srpVerifier": crypto.srp_verifier,
                        "publicKey": crypto.public_key,
                        "encryptedPrivateKey": crypto.encrypted_private_key,
                        "encryptedMasterKey": crypto.encrypted_master_key,
                        "recoveryKeyHint": crypto.recovery_key_hint,
                        "encryptedVaultKey": crypto.encrypted_vault_key,
                    }]),
                    unauthenticated_json_headers(),
                )
                .await;
            assert_eq!(signup.status, StatusCode::OK);
            assert_eq!(signup.body["result"]["Ok"]["success"], json!(true));
            assert_eq!(
                signup.body["result"]["Ok"]["user"]["teamId"],
                json!(fixture.team_id)
            );
        })
        .await;
    })
    .await;
}

#[tokio::test]
async fn auth_protected_handlers_require_authentication() {
    with_rpc_test_app("auth_protected_handlers_require_authentication", |app| async move {
			let protected_calls = vec![
				("auth.me", json!([])),
				("auth.updateEmail", json!([{ "newEmail": "new@example.com", "srpSalt": "aa", "srpVerifier": "bb", "encryptedPrivateKey": "cipher", "encryptedVaultKeys": [] }])),
				("auth.changePassword", json!([{ "srpSalt": "aa", "srpVerifier": "bb", "encryptedPrivateKey": "cipher", "encryptedVaultKeys": [] }])),
				("auth.regenerateSecretKey", json!([{ "secretKeyHint": "SK1-TEST", "srpSalt": "aa", "srpVerifier": "bb", "encryptedPrivateKey": "cipher", "encryptedVaultKeys": [] }])),
				("auth.storeRecoveryKey", json!([{ "encryptedMasterKey": "master", "recoveryKeyHint": "hint" }])),
				("auth.deleteAccount", json!([{ "confirmEmail": "user@example.com" }])),
				("auth.listDevices", json!([])),
				("auth.revokeDevice", json!([{ "sessionId": "session_target_01" }])),
				("auth.renameDevice", json!([{ "sessionId": "session_target_01", "deviceName": "Laptop" }])),
				("auth.heartbeat", json!([])),
				("auth.logout", json!([])),
				("auth.logoutAll", json!([])),
				("auth.refreshSession", json!([])),
			];

			for (method, params) in protected_calls {
				let response = app
					.rpc_call(method, params, unauthenticated_json_headers())
					.await;
				assert_eq!(response.status, StatusCode::OK, "unexpected status for {method}");
				assert_rpc_error(
					&response.body,
					"UNAUTHORIZED",
					"Authentication required",
				);
			}
		})
		.await;
}

#[tokio::test]
async fn auth_self_hosted_registration_requires_bootstrap_invite() {
    with_auth_test_env_async(Some("self-hosted"), async {
        with_rpc_test_app(
            "auth_self_hosted_registration_requires_bootstrap_invite",
            |app| async move {
                seed_user(
                    &app.pool,
                    "bootstrap_user_seed",
                    "Bootstrap User",
                    "bootstrap@example.com",
                )
                .await;

                let registration = app
                    .rpc_call(
                        "auth.registrationStatus",
                        json!([]),
                        unauthenticated_json_headers(),
                    )
                    .await;
                assert_eq!(registration.status, StatusCode::OK);
                assert_eq!(
                    registration.body["result"]["Ok"]["mode"],
                    json!("self-hosted")
                );
                assert_eq!(
                    registration.body["result"]["Ok"]["allowPublicSignup"],
                    json!(false)
                );
                assert_eq!(
                    registration.body["result"]["Ok"]["reason"],
                    json!("invite_only_after_bootstrap")
                );
                assert_eq!(
                    registration.body["result"]["Ok"]["requiresEmailVerification"],
                    json!(false)
                );

                let verification = app
                    .rpc_call(
                        "auth.requestSignupVerification",
                        json!([{ "email": "new-user@example.com", "invitationToken": null }]),
                        unauthenticated_json_headers(),
                    )
                    .await;
                assert_eq!(verification.status, StatusCode::OK);
                assert_handler_error(
                    &verification.body,
                    "FORBIDDEN",
                    "Public registration is disabled. Ask an admin for an invite link.",
                );
            },
        )
        .await;
    })
    .await;
}

#[tokio::test]
async fn auth_self_hosted_bootstrap_signup_skips_email_verification() {
    let _guard = crate::test_support::acquire_env_lock_async().await;
    let previous = (
        std::env::var("BITTERY_MODE").ok(),
        std::env::var("BITTERY_ENABLE_DEV_AUTH_STUBS").ok(),
        std::env::var("NODE_ENV").ok(),
    );
    unsafe { std::env::set_var("BITTERY_MODE", "self-hosted") };
    unsafe { std::env::remove_var("BITTERY_ENABLE_DEV_AUTH_STUBS") };
    unsafe { std::env::set_var("NODE_ENV", "production") };

    with_rpc_test_app(
        "auth_self_hosted_bootstrap_signup_skips_email_verification",
        |app| async move {
            let email = "admin@example.com";
            let crypto = build_auth_crypto_fixture("self-hosted-admin", "bootstrap-password");

            let registration = app
                .rpc_call(
                    "auth.registrationStatus",
                    json!([]),
                    unauthenticated_json_headers(),
                )
                .await;
            assert_eq!(registration.status, StatusCode::OK);
            assert_eq!(
                registration.body["result"]["Ok"]["requiresEmailVerification"],
                json!(false)
            );
            assert_eq!(
                registration.body["result"]["Ok"]["allowPublicSignup"],
                json!(true)
            );

            let request_verification = app
                .rpc_call(
                    "auth.requestSignupVerification",
                    json!([{ "email": email, "invitationToken": null }]),
                    unauthenticated_json_headers(),
                )
                .await;
            assert_eq!(request_verification.status, StatusCode::OK);
            assert_eq!(
                request_verification.body["result"]["Ok"]["success"],
                json!(true)
            );

            let signup = app
                .rpc_call(
                    "auth.signup",
                    json!([{
                        "email": email,
                        "signupVerificationToken": "",
                        "name": "Self-Hosted Admin",
                        "plan": null,
                        "organizationName": null,
                        "secretKeyHint": crypto.secret_key_hint,
                        "srpSalt": crypto.srp_salt,
                        "srpVerifier": crypto.srp_verifier,
                        "publicKey": crypto.public_key,
                        "encryptedPrivateKey": crypto.encrypted_private_key,
                        "encryptedMasterKey": crypto.encrypted_master_key,
                        "recoveryKeyHint": crypto.recovery_key_hint,
                        "encryptedVaultKey": crypto.encrypted_vault_key,
                    }]),
                    unauthenticated_json_headers(),
                )
                .await;
            assert_eq!(signup.status, StatusCode::OK);
            assert_eq!(signup.body["result"]["Ok"]["success"], json!(true));
            assert_eq!(
                signup.body["result"]["Ok"]["user"]["email"],
                json!(normalize_email(email))
            );
        },
    )
    .await;

    let (previous_mode, previous_stubs, previous_node_env) = previous;
    match previous_mode.as_deref() {
        Some(value) => unsafe { std::env::set_var("BITTERY_MODE", value) },
        None => unsafe { std::env::remove_var("BITTERY_MODE") },
    }
    match previous_stubs.as_deref() {
        Some(value) => unsafe { std::env::set_var("BITTERY_ENABLE_DEV_AUTH_STUBS", value) },
        None => unsafe { std::env::remove_var("BITTERY_ENABLE_DEV_AUTH_STUBS") },
    }
    match previous_node_env.as_deref() {
        Some(value) => unsafe { std::env::set_var("NODE_ENV", value) },
        None => unsafe { std::env::remove_var("NODE_ENV") },
    }
}

#[tokio::test]
async fn auth_invited_signup_handles_missing_and_valid_invitations() {
    with_auth_test_env_async(Some("cloud"), async {
        with_rpc_test_app(
            "auth_invited_signup_handles_missing_and_valid_invitations",
            |app| async move {
                let fixture = build_auth_invitation_fixture(&app.pool, "signup").await;
                let missing_crypto =
                    build_auth_crypto_fixture("invitation-missing", "invite-missing-pass");

                let missing = app
                    .rpc_call(
                        "auth.signupWithInvitation",
                        json!([{
                            "token": build_valid_token("missing_invite"),
                            "email": fixture.invited_email,
                            "signupVerificationToken": "invalid-token",
                            "name": "Invited User",
                            "secretKeyHint": missing_crypto.secret_key_hint,
                            "srpSalt": missing_crypto.srp_salt,
                            "srpVerifier": missing_crypto.srp_verifier,
                            "publicKey": missing_crypto.public_key,
                            "encryptedPrivateKey": missing_crypto.encrypted_private_key,
                            "encryptedMasterKey": missing_crypto.encrypted_master_key,
                            "recoveryKeyHint": missing_crypto.recovery_key_hint,
                            "encryptedVaultKey": missing_crypto.encrypted_vault_key,
                        }]),
                        unauthenticated_json_headers(),
                    )
                    .await;
                assert_eq!(missing.status, StatusCode::OK);
                assert_handler_error(
                    &missing.body,
                    "NOT_FOUND",
                    "Invitation not found or already used",
                );

                let signup_verification_token = issue_signup_verification_token(
                    &app,
                    &fixture.invited_email,
                    Some(&fixture.invitation_token),
                )
                .await;
                let crypto = build_auth_crypto_fixture("invitation-success", "invite-success-pass");

                let signup = app
                    .rpc_call(
                        "auth.signupWithInvitation",
                        json!([{
                            "token": fixture.invitation_token,
                            "email": fixture.invited_email,
                            "signupVerificationToken": signup_verification_token,
                            "name": "Invited User",
                            "secretKeyHint": crypto.secret_key_hint,
                            "srpSalt": crypto.srp_salt,
                            "srpVerifier": crypto.srp_verifier,
                            "publicKey": crypto.public_key,
                            "encryptedPrivateKey": crypto.encrypted_private_key,
                            "encryptedMasterKey": crypto.encrypted_master_key,
                            "recoveryKeyHint": crypto.recovery_key_hint,
                            "encryptedVaultKey": crypto.encrypted_vault_key,
                        }]),
                        unauthenticated_json_headers(),
                    )
                    .await;
                assert_eq!(signup.status, StatusCode::OK);
                assert_eq!(signup.body["result"]["Ok"]["success"], json!(true));
                assert_eq!(
                    signup.body["result"]["Ok"]["user"]["teamId"],
                    json!(fixture.team_id)
                );
                assert_eq!(signup.body["result"]["Ok"]["user"]["role"], json!("member"));
                assert!(signup.body["result"]["Ok"]["vaultKeys"]
                    .as_array()
                    .expect("vault keys should be an array")
                    .iter()
                    .any(|entry| entry["vaultId"] == json!(fixture.team_vault_id)));
            },
        )
        .await;
    })
    .await;
}

#[tokio::test]
async fn auth_recovery_flow_verifies_codes_returns_data_and_resets_password() {
    with_auth_test_env_async(Some("cloud"), async {
        with_rpc_test_app(
            "auth_recovery_flow_verifies_codes_returns_data_and_resets_password",
            |app| async move {
                let fixture = build_seeded_auth_account_fixture(&app.pool, "recovery").await;
                let existing_session = app.issue_session(&fixture.user_id).await;

                let request_recovery = app
                    .rpc_call(
                        "auth.requestRecoveryVerification",
                        json!([{ "email": fixture.email }]),
                        unauthenticated_json_headers(),
                    )
                    .await;
                assert_eq!(request_recovery.status, StatusCode::OK);
                assert_eq!(
                    request_recovery.body["result"]["Ok"]["success"],
                    json!(true)
                );

                let code = latest_recovery_code(&app.pool, &fixture.email).await;

                let wrong_code = app
                    .rpc_call(
                        "auth.verifyRecoveryCode",
                        json!([{ "email": fixture.email, "code": "000000" }]),
                        unauthenticated_json_headers(),
                    )
                    .await;
                assert_eq!(wrong_code.status, StatusCode::OK);
                assert_eq!(wrong_code.body["result"]["Ok"]["success"], json!(false));

                let verified = app
                    .rpc_call(
                        "auth.verifyRecoveryCode",
                        json!([{ "email": fixture.email, "code": code }]),
                        unauthenticated_json_headers(),
                    )
                    .await;
                assert_eq!(verified.status, StatusCode::OK);
                assert_eq!(verified.body["result"]["Ok"]["success"], json!(true));
                let recovery_token = verified.body["result"]["Ok"]["recoveryToken"]
                    .as_str()
                    .expect("recovery token should exist")
                    .to_string();

                let invalid_recovery = app
                    .rpc_call(
                        "auth.getRecoveryData",
                        json!([{ "recoveryToken": "invalid-token" }]),
                        unauthenticated_json_headers(),
                    )
                    .await;
                assert_eq!(invalid_recovery.status, StatusCode::OK);
                assert_handler_error(
                    &invalid_recovery.body,
                    "UNAUTHORIZED",
                    "Invalid recovery session",
                );

                let recovery_data = app
                    .rpc_call(
                        "auth.getRecoveryData",
                        json!([{ "recoveryToken": recovery_token }]),
                        unauthenticated_json_headers(),
                    )
                    .await;
                assert_eq!(recovery_data.status, StatusCode::OK);
                assert_eq!(
                    recovery_data.body["result"]["Ok"]["userId"],
                    json!(fixture.user_id)
                );
                assert!(recovery_data.body["result"]["Ok"]["vaultKeys"]
                    .as_array()
                    .expect("vault keys should be an array")
                    .iter()
                    .any(|entry| entry["vaultId"] == json!(fixture.vault_id)));

                let next_crypto = build_auth_crypto_fixture("recovery-reset", "reset-password-123");
                let reset = app
                    .rpc_call(
                        "auth.resetPassword",
                        json!([{
                            "recoveryToken": verified.body["result"]["Ok"]["recoveryToken"],
                            "srpSalt": next_crypto.srp_salt,
                            "srpVerifier": next_crypto.srp_verifier,
                            "encryptedPrivateKey": next_crypto.encrypted_private_key,
                            "encryptedMasterKey": next_crypto.encrypted_master_key,
                            "recoveryKeyHint": next_crypto.recovery_key_hint,
                            "secretKeyHint": next_crypto.secret_key_hint,
                            "encryptedVaultKeys": [{
                                "vaultId": fixture.vault_id,
                                "encryptedVaultKey": "rotated-recovery-vault-key"
                            }],
                        }]),
                        unauthenticated_json_headers(),
                    )
                    .await;
                assert_eq!(reset.status, StatusCode::OK);
                assert_eq!(reset.body["result"]["Ok"]["userId"], json!(fixture.user_id));

                let session_count = query_scalar::<_, i64>(
                    "SELECT COUNT(*)::bigint FROM session WHERE user_id = $1",
                )
                .bind(&fixture.user_id)
                .fetch_one(&app.pool)
                .await
                .expect("session count should load");
                assert_eq!(session_count, 1);
                assert!(app
                    .state
                    .sessions
                    .verify_token(&existing_session.token)
                    .await
                    .is_none());
            },
        )
        .await;
    })
    .await;
}

#[tokio::test]
async fn auth_account_mutations_update_credentials_and_revoke_sessions() {
    with_rpc_test_app(
        "auth_account_mutations_update_credentials_and_revoke_sessions",
        |app| async move {
            let fixture = build_seeded_auth_account_fixture(&app.pool, "mutations").await;
            seed_user(
                &app.pool,
                "auth_conflict_user",
                "Conflict User",
                "conflict@example.com",
            )
            .await;

            let update_session = app.issue_session(&fixture.user_id).await;
            let update_crypto = build_auth_crypto_fixture("update-email", "update-email-pass");

            let conflict = app
                .rpc_call(
                    "auth.updateEmail",
                    json!([{
                        "newEmail": "conflict@example.com",
                        "srpSalt": update_crypto.srp_salt,
                        "srpVerifier": update_crypto.srp_verifier,
                        "encryptedPrivateKey": update_crypto.encrypted_private_key,
                        "encryptedVaultKeys": [{
                            "vaultId": fixture.vault_id,
                            "encryptedVaultKey": "updated-vault-key"
                        }],
                    }]),
                    authenticated_json_headers(&update_session.token),
                )
                .await;
            assert_eq!(conflict.status, StatusCode::OK);
            assert_handler_error(&conflict.body, "BAD_REQUEST", "Email already in use");

            let update_email = app
                .rpc_call(
                    "auth.updateEmail",
                    json!([{
                        "newEmail": "updated-auth@example.com",
                        "srpSalt": update_crypto.srp_salt,
                        "srpVerifier": update_crypto.srp_verifier,
                        "encryptedPrivateKey": update_crypto.encrypted_private_key,
                        "encryptedVaultKeys": [{
                            "vaultId": fixture.vault_id,
                            "encryptedVaultKey": "updated-vault-key"
                        }],
                    }]),
                    authenticated_json_headers(&update_session.token),
                )
                .await;
            assert_eq!(update_email.status, StatusCode::OK);
            assert_eq!(update_email.body["result"]["Ok"]["success"], json!(true));
            assert!(app
                .state
                .sessions
                .verify_token(&update_session.token)
                .await
                .is_none());

            let updated_email =
                query_scalar::<_, String>("SELECT email FROM \"user\" WHERE id = $1")
                    .bind(&fixture.user_id)
                    .fetch_one(&app.pool)
                    .await
                    .expect("updated email should load");
            assert_eq!(updated_email, "updated-auth@example.com");

            let change_session = app.issue_session(&fixture.user_id).await;
            let change_crypto =
                build_auth_crypto_fixture("change-password", "change-password-pass");
            let change_password = app
                .rpc_call(
                    "auth.changePassword",
                    json!([{
                        "srpSalt": change_crypto.srp_salt,
                        "srpVerifier": change_crypto.srp_verifier,
                        "encryptedPrivateKey": change_crypto.encrypted_private_key,
                        "encryptedVaultKeys": [{
                            "vaultId": fixture.vault_id,
                            "encryptedVaultKey": "password-rotated-vault-key"
                        }],
                    }]),
                    authenticated_json_headers(&change_session.token),
                )
                .await;
            assert_eq!(change_password.status, StatusCode::OK);
            assert_eq!(change_password.body["result"]["Ok"]["success"], json!(true));
            assert!(app
                .state
                .sessions
                .verify_token(&change_session.token)
                .await
                .is_none());

            let current_session = app.issue_session(&fixture.user_id).await;
            let other_session = app.issue_session(&fixture.user_id).await;
            let regenerate_crypto =
                build_auth_crypto_fixture("regen-secret-key", "regen-secret-pass");
            let regenerate = app
                .rpc_call(
                    "auth.regenerateSecretKey",
                    json!([{
                        "secretKeyHint": regenerate_crypto.secret_key_hint,
                        "srpSalt": regenerate_crypto.srp_salt,
                        "srpVerifier": regenerate_crypto.srp_verifier,
                        "encryptedPrivateKey": regenerate_crypto.encrypted_private_key,
                        "encryptedVaultKeys": [{
                            "vaultId": fixture.vault_id,
                            "encryptedVaultKey": "secret-key-rotated-vault-key"
                        }],
                    }]),
                    authenticated_json_headers(&current_session.token),
                )
                .await;
            assert_eq!(regenerate.status, StatusCode::OK);
            assert_eq!(regenerate.body["result"]["Ok"]["success"], json!(true));
            assert!(app
                .state
                .sessions
                .verify_token(&current_session.token)
                .await
                .is_some());
            assert!(app
                .state
                .sessions
                .verify_token(&other_session.token)
                .await
                .is_none());

            let recovery_session = app.issue_session(&fixture.user_id).await;
            let store_recovery = app
                .rpc_call(
                    "auth.storeRecoveryKey",
                    json!([{
                        "encryptedMasterKey": "stored-master-key",
                        "recoveryKeyHint": "stored-hint"
                    }]),
                    authenticated_json_headers(&recovery_session.token),
                )
                .await;
            assert_eq!(store_recovery.status, StatusCode::OK);
            assert_eq!(store_recovery.body["result"]["Ok"]["success"], json!(true));

            let stored_hint = query_scalar::<_, Option<String>>(
                "SELECT recovery_key_hint FROM \"user\" WHERE id = $1",
            )
            .bind(&fixture.user_id)
            .fetch_one(&app.pool)
            .await
            .expect("recovery hint should load");
            assert_eq!(stored_hint.as_deref(), Some("stored-hint"));
        },
    )
    .await;
}

#[tokio::test]
async fn auth_session_management_and_account_deletion_flow() {
    with_rpc_test_app(
        "auth_session_management_and_account_deletion_flow",
        |app| async move {
            let fixture = build_seeded_auth_account_fixture(&app.pool, "sessions").await;
            let current_session = app.issue_session(&fixture.user_id).await;
            let other_session = app.issue_session(&fixture.user_id).await;

            let devices = app
                .rpc_call(
                    "auth.listDevices",
                    json!([]),
                    authenticated_json_headers(&current_session.token),
                )
                .await;
            assert_eq!(devices.status, StatusCode::OK);
            assert_eq!(
                devices.body["result"]["Ok"]
                    .as_array()
                    .expect("devices should be an array")
                    .len(),
                2,
            );

            let invalid_rename = app
                .rpc_call(
                    "auth.renameDevice",
                    json!([{ "sessionId": other_session.session_id, "deviceName": "   " }]),
                    authenticated_json_headers(&current_session.token),
                )
                .await;
            assert_eq!(invalid_rename.status, StatusCode::OK);
            assert_handler_error(
                &invalid_rename.body,
                "BAD_REQUEST",
                "Device name must be between 1 and 100 characters",
            );

            let rename = app
                .rpc_call(
                    "auth.renameDevice",
                    json!([{ "sessionId": other_session.session_id, "deviceName": "Work Laptop" }]),
                    authenticated_json_headers(&current_session.token),
                )
                .await;
            assert_eq!(rename.status, StatusCode::OK);
            assert_eq!(rename.body["result"]["Ok"]["success"], json!(true));

            let before_heartbeat = query_scalar::<_, OffsetDateTime>(
                "SELECT last_active_at FROM session WHERE id = $1",
            )
            .bind(&current_session.session_id)
            .fetch_one(&app.pool)
            .await
            .expect("current session last_active_at should load");

            let heartbeat = app
                .rpc_call(
                    "auth.heartbeat",
                    json!([]),
                    authenticated_json_headers(&current_session.token),
                )
                .await;
            assert_eq!(heartbeat.status, StatusCode::OK);
            assert_eq!(heartbeat.body["result"]["Ok"]["success"], json!(true));

            let after_heartbeat = query_scalar::<_, OffsetDateTime>(
                "SELECT last_active_at FROM session WHERE id = $1",
            )
            .bind(&current_session.session_id)
            .fetch_one(&app.pool)
            .await
            .expect("updated last_active_at should load");
            assert!(after_heartbeat >= before_heartbeat);

            let current_revoke = app
                .rpc_call(
                    "auth.revokeDevice",
                    json!([{ "sessionId": current_session.session_id }]),
                    authenticated_json_headers(&current_session.token),
                )
                .await;
            assert_eq!(current_revoke.status, StatusCode::OK);
            assert_handler_error(
                &current_revoke.body,
                "BAD_REQUEST",
                "Cannot revoke current session. Use logout instead.",
            );

            let revoke = app
                .rpc_call(
                    "auth.revokeDevice",
                    json!([{ "sessionId": other_session.session_id }]),
                    authenticated_json_headers(&current_session.token),
                )
                .await;
            assert_eq!(revoke.status, StatusCode::OK);
            assert_eq!(revoke.body["result"]["Ok"]["success"], json!(true));
            assert!(app
                .state
                .sessions
                .verify_token(&other_session.token)
                .await
                .is_none());

            let extra_session = app.issue_session(&fixture.user_id).await;
            let logout_all = app
                .rpc_call(
                    "auth.logoutAll",
                    json!([]),
                    authenticated_json_headers(&current_session.token),
                )
                .await;
            assert_eq!(logout_all.status, StatusCode::OK);
            assert_eq!(logout_all.body["result"]["Ok"]["success"], json!(true));
            assert!(app
                .state
                .sessions
                .verify_token(&current_session.token)
                .await
                .is_none());
            assert!(app
                .state
                .sessions
                .verify_token(&extra_session.token)
                .await
                .is_none());

            let delete_session = app.issue_session(&fixture.user_id).await;
            let wrong_confirm = app
                .rpc_call(
                    "auth.deleteAccount",
                    json!([{ "confirmEmail": "wrong@example.com" }]),
                    authenticated_json_headers(&delete_session.token),
                )
                .await;
            assert_eq!(wrong_confirm.status, StatusCode::OK);
            assert_handler_error(&wrong_confirm.body, "BAD_REQUEST", "Email does not match");

            let delete_account = app
                .rpc_call(
                    "auth.deleteAccount",
                    json!([{ "confirmEmail": fixture.email }]),
                    authenticated_json_headers(&delete_session.token),
                )
                .await;
            assert_eq!(delete_account.status, StatusCode::OK);
            assert_eq!(delete_account.body["result"]["Ok"]["success"], json!(true));

            let remaining_users =
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM \"user\" WHERE id = $1")
                    .bind(&fixture.user_id)
                    .fetch_one(&app.pool)
                    .await
                    .expect("remaining user count should load");
            assert_eq!(remaining_users, 0);
        },
    )
    .await;
}

#[test]
fn header_helpers_trim_values_and_extract_bearer_tokens() {
    let request = Request::builder()
        .header(AUTHORIZATION, "  bearer session-token  ")
        .header("x-client-id", "  browser-1  ")
        .body(Body::empty())
        .expect("request should build");

    assert_eq!(
        header_value(&request, "x-client-id").as_deref(),
        Some("browser-1")
    );
    assert_eq!(
        parse_bearer_token(&request).as_deref(),
        Some("session-token"),
    );

    let non_bearer = Request::builder()
        .header(AUTHORIZATION, "Basic abc123")
        .body(Body::empty())
        .expect("request should build");
    assert_eq!(parse_bearer_token(&non_bearer), None);

    let invalid_header = Request::builder()
        .header(
            "x-client-id",
            HeaderValue::from_bytes(&[0xff]).expect("header value should build"),
        )
        .body(Body::empty())
        .expect("request should build");
    assert_eq!(header_value(&invalid_header, "x-client-id"), None);
}

#[test]
fn signup_helpers_normalize_plans_member_limits_and_names() {
    assert_eq!(
        normalize_signup_plan(None).expect("default plan should be valid"),
        "personal"
    );
    assert_eq!(
        normalize_signup_plan(Some(" Team ")).expect("team plan should be valid"),
        "team",
    );
    assert_eq!(
        normalize_signup_plan(Some("enterprise"))
            .expect_err("unknown plan should fail")
            .message,
        "Invalid plan",
    );

    assert_eq!(super::map_plan_to_team_type("family"), "family");
    assert_eq!(super::map_plan_to_team_type("team"), "organization");
    assert_eq!(super::map_plan_to_team_type("personal"), "personal");

    assert_eq!(plan_member_limit("personal"), Some(1));
    assert_eq!(plan_member_limit("family"), Some(6));
    assert_eq!(plan_member_limit("team"), None);

    assert_eq!(
        signup_team_name(true, "organization", None),
        "Bittery Instance"
    );
    assert_eq!(
        signup_team_name(true, "organization", Some("  Example Org  ")),
        "Example Org",
    );
    assert_eq!(signup_team_name(false, "family", None), "My Family");
    assert_eq!(signup_team_name(false, "personal", None), "My Team");
}

#[test]
fn validation_helpers_reject_invalid_ids_hex_attempt_ids_and_tokens() {
    validate_resource_id("resource_123").expect("resource id should be valid");
    assert_eq!(
        validate_resource_id("short")
            .expect_err("short ids should fail")
            .message,
        "Invalid resource ID",
    );

    validate_hex_string("a0ff", "Invalid hex").expect("hex should be valid");
    assert_eq!(
        validate_hex_string("abc", "Invalid hex")
            .expect_err("odd-length hex should fail")
            .message,
        "Invalid hex",
    );

    let valid_attempt_id = format!("{}:attempt_token", "a".repeat(64));
    validate_login_attempt_id(&valid_attempt_id).expect("attempt id should be valid");
    assert_eq!(
        validate_login_attempt_id("not-an-attempt-id")
            .expect_err("invalid attempt ids should fail")
            .message,
        "Invalid login attempt ID",
    );

    validate_token("abcdEFGHijklMNOPqrstUVWXyz012345").expect("token should be valid");
    assert_eq!(
        validate_token("short-token")
            .expect_err("short tokens should fail")
            .message,
        "Invalid token",
    );
}

#[test]
fn pending_vault_key_parser_accepts_valid_payloads() {
    assert!(parse_pending_vault_keys(None)
        .expect("missing payload should succeed")
        .is_empty());
    assert!(parse_pending_vault_keys(Some("  "))
        .expect("blank payload should succeed")
        .is_empty());

    let parsed = parse_pending_vault_keys(Some(
			r#"[{"vaultId":"vault-1","encryptedVaultKey":"key-1"},{"vaultId":"vault-2","encryptedVaultKey":"key-2"}]"#,
		))
		.expect("valid payload should parse");

    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].vault_id, "vault-1");
    assert_eq!(parsed[1].encrypted_vault_key, "key-2");
}

#[test]
fn pending_vault_key_parser_rejects_invalid_entries_and_duplicates() {
    assert_eq!(
        parse_pending_vault_keys(Some(r#"[{"vaultId":"vault-1","encryptedVaultKey":"   "}]"#))
            .expect_err("blank encrypted keys should fail")
            .message,
        "Invalid pendingVaultKeys entry at index 0",
    );

    assert_eq!(
			parse_pending_vault_keys(Some(
				r#"[{"vaultId":"vault-1","encryptedVaultKey":"key-1"},{"vaultId":" vault-1 ","encryptedVaultKey":"key-2"}]"#,
			))
				.expect_err("duplicate vault ids should fail")
				.message,
			"Duplicate vault IDs are not allowed in pendingVaultKeys",
		);
}

#[test]
fn fake_hint_is_case_insensitive() {
    let lower = deterministic_fake_hint("case-test@example.com");
    let upper = deterministic_fake_hint("CASE-TEST@EXAMPLE.COM");

    assert_eq!(lower, upper);
    assert!(lower.starts_with("A3-"));
    assert_eq!(lower.len(), 11);
}

fn build_auth_crypto_fixture(label: &str, auth_password: &str) -> AuthCryptoFixture {
    let client = SrpClient::new(super::HashAlgorithm::Sha256, super::PrimeGroup::G4096);
    let srp_salt = client.generate_salt();
    let private_key = client
        .derive_safe_private_key(&srp_salt, auth_password, Some(TEST_SRP_ITERATIONS))
        .expect("private key should derive");
    let srp_verifier = client
        .derive_verifier(&private_key)
        .expect("verifier should derive");

    AuthCryptoFixture {
        auth_password: auth_password.to_string(),
        srp_salt,
        srp_verifier,
        secret_key_hint: format!("SKH-{label}"),
        public_key: format!("public-key-{label}"),
        encrypted_private_key: format!("encrypted-private-key-{label}"),
        encrypted_master_key: format!("encrypted-master-key-{label}"),
        recovery_key_hint: format!("recovery-key-hint-{label}"),
        encrypted_vault_key: format!("encrypted-vault-key-{label}"),
    }
}

fn build_login_ephemeral_fixture() -> LoginEphemeralFixture {
    let client = SrpClient::new(super::HashAlgorithm::Sha256, super::PrimeGroup::G4096);
    let ephemeral = client.generate_ephemeral();
    LoginEphemeralFixture {
        public_key: ephemeral.public.clone(),
        secret: ephemeral.secret.clone(),
    }
}

fn derive_login_proof(
    ephemeral: &LoginEphemeralFixture,
    salt: &str,
    server_public_key: &str,
    auth_password: &str,
    iterations: u32,
) -> String {
    let client = SrpClient::new(super::HashAlgorithm::Sha256, super::PrimeGroup::G4096);
    let private_key = client
        .derive_safe_private_key(salt, auth_password, Some(iterations))
        .expect("private key should derive");
    let session = client
        .derive_session(&ephemeral.secret, server_public_key, salt, "", &private_key)
        .expect("login proof should derive");
    session.proof.clone()
}

async fn with_auth_test_env_async<T, F>(mode: Option<&str>, future: F) -> T
where
    F: Future<Output = T>,
{
    let _guard = crate::test_support::acquire_env_lock_async().await;
    let previous = (
        std::env::var("BITTERY_MODE").ok(),
        std::env::var("BITTERY_ENABLE_DEV_AUTH_STUBS").ok(),
        std::env::var("NODE_ENV").ok(),
        std::env::var("BITTERY_CLOUD_PUBLIC_SIGNUP").ok(),
        std::env::var("BITTERY_CLOUD_BILLING_ENABLED").ok(),
    );
    match mode {
        Some(value) => unsafe { std::env::set_var("BITTERY_MODE", value) },
        None => unsafe { std::env::remove_var("BITTERY_MODE") },
    }
    unsafe { std::env::set_var("BITTERY_ENABLE_DEV_AUTH_STUBS", "true") };
    unsafe { std::env::remove_var("NODE_ENV") };
    if mode == Some("cloud") {
        unsafe { std::env::set_var("BITTERY_CLOUD_PUBLIC_SIGNUP", "true") };
        unsafe { std::env::set_var("BITTERY_CLOUD_BILLING_ENABLED", "true") };
    }

    let result = future.await;

    let (
        previous_mode,
        previous_stubs,
        previous_node_env,
        previous_cloud_public_signup,
        previous_cloud_billing,
    ) = previous;
    match previous_mode.as_deref() {
        Some(value) => unsafe { std::env::set_var("BITTERY_MODE", value) },
        None => unsafe { std::env::remove_var("BITTERY_MODE") },
    }
    match previous_stubs.as_deref() {
        Some(value) => unsafe { std::env::set_var("BITTERY_ENABLE_DEV_AUTH_STUBS", value) },
        None => unsafe { std::env::remove_var("BITTERY_ENABLE_DEV_AUTH_STUBS") },
    }
    match previous_node_env.as_deref() {
        Some(value) => unsafe { std::env::set_var("NODE_ENV", value) },
        None => unsafe { std::env::remove_var("NODE_ENV") },
    }
    match previous_cloud_public_signup.as_deref() {
        Some(value) => unsafe { std::env::set_var("BITTERY_CLOUD_PUBLIC_SIGNUP", value) },
        None => unsafe { std::env::remove_var("BITTERY_CLOUD_PUBLIC_SIGNUP") },
    }
    match previous_cloud_billing.as_deref() {
        Some(value) => unsafe { std::env::set_var("BITTERY_CLOUD_BILLING_ENABLED", value) },
        None => unsafe { std::env::remove_var("BITTERY_CLOUD_BILLING_ENABLED") },
    }

    result
}

fn unauthenticated_json_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert("x-app-platform", HeaderValue::from_static("desktop"));
    headers.insert("x-client-id", HeaderValue::from_static("integration-test"));
    headers
}

fn assert_handler_error(body: &serde_json::Value, code: &str, message: &str) {
    assert_eq!(body["jsonrpc"], json!("2.0"));
    assert_eq!(body["result"]["Err"]["code"], json!(code));
    assert_eq!(body["result"]["Err"]["message"], json!(message));
}

fn assert_rpc_error(body: &serde_json::Value, code: &str, message: &str) {
    assert_eq!(body["jsonrpc"], json!("2.0"));
    assert_eq!(body["error"]["message"], json!(message));
    assert_eq!(body["error"]["data"]["code"], json!(code));
}

fn build_valid_token(label: &str) -> String {
    let mut token = label
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect::<String>();
    while token.len() < 32 {
        token.push('x');
    }
    token.truncate(32);
    token
}

async fn latest_signup_verification_code(
    pool: &PgPool,
    email: &str,
    invitation_token: Option<&str>,
) -> String {
    match invitation_token {
			Some(invitation_token) => query_scalar::<_, String>(
				"SELECT code FROM signup_verification WHERE email = $1 AND invitation_token = $2 ORDER BY created_at DESC LIMIT 1",
			)
			.bind(normalize_email(email))
			.bind(invitation_token)
			.fetch_one(pool)
			.await
			.expect("signup verification code should load"),
			None => query_scalar::<_, String>(
				"SELECT code FROM signup_verification WHERE email = $1 AND invitation_token IS NULL ORDER BY created_at DESC LIMIT 1",
			)
			.bind(normalize_email(email))
			.fetch_one(pool)
			.await
			.expect("signup verification code should load"),
		}
}

async fn latest_recovery_code(pool: &PgPool, email: &str) -> String {
    query_scalar::<_, String>(
        "SELECT code FROM recovery_verification WHERE email = $1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(normalize_email(email))
    .fetch_one(pool)
    .await
    .expect("recovery code should load")
}

async fn issue_signup_verification_token(
    app: &RpcTestApp,
    email: &str,
    invitation_token: Option<&str>,
) -> String {
    let request = app
        .rpc_call(
            "auth.requestSignupVerification",
            json!([{ "email": email, "invitationToken": invitation_token }]),
            unauthenticated_json_headers(),
        )
        .await;
    assert_eq!(request.status, StatusCode::OK);
    assert_eq!(request.body["result"]["Ok"]["success"], json!(true));

    let code = latest_signup_verification_code(&app.pool, email, invitation_token).await;
    let verified = app
        .rpc_call(
            "auth.verifySignupVerification",
            json!([{ "email": email, "code": code, "invitationToken": invitation_token }]),
            unauthenticated_json_headers(),
        )
        .await;
    assert_eq!(verified.status, StatusCode::OK);
    assert_eq!(verified.body["result"]["Ok"]["success"], json!(true));
    verified.body["result"]["Ok"]["signupVerificationToken"]
        .as_str()
        .expect("signup verification token should exist")
        .to_string()
}

#[allow(clippy::too_many_arguments)]
async fn seed_team_invitation(
    pool: &PgPool,
    invitation_id: &str,
    team_id: &str,
    email: &str,
    role: &str,
    invited_by_id: &str,
    token: &str,
    pending_vault_keys: Option<&str>,
) {
    query(
			"INSERT INTO team_invitation (id, team_id, email, role, invited_by_id, token, pending_vault_keys, expires_at) VALUES ($1, $2, $3, $4::team_role, $5, $6, $7, $8)",
		)
		.bind(invitation_id)
		.bind(team_id)
		.bind(normalize_email(email))
		.bind(role)
		.bind(invited_by_id)
		.bind(token)
		.bind(pending_vault_keys)
		.bind(now_utc() + Duration::days(1))
		.execute(pool)
		.await
		.expect("team invitation should seed");
}

async fn build_seeded_auth_account_fixture(pool: &PgPool, label: &str) -> AuthAccountFixture {
    let user_id = format!("auth_user_{label}");
    let email = format!("auth-{label}@example.com");
    let team_id = format!("auth_team_{label}");
    let vault_id = format!("auth_vault_{label}");

    seed_user(pool, &user_id, &format!("Auth {label}"), &email).await;
    seed_team(
        pool,
        &team_id,
        &format!("Auth Team {label}"),
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
        None,
    )
    .await;
    seed_vault_key(
        pool,
        &format!("auth_vault_key_{label}"),
        &vault_id,
        &user_id,
        "seed-encrypted-vault-key",
        "owner",
    )
    .await;
    query(
			"UPDATE \"user\" SET secret_key_hint = $1, encrypted_master_key = $2, recovery_key_hint = $3 WHERE id = $4",
		)
		.bind(format!("SEED-HINT-{label}"))
		.bind(format!("seed-master-key-{label}"))
		.bind(format!("seed-recovery-hint-{label}"))
		.bind(&user_id)
		.execute(pool)
		.await
		.expect("seeded account should update");

    AuthAccountFixture {
        user_id,
        email,
        vault_id,
    }
}

async fn build_auth_invitation_fixture(pool: &PgPool, label: &str) -> AuthInvitationFixture {
    let inviter_user_id = format!("auth_inviter_{label}");
    let team_id = format!("auth_invite_team_{label}");
    let team_vault_id = format!("auth_invite_vault_{label}");
    let invitation_token = build_valid_token(&format!("invite_{label}"));
    let invited_email = format!("invited-{label}@example.com");
    let pending_vault_keys = json!([{
        "vaultId": team_vault_id,
        "encryptedVaultKey": format!("pending-vault-key-{label}")
    }])
    .to_string();

    seed_user(
        pool,
        &inviter_user_id,
        "Inviter User",
        &format!("inviter-{label}@example.com"),
    )
    .await;
    seed_team(
        pool,
        &team_id,
        "Invited Team",
        &inviter_user_id,
        "organization",
        "team",
        "active",
    )
    .await;
    assign_user_to_team(pool, &inviter_user_id, &team_id, "owner").await;
    seed_vault(
        pool,
        &team_vault_id,
        "Shared Team Vault",
        "team",
        &inviter_user_id,
        Some(&team_id),
    )
    .await;
    seed_vault_key(
        pool,
        &format!("auth_invite_vault_key_{label}"),
        &team_vault_id,
        &inviter_user_id,
        "inviter-vault-key",
        "owner",
    )
    .await;
    seed_team_invitation(
        pool,
        &format!("auth_invitation_{label}"),
        &team_id,
        &invited_email,
        "member",
        &inviter_user_id,
        &invitation_token,
        Some(&pending_vault_keys),
    )
    .await;

    AuthInvitationFixture {
        team_id,
        team_vault_id,
        invitation_token,
        invited_email,
    }
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

const RATE_LIMITED_CODE: &str = "TOO_MANY_REQUESTS";

/// Sets (and restores on drop) `RATE_LIMIT_*` env vars. Must be constructed while
/// the env lock is held (e.g. inside `with_auth_test_env_async`).
use crate::test_support::EnvVarGuard as RateLimitEnvGuard;

/// These tests drive the per-IP limiter through `x-forwarded-for`, which the
/// server only honours when `TRUST_PROXY_MODE` says it sits behind a proxy — so
/// every rate-limit test opts in alongside its own tuning vars.
fn rate_limit_env(vars: &[(&str, &str)]) -> RateLimitEnvGuard {
    let mut all = vec![("TRUST_PROXY_MODE", "forwarded")];
    all.extend_from_slice(vars);
    RateLimitEnvGuard::set(&all)
}

fn headers_with_ip(ip: &str) -> HeaderMap {
    let mut headers = unauthenticated_json_headers();
    headers.insert(
        "x-forwarded-for",
        HeaderValue::from_str(ip).expect("ip header should build"),
    );
    headers
}

fn object_keys(value: &serde_json::Value) -> Vec<String> {
    let mut keys: Vec<String> = value
        .as_object()
        .expect("expected an object")
        .keys()
        .cloned()
        .collect();
    keys.sort();
    keys
}

#[tokio::test]
async fn verify_recovery_code_locks_out_after_repeated_failures() {
    with_auth_test_env_async(Some("cloud"), async {
        with_rpc_test_app(
            "rate_limit_recovery_verify_lockout",
            |app| async move {
                let _env = rate_limit_env(&[
                    ("RATE_LIMIT_RECOVERY_VERIFY_MAX", "3"),
                    ("RATE_LIMIT_RECOVERY_LOCK_MINUTES", "15"),
                ]);
                let fixture = build_seeded_auth_account_fixture(&app.pool, "rl_recovery").await;

                let request = app
                    .rpc_call(
                        "auth.requestRecoveryVerification",
                        json!([{ "email": fixture.email }]),
                        unauthenticated_json_headers(),
                    )
                    .await;
                assert_eq!(request.status, StatusCode::OK);
                let code = latest_recovery_code(&app.pool, &fixture.email).await;

                // Two wrong attempts stay below the threshold.
                for _ in 0..2 {
                    let wrong = app
                        .rpc_call(
                            "auth.verifyRecoveryCode",
                            json!([{ "email": fixture.email, "code": "000000" }]),
                            unauthenticated_json_headers(),
                        )
                        .await;
                    assert_eq!(wrong.body["result"]["Ok"]["success"], json!(false));
                }

                // Third wrong attempt trips the lockout.
                let tripped = app
                    .rpc_call(
                        "auth.verifyRecoveryCode",
                        json!([{ "email": fixture.email, "code": "000000" }]),
                        unauthenticated_json_headers(),
                    )
                    .await;
                assert_handler_error(
                    &tripped.body,
                    RATE_LIMITED_CODE,
                    crate::services::rate_limit::RATE_LIMITED_MESSAGE,
                );

                // The correct code must still fail while locked.
                let correct = app
                    .rpc_call(
                        "auth.verifyRecoveryCode",
                        json!([{ "email": fixture.email, "code": code }]),
                        unauthenticated_json_headers(),
                    )
                    .await;
                assert_handler_error(
                    &correct.body,
                    RATE_LIMITED_CODE,
                    crate::services::rate_limit::RATE_LIMITED_MESSAGE,
                );

                // The pending recovery_verification row is invalidated.
                let invalidated = query_scalar::<_, i64>(
                    "SELECT COUNT(*)::bigint FROM recovery_verification WHERE email = $1 AND used_at IS NOT NULL",
                )
                .bind(normalize_email(&fixture.email))
                .fetch_one(&app.pool)
                .await
                .expect("recovery verification count should load");
                assert!(invalidated >= 1);

                // locked_until is set in rate_limit_state for the recovery scope.
                let locked_until = query_scalar::<_, Option<OffsetDateTime>>(
                    "SELECT locked_until FROM rate_limit_state WHERE scope = 'auth_recovery_verify'",
                )
                .fetch_one(&app.pool)
                .await
                .expect("lock row should load");
                assert!(locked_until.is_some_and(|until| until > now_utc()));

                // An audit event was recorded.
                let audit_count = query_scalar::<_, i64>(
                    "SELECT COUNT(*)::bigint FROM audit_log WHERE user_id = $1 AND action = 'recovery_verification_locked'",
                )
                .bind(&fixture.user_id)
                .fetch_one(&app.pool)
                .await
                .expect("audit count should load");
                assert_eq!(audit_count, 1);
            },
        )
        .await;
    })
    .await;
}

#[tokio::test]
async fn start_login_is_rate_limited_per_ip() {
    with_auth_test_env_async(Some("cloud"), async {
        with_rpc_test_app("rate_limit_start_login_ip", |app| async move {
            let _env = rate_limit_env(&[
                ("RATE_LIMIT_LOGIN_IP", "3"),
                ("RATE_LIMIT_LOGIN_EMAIL", "50"),
            ]);
            let ephemeral = build_login_ephemeral_fixture();
            let email = "rl-login-ip@example.com";

            for _ in 0..3 {
                let response = app
                    .rpc_call(
                        "auth.startLogin",
                        json!([{ "email": email, "clientPublicKey": ephemeral.public_key }]),
                        headers_with_ip("203.0.113.10"),
                    )
                    .await;
                assert!(response.body["result"]["Ok"].is_object());
            }

            let blocked = app
                .rpc_call(
                    "auth.startLogin",
                    json!([{ "email": email, "clientPublicKey": ephemeral.public_key }]),
                    headers_with_ip("203.0.113.10"),
                )
                .await;
            assert_handler_error(
                &blocked.body,
                RATE_LIMITED_CODE,
                crate::services::rate_limit::RATE_LIMITED_MESSAGE,
            );

            // A different IP is unaffected.
            let other_ip = app
                .rpc_call(
                    "auth.startLogin",
                    json!([{ "email": email, "clientPublicKey": ephemeral.public_key }]),
                    headers_with_ip("203.0.113.99"),
                )
                .await;
            assert!(other_ip.body["result"]["Ok"].is_object());
        })
        .await;
    })
    .await;
}

/// Without `TRUST_PROXY_MODE`, `x-forwarded-for` is caller-controlled: if the
/// limiter keyed on it, rotating the header would mint a fresh per-IP budget on
/// every request. All spoofed values must collapse onto the same key instead.
#[tokio::test]
async fn start_login_ignores_forwarded_for_when_proxy_is_not_trusted() {
    with_auth_test_env_async(Some("cloud"), async {
        with_rpc_test_app("rate_limit_start_login_spoofed_ip", |app| async move {
            let _env = RateLimitEnvGuard::set(&[
                ("TRUST_PROXY_MODE", "none"),
                ("RATE_LIMIT_LOGIN_IP", "3"),
                ("RATE_LIMIT_LOGIN_EMAIL", "50"),
            ]);
            let ephemeral = build_login_ephemeral_fixture();
            let email = "rl-login-spoof@example.com";

            for index in 0..3 {
                let response = app
                    .rpc_call(
                        "auth.startLogin",
                        json!([{ "email": email, "clientPublicKey": ephemeral.public_key }]),
                        headers_with_ip(&format!("203.0.113.{index}")),
                    )
                    .await;
                assert!(response.body["result"]["Ok"].is_object());
            }

            // A fourth forged address does not escape the per-IP window.
            let blocked = app
                .rpc_call(
                    "auth.startLogin",
                    json!([{ "email": email, "clientPublicKey": ephemeral.public_key }]),
                    headers_with_ip("203.0.113.250"),
                )
                .await;
            assert_handler_error(
                &blocked.body,
                RATE_LIMITED_CODE,
                crate::services::rate_limit::RATE_LIMITED_MESSAGE,
            );
        })
        .await;
    })
    .await;
}

#[tokio::test]
async fn start_login_is_rate_limited_per_email_across_ips_without_enumeration() {
    with_auth_test_env_async(Some("cloud"), async {
        with_rpc_test_app("rate_limit_start_login_email", |app| async move {
            let _env = rate_limit_env(&[
                ("RATE_LIMIT_LOGIN_IP", "50"),
                ("RATE_LIMIT_LOGIN_EMAIL", "3"),
            ]);
            let ephemeral = build_login_ephemeral_fixture();
            let unregistered = "rl-login-missing@example.com";

            // The per-email counter increments even for an account that does not exist,
            // across different IPs.
            for index in 0..3 {
                let response = app
                    .rpc_call(
                        "auth.startLogin",
                        json!([{ "email": unregistered, "clientPublicKey": ephemeral.public_key }]),
                        headers_with_ip(&format!("198.51.100.{index}")),
                    )
                    .await;
                assert!(response.body["result"]["Ok"].is_object());
            }
            let blocked = app
                .rpc_call(
                    "auth.startLogin",
                    json!([{ "email": unregistered, "clientPublicKey": ephemeral.public_key }]),
                    headers_with_ip("198.51.100.200"),
                )
                .await;
            assert_handler_error(
                &blocked.body,
                RATE_LIMITED_CODE,
                crate::services::rate_limit::RATE_LIMITED_MESSAGE,
            );

            // Enumeration safety: registered and unregistered emails yield the same
            // response shape.
            let fixture = build_seeded_auth_account_fixture(&app.pool, "rl_login_enum").await;
            let registered_crypto = build_auth_crypto_fixture("rl-login-enum", "enum-password-123");
            query("UPDATE \"user\" SET srp_salt = $1, srp_verifier = $2 WHERE id = $3")
                .bind(&registered_crypto.srp_salt)
                .bind(&registered_crypto.srp_verifier)
                .bind(&fixture.user_id)
                .execute(&app.pool)
                .await
                .expect("registered account SRP fixture should update");
            let registered = app
                .rpc_call(
                    "auth.startLogin",
                    json!([{ "email": fixture.email, "clientPublicKey": ephemeral.public_key }]),
                    headers_with_ip("198.51.100.240"),
                )
                .await;
            let fresh_missing = app
                .rpc_call(
                    "auth.startLogin",
                    json!([{ "email": "rl-login-fresh-missing@example.com", "clientPublicKey": ephemeral.public_key }]),
                    headers_with_ip("198.51.100.241"),
                )
                .await;
            assert_eq!(
                object_keys(&registered.body["result"]["Ok"]),
                object_keys(&fresh_missing.body["result"]["Ok"]),
            );
        })
        .await;
    })
    .await;
}

#[tokio::test]
async fn signup_is_rate_limited_per_ip_and_per_email() {
    with_auth_test_env_async(Some("cloud"), async {
        with_rpc_test_app("rate_limit_signup", |app| async move {
            let crypto = build_auth_crypto_fixture("rl-signup", "signup-password-123");

            // Per-IP: same IP, varying emails.
            {
                let _env = rate_limit_env(&[
                    ("RATE_LIMIT_SIGNUP_IP", "2"),
                    ("RATE_LIMIT_SIGNUP_EMAIL", "50"),
                ]);
                for index in 0..2 {
                    let response = app
                        .rpc_call(
                            "auth.signup",
                            signup_params(&crypto, &format!("rl-signup-ip-{index}@example.com")),
                            headers_with_ip("192.0.2.10"),
                        )
                        .await;
                    // Rejected for a non-rate-limit reason (missing verification), but counted.
                    assert!(response.body["result"]["Err"]["code"] != json!(RATE_LIMITED_CODE));
                }
                let blocked = app
                    .rpc_call(
                        "auth.signup",
                        signup_params(&crypto, "rl-signup-ip-blocked@example.com"),
                        headers_with_ip("192.0.2.10"),
                    )
                    .await;
                assert_eq!(
                    blocked.body["result"]["Err"]["code"],
                    json!(RATE_LIMITED_CODE)
                );
            }

            // Per-email: same email, varying IPs.
            {
                let _env = rate_limit_env(&[
                    ("RATE_LIMIT_SIGNUP_IP", "50"),
                    ("RATE_LIMIT_SIGNUP_EMAIL", "2"),
                ]);
                let email = "rl-signup-email@example.com";
                for index in 0..2 {
                    let response = app
                        .rpc_call(
                            "auth.signup",
                            signup_params(&crypto, email),
                            headers_with_ip(&format!("192.0.2.{}", 100 + index)),
                        )
                        .await;
                    assert!(response.body["result"]["Err"]["code"] != json!(RATE_LIMITED_CODE));
                }
                let blocked = app
                    .rpc_call(
                        "auth.signup",
                        signup_params(&crypto, email),
                        headers_with_ip("192.0.2.200"),
                    )
                    .await;
                assert_eq!(
                    blocked.body["result"]["Err"]["code"],
                    json!(RATE_LIMITED_CODE)
                );
            }
        })
        .await;
    })
    .await;
}

#[tokio::test]
async fn request_recovery_verification_is_rate_limited() {
    with_auth_test_env_async(Some("cloud"), async {
        with_rpc_test_app("rate_limit_recovery_request", |app| async move {
            let _env = rate_limit_env(&[("RATE_LIMIT_RECOVERY_REQUEST", "2")]);
            let fixture = build_seeded_auth_account_fixture(&app.pool, "rl_recovery_req").await;

            for _ in 0..2 {
                let response = app
                    .rpc_call(
                        "auth.requestRecoveryVerification",
                        json!([{ "email": fixture.email }]),
                        headers_with_ip("192.0.2.55"),
                    )
                    .await;
                assert_eq!(response.body["result"]["Ok"]["success"], json!(true));
            }

            let blocked = app
                .rpc_call(
                    "auth.requestRecoveryVerification",
                    json!([{ "email": fixture.email }]),
                    headers_with_ip("192.0.2.55"),
                )
                .await;
            assert_handler_error(
                &blocked.body,
                RATE_LIMITED_CODE,
                crate::services::rate_limit::RATE_LIMITED_MESSAGE,
            );
        })
        .await;
    })
    .await;
}

/// Rotating the client IP must not mint a fresh budget: the email dimension is
/// keyed on the email hash alone, so it still trips.
#[tokio::test]
async fn request_recovery_verification_limits_one_email_across_rotating_ips() {
    with_auth_test_env_async(Some("cloud"), async {
        with_rpc_test_app("rate_limit_recovery_req_ip_rotation", |app| async move {
            let _env = rate_limit_env(&[("RATE_LIMIT_RECOVERY_REQUEST", "2")]);
            let fixture = build_seeded_auth_account_fixture(&app.pool, "rl_rec_ip_rot").await;

            for ip in ["198.51.100.1", "198.51.100.2"] {
                let response = app
                    .rpc_call(
                        "auth.requestRecoveryVerification",
                        json!([{ "email": fixture.email }]),
                        headers_with_ip(ip),
                    )
                    .await;
                assert_eq!(response.body["result"]["Ok"]["success"], json!(true));
            }

            // A third, previously unseen IP still hits the per-email counter.
            let blocked = app
                .rpc_call(
                    "auth.requestRecoveryVerification",
                    json!([{ "email": fixture.email }]),
                    headers_with_ip("198.51.100.3"),
                )
                .await;
            assert_handler_error(
                &blocked.body,
                RATE_LIMITED_CODE,
                crate::services::rate_limit::RATE_LIMITED_MESSAGE,
            );
        })
        .await;
    })
    .await;
}

/// Rotating the email must not mint a fresh budget either: the IP dimension is
/// keyed on the client IP alone, so a single source still trips.
#[tokio::test]
async fn request_recovery_verification_limits_one_ip_across_rotating_emails() {
    with_auth_test_env_async(Some("cloud"), async {
        with_rpc_test_app("rate_limit_recovery_req_email_rotation", |app| async move {
            let _env = rate_limit_env(&[("RATE_LIMIT_RECOVERY_REQUEST", "2")]);
            let first = build_seeded_auth_account_fixture(&app.pool, "rl_rec_em_rot_a").await;
            let second = build_seeded_auth_account_fixture(&app.pool, "rl_rec_em_rot_b").await;
            let third = build_seeded_auth_account_fixture(&app.pool, "rl_rec_em_rot_c").await;

            for email in [&first.email, &second.email] {
                let response = app
                    .rpc_call(
                        "auth.requestRecoveryVerification",
                        json!([{ "email": email }]),
                        headers_with_ip("203.0.113.9"),
                    )
                    .await;
                assert_eq!(response.body["result"]["Ok"]["success"], json!(true));
            }

            // A third, previously unseen email still hits the per-IP counter.
            let blocked = app
                .rpc_call(
                    "auth.requestRecoveryVerification",
                    json!([{ "email": third.email }]),
                    headers_with_ip("203.0.113.9"),
                )
                .await;
            assert_handler_error(
                &blocked.body,
                RATE_LIMITED_CODE,
                crate::services::rate_limit::RATE_LIMITED_MESSAGE,
            );
        })
        .await;
    })
    .await;
}

fn signup_params(crypto: &AuthCryptoFixture, email: &str) -> serde_json::Value {
    json!([{
        "email": email,
        "signupVerificationToken": "invalid-token",
        "name": "Rate Limit Signup",
        "plan": "personal",
        "organizationName": null,
        "secretKeyHint": crypto.secret_key_hint,
        "srpSalt": crypto.srp_salt,
        "srpVerifier": crypto.srp_verifier,
        "publicKey": crypto.public_key,
        "encryptedPrivateKey": crypto.encrypted_private_key,
        "encryptedMasterKey": crypto.encrypted_master_key,
        "recoveryKeyHint": crypto.recovery_key_hint,
        "encryptedVaultKey": crypto.encrypted_vault_key,
    }])
}
