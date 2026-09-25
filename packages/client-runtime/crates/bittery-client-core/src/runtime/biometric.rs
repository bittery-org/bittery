//! Local biometric release. Core decides access; the host supplies only hardware and OS prompts.
use super::*;
use crate::{BiometricFailure, BiometricHardware, Incarnation};
use async_trait::async_trait;

const DEFAULT_REENTRY_MS: i64 = 30 * 24 * 60 * 60 * 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BiometricPromptResult {
    Authenticated,
    Cancelled,
    Failed,
    LockedOut,
    Unavailable,
    NotEnrolled,
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub trait BiometricPort: Send + Sync {
    async fn hardware(&self) -> Result<BiometricHardware, RuntimeError>;
    async fn authenticate(
        &self,
        prompt_message: &str,
        cancellation: RequestCancellation,
    ) -> BiometricPromptResult;
}

struct UnavailableBiometricPort;
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl BiometricPort for UnavailableBiometricPort {
    async fn hardware(&self) -> Result<BiometricHardware, RuntimeError> {
        Ok(BiometricHardware {
            has_hardware: false,
            is_enrolled: false,
            kind: None,
        })
    }
    async fn authenticate(
        &self,
        _prompt_message: &str,
        _cancellation: RequestCancellation,
    ) -> BiometricPromptResult {
        BiometricPromptResult::Unavailable
    }
}

const GRACE_MS: u64 = 10 * 60 * 1_000;

#[derive(Default)]
struct LocalAccessState {
    revision: u64,
    accounts: HashMap<AccountId, u64>,
    grace: HashMap<AccountId, (Incarnation, u64, u64)>,
    prompts: Vec<std::sync::Weak<PromptScope>>,
}
struct PromptScope {
    targets: Mutex<std::collections::HashSet<AccountId>>,
    cancellation: RequestCancellation,
}
impl Drop for PromptScope {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}
pub(super) struct BiometricState {
    port: Mutex<Arc<dyn BiometricPort>>,
    state: Mutex<LocalAccessState>,
    prompt: tokio::sync::Mutex<()>,
    settings: tokio::sync::Mutex<()>,
}
impl Default for BiometricState {
    fn default() -> Self {
        Self {
            port: Mutex::new(Arc::new(UnavailableBiometricPort)),
            state: Mutex::default(),
            prompt: tokio::sync::Mutex::new(()),
            settings: tokio::sync::Mutex::new(()),
        }
    }
}
impl LocalAccessState {
    fn retire_account(&mut self, account: &AccountId) {
        *self.accounts.entry(account.clone()).or_default() += 1;
        self.grace.remove(account);
        self.prompts.retain(|weak| {
            let Some(prompt) = weak.upgrade() else {
                return false;
            };
            let mut targets = prompt
                .targets
                .lock()
                .expect("biometric targets lock poisoned");
            targets.remove(account);
            if targets.is_empty() {
                prompt.cancellation.cancel();
            }
            true
        });
    }
}
pub(super) struct BiometricPublicationRetirement<'a> {
    _state: std::sync::MutexGuard<'a, LocalAccessState>,
}
pub(super) struct BiometricReleaseGuard<'a> {
    _state: std::sync::MutexGuard<'a, LocalAccessState>,
}

impl BiometricState {
    pub(super) fn retire(&self, account: &AccountId) {
        self.state
            .lock()
            .expect("local access lock poisoned")
            .retire_account(account);
    }
    // Keep scope retirement and synchronous generation publication indivisible to preflight
    // registration. The established lock order is biometric state, then publication.
    pub(super) fn retire_for_publication(
        &self,
        account: &AccountId,
    ) -> BiometricPublicationRetirement<'_> {
        let mut state = self.state.lock().expect("local access lock poisoned");
        state.retire_account(account);
        BiometricPublicationRetirement { _state: state }
    }
    pub(super) fn retire_all(&self) {
        let mut state = self.state.lock().expect("local access lock poisoned");
        state.revision += 1;
        state.grace.clear();
        for prompt in state.prompts.drain(..).filter_map(|weak| weak.upgrade()) {
            prompt.cancellation.cancel();
        }
    }
    pub(super) fn generation(&self, account: &AccountId) -> (u64, u64) {
        let state = self.state.lock().expect("local access lock poisoned");
        (state.revision, *state.accounts.get(account).unwrap_or(&0))
    }

    /// Hold the same retirement mutex used by preference, policy and port changes while a
    /// successful native disclosure crosses its final source admission boundary.
    pub(super) fn guard_generations(
        &self,
        expected: &[(AccountId, (u64, u64))],
    ) -> Option<BiometricReleaseGuard<'_>> {
        let state = self.state.lock().expect("local access lock poisoned");
        if expected.iter().any(|(account, generation)| {
            (state.revision, *state.accounts.get(account).unwrap_or(&0)) != *generation
        }) {
            return None;
        }
        Some(BiometricReleaseGuard { _state: state })
    }
}
struct LocalAccessGuard {
    snapshot: crate::replica::ReplicaSnapshot,
    generation: (u64, u64),
}

