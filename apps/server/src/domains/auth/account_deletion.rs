use bittery_crypto_core::normalize_email;
use sha2::{Digest, Sha256};
use sqlx::{query, query_as, query_scalar, FromRow, Postgres, Transaction};
use subtle::ConstantTimeEq;
use uuid::Uuid;

#[cfg(test)]
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock, Weak},
};

use crate::{
    db::{
        enums::TeamType,
        events::{generate_resource_id, hash_token, insert_audit_event},
    },
    http::{error::ApiError, error_code::ErrorCode},
    shared::{
        rate_limit::{account_mutation_limit, SCOPE_DELETE_ACCOUNT_USER},
        transaction::{acquire_team_authority_lock, database_error},
    },
    AppState,
};

use super::enforce_window_limit;

const PROOF_DOMAIN: &[u8] = b"bittery/account-deletion-proof/v1";
const REQUEST_DOMAIN: &[u8] = b"bittery/account-deletion-request/v1";
const ADVISORY_DOMAIN: &[u8] = b"bittery/account-deletion-advisory/v1";
const DELETE_METHOD: &[u8] = b"DELETE";
const DELETE_PATH: &[u8] = b"/api/v1/users/me";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AccountDeletionOutcome {
    Deleted,
    ConfirmationEmailMismatch,
    Blocked,
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum AccountDeletionMetricKind {
    Insert,
    Replay,
    Outcome(&'static str),
    CommittedInsertGrowth,
    RateLimit,
    RequestIdReuse(&'static str),
    UniquenessFailure(&'static str),
}

#[cfg(test)]
type AccountDeletionMetricBuffer = Mutex<Vec<AccountDeletionMetricKind>>;
#[cfg(test)]
type AccountDeletionMetricRegistry = Mutex<HashMap<String, Weak<AccountDeletionMetricBuffer>>>;
#[cfg(test)]
static ACCOUNT_DELETION_METRIC_RECORDERS: OnceLock<AccountDeletionMetricRegistry> = OnceLock::new();

#[cfg(test)]
pub(crate) struct AccountDeletionMetricRecorder {
    request_id: String,
    metrics: Arc<AccountDeletionMetricBuffer>,
}

#[cfg(test)]
impl AccountDeletionMetricRecorder {
    pub(crate) fn take(&self) -> Vec<AccountDeletionMetricKind> {
        std::mem::take(
            &mut *self
                .metrics
                .lock()
                .expect("Account deletion metric recorder should lock"),
        )
    }
}

#[cfg(test)]
impl Drop for AccountDeletionMetricRecorder {
    fn drop(&mut self) {
        let recorders =
            ACCOUNT_DELETION_METRIC_RECORDERS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut recorders = recorders
            .lock()
            .expect("Account deletion metric recorder registry should lock");
        if recorders
            .get(&self.request_id)
            .and_then(Weak::upgrade)
            .is_some_and(|registered| Arc::ptr_eq(&registered, &self.metrics))
        {
            recorders.remove(&self.request_id);
        }
    }
}

#[derive(Debug)]
pub(crate) struct AccountDeletionAnswer {
    pub(crate) request_id: String,
    pub(crate) outcome: AccountDeletionOutcome,
    pub(crate) replayed: bool,
}

#[derive(FromRow)]
struct RetainedOutcomeRow {
    credential_proof: Vec<u8>,
    request_fingerprint: Vec<u8>,
    outcome: String,
}

#[derive(FromRow)]
struct LiveDeletionAuthority {
    user_id: String,
    email: String,
    team_id: Option<String>,
}

pub(crate) async fn delete_server_account(
    state: &AppState,
    bearer: Option<&str>,
    request_id: &str,
    confirm_email: &str,
) -> Result<AccountDeletionAnswer, ApiError> {
    let bearer = bearer.ok_or_else(unauthorized)?;
    let request_uuid = canonical_request_id(request_id)?;
    let normalized_email = canonical_email(confirm_email)?;
    let canonical_body = serde_json::to_vec(&serde_json::json!({
        "confirmEmail": normalized_email,
    }))
    .map_err(|_| ApiError::internal())?;
    let proof = credential_proof(bearer);
    let fingerprint = request_fingerprint(&request_uuid.to_string(), &canonical_body);

    let mut transaction = state.db_pool.begin().await.map_err(|error| {
        ApiError::from(database_error(error, "Failed to begin Account deletion"))
    })?;
    lock_request_id(&mut transaction, &request_uuid).await?;

    if let Some(answer) =
        retained_answer(&mut transaction, request_uuid, &proof, &fingerprint).await?
    {
        transaction.commit().await.map_err(|error| {
            ApiError::from(database_error(error, "Failed to replay Account deletion"))
        })?;
        record_committed_metrics(
            request_id,
            answer.outcome,
            AccountDeletionMetricKindRef::Replay,
        );
        return Ok(answer);
    }

    let authority = live_authority(&mut transaction, bearer)
        .await?
        .ok_or_else(unauthorized)?;
    if let Err(error) = enforce_window_limit(
        state.rate_limiter.as_ref(),
        SCOPE_DELETE_ACCOUNT_USER,
        &authority.user_id,
        account_mutation_limit(&state.config.rate_limit),
    )
    .await
    {
        if error.code == crate::shared::error::AppErrorCode::TooManyRequests {
            emit_account_deletion_metric(request_id, AccountDeletionMetricKindRef::RateLimit);
        }
        return Err(ApiError::from(error));
    }
    if let Some(team_id) = authority.team_id.as_deref() {
        acquire_team_authority_lock(
            &mut *transaction,
            team_id,
            "Failed to lock Team authority for Account deletion",
        )
        .await
        .map_err(ApiError::from)?;
    }

    let outcome = decide_outcome(&mut transaction, &authority, &normalized_email).await?;
    #[cfg(test)]
    crate::test_support::pause_account_deletion_after_decision(&request_uuid.to_string()).await;
    insert_retained(
        &mut transaction,
        request_uuid,
        &proof,
        &fingerprint,
        outcome,
    )
    .await?;

    if outcome == AccountDeletionOutcome::Deleted {
        insert_audit_event(
            &mut *transaction,
            &generate_resource_id("audit"),
            &authority.user_id,
            "account_deleted",
            "user",
            &authority.user_id,
            None,
        )
        .await
        .map_err(ApiError::from)?;
        query("DELETE FROM \"user\" WHERE id = $1")
            .bind(&authority.user_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| database_error(error, "Failed to delete account"))?;
    }

    #[cfg(test)]
    crate::test_support::pause_account_deletion_before_commit(&request_uuid.to_string()).await;

    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit Account deletion"))?;
    #[cfg(test)]
    crate::test_support::pause_account_deletion_after_commit(request_id).await;
    record_committed_metrics(request_id, outcome, AccountDeletionMetricKindRef::Insert);
    Ok(AccountDeletionAnswer {
        request_id: request_uuid.to_string(),
        outcome,
        replayed: false,
    })
}

fn canonical_request_id(value: &str) -> Result<Uuid, ApiError> {
    let parsed = Uuid::parse_str(value).map_err(|_| {
        ApiError::bad_request(
            ErrorCode::InvalidIdempotencyKey,
            "Idempotency-Key must be a canonical UUID v4.",
        )
    })?;
    if parsed.get_version_num() != 4 || parsed.to_string() != value {
        return Err(ApiError::bad_request(
            ErrorCode::InvalidIdempotencyKey,
            "Idempotency-Key must be a canonical UUID v4.",
        ));
    }
    Ok(parsed)
}

fn canonical_email(value: &str) -> Result<String, ApiError> {
    let normalized = normalize_email(value);
    if normalized.is_empty() || normalized.len() > 254 {
        return Err(ApiError::bad_request(
            ErrorCode::InvalidEmail,
            "Confirmation email must contain 1 to 254 UTF-8 bytes.",
        ));
    }
    Ok(normalized)
}

fn frame(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

fn credential_proof(bearer: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    frame(&mut hasher, PROOF_DOMAIN);
    frame(&mut hasher, bearer.as_bytes());
    hasher.finalize().into()
}

fn request_fingerprint(request_id: &str, body: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for value in [
        REQUEST_DOMAIN,
        DELETE_METHOD,
        DELETE_PATH,
        request_id.as_bytes(),
        body,
    ] {
        frame(&mut hasher, value);
    }
    hasher.finalize().into()
}

async fn lock_request_id(
    transaction: &mut Transaction<'_, Postgres>,
    request_id: &Uuid,
) -> Result<(), ApiError> {
    let mut hasher = Sha256::new();
    frame(&mut hasher, ADVISORY_DOMAIN);
    frame(&mut hasher, request_id.to_string().as_bytes());
    let digest: [u8; 32] = hasher.finalize().into();
    let key = i64::from_be_bytes(digest[..8].try_into().expect("eight-byte advisory key"));
    query("SELECT pg_advisory_xact_lock($1)")
        .bind(key)
        .execute(&mut **transaction)
        .await
        .map_err(|error| database_error(error, "Failed to lock Account deletion request"))?;
    Ok(())
}

async fn retained_answer(
    transaction: &mut Transaction<'_, Postgres>,
    request_id: Uuid,
    proof: &[u8; 32],
    fingerprint: &[u8; 32],
) -> Result<Option<AccountDeletionAnswer>, ApiError> {
    let row = query_as::<_, RetainedOutcomeRow>(
        "SELECT credential_proof, request_fingerprint, outcome FROM account_deletion_outcome WHERE request_id = $1::uuid",
    )
    .bind(request_id.to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|error| database_error(error, "Failed to read Account deletion outcome"))?;
    let Some(row) = row else {
        return Ok(None);
    };
    let proof_matches = row.credential_proof.as_slice().ct_eq(proof).unwrap_u8() == 1;
    let fingerprint_matches = row.request_fingerprint.as_slice() == fingerprint;
    if !proof_matches || !fingerprint_matches {
        emit_account_deletion_metric(
            &request_id.to_string(),
            AccountDeletionMetricKindRef::RequestIdReuse(if !proof_matches {
                "credential_proof"
            } else {
                "request_fingerprint"
            }),
        );
        return Err(unauthorized());
    }
    Ok(Some(AccountDeletionAnswer {
        request_id: request_id.to_string(),
        outcome: decode_outcome(&row.outcome)?,
        replayed: true,
    }))
}

async fn live_authority(
    transaction: &mut Transaction<'_, Postgres>,
    bearer: &str,
) -> Result<Option<LiveDeletionAuthority>, ApiError> {
    query_as::<_, LiveDeletionAuthority>(
        r#"
        SELECT u.id AS user_id, u.email, u.team_id
        FROM session s
        JOIN "user" u ON u.id = s.user_id
        WHERE s.id = $1 AND s.expires_at > NOW()
        FOR UPDATE OF s, u
        "#,
    )
    .bind(hash_token(bearer))
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|error| database_error(error, "Failed to authenticate Account deletion").into())
}

async fn decide_outcome(
    transaction: &mut Transaction<'_, Postgres>,
    authority: &LiveDeletionAuthority,
    normalized_email: &str,
) -> Result<AccountDeletionOutcome, ApiError> {
    if normalize_email(&authority.email) != normalized_email {
        return Ok(AccountDeletionOutcome::ConfirmationEmailMismatch);
    }
    if let Some(team_id) = authority.team_id.as_deref() {
        let team = query_as::<_, (String, TeamType)>(
            "SELECT owner_id, type::text FROM team WHERE id = $1",
        )
        .bind(team_id)
        .fetch_optional(&mut **transaction)
        .await
        .map_err(|error| database_error(error, "Failed to load Team deletion authority"))?;
        if team.as_ref().is_some_and(|(owner_id, team_type)| {
            owner_id == &authority.user_id && *team_type != TeamType::Personal
        }) {
            let members =
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM \"user\" WHERE team_id = $1")
                    .bind(team_id)
                    .fetch_one(&mut **transaction)
                    .await
                    .map_err(|error| database_error(error, "Failed to load Team members"))?;
            let vaults =
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM vault WHERE team_id = $1")
                    .bind(team_id)
                    .fetch_one(&mut **transaction)
                    .await
                    .map_err(|error| database_error(error, "Failed to load Team Vaults"))?;
            if members > 1 || vaults > 0 {
                return Ok(AccountDeletionOutcome::Blocked);
            }
        }
    }
    Ok(AccountDeletionOutcome::Deleted)
}

async fn insert_retained(
    transaction: &mut Transaction<'_, Postgres>,
    request_id: Uuid,
    proof: &[u8; 32],
    fingerprint: &[u8; 32],
    outcome: AccountDeletionOutcome,
) -> Result<(), ApiError> {
    let result = query(
        "INSERT INTO account_deletion_outcome (request_id, credential_proof, request_fingerprint, outcome) VALUES ($1::uuid, $2, $3, $4)",
    )
    .bind(request_id.to_string())
    .bind(proof.as_slice())
    .bind(fingerprint.as_slice())
    .bind(encode_outcome(outcome))
    .execute(&mut **transaction)
    .await;
    if let Err(error) = result {
        if let Some(collision) = uniqueness_failure(&error) {
            emit_account_deletion_metric(
                &request_id.to_string(),
                AccountDeletionMetricKindRef::UniquenessFailure(collision),
            );
        }
        return Err(database_error(error, "Failed to retain Account deletion outcome").into());
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum AccountDeletionMetricKindRef {
    Insert,
    Replay,
    Outcome(&'static str),
    CommittedInsertGrowth,
    RateLimit,
    RequestIdReuse(&'static str),
    UniquenessFailure(&'static str),
}

fn record_committed_metrics(
    request_id: &str,
    outcome: AccountDeletionOutcome,
    operation: AccountDeletionMetricKindRef,
) {
    emit_account_deletion_metric(request_id, operation);
    emit_account_deletion_metric(
        request_id,
        AccountDeletionMetricKindRef::Outcome(encode_outcome(outcome)),
    );
    if !matches!(operation, AccountDeletionMetricKindRef::Insert) {
        return;
    }
    emit_account_deletion_metric(
        request_id,
        AccountDeletionMetricKindRef::CommittedInsertGrowth,
    );
}

fn uniqueness_failure(error: &sqlx::Error) -> Option<&'static str> {
    let database_error = error.as_database_error()?;
    if database_error.code().as_deref() != Some("23505") {
        return None;
    }
    match database_error.constraint() {
        Some("account_deletion_outcome_pkey") => Some("request_id"),
        Some("account_deletion_outcome_deleted_proof_unique") => Some("deleted_proof"),
        _ => Some("other"),
    }
}

fn emit_account_deletion_metric(request_id: &str, kind: AccountDeletionMetricKindRef) {
    match kind {
        AccountDeletionMetricKindRef::Insert => tracing::info!(
            metric = "account_deletion.insert",
            value = 1_u64,
            request_id,
            "Account deletion outcome inserted"
        ),
        AccountDeletionMetricKindRef::Replay => tracing::info!(
            metric = "account_deletion.replay",
            value = 1_u64,
            request_id,
            "Account deletion outcome replayed"
        ),
        AccountDeletionMetricKindRef::Outcome(outcome) => tracing::info!(
            metric = "account_deletion.outcome",
            value = 1_u64,
            request_id,
            outcome,
            "Account deletion closed outcome observed"
        ),
        AccountDeletionMetricKindRef::CommittedInsertGrowth => tracing::info!(
            metric = "account_deletion.outcome_rows_growth",
            value = 1_u64,
            request_id,
            "Account deletion committed row growth observed"
        ),
        AccountDeletionMetricKindRef::RateLimit => tracing::info!(
            metric = "account_deletion.rate_limit",
            value = 1_u64,
            request_id,
            "Account deletion request rate-limited"
        ),
        AccountDeletionMetricKindRef::RequestIdReuse(mismatch) => tracing::warn!(
            metric = "account_deletion.request_id_reuse",
            value = 1_u64,
            request_id,
            mismatch,
            "Account deletion request id reuse refused"
        ),
        AccountDeletionMetricKindRef::UniquenessFailure(collision) => tracing::warn!(
            metric = "account_deletion.uniqueness_failure",
            value = 1_u64,
            request_id,
            collision,
            "Account deletion outcome uniqueness failure"
        ),
    }

    #[cfg(test)]
    if let Some(metrics) = ACCOUNT_DELETION_METRIC_RECORDERS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("Account deletion metric recorder registry should lock")
        .get(request_id)
        .and_then(Weak::upgrade)
    {
        metrics
            .lock()
            .expect("Account deletion metric recorder should lock")
            .push(kind.into());
    }
}

#[cfg(test)]
impl From<AccountDeletionMetricKindRef> for AccountDeletionMetricKind {
    fn from(value: AccountDeletionMetricKindRef) -> Self {
        match value {
            AccountDeletionMetricKindRef::Insert => Self::Insert,
            AccountDeletionMetricKindRef::Replay => Self::Replay,
            AccountDeletionMetricKindRef::Outcome(outcome) => Self::Outcome(outcome),
            AccountDeletionMetricKindRef::CommittedInsertGrowth => Self::CommittedInsertGrowth,
            AccountDeletionMetricKindRef::RateLimit => Self::RateLimit,
            AccountDeletionMetricKindRef::RequestIdReuse(mismatch) => {
                Self::RequestIdReuse(mismatch)
            }
            AccountDeletionMetricKindRef::UniquenessFailure(collision) => {
                Self::UniquenessFailure(collision)
            }
        }
    }
}

#[cfg(test)]
pub(crate) fn install_account_deletion_metric_recorder(
    request_id: &str,
) -> AccountDeletionMetricRecorder {
    let metrics = Arc::new(Mutex::new(Vec::new()));
    let mut recorders = ACCOUNT_DELETION_METRIC_RECORDERS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("Account deletion metric recorder registry should lock");
    assert!(
        recorders.get(request_id).and_then(Weak::upgrade).is_none(),
        "Account deletion metric request IDs must be unique across parallel tests"
    );
    recorders.insert(request_id.to_string(), Arc::downgrade(&metrics));
    AccountDeletionMetricRecorder {
        request_id: request_id.to_string(),
        metrics,
    }
}

#[cfg(test)]
pub(crate) fn account_deletion_credential_proof_for_test(bearer: &str) -> [u8; 32] {
    credential_proof(bearer)
}

fn encode_outcome(outcome: AccountDeletionOutcome) -> &'static str {
    match outcome {
        AccountDeletionOutcome::Deleted => "deleted",
        AccountDeletionOutcome::ConfirmationEmailMismatch => "confirmationMismatch",
        AccountDeletionOutcome::Blocked => "accountDeletionBlocked",
    }
}

fn decode_outcome(value: &str) -> Result<AccountDeletionOutcome, ApiError> {
    match value {
        "deleted" => Ok(AccountDeletionOutcome::Deleted),
        "confirmationMismatch" => Ok(AccountDeletionOutcome::ConfirmationEmailMismatch),
        "accountDeletionBlocked" => Ok(AccountDeletionOutcome::Blocked),
        _ => Err(ApiError::internal()),
    }
}

fn unauthorized() -> ApiError {
    ApiError::unauthorized("A valid bearer session is required.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_deletion_hashes_pin_length_delimited_protocol_bytes() {
        assert_eq!(
            hex::encode(credential_proof("opaque-bearer")),
            "4e8c73074b955e66b81baf872bdb48838620bef7e3e0135d39b7019a5c731126"
        );
        assert_eq!(
            hex::encode(request_fingerprint(
                "018f05c4-7b6a-4a89-9237-2e612fa96c12",
                br#"{"confirmEmail":"mixed@example.com"}"#,
            )),
            "e2d685ed9134cccba54debfe572e2c64eba45de4491ea0c86c4cd94d2e1fea2f"
        );
    }

    #[test]
    fn account_deletion_accepts_only_canonical_scope_values() {
        assert_eq!(
            canonical_request_id("018f05c4-7b6a-4a89-9237-2e612fa96c12")
                .unwrap()
                .to_string(),
            "018f05c4-7b6a-4a89-9237-2e612fa96c12"
        );
        assert!(canonical_request_id("018F05C4-7B6A-4A89-9237-2E612FA96C12").is_err());
        assert!(canonical_request_id("018f05c4-7b6a-1a89-9237-2e612fa96c12").is_err());
        assert_eq!(
            canonical_email("  MIXED@ＥＸＡＭＰＬＥ.COM  ").unwrap(),
            "mixed@example.com"
        );
        assert!(canonical_email("  ").is_err());
        assert!(canonical_email(&format!("{}@x", "a".repeat(253))).is_err());
    }

    #[test]
    fn metric_recorders_are_request_scoped_and_parallel_safe() {
        let first_id = "018f05c4-7b6a-4a89-9237-2e612fa96c91";
        let second_id = "018f05c4-7b6a-4a89-9237-2e612fa96c92";
        let first = install_account_deletion_metric_recorder(first_id);
        let second = install_account_deletion_metric_recorder(second_id);

        emit_account_deletion_metric(first_id, AccountDeletionMetricKindRef::Insert);
        emit_account_deletion_metric(second_id, AccountDeletionMetricKindRef::Replay);

        assert_eq!(first.take(), vec![AccountDeletionMetricKind::Insert]);
        assert_eq!(second.take(), vec![AccountDeletionMetricKind::Replay]);
    }
}
