use rand::RngExt;
use sha2::{Digest, Sha256};
use sqlx::{query, query_as, query_scalar, PgPool, Postgres, Transaction};
use time::{Duration, OffsetDateTime};

use crate::{
    db::models::{DbRecoveryVerificationRow, DbShareEmailVerificationRow, DbSignupVerificationRow},
    error::AppError,
    repo::common::generate_resource_id,
    services::{
        rate_limit::{
            self, recovery_verify_lock_duration, recovery_verify_max_attempts,
            signup_verify_lock_duration, signup_verify_max_attempts, RateLimiter,
        },
        session::hash_token,
    },
};

const VERIFICATION_CODE_TTL: Duration = Duration::minutes(15);

#[derive(Clone, Copy)]
pub(crate) enum VerificationPurpose<'a> {
    Signup { invitation_token: Option<&'a str> },
    Recovery,
    ShareEmail { share_link_id: &'a str },
}

pub(crate) struct VerificationCodeService<'a> {
    pool: &'a PgPool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum VerificationCodeOutcome {
    Valid { verification_id: String },
    Invalid,
    Exhausted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LockoutVerificationCodeOutcome {
    Valid { verification_id: String },
    Invalid,
    Exhausted,
    Locked,
    LockoutTriggered,
}

impl<'a> VerificationCodeService<'a> {
    pub(crate) fn new(pool: &'a PgPool) -> Self {
        Self { pool }
    }

    pub(crate) fn is_valid_code(code: &str) -> bool {
        code.len() == 6 && code.bytes().all(|byte| byte.is_ascii_digit())
    }

    pub(crate) async fn issue(
        &self,
        purpose: VerificationPurpose<'_>,
        email: &str,
    ) -> Result<String, AppError> {
        let code = generate_code();
        let now = OffsetDateTime::now_utc();
        let expires_at = now + VERIFICATION_CODE_TTL;

        match purpose {
            VerificationPurpose::Signup { invitation_token } => {
                let invitation_token_hash = invitation_token.map(hash_token);
                match invitation_token_hash.as_deref() {
                    Some(invitation_token_hash) => {
                        query(
                            "UPDATE signup_verification SET used_at = $1, updated_at = $1 WHERE email = $2 AND invitation_token_hash = $3 AND used_at IS NULL",
                        )
                        .bind(now)
                        .bind(email)
                        .bind(invitation_token_hash)
                        .execute(self.pool)
                        .await
                        .map_err(|error| {
                            tracing::error!(error = %error, "Failed to invalidate signup verification");
                            AppError::internal("Failed to create signup verification")
                        })?;
                    }
                    None => {
                        query(
                            "UPDATE signup_verification SET used_at = $1, updated_at = $1 WHERE email = $2 AND invitation_token_hash IS NULL AND used_at IS NULL",
                        )
                        .bind(now)
                        .bind(email)
                        .execute(self.pool)
                        .await
                        .map_err(|error| {
                            tracing::error!(error = %error, "Failed to invalidate signup verification");
                            AppError::internal("Failed to create signup verification")
                        })?;
                    }
                }

                query(
                    "INSERT INTO signup_verification (id, email, invitation_token_hash, code_hash, expires_at) VALUES ($1, $2, $3, $4, $5)",
                )
                .bind(generate_resource_id("signup_verify"))
                .bind(email)
                .bind(invitation_token_hash)
                .bind(hash_token(&code))
                .bind(expires_at)
                .execute(self.pool)
                .await
                .map_err(|error| {
                    tracing::error!(error = %error, "Failed to create signup verification");
                    AppError::internal("Failed to create signup verification")
                })?;
            }
            VerificationPurpose::Recovery => {
                query("UPDATE recovery_verification SET used_at = $1 WHERE email = $2 AND used_at IS NULL")
                    .bind(now)
                    .bind(email)
                    .execute(self.pool)
                    .await
                    .map_err(|error| {
                        tracing::error!(error = %error, "Failed to invalidate recovery verification");
                        AppError::internal("Failed to create recovery verification")
                    })?;

                query(
                    "INSERT INTO recovery_verification (id, email, code_hash, expires_at) VALUES ($1, $2, $3, $4)",
                )
                .bind(generate_resource_id("recovery_verification"))
                .bind(email)
                .bind(hash_token(&code))
                .bind(expires_at)
                .execute(self.pool)
                .await
                .map_err(|error| {
                    tracing::error!(error = %error, "Failed to create recovery verification");
                    AppError::internal("Failed to create recovery verification")
                })?;
            }
            VerificationPurpose::ShareEmail { share_link_id } => {
                query(
                    "INSERT INTO share_email_verification (id, share_link_id, email, code_hash, expires_at) VALUES ($1, $2, $3, $4, $5)",
                )
                .bind(generate_resource_id("share_verification"))
                .bind(share_link_id)
                .bind(email)
                .bind(hash_token(&code))
                .bind(expires_at)
                .execute(self.pool)
                .await
                .map_err(|error| {
                    tracing::error!(error = %error, "Failed to create share email verification");
                    AppError::internal("Failed to create share email verification")
                })?;
            }
        }

        Ok(code)
    }

    pub(crate) async fn verify(
        &self,
        purpose: VerificationPurpose<'_>,
        email: &str,
        code: &str,
    ) -> Result<VerificationCodeOutcome, AppError> {
        if !Self::is_valid_code(code) {
            return Ok(VerificationCodeOutcome::Invalid);
        }

        match purpose {
            VerificationPurpose::Signup { invitation_token } => {
                self.verify_signup(email, code, invitation_token).await
            }
            VerificationPurpose::Recovery => self.verify_recovery(email, code).await,
            VerificationPurpose::ShareEmail { share_link_id } => {
                self.verify_share_email(share_link_id, email, code).await
            }
        }
    }

    pub(crate) async fn verify_with_lockout(
        &self,
        purpose: VerificationPurpose<'_>,
        email: &str,
        code: &str,
        limiter: &dyn RateLimiter,
    ) -> Result<LockoutVerificationCodeOutcome, AppError> {
        let Some((scope, max_attempts, lock_duration)) = lockout_settings(purpose) else {
            return Ok(match self.verify(purpose, email, code).await? {
                VerificationCodeOutcome::Valid { verification_id } => {
                    LockoutVerificationCodeOutcome::Valid { verification_id }
                }
                VerificationCodeOutcome::Invalid => LockoutVerificationCodeOutcome::Invalid,
                VerificationCodeOutcome::Exhausted => LockoutVerificationCodeOutcome::Exhausted,
            });
        };
        let lockout_key = lockout_key(purpose, email);

        if limiter.is_locked(scope, &lockout_key).await?.is_limited() {
            return Ok(LockoutVerificationCodeOutcome::Locked);
        }

        if !Self::is_valid_code(code) {
            return Ok(LockoutVerificationCodeOutcome::Invalid);
        }

        let had_active_code = self.has_active_code(purpose, email).await?;
        let outcome = self.verify(purpose, email, code).await?;

        if let VerificationCodeOutcome::Valid { verification_id } = outcome {
            limiter.clear(scope, &lockout_key).await?;
            return Ok(LockoutVerificationCodeOutcome::Valid { verification_id });
        }

        if !had_active_code {
            return Ok(match outcome {
                VerificationCodeOutcome::Invalid => LockoutVerificationCodeOutcome::Invalid,
                VerificationCodeOutcome::Exhausted => LockoutVerificationCodeOutcome::Exhausted,
                VerificationCodeOutcome::Valid { .. } => unreachable!(),
            });
        }

        if limiter
            .record_failure(scope, &lockout_key, max_attempts, lock_duration)
            .await?
            .is_limited()
        {
            self.invalidate_pending_codes(purpose, email).await?;
            return Ok(LockoutVerificationCodeOutcome::LockoutTriggered);
        }

        Ok(match outcome {
            VerificationCodeOutcome::Invalid => LockoutVerificationCodeOutcome::Invalid,
            VerificationCodeOutcome::Exhausted => LockoutVerificationCodeOutcome::Exhausted,
            VerificationCodeOutcome::Valid { .. } => unreachable!(),
        })
    }

    pub(crate) async fn verify_with_lockout_and_consume(
        &self,
        purpose: VerificationPurpose<'_>,
        email: &str,
        code: &str,
        limiter: &dyn RateLimiter,
    ) -> Result<LockoutVerificationCodeOutcome, AppError> {
        let outcome = self
            .verify_with_lockout(purpose, email, code, limiter)
            .await?;
        let LockoutVerificationCodeOutcome::Valid { verification_id } = outcome else {
            return Ok(outcome);
        };

        if self.consume(purpose, &verification_id).await? {
            Ok(LockoutVerificationCodeOutcome::Valid { verification_id })
        } else {
            Ok(LockoutVerificationCodeOutcome::Invalid)
        }
    }

    pub(crate) async fn consume(
        &self,
        purpose: VerificationPurpose<'_>,
        verification_id: &str,
    ) -> Result<bool, AppError> {
        let now = OffsetDateTime::now_utc();
        let rows_affected = match purpose {
            VerificationPurpose::Signup { .. } => query(
                "UPDATE signup_verification SET attempts = attempts + 1, used_at = $1, updated_at = $1 WHERE id = $2 AND expires_at > $1 AND used_at IS NULL AND attempts < max_attempts",
            )
            .bind(now)
            .bind(verification_id)
            .execute(self.pool)
            .await
            .map_err(|error| {
                tracing::error!(error = %error, "Failed to consume signup verification");
                AppError::internal("Failed to consume signup verification")
            })?
            .rows_affected(),
            VerificationPurpose::Recovery => query(
                "UPDATE recovery_verification SET used_at = $1 WHERE id = $2 AND expires_at > $1 AND used_at IS NULL",
            )
            .bind(now)
            .bind(verification_id)
            .execute(self.pool)
            .await
            .map_err(|error| {
                tracing::error!(error = %error, "Failed to consume recovery verification");
                AppError::internal("Failed to consume recovery verification")
            })?
            .rows_affected(),
            VerificationPurpose::ShareEmail { share_link_id } => query(
                "UPDATE share_email_verification SET used_at = $1 WHERE id = $2 AND share_link_id = $3 AND expires_at > $1 AND used_at IS NULL",
            )
            .bind(now)
            .bind(verification_id)
            .bind(share_link_id)
            .execute(self.pool)
            .await
            .map_err(|error| {
                tracing::error!(error = %error, "Failed to consume share email verification");
                AppError::internal("Failed to consume share email verification")
            })?
            .rows_affected(),
        };

        Ok(rows_affected == 1)
    }

    pub(crate) async fn consume_recovery_session(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        verification_id: &str,
    ) -> Result<bool, AppError> {
        let rows_affected = query(
            "UPDATE recovery_verification SET attempts = max_attempts WHERE id = $1 AND used_at IS NOT NULL AND attempts < max_attempts",
        )
        .bind(verification_id)
        .execute(transaction.as_mut())
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "Failed to consume recovery session");
            AppError::internal("Failed to consume recovery session")
        })?
        .rows_affected();

        Ok(rows_affected == 1)
    }

    async fn verify_signup(
        &self,
        email: &str,
        code: &str,
        invitation_token: Option<&str>,
    ) -> Result<VerificationCodeOutcome, AppError> {
        let now = OffsetDateTime::now_utc();
        let invitation_token_hash = invitation_token.map(hash_token);
        let code_hash = hash_token(code);
        let valid = match invitation_token_hash.as_deref() {
            Some(invitation_token_hash) => query_as::<_, DbSignupVerificationRow>(
                "SELECT id, email, invitation_token_hash, code_hash, attempts, max_attempts, expires_at, used_at, created_at FROM signup_verification WHERE email = $1 AND invitation_token_hash = $2 AND code_hash = $3 AND expires_at > $4 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
            )
            .bind(email)
            .bind(invitation_token_hash)
            .bind(code_hash)
            .bind(now)
            .fetch_optional(self.pool)
            .await,
            None => query_as::<_, DbSignupVerificationRow>(
                "SELECT id, email, invitation_token_hash, code_hash, attempts, max_attempts, expires_at, used_at, created_at FROM signup_verification WHERE email = $1 AND invitation_token_hash IS NULL AND code_hash = $2 AND expires_at > $3 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
            )
            .bind(email)
            .bind(code_hash)
            .bind(now)
            .fetch_optional(self.pool)
            .await,
        }
        .map_err(|error| {
            tracing::error!(error = %error, "Failed to load signup verification");
            AppError::internal("Failed to load signup verification")
        })?;

        if let Some(verification) = valid {
            if verification.attempts >= verification.max_attempts {
                return Ok(VerificationCodeOutcome::Exhausted);
            }
            return Ok(VerificationCodeOutcome::Valid {
                verification_id: verification.id,
            });
        }

        let active = match invitation_token_hash.as_deref() {
            Some(invitation_token_hash) => query_as::<_, DbSignupVerificationRow>(
                "SELECT id, email, invitation_token_hash, code_hash, attempts, max_attempts, expires_at, used_at, created_at FROM signup_verification WHERE email = $1 AND invitation_token_hash = $2 AND expires_at > $3 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
            )
            .bind(email)
            .bind(invitation_token_hash)
            .bind(now)
            .fetch_optional(self.pool)
            .await,
            None => query_as::<_, DbSignupVerificationRow>(
                "SELECT id, email, invitation_token_hash, code_hash, attempts, max_attempts, expires_at, used_at, created_at FROM signup_verification WHERE email = $1 AND invitation_token_hash IS NULL AND expires_at > $2 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
            )
            .bind(email)
            .bind(now)
            .fetch_optional(self.pool)
            .await,
        }
        .map_err(|error| {
            tracing::error!(error = %error, "Failed to load active signup verification");
            AppError::internal("Failed to load active signup verification")
        })?;

        if let Some(verification) = active {
            self.record_failed_signup_attempt(verification, now).await?;
        }

        Ok(VerificationCodeOutcome::Invalid)
    }

    async fn verify_recovery(
        &self,
        email: &str,
        code: &str,
    ) -> Result<VerificationCodeOutcome, AppError> {
        let now = OffsetDateTime::now_utc();
        let valid = query_as::<_, DbRecoveryVerificationRow>(
            "SELECT id, email, code_hash, attempts, max_attempts, expires_at, used_at, created_at FROM recovery_verification WHERE email = $1 AND code_hash = $2 AND expires_at > $3 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
        )
        .bind(email)
        .bind(hash_token(code))
        .bind(now)
        .fetch_optional(self.pool)
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "Failed to load recovery verification");
            AppError::internal("Failed to load recovery verification")
        })?;

        if let Some(verification) = valid {
            if verification.attempts >= verification.max_attempts {
                return Ok(VerificationCodeOutcome::Exhausted);
            }
            return Ok(VerificationCodeOutcome::Valid {
                verification_id: verification.id,
            });
        }

        let active = query_as::<_, DbRecoveryVerificationRow>(
            "SELECT id, email, code_hash, attempts, max_attempts, expires_at, used_at, created_at FROM recovery_verification WHERE email = $1 AND expires_at > $2 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
        )
        .bind(email)
        .bind(now)
        .fetch_optional(self.pool)
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "Failed to load active recovery verification");
            AppError::internal("Failed to load active recovery verification")
        })?;

        if let Some(verification) = active {
            self.record_failed_recovery_attempt(verification, now)
                .await?;
        }

        Ok(VerificationCodeOutcome::Invalid)
    }

    async fn verify_share_email(
        &self,
        share_link_id: &str,
        email: &str,
        code: &str,
    ) -> Result<VerificationCodeOutcome, AppError> {
        let now = OffsetDateTime::now_utc();
        let valid = query_as::<_, DbShareEmailVerificationRow>(
            "SELECT id, share_link_id, email, code_hash, attempts, max_attempts, expires_at, created_at, used_at FROM share_email_verification WHERE share_link_id = $1 AND email = $2 AND code_hash = $3 AND expires_at > $4 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
        )
        .bind(share_link_id)
        .bind(email)
        .bind(hash_token(code))
        .bind(now)
        .fetch_optional(self.pool)
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "Failed to load share email verification");
            AppError::internal("Failed to load share email verification")
        })?;

        if let Some(verification) = valid {
            if verification.attempts >= verification.max_attempts {
                return Ok(VerificationCodeOutcome::Exhausted);
            }
            return Ok(VerificationCodeOutcome::Valid {
                verification_id: verification.id,
            });
        }

        let active = query_as::<_, DbShareEmailVerificationRow>(
            "SELECT id, share_link_id, email, code_hash, attempts, max_attempts, expires_at, created_at, used_at FROM share_email_verification WHERE share_link_id = $1 AND email = $2 AND expires_at > $3 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
        )
        .bind(share_link_id)
        .bind(email)
        .bind(now)
        .fetch_optional(self.pool)
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "Failed to load active share email verification");
            AppError::internal("Failed to load active share email verification")
        })?;

        if let Some(verification) = active {
            self.record_failed_share_email_attempt(verification, now)
                .await?;
        }

        Ok(VerificationCodeOutcome::Invalid)
    }

    async fn record_failed_signup_attempt(
        &self,
        verification: DbSignupVerificationRow,
        now: OffsetDateTime,
    ) -> Result<(), AppError> {
        let next_attempts = verification.attempts + 1;
        let used_at = (next_attempts >= verification.max_attempts).then_some(now);
        query(
            "UPDATE signup_verification SET attempts = $1, used_at = $2, updated_at = $3 WHERE id = $4",
        )
        .bind(next_attempts)
        .bind(used_at)
        .bind(now)
        .bind(verification.id)
        .execute(self.pool)
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "Failed to update signup verification attempts");
            AppError::internal("Failed to update signup verification attempts")
        })?;
        Ok(())
    }

    async fn record_failed_recovery_attempt(
        &self,
        verification: DbRecoveryVerificationRow,
        now: OffsetDateTime,
    ) -> Result<(), AppError> {
        let next_attempts = verification.attempts + 1;
        let used_at = (next_attempts >= verification.max_attempts).then_some(now);
        query("UPDATE recovery_verification SET attempts = $1, used_at = $2 WHERE id = $3")
            .bind(next_attempts)
            .bind(used_at)
            .bind(verification.id)
            .execute(self.pool)
            .await
            .map_err(|error| {
                tracing::error!(error = %error, "Failed to update recovery verification attempts");
                AppError::internal("Failed to update recovery verification attempts")
            })?;
        Ok(())
    }

    async fn record_failed_share_email_attempt(
        &self,
        verification: DbShareEmailVerificationRow,
        now: OffsetDateTime,
    ) -> Result<(), AppError> {
        let next_attempts = verification.attempts + 1;
        let used_at = (next_attempts >= verification.max_attempts).then_some(now);
        query("UPDATE share_email_verification SET attempts = $1, used_at = $2 WHERE id = $3")
            .bind(next_attempts)
            .bind(used_at)
            .bind(verification.id)
            .execute(self.pool)
            .await
            .map_err(|error| {
                tracing::error!(error = %error, "Failed to update share email verification attempts");
                AppError::internal("Failed to update share email verification attempts")
            })?;
        Ok(())
    }

    async fn has_active_code(
        &self,
        purpose: VerificationPurpose<'_>,
        email: &str,
    ) -> Result<bool, AppError> {
        let now = OffsetDateTime::now_utc();
        let exists = match purpose {
            VerificationPurpose::Signup { .. } => query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM signup_verification WHERE email = $1 AND expires_at > $2 AND used_at IS NULL)",
            )
            .bind(email)
            .bind(now)
            .fetch_one(self.pool)
            .await,
            VerificationPurpose::Recovery => query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM recovery_verification WHERE email = $1 AND expires_at > $2 AND used_at IS NULL)",
            )
            .bind(email)
            .bind(now)
            .fetch_one(self.pool)
            .await,
            VerificationPurpose::ShareEmail { share_link_id } => query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM share_email_verification WHERE share_link_id = $1 AND email = $2 AND expires_at > $3 AND used_at IS NULL)",
            )
            .bind(share_link_id)
            .bind(email)
            .bind(now)
            .fetch_one(self.pool)
            .await,
        }
        .map_err(|error| {
            tracing::error!(error = %error, "Failed to check active verification code");
            AppError::internal("Failed to check active verification code")
        })?;
        Ok(exists)
    }

    async fn invalidate_pending_codes(
        &self,
        purpose: VerificationPurpose<'_>,
        email: &str,
    ) -> Result<(), AppError> {
        let now = OffsetDateTime::now_utc();
        match purpose {
            VerificationPurpose::Signup { .. } => query(
                "UPDATE signup_verification SET used_at = $1, updated_at = $1 WHERE email = $2 AND used_at IS NULL",
            )
            .bind(now)
            .bind(email)
            .execute(self.pool)
            .await,
            VerificationPurpose::Recovery => {
                query("UPDATE recovery_verification SET used_at = $1 WHERE email = $2 AND used_at IS NULL")
                    .bind(now)
                    .bind(email)
                    .execute(self.pool)
                    .await
            }
            VerificationPurpose::ShareEmail { share_link_id } => query(
                "UPDATE share_email_verification SET used_at = $1 WHERE share_link_id = $2 AND email = $3 AND used_at IS NULL",
            )
            .bind(now)
            .bind(share_link_id)
            .bind(email)
            .execute(self.pool)
            .await,
        }
        .map_err(|error| {
            tracing::error!(error = %error, "Failed to invalidate verification codes");
            AppError::internal("Failed to invalidate verification codes")
        })?;
        Ok(())
    }
}