impl Runtime {
    /// Native composition installs one primitive OS adapter; no renderer can supply authorization.
    pub fn install_biometric_port(&self, port: Arc<dyn BiometricPort>) {
        self.biometric.retire_all();
        *self
            .biometric
            .port
            .lock()
            .expect("Biometric capability lock poisoned") = port;
    }

    pub(super) async fn reentry_period(&self) -> Result<i64, RuntimeError> {
        Ok(self
            .platform_storage
            .load_local_security()
            .await?
            .map_or(DEFAULT_REENTRY_MS, |settings| {
                settings.master_password_reentry_period_ms
            }))
    }

    pub(super) async fn request_biometric(
        &self,
        request: RuntimeRequest,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.ensure_open()?;
        self.reject_request_during_pending_teardown(&request)?;
        if cancellation.is_cancelled() {
            return Err(local_cancelled());
        }
        let port = self
            .biometric
            .port
            .lock()
            .expect("Biometric capability lock poisoned")
            .clone();
        match request {
            RuntimeRequest::SetMasterPasswordReentryPeriod { period_ms } => {
                let _admission = self.teardown_admission.read().await;
                let _catalog = self.catalog_transition.lock().await;
                let _settings = self.biometric.settings.lock().await;
                self.ensure_open()?;
                self.reject_request_during_pending_teardown(
                    &RuntimeRequest::SetMasterPasswordReentryPeriod { period_ms },
                )?;
                if cancellation.is_cancelled() {
                    return Err(local_cancelled());
                }
                self.biometric.retire_all();
                self.platform_storage
                    .store_local_security(period_ms)
                    .await?;
                Ok(RuntimeResponse::MasterPasswordReentryPeriod { period_ms })
            }
            RuntimeRequest::BiometricAvailability { account_ids } => {
                let hardware = port.hardware().await?;
                let period = self.reentry_period().await?;
                let mut accounts = Vec::new();
                for account_id in unique_accounts(account_ids) {
                    let enabled = self.biometric_enabled(&account_id).await.unwrap_or(false);
                    let failure = self
                        .local_access_guard(&account_id, &hardware, period)
                        .await
                        .err();
                    accounts.push(crate::BiometricAccountAvailability {
                        account_id,
                        enabled,
                        failure,
                    });
                }
                Ok(RuntimeResponse::BiometricAvailability {
                    hardware,
                    accounts,
                    master_password_reentry_period_ms: period,
                })
            }
            RuntimeRequest::SetBiometricEnabled {
                account_id,
                enabled,
            } => {
                let expected = self.require_snapshot(&account_id)?;
                self.biometric.retire(&account_id);
                let lock = self.account_execution_lock(&account_id)?;
                let _guard = lock.lock().await;
                self.ensure_open()?;
                self.reject_request_during_pending_teardown(
                    &RuntimeRequest::SetBiometricEnabled {
                        account_id: account_id.clone(),
                        enabled,
                    },
                )?;
                let snapshot = self.require_snapshot(&account_id)?;
                if snapshot.incarnation != expected.incarnation
                    || snapshot.user_id != expected.user_id
                {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AuthenticationRequired,
                        "Biometric setting belongs to a retired Account generation",
                    ));
                }
                let mut metadata = self
                    .platform_storage
                    .load_account_metadata(&account_id, &snapshot.incarnation)
                    .await?
                    .ok_or_else(local_material_required)?;
                let quick = self
                    .platform_storage
                    .load_quick_unlock(&account_id, &snapshot.incarnation)
                    .await?;
                if enabled
                    && (!port.hardware().await?.has_hardware
                        || quick.is_none()
                        || self.platform_storage.load_device_key().await?.is_none())
                {
                    return Ok(RuntimeResponse::BiometricEnabled {
                        account_id,
                        enabled: metadata.biometric_enabled
                            && quick.is_some_and(|q| q.biometric_enabled),
                    });
                }
                if cancellation.is_cancelled() {
                    return Err(local_cancelled());
                }
                metadata.biometric_enabled = enabled;
                // A partial write can only disable release: both existing flags must be true.
                if let Some(mut quick) = quick {
                    quick.biometric_enabled = enabled;
                    if enabled {
                        self.platform_storage
                            .store_account_metadata(&metadata)
                            .await?;
                        self.platform_storage.store_quick_unlock(&quick).await?;
                    } else {
                        self.platform_storage.store_quick_unlock(&quick).await?;
                        self.platform_storage
                            .store_account_metadata(&metadata)
                            .await?;
                    }
                } else {
                    self.platform_storage
                        .store_account_metadata(&metadata)
                        .await?;
                }
                Ok(RuntimeResponse::BiometricEnabled {
                    account_id,
                    enabled,
                })
            }
            RuntimeRequest::BiometricUnlock {
                account_id,
                prompt_message,
            } => {
                self.unlock_biometrically(
                    vec![account_id],
                    prompt_message,
                    false,
                    port,
                    cancellation,
                )
                .await
            }
            RuntimeRequest::BiometricUnlockAccounts {
                account_ids,
                prompt_message,
            } => {
                self.unlock_biometrically(
                    unique_accounts(account_ids),
                    prompt_message,
                    true,
                    port,
                    cancellation,
                )
                .await
            }
            _ => unreachable!("non-biometric command"),
        }
    }

    async fn biometric_enabled(&self, account: &AccountId) -> Result<bool, RuntimeError> {
        let Some(snapshot) = self.replica.snapshot(account) else {
            return Ok(false);
        };
        let metadata = self
            .platform_storage
            .load_account_metadata(account, &snapshot.incarnation)
            .await?;
        let quick = self
            .platform_storage
            .load_quick_unlock(account, &snapshot.incarnation)
            .await?;
        Ok(metadata.is_some_and(|value| value.biometric_enabled)
            && quick.is_some_and(|value| value.biometric_enabled))
    }

    async fn local_access_guard(
        &self,
        account: &AccountId,
        hardware: &BiometricHardware,
        period: i64,
    ) -> Result<LocalAccessGuard, BiometricFailure> {
        if !hardware.has_hardware {
            return Err(BiometricFailure::Unavailable);
        }
        if !hardware.is_enrolled {
            return Err(BiometricFailure::NotEnrolled);
        }
        self.ensure_open().map_err(local_failure)?;
        self.require_native_local_unlock_allowed(account)
            .map_err(local_failure)?;
        self.reject_request_during_pending_teardown(&RuntimeRequest::BiometricUnlock {
            account_id: account.clone(),
            prompt_message: String::new(),
        })
        .map_err(local_failure)?;
        if self.account_access_retirement_is_pending(account)
            || self
                .lock_epoch_pending
                .lock()
                .expect("pending lock epoch lock poisoned")
                .contains_key(account)
        {
            return Err(BiometricFailure::AccountChanged);
        }
        let generation = self.biometric.generation(account);
        let snapshot = self.require_snapshot(account).map_err(local_failure)?;
        let metadata = self
            .platform_storage
            .load_account_metadata(account, &snapshot.incarnation)
            .await
            .map_err(local_failure)?
            .ok_or(BiometricFailure::PasswordRequired)?;
        let quick = self
            .platform_storage
            .load_quick_unlock(account, &snapshot.incarnation)
            .await
            .map_err(local_failure)?
            .ok_or(BiometricFailure::PasswordRequired)?;
        if !metadata.biometric_enabled || !quick.biometric_enabled {
            return Err(BiometricFailure::NotEnabled);
        }
        let now = self.clock.now_ms().map_err(local_failure)?;
        let session = self
            .platform_storage
            .load_current_session(account, &snapshot.incarnation)
            .await
            .map_err(local_failure)?
            .ok_or(BiometricFailure::PasswordRequired)?;
        if self
            .platform_storage
            .load_device_key()
            .await
            .map_err(local_failure)?
            .is_none()
        {
            return Err(BiometricFailure::PasswordRequired);
        }
        require_local_deadlines(&quick, &session, period, now)?;
        Ok(LocalAccessGuard {
            snapshot,
            generation,
        })
    }

    async fn unlock_biometrically(
        &self,
        account_ids: Vec<AccountId>,
        message: String,
        force_prompt: bool,
        port: Arc<dyn BiometricPort>,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let hardware = port.hardware().await?;
        let period = self.reentry_period().await?;
        let mut results = Vec::new();
        let mut eligible = Vec::new();
        for account_id in account_ids {
            match self
                .local_access_guard(&account_id, &hardware, period)
                .await
            {
                Ok(guard) => {
                    results.push(crate::BiometricAccountUnlock {
                        account_id,
                        failure: None,
                    });
                    eligible.push((results.len() - 1, guard));
                }
                Err(failure) => results.push(crate::BiometricAccountUnlock {
                    account_id,
                    failure: Some(failure),
                }),
            }
        }
        if eligible.is_empty() {
            return Ok(RuntimeResponse::BiometricUnlock { accounts: results });
        }
        let scope = {
            let mut state = self
                .biometric
                .state
                .lock()
                .expect("local access lock poisoned");
            // Validation and registration share retirement's mutex, so retired preflight cannot
            // start a new prompt after the cancellation that was meant to fence it.
            eligible.retain(|(index, guard)| {
                let account = &guard.snapshot.account_id;
                let current = (state.revision, *state.accounts.get(account).unwrap_or(&0));
                let valid = current == guard.generation
                    && !self.is_closed()
                    && !self.account_access_retirement_is_pending(account)
                    && !self.account_teardown_is_pending(account)
                    && self.replica.snapshot(account).is_some_and(|snapshot| {
                        snapshot.incarnation == guard.snapshot.incarnation
                            && snapshot.lock_epoch == guard.snapshot.lock_epoch
                    });
                if !valid {
                    results[*index].failure = Some(BiometricFailure::AccountChanged);
                }
                valid
            });
            state.prompts.retain(|scope| scope.strong_count() > 0);
            if eligible.is_empty() {
                return Ok(RuntimeResponse::BiometricUnlock { accounts: results });
            }
            let scope = Arc::new(PromptScope {
                targets: Mutex::new(
                    eligible
                        .iter()
                        .map(|(_, guard)| guard.snapshot.account_id.clone())
                        .collect(),
                ),
                cancellation: RequestCancellation::new(),
            });
            state.prompts.push(Arc::downgrade(&scope));
            scope
        };
        let now = self.clock.now_ms()?;
        let needs_prompt = force_prompt || {
            let state = self
                .biometric
                .state
                .lock()
                .expect("local access lock poisoned");
            eligible.iter().any(|(_, guard)| {
                !state.grace.get(&guard.snapshot.account_id).is_some_and(
                    |(incarnation, epoch, at)| {
                        incarnation == &guard.snapshot.incarnation
                            && *epoch == guard.snapshot.lock_epoch
                            && now.saturating_sub(*at) <= GRACE_MS
                    },
                )
            })
        };
        let prompted = if needs_prompt {
            let prompt_guard = tokio::select! {
                biased;
                _ = cancellation.cancelled() => { scope.cancellation.cancel(); return Err(local_cancelled()) },
                _ = scope.cancellation.cancelled() => None,
                guard = self.biometric.prompt.lock() => Some(guard),
            };
            if let Some(_prompt_guard) = prompt_guard {
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => { scope.cancellation.cancel(); return Err(local_cancelled()) },
                    _ = scope.cancellation.cancelled() => BiometricPromptResult::Cancelled,
                    result = port.authenticate(&message, scope.cancellation.clone()) => result,
                }
            } else {
                BiometricPromptResult::Cancelled
            }
        } else {
            BiometricPromptResult::Authenticated
        };
        for (index, expected) in eligible {
            let result = if self.biometric.generation(&expected.snapshot.account_id)
                != expected.generation
            {
                Err(BiometricFailure::AccountChanged)
            } else if let Some(failure) = prompt_failure(prompted) {
                Err(failure)
            } else {
                self.release_biometric_target(
                    &expected,
                    port.as_ref(),
                    &cancellation,
                    &scope.cancellation,
                )
                .await
            };
            if result.is_ok() && needs_prompt {
                self.biometric
                    .state
                    .lock()
                    .expect("local access lock poisoned")
                    .grace
                    .insert(
                        expected.snapshot.account_id.clone(),
                        (
                            expected.snapshot.incarnation.clone(),
                            expected.snapshot.lock_epoch,
                            self.clock.now_ms()?,
                        ),
                    );
            }
            results[index].failure = result.err();
        }
        Ok(RuntimeResponse::BiometricUnlock { accounts: results })
    }

    async fn release_biometric_target(
        &self,
        expected: &LocalAccessGuard,
        port: &dyn BiometricPort,
        cancellation: &RequestCancellation,
        retirement: &RequestCancellation,
    ) -> Result<(), BiometricFailure> {
        let account = &expected.snapshot.account_id;
        let hardware = port.hardware().await.map_err(local_failure)?;
        let period = self.reentry_period().await.map_err(local_failure)?;
        let after_prompt = self.local_access_guard(account, &hardware, period).await?;
        if after_prompt.generation != expected.generation
            || after_prompt.snapshot.incarnation != expected.snapshot.incarnation
            || after_prompt.snapshot.lock_epoch != expected.snapshot.lock_epoch
        {
            return Err(BiometricFailure::AccountChanged);
        }
        // Verify Travel using the retained Session only. This call cannot create or refresh it.
        let metadata = self
            .platform_storage
            .load_account_metadata(account, &expected.snapshot.incarnation)
            .await
            .map_err(local_failure)?
            .ok_or(BiometricFailure::AccountChanged)?;
        let session = self
            .platform_storage
            .load_current_session(account, &expected.snapshot.incarnation)
            .await
            .map_err(local_failure)?
            .ok_or(BiometricFailure::PasswordRequired)?;
        let (policy, fresh) = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(BiometricFailure::Cancelled),
            _ = retirement.cancelled() => return Err(BiometricFailure::AccountChanged),
            result = self.verify_local_travel_policy(&metadata, &session, cancellation.clone()) => result.map_err(|failure| match failure {
                super::local_access::LocalTravelFailure::Unavailable => BiometricFailure::Unavailable,
                super::local_access::LocalTravelFailure::Unverified => BiometricFailure::TravelUnverified,
                super::local_access::LocalTravelFailure::Runtime(error) => local_failure(error),
            })?,
        };
        let lock = self
            .account_execution_lock(account)
            .map_err(local_failure)?;
        let execution_guard = lock.lock().await;
        let _settings = self.biometric.settings.lock().await;
        let period = self.reentry_period().await.map_err(local_failure)?;
        let current = self.local_access_guard(account, &hardware, period).await?;
        if cancellation.is_cancelled() {
            return Err(BiometricFailure::Cancelled);
        }
        if current.generation != expected.generation
            || current.snapshot.incarnation != expected.snapshot.incarnation
            || current.snapshot.lock_epoch != expected.snapshot.lock_epoch
        {
            return Err(BiometricFailure::AccountChanged);
        }
        if fresh {
            // A subsequent offline attempt must see this policy even when release is refused.
            let mut metadata = self
                .platform_storage
                .load_account_metadata(account, &current.snapshot.incarnation)
                .await
                .map_err(local_failure)?
                .ok_or(BiometricFailure::AccountChanged)?;
            metadata.verified_travel_mode = Some(policy.clone());
            self.platform_storage
                .store_account_metadata(&metadata)
                .await
                .map_err(local_failure)?;
        }
        let session = self
            .platform_storage
            .load_current_session(account, &current.snapshot.incarnation)
            .await
            .map_err(local_failure)?
            .ok_or(BiometricFailure::PasswordRequired)?;
        // Ticket 71 owns all-generation Travel erasure. Until composed, refuse release if any
        // hidden authority remains; never substitute filtering for erasure or publish hidden keys.
        if Self::hidden_local_authority_remains(&current.snapshot, &session, &policy) {
            return Err(BiometricFailure::TravelUnverified);
        }
        let quick = self
            .platform_storage
            .load_quick_unlock(account, &current.snapshot.incarnation)
            .await
            .map_err(local_failure)?
            .ok_or(BiometricFailure::PasswordRequired)?;
        let device = self
            .platform_storage
            .load_device_key()
            .await
            .map_err(local_failure)?
            .ok_or(BiometricFailure::PasswordRequired)?;
        require_local_deadlines(
            &quick,
            &session,
            period,
            self.clock.now_ms().map_err(local_failure)?,
        )?;
        let key = unwrap_master_unlock_key(&quick.encrypted_master_unlock_key, &device.key_bytes)
            .map_err(local_failure)?;
        let invalidated = {
            let _native = self
                .native_local_unlock_publication(&current.snapshot)
                .map_err(local_failure)?;
            let state = self
                .biometric
                .state
                .lock()
                .expect("local access lock poisoned");
            if (state.revision, *state.accounts.get(account).unwrap_or(&0)) != expected.generation
                || cancellation.is_cancelled()
            {
                return Err(BiometricFailure::AccountChanged);
            }
            self.publish_account_unlock(
                &current.snapshot,
                key,
                Some(session.encrypted_private_key.clone()),
            )
            .map_err(local_failure)?
        };
        let decrypted = self.decrypt_visible_items(account);
        let failed_delivery = decrypted
            .as_ref()
            .err()
            .and_then(|_| self.fence_account_unlock(&current.snapshot, AccountAccessState::Locked));
        drop(_settings);
        drop(execution_guard);
        finish_generation_fence(invalidated);
        finish_generation_fence(failed_delivery);
        if decrypted.is_ok() {
            self.note_local_unlock_completed(account);
            self.note_session_available(account);
        } else {
            self.publish_all_unless_closed();
        }
        decrypted.map_err(local_failure)
    }
}
pub(super) fn require_local_deadlines(
    quick: &crate::platform_storage::QuickUnlockDocument,
    session: &crate::platform_storage::CurrentSessionDocument,
    period: i64,
    now: u64,
) -> Result<(), BiometricFailure> {
    if (period >= 0
        && now.saturating_sub(
            quick
                .last_master_password_entry_ms
                .unwrap_or(quick.created_at_ms),
        ) >= period as u64)
        || session.expires_at_ms <= now
        || session
            .server_expires_at_ms
            .is_some_and(|expiry| expiry <= now)
    {
        Err(BiometricFailure::PasswordRequired)
    } else {
        Ok(())
    }
}

