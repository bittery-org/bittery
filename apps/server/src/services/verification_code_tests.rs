use sqlx::{query, query_scalar};
use time::OffsetDateTime;

use super::*;
use crate::test_support::{
    acquire_env_lock_async, seed_item, seed_user, seed_vault, with_rpc_test_app, EnvVarGuard,
};

const EMAIL: &str = "verification-codes@example.com";
const SHARE_LINK_ID: &str = "verification_code_share_link";

#[test]
fn generated_codes_are_six_ascii_digits() {
    for _ in 0..100 {
        let code = generate_code();
        assert!(VerificationCodeService::is_valid_code(&code));
        assert_eq!(code.len(), 6);
    }
}

#[tokio::test]
async fn codes_expire_exhaust_and_consume_once_for_each_purpose() {
    with_rpc_test_app("verification_code_lifecycle", |app| async move {
        seed_share_link(&app.pool).await;
        let codes = VerificationCodeService::new(&app.pool);

        let signup = VerificationPurpose::Signup {
            invitation_token: None,
        };
        let recovery = VerificationPurpose::Recovery;
        let share_email = VerificationPurpose::ShareEmail {
            share_link_id: SHARE_LINK_ID,
        };

        assert_exhausts_after_five_wrong_attempts(&codes, signup, "signup_verification").await;
        assert_exhausts_after_five_wrong_attempts(&codes, recovery, "recovery_verification").await;
        assert_exhausts_after_five_wrong_attempts(&codes, share_email, "share_email_verification")
            .await;

        assert_consumes_once(&codes, signup).await;
        assert_consumes_once(&codes, recovery).await;
        assert_consumes_once(&codes, share_email).await;

        let code = codes
            .issue(share_email, EMAIL)
            .await
            .expect("code should issue");
        query("UPDATE share_email_verification SET expires_at = $1 WHERE email = $2")
            .bind(OffsetDateTime::now_utc() - time::Duration::seconds(1))
            .bind(EMAIL)
            .execute(&app.pool)
            .await
            .expect("share code should expire");
        assert_eq!(
            codes
                .verify(share_email, EMAIL, &code)
                .await
                .expect("expired verification should resolve"),
            VerificationCodeOutcome::Invalid
        );
    })
    .await;
}

#[tokio::test]
async fn signup_lockout_burns_pending_codes() {
    let _env_lock = acquire_env_lock_async().await;
    let _env = EnvVarGuard::set(&[
        ("RATE_LIMIT_SIGNUP_VERIFY_MAX", "2"),
        ("RATE_LIMIT_SIGNUP_VERIFY_LOCK_MINUTES", "15"),
    ]);

    with_rpc_test_app("verification_code_signup_lockout", |app| async move {
        let codes = VerificationCodeService::new(&app.pool);
        let purpose = VerificationPurpose::Signup {
            invitation_token: None,
        };
        let code = codes
            .issue(purpose, EMAIL)
            .await
            .expect("code should issue");

        assert_eq!(
            codes
                .verify_with_lockout(purpose, EMAIL, "000000", app.state.rate_limiter.as_ref())
                .await
                .expect("first failure should resolve"),
            LockoutVerificationCodeOutcome::Invalid
        );
        assert_eq!(
            codes
                .verify_with_lockout(purpose, EMAIL, "000000", app.state.rate_limiter.as_ref())
                .await
                .expect("second failure should resolve"),
            LockoutVerificationCodeOutcome::LockoutTriggered
        );
        assert_eq!(
            codes
                .verify_with_lockout(purpose, EMAIL, &code, app.state.rate_limiter.as_ref())
                .await
                .expect("locked verification should resolve"),
            LockoutVerificationCodeOutcome::Locked
        );
    })
    .await;
}

async fn assert_exhausts_after_five_wrong_attempts(
    codes: &VerificationCodeService<'_>,
    purpose: VerificationPurpose<'_>,
    table: &str,
) {
    let code = codes
        .issue(purpose, EMAIL)
        .await
        .expect("code should issue");
    assert_ne!(code, "000000");

    for _ in 0..5 {
        assert_eq!(
            codes
                .verify(purpose, EMAIL, "000000")
                .await
                .expect("wrong verification should resolve"),
            VerificationCodeOutcome::Invalid
        );
    }

    let used = query_scalar::<_, bool>(&format!(
        "SELECT used_at IS NOT NULL FROM {table} WHERE email = $1 ORDER BY created_at DESC LIMIT 1"
    ))
    .bind(EMAIL)
    .fetch_one(codes.pool)
    .await
    .expect("verification row should load");
    assert!(used);
}

async fn assert_consumes_once(
    codes: &VerificationCodeService<'_>,
    purpose: VerificationPurpose<'_>,
) {
    let code = codes
        .issue(purpose, EMAIL)
        .await
        .expect("code should issue");
    let VerificationCodeOutcome::Valid { verification_id } = codes
        .verify(purpose, EMAIL, &code)
        .await
        .expect("correct verification should resolve")
    else {
        panic!("correct code should verify");
    };

    assert!(codes
        .consume(purpose, &verification_id)
        .await
        .expect("first consume should resolve"));
    assert!(!codes
        .consume(purpose, &verification_id)
        .await
        .expect("second consume should resolve"));
}

async fn seed_share_link(pool: &sqlx::PgPool) {
    seed_user(pool, "verification_code_user", "Verification User", EMAIL).await;
    seed_vault(
        pool,
        "verification_code_vault",
        "Verification Vault",
        "personal",
        "verification_code_user",
        None,
    )
    .await;
    seed_item(
        pool,
        "verification_code_item",
        "verification_code_vault",
        "login",
        "encrypted-data",
        "encryption-iv",
        "verification_code_user",
    )
    .await;
    query(
        "INSERT INTO share_link (id, item_id, created_by_id, token_hash, access_mode, encrypted_item_data, encryption_iv, encrypted_share_key, share_key_iv, expires_at) VALUES ($1, $2, $3, $4, 'email-restricted', $5, $6, $7, $8, $9)",
    )
    .bind(SHARE_LINK_ID)
    .bind("verification_code_item")
    .bind("verification_code_user")
    .bind("verification-code-token-hash")
    .bind("encrypted-data")
    .bind("encryption-iv")
    .bind("encrypted-share-key")
    .bind("share-key-iv")
    .bind(OffsetDateTime::now_utc() + time::Duration::days(1))
    .execute(pool)
    .await
    .expect("share link should seed");
}
