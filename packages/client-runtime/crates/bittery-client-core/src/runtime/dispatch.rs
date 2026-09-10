//! Sending accepted Operations, and surviving everything the network does to them.
//!
//! Only an authoritative semantic outcome ends an accepted Operation. A transport answer moves
//! two things and nothing else: a diagnostic attempt count and the next time this Device may try
//! again. There is deliberately no attempt limit, no discard, and no path that treats an HTTP
//! status as a semantic result — reading an answer is `outcome.rs`'s job, and completing on one
//! is a single reconciliation plan.

use super::outcome::{CompletionResult, OutcomeResolutionAuthBudget, SemanticAnswer};
use super::*;
use crate::{
    auth_http::AuthenticatedOutcome,
    http_transport::HttpHeader,
    platform_storage::CurrentSessionDocument,
    replica::{
        AuthorityVaultRole, AuthorityVaultType, OperationKind, OperationSchedulingState,
        ReplicaSnapshot,
    },
    server_contract::{
        VaultImageContentType, VaultImageStagingBody, VaultImageStagingStatusResponse, VaultRole,
        VaultType,
    },
    AccountId,
};
use async_trait::async_trait;
use std::collections::HashMap;

/// How long one local send may hold an Operation before another pass may try it again.
///
/// The value only trades wasted duplicate sends against how long a stalled attempt can delay a
/// retry. It is not a correctness bound, so it does not have to be right.
pub(crate) const DISPATCH_LEASE_MS: u64 = 30_000;

/// The first retry waits a second, and no retry ever waits more than five minutes.
const BASE_BACKOFF_MS: u64 = 1_000;
const MAX_BACKOFF_MS: u64 = 5 * 60 * 1_000;

/// Doubles per attempt up to the ceiling, and never overflows however long an Account is offline.
///
/// The delay is deliberately not randomized. One Device retrying its own accepted work is not a
/// thundering herd, and a reproducible schedule is worth more here than jitter.
fn backoff_ms(attempt_count: u64) -> u64 {
    let exponent = u32::try_from(attempt_count.saturating_sub(1).min(20)).unwrap_or(20);
    (BASE_BACKOFF_MS << exponent).min(MAX_BACKOFF_MS)
}

/// Suppresses duplicate sends inside one Runtime, and supplies nothing else.
///
/// It is in-memory and it expires. A crashed process leaves no lease behind, a stalled attempt
/// cannot pin work forever, and two holders at once change only how much network is wasted: the
/// Server's `(User, Operation ID)` table is what makes the effect happen once.
#[derive(Default)]
pub(crate) struct DispatchLeases {
    held: Mutex<HashMap<String, u64>>,
}

/// Releases its lease on drop, including on an unwind out of a dispatch attempt.
pub(crate) struct DispatchLease {
    leases: Arc<DispatchLeases>,
    operation_id: String,
}

impl DispatchLeases {
    pub(crate) fn acquire(
        self: &Arc<Self>,
        operation_id: &str,
        now_ms: u64,
    ) -> Option<DispatchLease> {
        let mut held = self.held.lock().expect("dispatch lease lock poisoned");
        held.retain(|_, expires_at| *expires_at > now_ms);
        if held.contains_key(operation_id) {
            return None;
        }
        held.insert(
            operation_id.to_owned(),
            now_ms.saturating_add(DISPATCH_LEASE_MS),
        );
        Some(DispatchLease {
            leases: Arc::clone(self),
            operation_id: operation_id.to_owned(),
        })
    }
}

impl Drop for DispatchLease {
    fn drop(&mut self) {
        self.leases
            .held
            .lock()
            .expect("dispatch lease lock poisoned")
            .remove(&self.operation_id);
    }
}

/// What one scan of every Account's accepted work decided to do next.
pub(super) enum DispatchPass {
    /// Something was attempted or something durable moved. Read the Replica again.
    Progressed,
    /// Nothing is eligible and no clock can change that. Only an event can.
    Parked,
    /// Nothing is eligible yet, but Device time alone will make it eligible.
    WaitFor { milliseconds: u64 },
}

/// What one attempt at one Operation left behind.
enum AttemptOutcome {
    /// Backoff moved, or the Server answered. Either way the next scan sees new durable truth.
    Progressed,
    /// This Account needs reauthentication. The Operation stays; the scan skips the Account.
    Parked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CreateVaultRecoveryPolicy {
    ParkedFenced,
    FailAccount,
    ReauthenticationRequired,
    Parked,
    Retry,
}

pub(super) fn create_vault_recovery_policy(
    error: &super::create_vault_staging::CreateVaultRecoveryError,
) -> CreateVaultRecoveryPolicy {
    use super::create_vault_staging::CreateVaultRecoveryError;

    match error {
        CreateVaultRecoveryError::ParkedFenced => CreateVaultRecoveryPolicy::ParkedFenced,
        CreateVaultRecoveryError::Fatal(error)
            if error.code == RuntimeErrorCode::InvariantViolation =>
        {
            CreateVaultRecoveryPolicy::FailAccount
        }
        CreateVaultRecoveryError::Fatal(error)
            if matches!(
                error.code,
                RuntimeErrorCode::AuthenticationRequired
                    | RuntimeErrorCode::AuthenticationUnavailable
            ) =>
        {
            CreateVaultRecoveryPolicy::ReauthenticationRequired
        }
        CreateVaultRecoveryError::Fatal(error)
            if matches!(
                error.code,
                RuntimeErrorCode::RuntimeClosed
                    | RuntimeErrorCode::Cancelled
                    | RuntimeErrorCode::AccountMissing
                    | RuntimeErrorCode::AccountFailed
            ) =>
        {
            CreateVaultRecoveryPolicy::Parked
        }
        CreateVaultRecoveryError::Fatal(_) => CreateVaultRecoveryPolicy::Retry,
    }
}

pub(super) enum CleanupAttemptOutcome {
    Completed,
    RetryScheduled,
    Parked,
}

/// The fence-safe authenticated send shared by Sync catch-up and the background dispatcher.
/// Semantic completion belongs to the caller; Bootstrap owns terminal Sync page progress.
enum ExactSendOutcome {
    Outcome(crate::replica::ObservedOutcome),
    IdentityReused,
    Deferred,
    RetryScheduled,
    Reauthenticate,
}

pub(super) struct ProductionOperationPort<'a> {
    runtime: &'a Runtime,
    account_id: AccountId,
    http: AuthHttpClient<'a>,
    session: tokio::sync::Mutex<CurrentSessionDocument>,
    upload: Mutex<Option<(String, String, Vec<HttpHeader>)>>,
}