fn generate_code() -> String {
    rand::rng().random_range(100000..=999999).to_string()
}

fn hash_email(email: &str) -> String {
    hex::encode(Sha256::digest(email.as_bytes()))
}

fn lockout_key(purpose: VerificationPurpose<'_>, email: &str) -> String {
    match purpose {
        VerificationPurpose::ShareEmail { share_link_id } => {
            hash_email(&format!("{share_link_id}:{email}"))
        }
        VerificationPurpose::Signup { .. } | VerificationPurpose::Recovery => hash_email(email),
    }
}

fn lockout_settings(
    purpose: VerificationPurpose<'_>,
) -> Option<(&'static str, i64, std::time::Duration)> {
    match purpose {
        VerificationPurpose::Signup { .. } => Some((
            rate_limit::SCOPE_SIGNUP_VERIFY,
            signup_verify_max_attempts(),
            signup_verify_lock_duration(),
        )),
        VerificationPurpose::Recovery => Some((
            rate_limit::SCOPE_RECOVERY_VERIFY,
            recovery_verify_max_attempts(),
            recovery_verify_lock_duration(),
        )),
        VerificationPurpose::ShareEmail { .. } => Some((
            rate_limit::SCOPE_SHARE_EMAIL_VERIFY,
            rate_limit::share_email_verify_max_attempts(),
            rate_limit::share_email_verify_lock_duration(),
        )),
    }
}

#[cfg(test)]
#[path = "verification_code_tests.rs"]
mod tests;