fn unique_accounts(accounts: Vec<AccountId>) -> Vec<AccountId> {
    let mut seen = std::collections::HashSet::new();
    accounts
        .into_iter()
        .filter(|account| seen.insert(account.clone()))
        .collect()
}
fn local_material_required() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthenticationRequired,
        "Local unlock material is unavailable",
    )
}
fn local_cancelled() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::Cancelled,
        "Local access request cancelled",
    )
}
fn local_failure(error: RuntimeError) -> BiometricFailure {
    match error.code {
        RuntimeErrorCode::Cancelled => BiometricFailure::Cancelled,
        RuntimeErrorCode::AccountMissing
        | RuntimeErrorCode::RuntimeClosed
        | RuntimeErrorCode::AccountFailed => BiometricFailure::AccountChanged,
        RuntimeErrorCode::AuthenticationRequired | RuntimeErrorCode::AccessDenied => {
            BiometricFailure::PasswordRequired
        }
        _ => BiometricFailure::StorageUnavailable,
    }
}
fn prompt_failure(result: BiometricPromptResult) -> Option<BiometricFailure> {
    match result {
        BiometricPromptResult::Authenticated => None,
        BiometricPromptResult::Cancelled => Some(BiometricFailure::Cancelled),
        BiometricPromptResult::Failed => Some(BiometricFailure::Failed),
        BiometricPromptResult::LockedOut => Some(BiometricFailure::LockedOut),
        BiometricPromptResult::Unavailable => Some(BiometricFailure::Unavailable),
        BiometricPromptResult::NotEnrolled => Some(BiometricFailure::NotEnrolled),
    }
}