impl ProductionOperationPort<'_> {
    pub(super) fn staging_body(
        binding: &super::create_vault_staging::CreateVaultStagingBinding,
    ) -> Result<VaultImageStagingBody, super::create_vault_staging::CreateVaultStagingError> {
        Ok(VaultImageStagingBody {
            vault_id: binding.vault_id.clone(),
            byte_length: i64::try_from(binding.byte_length)
                .map_err(|_| super::create_vault_staging::CreateVaultStagingError::Retryable)?,
            content_type: match binding.content_type.as_str() {
                "image/jpeg" => VaultImageContentType::ImageJpeg,
                "image/png" => VaultImageContentType::ImagePng,
                "image/webp" => VaultImageContentType::ImageWebp,
                "image/gif" => VaultImageContentType::ImageGif,
                "image/avif" => VaultImageContentType::ImageAvif,
                _ => return Err(super::create_vault_staging::CreateVaultStagingError::Retryable),
            },
            sha256: binding.sha256.clone(),
        })
    }

    pub(super) fn status(
        response: VaultImageStagingStatusResponse,
        binding: &super::create_vault_staging::CreateVaultStagingBinding,
    ) -> Result<
        super::create_vault_staging::CreateVaultStagingStatus,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        match response {
            VaultImageStagingStatusResponse::Absent {} => {
                Ok(super::create_vault_staging::CreateVaultStagingStatus::Missing)
            }
            VaultImageStagingStatusResponse::Unconfirmed {
                object_key,
                generation,
                lease_expires_at,
            } => Self::bound_status(
                binding,
                object_key,
                generation,
                lease_expires_at,
                super::create_vault_staging::CreateVaultStagingStatus::AwaitingUpload,
            ),
            VaultImageStagingStatusResponse::Confirmed {
                object_key,
                generation,
                lease_expires_at,
            } => Self::bound_status(
                binding,
                object_key,
                generation,
                lease_expires_at,
                super::create_vault_staging::CreateVaultStagingStatus::Confirmed,
            ),
            VaultImageStagingStatusResponse::CleanupPending { .. } => {
                Err(super::create_vault_staging::CreateVaultStagingError::Retryable)
            }
        }
    }

    fn bound_status(
        binding: &super::create_vault_staging::CreateVaultStagingBinding,
        object_key: String,
        generation: i64,
        lease_expires_at: String,
        status: super::create_vault_staging::CreateVaultStagingStatus,
    ) -> Result<
        super::create_vault_staging::CreateVaultStagingStatus,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        if object_key == binding.object_key && generation > 0 && !lease_expires_at.is_empty() {
            Ok(status)
        } else {
            Err(super::create_vault_staging::CreateVaultStagingError::Retryable)
        }
    }

    async fn renewed_session(
        &self,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        let mut session = self.session.lock().await;
        match self
            .runtime
            .renew_session(
                &self.account_id,
                &session,
                &self.http,
                RequestCancellation::new(),
            )
            .await
        {
            Ok(renewed) => {
                *session = renewed;
                Ok(())
            }
            Err(error) if error.code == RuntimeErrorCode::AuthenticationRequired => {
                Err(super::create_vault_staging::CreateVaultStagingError::Unauthorized)
            }
            Err(_) => Err(super::create_vault_staging::CreateVaultStagingError::Retryable),
        }
    }
}

fn production_exchange<T>(
    result: Result<AuthenticatedOutcome<T>, RuntimeError>,
) -> Result<T, super::create_vault_staging::CreateVaultStagingError> {
    match result {
        Ok(AuthenticatedOutcome::Ok(value)) => Ok(value),
        Ok(AuthenticatedOutcome::ReauthenticationRequired) => {
            Err(super::create_vault_staging::CreateVaultStagingError::Unauthorized)
        }
        Ok(AuthenticatedOutcome::Transient) | Err(_) => {
            Err(super::create_vault_staging::CreateVaultStagingError::Retryable)
        }
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl super::create_vault_staging::CreateVaultStagingPort for ProductionOperationPort<'_> {
    async fn status(
        &self,
        binding: &super::create_vault_staging::CreateVaultStagingBinding,
    ) -> Result<
        super::create_vault_staging::CreateVaultStagingStatus,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        let body = Self::staging_body(binding)?;
        let session = self.session.lock().await;
        let response = production_exchange(
            self.http
                .vault_image_staging_status(
                    session.token.as_ref(),
                    &binding.operation_id,
                    &body,
                    RequestCancellation::new(),
                )
                .await,
        )?;
        Self::status(response, binding)
    }

    async fn grant(
        &self,
        binding: &super::create_vault_staging::CreateVaultStagingBinding,
    ) -> Result<
        super::create_vault_staging::CreateVaultUploadGrant,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        let body = Self::staging_body(binding)?;
        let session = self.session.lock().await;
        let response = production_exchange(
            self.http
                .grant_vault_image_staging(
                    session.token.as_ref(),
                    &binding.operation_id,
                    &body,
                    RequestCancellation::new(),
                )
                .await,
        )?;
        let upload_headers = response
            .upload_headers
            .into_iter()
            .map(|header| HttpHeader {
                name: header.name,
                value: header.value,
            })
            .collect();
        *self
            .upload
            .lock()
            .expect("Vault image upload lock poisoned") = Some((
            response.object_key.clone(),
            response.upload_url,
            upload_headers,
        ));
        Ok(super::create_vault_staging::CreateVaultUploadGrant {
            object_key: response.object_key,
            byte_length: binding.byte_length,
            content_type: binding.content_type.clone(),
            sha256: binding.sha256.clone(),
        })
    }

    async fn upload(
        &self,
        grant: &super::create_vault_staging::CreateVaultUploadGrant,
        bytes: &[u8],
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        let upload_url = self
            .upload
            .lock()
            .expect("Vault image upload lock poisoned")
            .clone()
            .filter(|(object_key, _, _)| object_key == &grant.object_key)
            .map(|(_, upload_url, headers)| (upload_url, headers))
            .ok_or(super::create_vault_staging::CreateVaultStagingError::Retryable)?;
        let (upload_url, headers) = upload_url;
        match self
            .http
            .upload_vault_image_staging(
                &upload_url,
                &grant.content_type,
                &grant.sha256,
                &headers,
                bytes,
                RequestCancellation::new(),
            )
            .await
        {
            Ok(true) => Ok(()),
            Ok(false) | Err(_) => {
                Err(super::create_vault_staging::CreateVaultStagingError::Retryable)
            }
        }
    }

    async fn confirm(
        &self,
        binding: &super::create_vault_staging::CreateVaultStagingBinding,
    ) -> Result<
        super::create_vault_staging::CreateVaultStagingStatus,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        let body = Self::staging_body(binding)?;
        let session = self.session.lock().await;
        let response = production_exchange(
            self.http
                .confirm_vault_image_staging(
                    session.token.as_ref(),
                    &binding.operation_id,
                    &body,
                    RequestCancellation::new(),
                )
                .await,
        )?;
        Self::status(response, binding)
    }

    async fn renew_session(
        &self,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        self.renewed_session().await
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl super::create_vault_executor::CreateVaultExecutorPort for ProductionOperationPort<'_> {
    async fn lookup(
        &self,
        operation: &OperationRecord,
    ) -> Result<
        Option<super::create_vault_executor::CreateVaultOperationResponse>,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        let session = self.session.lock().await;
        let outcome = production_exchange(
            self.http
                .fetch_operation_outcome(
                    session.token.as_ref(),
                    &operation.operation_id,
                    RequestCancellation::new(),
                )
                .await,
        )?;
        outcome
            .map(|outcome| {
                serde_json::to_vec(&outcome)
                    .map(
                        |body| super::create_vault_executor::CreateVaultOperationResponse {
                            status: 200,
                            body,
                        },
                    )
                    .map_err(|_| super::create_vault_staging::CreateVaultStagingError::Retryable)
            })
            .transpose()
    }

    async fn put_exact(
        &self,
        operation: &OperationRecord,
    ) -> Result<
        super::create_vault_executor::CreateVaultOperationResponse,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        let session = self.session.lock().await;
        let response = production_exchange(
            self.http
                .dispatch_operation(
                    session.token.as_ref(),
                    &operation.operation_id,
                    &operation.request,
                    RequestCancellation::new(),
                )
                .await,
        )?;
        Ok(super::create_vault_executor::CreateVaultOperationResponse {
            status: response.status,
            body: response.body,
        })
    }

    async fn fetch_vault(
        &self,
        vault_id: &str,
    ) -> Result<
        super::create_vault_executor::CreateVaultAuthorityRecord,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        let session = self.session.lock().await;
        let response = production_exchange(
            self.http
                .fetch_vault_authority(session.token.as_ref(), vault_id, RequestCancellation::new())
                .await,
        )?;
        Ok(super::create_vault_executor::CreateVaultAuthorityRecord {
            id: response.id,
            name: response.name,
            vault_type: match response.vault_type {
                VaultType::Personal => AuthorityVaultType::Personal,
                VaultType::Team => AuthorityVaultType::Team,
            },
            icon: response.icon,
            image_url: response.image_url,
            role: match response.user_role {
                VaultRole::Owner => AuthorityVaultRole::Owner,
                VaultRole::Admin => AuthorityVaultRole::Admin,
                VaultRole::Member => AuthorityVaultRole::Member,
                VaultRole::ReadOnly => AuthorityVaultRole::ReadOnly,
            },
        })
    }

    async fn fetch_vault_keys(
        &self,
        _vault_id: &str,
        cursor: Option<&str>,
    ) -> Result<
        super::create_vault_executor::CreateVaultAuthorityPage,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        let session = self.session.lock().await;
        let raw_response_body = production_exchange(
            self.http
                .fetch_vault_key_page_raw(
                    session.token.as_ref(),
                    cursor,
                    RequestCancellation::new(),
                )
                .await,
        )?;
        Ok(super::create_vault_executor::CreateVaultAuthorityPage {
            raw_response_body: Some(raw_response_body),
        })
    }

    async fn renew_session(
        &self,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        self.renewed_session().await
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl super::create_vault_cleanup::CreateVaultCleanupPort for ProductionOperationPort<'_> {
    async fn cleanup_remote(
        &self,
        binding: &super::create_vault_staging::CreateVaultStagingBinding,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        let body = Self::staging_body(binding)?;
        let session = self.session.lock().await;
        production_exchange(
            self.http
                .cleanup_vault_image_staging(
                    session.token.as_ref(),
                    &binding.operation_id,
                    &body,
                    RequestCancellation::new(),
                )
                .await,
        )
    }

    async fn renew_session(
        &self,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        self.renewed_session().await
    }
}

fn import_exchange<T>(
    result: Result<AuthenticatedOutcome<T>, RuntimeError>,
) -> Result<T, super::import_executor::ImportExecutorError> {
    match result {
        Ok(AuthenticatedOutcome::Ok(value)) => Ok(value),
        Ok(AuthenticatedOutcome::ReauthenticationRequired) => {
            Err(super::import_executor::ImportExecutorError::Unauthorized)
        }
        Ok(AuthenticatedOutcome::Transient) | Err(_) => {
            Err(super::import_executor::ImportExecutorError::Retryable)
        }
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl super::import_executor::ImportExecutorPort for ProductionOperationPort<'_> {
    async fn lookup(
        &self,
        operation: &OperationRecord,
    ) -> Result<
        Option<super::import_executor::ImportExchangeResponse>,
        super::import_executor::ImportExecutorError,
    > {
        let session = self.session.lock().await;
        import_exchange(
            self.http
                .fetch_operation_outcome(
                    session.token.as_ref(),
                    &operation.operation_id,
                    RequestCancellation::new(),
                )
                .await,
        )?
        .map(|value| {
            serde_json::to_vec(&value)
                .map(|body| super::import_executor::ImportExchangeResponse { status: 200, body })
                .map_err(|_| super::import_executor::ImportExecutorError::Retryable)
        })
        .transpose()
    }
    async fn post_exact(
        &self,
        operation: &OperationRecord,
    ) -> Result<
        super::import_executor::ImportExchangeResponse,
        super::import_executor::ImportExecutorError,
    > {
        let session = self.session.lock().await;
        let value = import_exchange(
            self.http
                .dispatch_operation(
                    session.token.as_ref(),
                    &operation.operation_id,
                    &operation.request,
                    RequestCancellation::new(),
                )
                .await,
        )?;
        Ok(super::import_executor::ImportExchangeResponse {
            status: value.status,
            body: value.body,
        })
    }
    async fn fetch_items(
        &self,
        vault_id: &str,
        item_ids: &[String],
        cursor: Option<&str>,
    ) -> Result<
        super::import_executor::ImportAuthorityPage,
        super::import_executor::ImportExecutorError,
    > {
        let session = self.session.lock().await;
        let (raw_response_body, next_cursor) = import_exchange(
            self.http
                .fetch_import_authority_page(
                    session.token.as_ref(),
                    vault_id,
                    item_ids,
                    cursor,
                    RequestCancellation::new(),
                )
                .await,
        )?;
        Ok(super::import_executor::ImportAuthorityPage {
            raw_response_body,
            next_cursor,
        })
    }
    async fn renew_session(&self) -> Result<(), super::import_executor::ImportExecutorError> {
        self.renewed_session().await.map_err(|error| match error {
            super::create_vault_staging::CreateVaultStagingError::Unauthorized => {
                super::import_executor::ImportExecutorError::Unauthorized
            }
            _ => super::import_executor::ImportExecutorError::Retryable,
        })
    }
}

impl Runtime {
    /// Proves a lookup hint by replaying the exact accepted request while Sync owns the Account
    /// fence. This completes semantics without page progress; Bootstrap advances the terminal
    /// page Cursor only after every event succeeds.
    pub(super) async fn replay_lookup_hint_for_sync_fenced(
        &self,
        snapshot: &ReplicaSnapshot,
        operation: &OperationRecord,
        http: &AuthHttpClient<'_>,
        session: &mut CurrentSessionDocument,
        auth_budget: &mut OutcomeResolutionAuthBudget,
    ) -> CompletionResult {
        if operation.kind == OperationKind::CreateVault {
            return CompletionResult::Retry;
        }
        match self
            .send_exact_operation_fenced(snapshot, operation, http, session, auth_budget)
            .await
        {
            ExactSendOutcome::Outcome(outcome) => {
                self.complete_operation_fenced_with_auth_budget(
                    &snapshot.account_id,
                    operation,
                    outcome,
                    http,
                    session,
                    None,
                    auth_budget,
                )
                .await
            }
            ExactSendOutcome::IdentityReused => {
                self.fail_account_module_fenced(&snapshot.account_id).await
            }
            ExactSendOutcome::Deferred | ExactSendOutcome::RetryScheduled => {
                CompletionResult::Retry
            }
            ExactSendOutcome::Reauthenticate => CompletionResult::Reauthenticate,
        }
    }

    /// Sends the immutable accepted request under a caller-held Account execution fence.
    ///
    /// This is the sole exact-send Session-renewal and transport-classification policy. Failures
    /// move the durable Operation schedule here, before either caller decides how to continue.
    async fn send_exact_operation_fenced(
        &self,
        snapshot: &ReplicaSnapshot,
        operation: &OperationRecord,
        http: &AuthHttpClient<'_>,
        session: &mut CurrentSessionDocument,
        auth_budget: &mut OutcomeResolutionAuthBudget,
    ) -> ExactSendOutcome {
        let Ok(now_ms) = self.clock.now_ms() else {
            return ExactSendOutcome::Deferred;
        };
        if operation.scheduling.not_before_ms > now_ms {
            return ExactSendOutcome::Deferred;
        }

        let account_id = &snapshot.account_id;
        let cancellation = RequestCancellation::new();
        let mut answer = http
            .dispatch_operation(
                session.token.as_ref(),
                &operation.operation_id,
                &operation.request,
                cancellation.clone(),
            )
            .await;

        if matches!(answer, Ok(AuthenticatedOutcome::ReauthenticationRequired)) {
            if !auth_budget.consume_renewal() {
                self.persist_backoff(snapshot, operation).await;
                self.mark_reauthentication_required(account_id);
                return ExactSendOutcome::Reauthenticate;
            }
            match self
                .renew_session(account_id, session, http, cancellation.clone())
                .await
            {
                Ok(renewed) => {
                    *session = renewed;
                    answer = http
                        .dispatch_operation(
                            session.token.as_ref(),
                            &operation.operation_id,
                            &operation.request,
                            cancellation,
                        )
                        .await;
                }
                Err(error) if error.code == RuntimeErrorCode::AuthenticationRequired => {
                    self.persist_backoff(snapshot, operation).await;
                    self.mark_reauthentication_required(account_id);
                    return ExactSendOutcome::Reauthenticate;
                }
                Err(_) => {
                    self.persist_backoff(snapshot, operation).await;
                    return ExactSendOutcome::RetryScheduled;
                }
            }
        }

        match answer {
            Ok(AuthenticatedOutcome::Ok(response)) => {
                match self.read_dispatch_answer(operation, response.status, &response.body) {
                    SemanticAnswer::Outcome(outcome) => ExactSendOutcome::Outcome(outcome),
                    SemanticAnswer::IdentityReused => ExactSendOutcome::IdentityReused,
                    SemanticAnswer::Undecided | SemanticAnswer::Transient => {
                        self.persist_backoff(snapshot, operation).await;
                        ExactSendOutcome::RetryScheduled
                    }
                    SemanticAnswer::ReauthenticationRequired => ExactSendOutcome::Reauthenticate,
                }
            }
            Ok(AuthenticatedOutcome::ReauthenticationRequired) => {
                self.persist_backoff(snapshot, operation).await;
                self.mark_reauthentication_required(account_id);
                ExactSendOutcome::Reauthenticate
            }
            Ok(AuthenticatedOutcome::Transient) | Err(_) => {
                self.persist_backoff(snapshot, operation).await;
                ExactSendOutcome::RetryScheduled
            }
        }
    }

    /// The Runtime's only background loop: it owns every accepted Operation until an authoritative
    /// semantic outcome ends it.
    ///
    /// It is a plain future rather than a spawned task because the crate has no scheduler and must
    /// not acquire one: a Worker host drives it with the same `spawn_local` it already uses for
    /// observation delivery, and a native host drives it from its own executor. It returns when
    /// the Runtime closes, so a host owns its lifetime by owning the future.
    #[doc(hidden)]
    pub async fn run_operation_dispatch(self: Arc<Self>) {
        if self.auth_client_config.is_none() {
            // Without Server identity there is no request to make, and that never changes.
            return;
        }
        loop {
            if self.is_closed() {
                return;
            }
            // Enabling the wake-up before reading the Replica is what makes the loop safe to park:
            // anything accepted, renewed, or closed during the scan is already registered here.
            let mut wake = std::pin::pin!(self.dispatch_wake.notified());
            wake.as_mut().enable();
            let pass = self.dispatch_eligible_operations().await;
            if self.is_closed() {
                return;
            }
            match pass {
                DispatchPass::Progressed => continue,
                DispatchPass::Parked => wake.await,
                DispatchPass::WaitFor { milliseconds } => {
                    tokio::select! {
                        () = wake => {}
                        () = self.device_timer.sleep_ms(milliseconds) => {}
                    }
                }
            }
        }
    }

    /// Wakes the dispatcher because something that can change eligibility happened.
    pub(super) fn wake_dispatch(&self) {
        self.dispatch_wake.notify_waiters();
        self.live_sync_wake.notify_waiters();
    }

    /// A usable Session exists again, so parked work can resume immediately instead of waiting for
    /// a timer that a parked Operation deliberately does not set.
    pub(super) fn note_session_available(&self, account_id: &AccountId) {
        self.clear_waiting_reason(account_id);
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        self.wake_dispatch();
        self.publish_all_unless_closed();
    }

    /// Finds the first Operation this Device may send right now, and says what to do afterwards.
    pub(super) async fn dispatch_eligible_operations(&self) -> DispatchPass {
        let Ok(now_ms) = self.clock.now_ms() else {
            return DispatchPass::Parked;
        };
        let mut earliest: Option<u64> = None;
        let mut leased_elsewhere = false;
        for snapshot in self.replica.snapshots() {
            if (snapshot.operations.is_empty()
                && !snapshot.receipts.iter().any(|receipt| {
                    receipt
                        .create_vault_cleanup
                        .as_ref()
                        .is_some_and(|cleanup| {
                            cleanup.local_artifact_pending || cleanup.remote_staging_pending
                        })
                }))
                || snapshot.failure.is_some()
                || self.account_teardown_is_pending(&snapshot.account_id)
            {
                continue;
            }
            if self
                .waiting_reasons
                .lock()
                .expect("waiting reason lock poisoned")
                .get(&snapshot.account_id)
                == Some(&AccountWaitingReason::ReauthenticationRequired)
            {
                // Parked on a Session, not on a clock. Only `note_session_available` frees it.
                continue;
            }
            for receipt in snapshot.receipts.iter().filter(|receipt| {
                receipt
                    .create_vault_cleanup
                    .as_ref()
                    .is_some_and(|cleanup| {
                        cleanup.local_artifact_pending || cleanup.remote_staging_pending
                    })
            }) {
                let key = (snapshot.account_id.clone(), receipt.operation_id.clone());
                if let Some(deadline) = self
                    .create_vault_cleanup_retry_deadlines
                    .lock()
                    .expect("create-Vault cleanup deadline lock poisoned")
                    .get(&key)
                    .copied()
                    .filter(|deadline| *deadline > now_ms)
                {
                    earliest = Some(earliest.map_or(deadline, |current| current.min(deadline)));
                    continue;
                }
                let Some(lease) = self.dispatch_leases.acquire(&receipt.operation_id, now_ms)
                else {
                    leased_elsewhere = true;
                    continue;
                };
                let outcome = self
                    .attempt_create_vault_receipt_cleanup(&snapshot, &receipt.operation_id)
                    .await;
                drop(lease);
                return match outcome {
                    CleanupAttemptOutcome::Completed | CleanupAttemptOutcome::RetryScheduled => {
                        DispatchPass::Progressed
                    }
                    CleanupAttemptOutcome::Parked => DispatchPass::Parked,
                };
            }
            for operation in &snapshot.operations {
                if operation.scheduling.not_before_ms > now_ms {
                    earliest = Some(
                        earliest.map_or(operation.scheduling.not_before_ms, |current| {
                            current.min(operation.scheduling.not_before_ms)
                        }),
                    );
                    continue;
                }
                let Some(lease) = self
                    .dispatch_leases
                    .acquire(&operation.operation_id, now_ms)
                else {
                    leased_elsewhere = true;
                    continue;
                };
                let outcome = self.attempt_dispatch(&snapshot, operation).await;
                drop(lease);
                return match outcome {
                    AttemptOutcome::Progressed => DispatchPass::Progressed,
                    AttemptOutcome::Parked => DispatchPass::Parked,
                };
            }
        }
        match earliest {
            Some(deadline) => DispatchPass::WaitFor {
                milliseconds: deadline.saturating_sub(now_ms).max(1),
            },
            None if leased_elsewhere => DispatchPass::WaitFor {
                milliseconds: DISPATCH_LEASE_MS,
            },
            None => DispatchPass::Parked,
        }
    }

    pub(super) async fn attempt_create_vault_receipt_cleanup(
        &self,
        snapshot: &ReplicaSnapshot,
        operation_id: &str,
    ) -> CleanupAttemptOutcome {
        let account_id = snapshot.account_id.clone();
        let key = (account_id.clone(), operation_id.to_owned());
        let Some(auth_config) = self.auth_client_config.clone() else {
            return CleanupAttemptOutcome::Parked;
        };
        let metadata = match self
            .platform_storage
            .load_account_metadata(&account_id, &snapshot.incarnation)
            .await
        {
            Ok(Some(metadata)) => metadata,
            Ok(None) => return CleanupAttemptOutcome::Parked,
            Err(_) => return self.schedule_production_cleanup_retry(key),
        };
        let session = match self
            .platform_storage
            .load_current_session(&account_id, &snapshot.incarnation)
            .await
        {
            Ok(Some(session)) => session,
            Ok(None) => return CleanupAttemptOutcome::Parked,
            Err(_) => return self.schedule_production_cleanup_retry(key),
        };
        let http = match AuthHttpClient::new(
            &self.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            auth_config,
        ) {
            Ok(http) => http,
            Err(_) => return self.schedule_production_cleanup_retry(key),
        };
        let port = ProductionOperationPort {
            runtime: self,
            account_id: account_id.clone(),
            http,
            session: tokio::sync::Mutex::new(session),
            upload: Mutex::new(None),
        };
        loop {
            match self
                .drive_create_vault_cleanup_cycle(&account_id, operation_id, &port)
                .await
            {
                Ok(super::create_vault_cleanup::CreateVaultCleanupPass::Progressed) => continue,
                Ok(super::create_vault_cleanup::CreateVaultCleanupPass::Completed) => {
                    self.create_vault_cleanup_retry_deadlines
                        .lock()
                        .expect("create-Vault cleanup deadline lock poisoned")
                        .remove(&key);
                    return CleanupAttemptOutcome::Completed;
                }
                Ok(super::create_vault_cleanup::CreateVaultCleanupPass::RetryScheduled)
                | Err(_) => return self.schedule_production_cleanup_retry(key),
                Ok(
                    super::create_vault_cleanup::CreateVaultCleanupPass::ReauthenticationRequired,
                ) => {
                    return CleanupAttemptOutcome::Parked;
                }
            }
        }
    }

    fn schedule_production_cleanup_retry(&self, key: (AccountId, String)) -> CleanupAttemptOutcome {
        if let Ok(now_ms) = self.clock.now_ms() {
            self.create_vault_cleanup_retry_deadlines
                .lock()
                .expect("create-Vault cleanup deadline lock poisoned")
                .insert(key, now_ms.saturating_add(BASE_BACKOFF_MS));
        }
        CleanupAttemptOutcome::RetryScheduled
    }

    pub(super) async fn best_effort_production_create_vault_remote_cleanup(
        &self,
        binding: &super::create_vault_staging::CreateVaultStagingBinding,
    ) {
        let Some(snapshot) = self.replica.snapshot(&binding.account_id) else {
            return;
        };
        let Some(auth_config) = self.auth_client_config.clone() else {
            return;
        };
        let Ok(Some(metadata)) = self
            .platform_storage
            .load_account_metadata(&binding.account_id, &snapshot.incarnation)
            .await
        else {
            return;
        };
        let Ok(Some(session)) = self
            .platform_storage
            .load_current_session(&binding.account_id, &snapshot.incarnation)
            .await
        else {
            return;
        };
        let Ok(http) = AuthHttpClient::new(
            &self.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            auth_config,
        ) else {
            return;
        };
        let port = ProductionOperationPort {
            runtime: self,
            account_id: binding.account_id.clone(),
            http,
            session: tokio::sync::Mutex::new(session),
            upload: Mutex::new(None),
        };
        let first =
            super::create_vault_cleanup::CreateVaultCleanupPort::cleanup_remote(&port, binding)
                .await;
        if matches!(
            first,
            Err(super::create_vault_staging::CreateVaultStagingError::Unauthorized)
        ) && super::create_vault_cleanup::CreateVaultCleanupPort::renew_session(&port)
            .await
            .is_ok()
        {
            let _ =
                super::create_vault_cleanup::CreateVaultCleanupPort::cleanup_remote(&port, binding)
                    .await;
        }
    }

    /// Replays one Operation's immutable bytes against the Session that is current right now.
    ///
    /// Every exit either moves durable backoff, parks the Account on a Session, or records that
    /// the Server already holds an answer. That is what keeps the loop from spinning.
    async fn attempt_dispatch(
        &self,
        snapshot: &ReplicaSnapshot,
        operation: &OperationRecord,
    ) -> AttemptOutcome {
        if operation.kind == OperationKind::ImportItems {
            return self.attempt_import_dispatch(snapshot, operation).await;
        }
        if operation.kind == OperationKind::CreateVault {
            #[cfg(feature = "binding-test-harness")]
            if operation.create_vault.as_ref().is_some_and(|intent| {
                self.create_vault_binding_pause_checkpoint
                    .lock()
                    .expect("binding create-Vault pause lock poisoned")
                    .as_ref()
                    == Some(&intent.checkpoint)
            }) {
                return AttemptOutcome::Parked;
            }
            return self
                .attempt_create_vault_dispatch(snapshot, operation)
                .await;
        }
        let account_id = snapshot.account_id.clone();
        let expected_incarnation = snapshot.incarnation.clone();
        let execution_lock = match self.account_execution_lock(&account_id) {
            Ok(lock) => lock,
            Err(_) => return AttemptOutcome::Parked,
        };
        let _execution_guard = execution_lock.lock().await;
        if self.is_closed() || self.account_teardown_is_pending(&account_id) {
            return AttemptOutcome::Parked;
        }
        let Some(snapshot) = self.replica.snapshot(&account_id) else {
            return AttemptOutcome::Progressed;
        };
        if snapshot.incarnation != expected_incarnation {
            return AttemptOutcome::Progressed;
        }
        let Some(operation) = snapshot
            .operations
            .iter()
            .find(|candidate| candidate.operation_id == operation.operation_id)
            .cloned()
        else {
            return AttemptOutcome::Progressed;
        };
        let Ok(now_ms) = self.clock.now_ms() else {
            return AttemptOutcome::Parked;
        };
        if operation.scheduling.not_before_ms > now_ms {
            return AttemptOutcome::Progressed;
        }
        let account_id = &snapshot.account_id;
        let Some(auth_config) = self.auth_client_config.clone() else {
            return AttemptOutcome::Parked;
        };
        let metadata = match self
            .platform_storage
            .load_account_metadata(account_id, &snapshot.incarnation)
            .await
        {
            Ok(Some(metadata)) => metadata,
            Ok(None) => {
                self.mark_reauthentication_required(account_id);
                return AttemptOutcome::Parked;
            }
            Err(_) => {
                self.persist_backoff(&snapshot, &operation).await;
                return AttemptOutcome::Progressed;
            }
        };
        let session = match self
            .platform_storage
            .load_current_session(account_id, &snapshot.incarnation)
            .await
        {
            Ok(Some(session)) => session,
            // No Session is the same answer as an unrenewable one: preserve the Operation and say
            // what the Account is waiting for.
            Ok(None) => {
                self.mark_reauthentication_required(account_id);
                return AttemptOutcome::Parked;
            }
            Err(_) => {
                self.persist_backoff(&snapshot, &operation).await;
                return AttemptOutcome::Progressed;
            }
        };
        let http = match AuthHttpClient::new(
            &self.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            auth_config,
        ) {
            Ok(http) => http,
            Err(_) => {
                self.persist_backoff(&snapshot, &operation).await;
                return AttemptOutcome::Progressed;
            }
        };
        self.send_with_session(&snapshot, &operation, &http, session)
            .await
    }

    async fn attempt_import_dispatch(
        &self,
        snapshot: &ReplicaSnapshot,
        operation: &OperationRecord,
    ) -> AttemptOutcome {
        let account_id = snapshot.account_id.clone();
        let Some(auth_config) = self.auth_client_config.clone() else {
            return AttemptOutcome::Parked;
        };
        let metadata = match self
            .platform_storage
            .load_account_metadata(&account_id, &snapshot.incarnation)
            .await
        {
            Ok(Some(metadata)) => metadata,
            Ok(None) => {
                self.mark_reauthentication_required(&account_id);
                return AttemptOutcome::Parked;
            }
            Err(_) => {
                return if self.persist_backoff(snapshot, operation).await {
                    AttemptOutcome::Progressed
                } else {
                    AttemptOutcome::Parked
                };
            }
        };
        let session = match self
            .platform_storage
            .load_current_session(&account_id, &snapshot.incarnation)
            .await
        {
            Ok(Some(session)) => session,
            Ok(None) => {
                self.mark_reauthentication_required(&account_id);
                return AttemptOutcome::Parked;
            }
            Err(_) => {
                return if self.persist_backoff(snapshot, operation).await {
                    AttemptOutcome::Progressed
                } else {
                    AttemptOutcome::Parked
                };
            }
        };
        let http = match AuthHttpClient::new(
            &self.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            auth_config,
        ) {
            Ok(http) => http,
            Err(_) => {
                return if self.persist_backoff(snapshot, operation).await {
                    AttemptOutcome::Progressed
                } else {
                    AttemptOutcome::Parked
                };
            }
        };
        let port = ProductionOperationPort {
            runtime: self,
            account_id: account_id.clone(),
            http,
            session: tokio::sync::Mutex::new(session),
            upload: Mutex::new(None),
        };
        match self
            .drive_import_executor_cycle(&account_id, &operation.operation_id, &port)
            .await
        {
            Ok(
                super::import_executor::ImportExecutorPass::Completed
                | super::import_executor::ImportExecutorPass::RetryScheduled,
            ) => AttemptOutcome::Progressed,
            Ok(
                super::import_executor::ImportExecutorPass::ParkedFenced
                | super::import_executor::ImportExecutorPass::ReauthenticationRequired,
            ) => AttemptOutcome::Parked,
            Err(error) => match create_vault_recovery_policy(
                &super::create_vault_staging::CreateVaultRecoveryError::Fatal(error),
            ) {
                CreateVaultRecoveryPolicy::FailAccount => {
                    self.fail_account_module(&account_id).await;
                    AttemptOutcome::Parked
                }
                CreateVaultRecoveryPolicy::ReauthenticationRequired => {
                    self.mark_reauthentication_required(&account_id);
                    AttemptOutcome::Parked
                }
                CreateVaultRecoveryPolicy::Retry => {
                    if self.persist_backoff(snapshot, operation).await {
                        AttemptOutcome::Progressed
                    } else {
                        AttemptOutcome::Parked
                    }
                }
                _ => AttemptOutcome::Parked,
            },
        }
    }

    async fn attempt_create_vault_dispatch(
        &self,
        snapshot: &ReplicaSnapshot,
        operation: &OperationRecord,
    ) -> AttemptOutcome {
        let account_id = snapshot.account_id.clone();
        let Some(auth_config) = self.auth_client_config.clone() else {
            return AttemptOutcome::Parked;
        };
        let metadata = match self
            .platform_storage
            .load_account_metadata(&account_id, &snapshot.incarnation)
            .await
        {
            Ok(Some(metadata)) => metadata,
            Ok(None) => {
                self.mark_reauthentication_required(&account_id);
                return AttemptOutcome::Parked;
            }
            Err(_) => {
                self.persist_backoff(snapshot, operation).await;
                return AttemptOutcome::Progressed;
            }
        };
        let session = match self
            .platform_storage
            .load_current_session(&account_id, &snapshot.incarnation)
            .await
        {
            Ok(Some(session)) => session,
            Ok(None) => {
                self.mark_reauthentication_required(&account_id);
                return AttemptOutcome::Parked;
            }
            Err(_) => {
                self.persist_backoff(snapshot, operation).await;
                return AttemptOutcome::Progressed;
            }
        };
        let http = match AuthHttpClient::new(
            &self.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            auth_config,
        ) {
            Ok(http) => http,
            Err(_) => {
                self.persist_backoff(snapshot, operation).await;
                return AttemptOutcome::Progressed;
            }
        };
        let port = ProductionOperationPort {
            runtime: self,
            account_id: account_id.clone(),
            http,
            session: tokio::sync::Mutex::new(session),
            upload: Mutex::new(None),
        };
        match self
            .drive_create_vault_recovery_cycle(&account_id, &operation.operation_id, &port, &port)
            .await
        {
            Ok(super::create_vault_executor::CreateVaultExecutorPass::Completed) => {
                while matches!(
                    self.drive_create_vault_cleanup_cycle(
                        &account_id,
                        &operation.operation_id,
                        &port,
                    )
                    .await,
                    Ok(super::create_vault_cleanup::CreateVaultCleanupPass::Progressed)
                ) {}
                AttemptOutcome::Progressed
            }
            Ok(super::create_vault_executor::CreateVaultExecutorPass::RetryScheduled) => {
                AttemptOutcome::Progressed
            }
            Ok(super::create_vault_executor::CreateVaultExecutorPass::ReauthenticationRequired) => {
                AttemptOutcome::Parked
            }
            Err(error) => match create_vault_recovery_policy(&error) {
                CreateVaultRecoveryPolicy::ParkedFenced => {
                    // A guard can only fence after another durable write moved truth. That write
                    // publishes the legitimate wake; reporting progress here would immediately
                    // select the still-eligible Operation and turn contention into a hot loop.
                    AttemptOutcome::Parked
                }
                CreateVaultRecoveryPolicy::FailAccount => {
                    // Contradictory Server authority or an impossible local image/outcome state
                    // must stop the Account durably. Parking without a durable reason would make
                    // the outer dispatcher select the same Operation forever.
                    self.fail_account_module(&account_id).await;
                    AttemptOutcome::Parked
                }
                CreateVaultRecoveryPolicy::ReauthenticationRequired => {
                    self.mark_reauthentication_required(&account_id);
                    AttemptOutcome::Parked
                }
                CreateVaultRecoveryPolicy::Parked => AttemptOutcome::Parked,
                CreateVaultRecoveryPolicy::Retry => {
                    self.persist_backoff(snapshot, operation).await;
                    AttemptOutcome::Progressed
                }
            },
        }
    }

    async fn send_with_session(
        &self,
        snapshot: &ReplicaSnapshot,
        operation: &OperationRecord,
        http: &AuthHttpClient<'_>,
        mut session: CurrentSessionDocument,
    ) -> AttemptOutcome {
        let account_id = &snapshot.account_id;
        let mut auth_budget = OutcomeResolutionAuthBudget::default();

        // A retry has already handed these exact bytes to the Server at least once, so the
        // Server may already hold the answer this Device never saw. Asking creates no second
        // effect; sending again would rely entirely on the Server's own deduplication.
        if operation.scheduling.attempt_count > 0 {
            match self
                .lookup_operation_outcome(
                    account_id,
                    operation,
                    http,
                    &mut session,
                    &mut auth_budget,
                )
                .await
            {
                SemanticAnswer::Outcome(outcome) => {
                    if operation.kind == OperationKind::CreateItem {
                        return self
                            .finish_operation(
                                snapshot,
                                operation,
                                outcome,
                                http,
                                &mut session,
                                &mut auth_budget,
                            )
                            .await;
                    }
                    // Lookup has no request fingerprint. For Share and existing-Item work it is
                    // only evidence that a same-kind decision exists under this ID. Replaying the
                    // exact immutable request proves identity: a matching fingerprint replays the
                    // outcome, while reuse answers 422 without another semantic effect.
                    let _outcome_hint = outcome;
                }
                SemanticAnswer::IdentityReused => {
                    self.fail_account_module_fenced(account_id).await;
                    return AttemptOutcome::Parked;
                }
                // Nothing was decided yet, so the identical bytes still have to go.
                SemanticAnswer::Undecided => {}
                SemanticAnswer::Transient => {
                    self.persist_backoff(snapshot, operation).await;
                    return AttemptOutcome::Progressed;
                }
                SemanticAnswer::ReauthenticationRequired => return AttemptOutcome::Parked,
            }
        }

        match self
            .send_exact_operation_fenced(snapshot, operation, http, &mut session, &mut auth_budget)
            .await
        {
            ExactSendOutcome::Outcome(outcome) => {
                self.finish_operation(
                    snapshot,
                    operation,
                    outcome,
                    http,
                    &mut session,
                    &mut auth_budget,
                )
                .await
            }
            ExactSendOutcome::IdentityReused => {
                self.fail_account_module_fenced(account_id).await;
                AttemptOutcome::Parked
            }
            ExactSendOutcome::Deferred | ExactSendOutcome::RetryScheduled => {
                AttemptOutcome::Progressed
            }
            ExactSendOutcome::Reauthenticate => AttemptOutcome::Parked,
        }
    }

    /// Completes one Operation on an authoritative outcome, or schedules another try.
    ///
    /// A reconciliation that cannot commit is exactly as durable as a failed send: the Operation,
    /// its immutable request, any overlay, and prior authority remain unchanged, with no receipt
    /// retained. Durable scheduling or reauthentication decides when this Device looks again.
    async fn finish_operation(
        &self,
        snapshot: &ReplicaSnapshot,
        operation: &OperationRecord,
        outcome: crate::replica::ObservedOutcome,
        http: &AuthHttpClient<'_>,
        session: &mut CurrentSessionDocument,
        auth_budget: &mut OutcomeResolutionAuthBudget,
    ) -> AttemptOutcome {
        match self
            .complete_operation_fenced_with_auth_budget(
                &snapshot.account_id,
                operation,
                outcome,
                http,
                session,
                None,
                auth_budget,
            )
            .await
        {
            CompletionResult::Completed => AttemptOutcome::Progressed,
            CompletionResult::Retry => {
                self.persist_backoff(snapshot, operation).await;
                AttemptOutcome::Progressed
            }
            CompletionResult::Reauthenticate | CompletionResult::Failed => AttemptOutcome::Parked,
        }
    }

    /// Moves the only two things an attempt is allowed to move.
    ///
    /// The whole record travels so the Replica can refuse any commit that would change the
    /// immutable half, and a rejected or fenced commit simply leaves the durable schedule alone.
    pub(super) async fn persist_backoff(
        &self,
        snapshot: &ReplicaSnapshot,
        operation: &OperationRecord,
    ) -> bool {
        let Ok(now_ms) = self.clock.now_ms() else {
            return false;
        };
        let attempt_count = operation.scheduling.attempt_count.saturating_add(1);
        let rescheduled = OperationRecord {
            scheduling: OperationSchedulingState {
                attempt_count,
                not_before_ms: now_ms.saturating_add(backoff_ms(attempt_count)),
            },
            ..operation.clone()
        };
        let result = self
            .replica
            .execute_recomputing(GuardedCommitPlan::new(
                snapshot.account_id.clone(),
                snapshot.incarnation.clone(),
                snapshot.revision,
                snapshot.lock_epoch,
                vec![PlanMutation::RescheduleOperation(rescheduled)],
            ))
            .await;
        if let Ok(RecomputedPlanResult::Applied { snapshot }) = result {
            let publication = self.publication.lock().expect("publication lock poisoned");
            self.replica.cache(snapshot);
            self.device_revision.fetch_add(1, Ordering::SeqCst);
            drop(publication);
            self.publish_all_unless_closed();
            true
        } else {
            false
        }
    }

    /// Sends a record a test captured earlier, which is what a second Runtime holding the same
    /// accepted work would send: identical bytes, identical identity, no shared local state.
    #[cfg(test)]
    pub(crate) async fn dispatch_captured_ignoring_lease(
        &self,
        snapshot: &ReplicaSnapshot,
        operation: &OperationRecord,
    ) {
        let _ = self.attempt_dispatch(snapshot, operation).await;
    }

    /// Sends one Operation as if this Runtime held its lease, so a test can put two senders on the
    /// same accepted work and watch the Server, not the lease, decide what happens.
    #[cfg(test)]
    pub(crate) async fn dispatch_once_ignoring_lease(
        &self,
        account_id: &AccountId,
        operation_id: &str,
    ) {
        let Some(snapshot) = self.replica.snapshot(account_id) else {
            return;
        };
        let Some(operation) = snapshot
            .operations
            .iter()
            .find(|candidate| candidate.operation_id == operation_id)
            .cloned()
        else {
            return;
        };
        let _ = self.attempt_dispatch(&snapshot, &operation).await;
    }

    /// Exercises one Share dispatch deterministically without running the background loop.
    #[cfg(test)]
    pub(crate) async fn dispatch_create_share_once_for_test(
        &self,
        account_id: &AccountId,
        operation_id: &str,
    ) {
        let Some(snapshot) = self.replica.snapshot(account_id) else {
            return;
        };
        let Some(operation) = snapshot
            .operations
            .iter()
            .find(|candidate| {
                candidate.operation_id == operation_id
                    && candidate.kind == OperationKind::CreateShare
            })
            .cloned()
        else {
            return;
        };
        let _ = self.attempt_dispatch(&snapshot, &operation).await;
    }
}
