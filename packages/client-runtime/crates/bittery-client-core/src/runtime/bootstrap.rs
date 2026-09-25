use super::outcome::{CompletionResult, OutcomeResolutionAuthBudget};
use super::vault_key::{unwrap_vault_key, VaultKeyMaterial};
use crate::{
    auth_http::{AuthHttpClient, AuthenticatedOutcome},
    authentication_installation::parse_session_expiry_ms,
    platform_storage::CurrentSessionDocument,
    protocol::{AttachmentProjection, ItemDraft, ItemProjection},
    replica::{
        AbandonBootstrapPlan, AuthorityAttachmentRecord, AuthorityItemCategory,
        AuthorityItemRecord, AuthorityVaultRecord, AuthorityVaultRole, AuthorityVaultType,
        BeginBootstrapPlan, BootstrapContinuation, BootstrapGenerationId, BootstrapGuard,
        BootstrapPageCursor, BootstrapPhase, CursorAdvance, MarkRefreshRequiredPlan, PlanResult,
        ReplicaSnapshot, ReplicaState, Sha256Fingerprint, StageBootstrapPagePlan,
        StageBootstrapPageResult, SyncCursor,
    },
    server_contract::{
        BootstrapAttachmentResponse, BootstrapItemResponse, BootstrapItemsResponse,
        BootstrapVaultSummary, ItemResponseDto, SyncCursorResponse, SyncEntityType, VaultRole,
        VaultType,
    },
    AccountAccessState, AccountId, AccountWaitingReason, ItemProjectionStatus, RequestCancellation,
    Runtime, RuntimeError, RuntimeErrorCode,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use bittery_crypto_core::{decrypt_with_aad, AadContext, EncryptedData};
use serde::Deserialize;
use std::sync::atomic::Ordering;
use zeroize::{Zeroize, Zeroizing};

const MAX_BOOTSTRAP_PAGES: usize = 4_096;

impl Runtime {
    pub(crate) async fn bootstrap_account(
        &self,
        account_id: &AccountId,
        cancellation: RequestCancellation,
    ) -> Result<(), RuntimeError> {
        let auth_config = self.auth_client_config.clone().ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::AuthenticationUnavailable,
                "authentication is not configured for this Runtime",
            )
        })?;
        let expected_incarnation = self
            .replica
            .snapshot(account_id)
            .ok_or_else(|| {
                RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
            })?
            .incarnation;
        let execution_lock = self.account_execution_lock(account_id)?;
        let _execution_guard = execution_lock.lock().await;
        self.ensure_open()?;
        let snapshot = self.replica.snapshot(account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
        })?;
        if snapshot.incarnation != expected_incarnation {
            return Err(replica_busy());
        }
        let metadata = self
            .platform_storage
            .load_account_metadata(account_id, &snapshot.incarnation)
            .await?
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::AuthenticationRequired,
                    "Account metadata is missing",
                )
            })?;
        let session = self
            .effective_session(account_id, &snapshot.incarnation)
            .await?
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::AuthenticationRequired,
                    "Current Session is missing",
                )
            })?;
        let http = AuthHttpClient::new(
            &self.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            auth_config,
        )?;
        match self
            .run_bootstrap(account_id, &http, session, cancellation)
            .await
        {
            Ok(_) => Ok(()),
            Err(error) if error.code == RuntimeErrorCode::AuthenticationRequired => {
                self.mark_reauthentication_required(account_id);
                Err(error)
            }
            Err(error) => Err(error),
        }
    }

    pub(super) async fn run_bootstrap(
        &self,
        account_id: &AccountId,
        http: &AuthHttpClient<'_>,
        session: CurrentSessionDocument,
        cancellation: RequestCancellation,
    ) -> Result<bool, RuntimeError> {
        let mut last_owned_generation = None;
        let (caught_up, _) = self
            .run_bootstrap_tracked(
                account_id,
                http,
                session,
                cancellation,
                &mut last_owned_generation,
            )
            .await?;
        Ok(caught_up)
    }

    async fn run_bootstrap_tracked(
        &self,
        account_id: &AccountId,
        http: &AuthHttpClient<'_>,
        session: CurrentSessionDocument,
        cancellation: RequestCancellation,
        last_owned_generation: &mut Option<BootstrapGenerationId>,
    ) -> Result<(bool, Option<BootstrapGenerationId>), RuntimeError> {
        let mut auth_budget = OutcomeResolutionAuthBudget::default();
        let snapshot = self.require_snapshot(account_id)?;
        let mut session = session;
        if self.travel_policy_sync_work_due(&snapshot) {
            self.persist_travel_policy_pending_fenced(&snapshot).await?;
        }
        let snapshot = self.require_travel_policy_scope(&snapshot)?;
        if self.travel_policy_server_verification_due(&snapshot) {
            let current = self.begin_travel_policy_refresh_fenced(&snapshot).await?;
            let verified = self
                .read_current_travel_policy_fenced(
                    &current,
                    http,
                    &mut session,
                    cancellation.clone(),
                    Some(&mut auth_budget),
                )
                .await?;
            // The GET snapshot must not retain hidden wrappers while selective cleanup drains.
            drop(session);
            let current = self
                .apply_verified_travel_policy_fenced(&current, verified)
                .await?;
            session = self
                .effective_session(account_id, &current.incarnation)
                .await?
                .ok_or_else(replica_busy)?;
        }
        // A newer episode must be verified before ordinary authority publication. Keep the
        // existing stream/control owner available for that duty.
        if self.travel_policy_verification_pending(&self.require_snapshot(account_id)?) {
            return Ok((true, None));
        }
        let session = self
            .hydrate_bootstrap_generation(
                account_id,
                http,
                session,
                cancellation.clone(),
                &mut auth_budget,
                last_owned_generation,
            )
            .await?;
        let (_, caught_up) = self
            .catch_up_changes(
                account_id,
                http,
                session,
                cancellation,
                &mut auth_budget,
                last_owned_generation,
            )
            .await?;
        // The live runner owns connection lifetime; this bounded pass only installs authority.
        self.decrypt_visible_items(account_id)?;
        let completed_generation = if caught_up {
            self.require_snapshot(account_id)?
                .bootstrap
                .active_generation
        } else {
            None
        };
        Ok((caught_up, completed_generation))
    }

    pub(super) async fn preflight_rotation_authority(
        &self,
        account_id: &AccountId,
        http: &AuthHttpClient<'_>,
        session: CurrentSessionDocument,
        cancellation: RequestCancellation,
    ) -> Result<ReplicaSnapshot, RuntimeError> {
        let initial = self.require_snapshot(account_id)?;
        let mut session = session;
        if initial.bootstrap.staging_generation.is_some() {
            // A generation begun by ordinary Sync cannot be reused as this preflight's proof.
            if !self
                .run_bootstrap(account_id, http, session, cancellation.clone())
                .await?
            {
                return Err(version_evidence_unavailable());
            }
            session = self
                .effective_session(account_id, &initial.incarnation)
                .await?
                .ok_or_else(replica_busy)?;
        }
        let snapshot = self.require_snapshot(account_id)?;
        if snapshot.incarnation != initial.incarnation
            || snapshot.lock_epoch != initial.lock_epoch
            || snapshot.user_id != initial.user_id
            || snapshot.bootstrap.staging_generation.is_some()
        {
            return Err(replica_busy());
        }
        let mut last_owned_generation = None;
        if snapshot.bootstrap.state == ReplicaState::Ready {
            let generation_id = BootstrapGenerationId(bittery_crypto_core::generate_uuid());
            match self
                .replica
                .begin_bootstrap(BeginBootstrapPlan {
                    guard: guard_from(&snapshot),
                    generation_id: generation_id.clone(),
                })
                .await?
            {
                PlanResult::Applied { .. } => last_owned_generation = Some(generation_id),
                PlanResult::Stale { .. } => return Err(replica_busy()),
                PlanResult::Missing => {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AccountMissing,
                        "account is not installed",
                    ));
                }
            }
        }
        let result = async {
            let (caught_up, completed_generation) = self
                .run_bootstrap_tracked(
                    account_id,
                    http,
                    session,
                    cancellation,
                    &mut last_owned_generation,
                )
                .await?;
            if !caught_up {
                return Err(version_evidence_unavailable());
            }
            let snapshot = self.require_snapshot(account_id)?;
            if snapshot.incarnation != initial.incarnation
                || snapshot.lock_epoch != initial.lock_epoch
                || snapshot.user_id != initial.user_id
                || completed_generation != last_owned_generation
                || snapshot.bootstrap.active_generation != completed_generation
            {
                return Err(replica_busy());
            }
            let version_proved = snapshot
                .bootstrap
                .active_generation
                .as_ref()
                .is_some_and(|id| {
                    snapshot
                        .bootstrap
                        .generations
                        .get(id)
                        .is_some_and(|generation| {
                            generation.vault_key_version_proved && generation.final_page_staged
                        })
                });
            if !version_proved
                || snapshot
                    .bootstrap
                    .snapshot()
                    .visible_vaults
                    .iter()
                    .any(|vault| vault.key_version.is_none_or(|version| version <= 0))
            {
                return Err(version_evidence_unavailable());
            }
            Ok(snapshot)
        }
        .await;
        if result.is_err() {
            self.abandon_owned_rotation_stage(&initial, last_owned_generation.as_ref())
                .await?;
        }
        result
    }

    async fn abandon_owned_rotation_stage(
        &self,
        expected: &ReplicaSnapshot,
        owned: Option<&BootstrapGenerationId>,
    ) -> Result<(), RuntimeError> {
        let Some(owned) = owned else { return Ok(()) };
        let snapshot = self.require_snapshot(&expected.account_id)?;
        if snapshot.incarnation != expected.incarnation
            || snapshot.user_id != expected.user_id
            || snapshot.lock_epoch != expected.lock_epoch
            || snapshot.bootstrap.staging_generation.as_ref() != Some(owned)
        {
            return Ok(());
        }
        let _ = self
            .replica
            .abandon_bootstrap(AbandonBootstrapPlan {
                guard: guard_from(&snapshot),
                generation_id: owned.clone(),
            })
            .await?;
        Ok(())
    }

    async fn hydrate_bootstrap_generation(
        &self,
        account_id: &AccountId,
        http: &AuthHttpClient<'_>,
        mut session: CurrentSessionDocument,
        cancellation: RequestCancellation,
        auth_budget: &mut OutcomeResolutionAuthBudget,
        last_owned_generation: &mut Option<BootstrapGenerationId>,
    ) -> Result<CurrentSessionDocument, RuntimeError> {
        let mut snapshot = self.require_snapshot(account_id)?;
        if snapshot.bootstrap.state != ReplicaState::Ready
            || snapshot.bootstrap.staging_generation.is_some()
        {
            // Preserve this duty through staged-page/restart retries. A retirement retry cannot
            // promote a complete generation before its post-watermark policy verification.
            snapshot = self.begin_travel_policy_refresh_fenced(&snapshot).await?;
        }
        if self.has_vault_retirement_work(&snapshot) {
            drop(session);
            self.resume_vault_retirements(&snapshot).await?;
            snapshot = self.require_snapshot(account_id)?;
            session = self
                .effective_session(account_id, &snapshot.incarnation)
                .await?
                .ok_or_else(replica_busy)?;
        }
        let hidden_vault_ids = self.verified_hidden_vault_ids(&snapshot).await?;
        if snapshot.bootstrap.state == ReplicaState::Ready
            && snapshot.bootstrap.staging_generation.is_none()
        {
            return Ok(session);
        }
        if snapshot.bootstrap.staging_generation.is_none() {
            let generation_id = BootstrapGenerationId(bittery_crypto_core::generate_uuid());
            match self
                .replica
                .begin_bootstrap(BeginBootstrapPlan {
                    guard: guard_from(&snapshot),
                    generation_id: generation_id.clone(),
                })
                .await?
            {
                PlanResult::Applied { .. } => *last_owned_generation = Some(generation_id),
                PlanResult::Stale { .. } => {
                    return Err(replica_busy());
                }
                PlanResult::Missing => {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AccountMissing,
                        "account is not installed",
                    ));
                }
            }
        }

        let mut pages = 0usize;
        loop {
            pages += 1;
            if pages > MAX_BOOTSTRAP_PAGES {
                return Err(sync_failure("Bootstrap exceeded the page bound"));
            }
            let snapshot = self.require_snapshot(account_id)?;
            let staging = snapshot
                .bootstrap
                .staging_generation
                .clone()
                .ok_or_else(replica_busy)?;
            let generation = snapshot
                .bootstrap
                .generations
                .get(&staging)
                .ok_or_else(replica_busy)?
                .clone();
            if generation.final_page_staged {
                break;
            }
            let phase = generation.next_page_cursor.phase();
            let request_cursor = generation.next_page_cursor.cursor().map(ToOwned::to_owned);
            let captured = generation.pinned_watermark != SyncCursor::Cold;
            let pinned = match &generation.pinned_watermark {
                SyncCursor::CapturedValue { id } => Some(id.clone()),
                _ => None,
            };
            let mut token = session.token.as_ref().to_owned();
            let mut page = http
                .bootstrap_page(
                    &token,
                    bootstrap_phase_query(phase),
                    request_cursor.as_deref(),
                    pinned.as_deref(),
                    captured,
                    cancellation.clone(),
                )
                .await?;
            if matches!(page, AuthenticatedOutcome::ReauthenticationRequired) {
                if !auth_budget.consume_renewal() {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AuthenticationRequired,
                        "Sync renewal allowance is exhausted",
                    ));
                }
                session = self
                    .renew_session(account_id, &session, http, cancellation.clone())
                    .await?;
                token = session.token.as_ref().to_owned();
                page = http
                    .bootstrap_page(
                        &token,
                        bootstrap_phase_query(phase),
                        request_cursor.as_deref(),
                        pinned.as_deref(),
                        captured,
                        cancellation.clone(),
                    )
                    .await?;
            }
            let page = match page {
                AuthenticatedOutcome::Ok(page) => page,
                AuthenticatedOutcome::Transient => {
                    self.abandon_owned_rotation_stage(&snapshot, Some(&staging))
                        .await?;
                    return Err(sync_failure("Sync Server request failed"));
                }
                AuthenticatedOutcome::ReauthenticationRequired => {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AuthenticationRequired,
                        "Session is missing or expired",
                    ));
                }
            };
            let BootstrapAuthorityPage {
                phase: response_phase,
                has_more,
                next_cursor,
                watermark,
                vault_key_version_included,
                mut vaults,
                mut items,
            } = authority_from_bootstrap_page(&page.value)?;
            if response_phase != phase {
                self.abandon_owned_rotation_stage(&snapshot, Some(&staging))
                    .await?;
                return Err(sync_failure("Bootstrap Server returned the wrong phase"));
            }
            if captured && watermark != generation.pinned_watermark {
                self.abandon_owned_rotation_stage(&snapshot, Some(&staging))
                    .await?;
                return Err(sync_failure("Bootstrap watermark changed between pages"));
            }
            let continuation = if has_more {
                let next_cursor = next_cursor
                    .ok_or_else(|| sync_failure("Bootstrap page is missing its next Cursor"))?;
                BootstrapContinuation::More { next_cursor }
            } else {
                BootstrapContinuation::Final
            };
            let snapshot = self.require_snapshot(account_id)?;
            let current_staging = snapshot
                .bootstrap
                .staging_generation
                .clone()
                .ok_or_else(replica_busy)?;
            if current_staging != staging {
                return Err(replica_busy());
            }
            let generation = snapshot
                .bootstrap
                .generations
                .get(&current_staging)
                .ok_or_else(replica_busy)?
                .clone();
            let response_fingerprint =
                bootstrap_page_fingerprint(&generation.next_page_cursor, &page.raw_body);
            vaults.retain(|vault| !hidden_vault_ids.contains(&vault.id));
            items.retain(|item| !hidden_vault_ids.contains(&item.vault_id));
            match self
                .replica
                .stage_bootstrap_page(StageBootstrapPagePlan {
                    guard: guard_from(&snapshot),
                    generation_id: current_staging.clone(),
                    page_identity: generation.next_page_identity,
                    request_cursor: generation.next_page_cursor,
                    raw_response_fingerprint: response_fingerprint,
                    pinned_watermark: watermark,
                    continuation,
                    vault_key_version_included,
                    vaults,
                    items,
                })
                .await?
            {
                StageBootstrapPageResult::Applied | StageBootstrapPageResult::Replayed => {}
                StageBootstrapPageResult::ReplayMismatch => {
                    self.abandon_owned_rotation_stage(&snapshot, Some(&current_staging))
                        .await?;
                    return Err(sync_failure("Bootstrap page fingerprint did not match"));
                }
                StageBootstrapPageResult::Stale { .. } => return Err(replica_busy()),
                StageBootstrapPageResult::Missing => {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AccountMissing,
                        "account is not installed",
                    ));
                }
            }
        }

        // A pre-Bootstrap policy read cannot cover an event lost before this watermark. Verify
        // after the captured Server boundary and before publishing the complete authority stage.
        let snapshot = self.require_snapshot(account_id)?;
        let staged = snapshot.bootstrap.staging_generation.clone();
        let current = self.begin_travel_policy_refresh_fenced(&snapshot).await?;
        let verified = self
            .read_current_travel_policy_fenced(
                &current,
                http,
                &mut session,
                cancellation,
                Some(auth_budget),
            )
            .await?;
        let mut filtered_hidden = hidden_vault_ids;
        filtered_hidden.sort();
        drop(session);
        let current = self
            .apply_verified_travel_policy_fenced(&current, verified)
            .await?;
        let verified_hidden = self.verified_hidden_vault_ids(&current).await?;
        if verified_hidden != filtered_hidden || current.bootstrap.staging_generation != staged {
            // The raw page fingerprints remain Server fingerprints. Rebuild under the verified
            // selection instead of rewriting accepted page contents or promoting an old filter.
            return Err(RuntimeError::new(
                RuntimeErrorCode::RetryableTransport,
                "Bootstrap requires fresh authority after verified Travel policy changed",
            ));
        }
        if self.travel_policy_verification_pending(&self.require_snapshot(account_id)?) {
            return Err(super::travel_policy::pending_policy());
        }
        let retired = self.promote_bootstrap_with_retirement(account_id).await?;
        let mut session = self
            .effective_session(account_id, &current.incarnation)
            .await?
            .ok_or_else(replica_busy)?;
        session
            .vault_keys
            .retain(|key| !retired.contains(&key.vault_id));
        Ok(session)
    }

    async fn catch_up_changes(
        &self,
        account_id: &AccountId,
        http: &AuthHttpClient<'_>,
        mut session: CurrentSessionDocument,
        cancellation: RequestCancellation,
        auth_budget: &mut OutcomeResolutionAuthBudget,
        last_owned_generation: &mut Option<BootstrapGenerationId>,
    ) -> Result<(CurrentSessionDocument, bool), RuntimeError> {
        let mut passes = 0usize;
        'catch_up: loop {
            passes += 1;
            if passes > MAX_BOOTSTRAP_PAGES {
                return Ok((session, false));
            }
            let snapshot = self.require_snapshot(account_id)?;
            if snapshot.bootstrap.state != ReplicaState::Ready {
                return Ok((session, false));
            }
            let since_id = match &snapshot.bootstrap.active_cursor {
                SyncCursor::CapturedValue { id } => Some(id.clone()),
                SyncCursor::CapturedEmpty => None,
                SyncCursor::Cold => return Ok((session, false)),
            };
            let mut token = session.token.as_ref().to_owned();
            let mut changes = http
                .sync_changes(&token, since_id.as_deref(), cancellation.clone())
                .await?;
            if matches!(changes, AuthenticatedOutcome::ReauthenticationRequired) {
                if !auth_budget.consume_renewal() {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AuthenticationRequired,
                        "Sync renewal allowance is exhausted",
                    ));
                }
                session = self
                    .renew_session(account_id, &session, http, cancellation.clone())
                    .await?;
                token = session.token.as_ref().to_owned();
                changes = http
                    .sync_changes(&token, since_id.as_deref(), cancellation.clone())
                    .await?;
            }
            let changes = match changes {
                AuthenticatedOutcome::Ok(changes) => changes,
                AuthenticatedOutcome::Transient => return Ok((session, false)),
                AuthenticatedOutcome::ReauthenticationRequired => {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AuthenticationRequired,
                        "Session is missing or expired",
                    ));
                }
            };
            // A response cannot silently rebase work fetched from an older page boundary.
            let page_cursor = snapshot.bootstrap.active_cursor.clone();
            if self.require_snapshot(account_id)?.bootstrap.active_cursor != page_cursor {
                return Ok((session, false));
            }
            if changes.events.iter().any(|event| {
                event.r#type == crate::server_contract::SyncEventType::TravelModeUpdated
            }) {
                self.begin_travel_policy_invalidation_fenced(&snapshot)
                    .await?;
                let current = self.require_travel_policy_scope(&snapshot)?;
                let verified = self
                    .read_current_travel_policy_fenced(
                        &current,
                        http,
                        &mut session,
                        cancellation.clone(),
                        Some(auth_budget),
                    )
                    .await?;
                // Release the captured wrappers before any selected cleanup can await a loan.
                drop(session);
                let current = self
                    .apply_verified_travel_policy_fenced(&current, verified)
                    .await?;
                // Reload only the effective wrappers left by the completed selective duty.
                session = self
                    .effective_session(account_id, &current.incarnation)
                    .await?
                    .ok_or_else(replica_busy)?;
            }
            if self.travel_policy_verification_pending(&self.require_snapshot(account_id)?) {
                return Ok((session, false));
            }
            let structural_refresh = changes.events.iter().any(|event| {
                !matches!(
                    event.entity_type,
                    SyncEntityType::Item | SyncEntityType::Operation
                )
            });
            if changes.requires_full_refresh || structural_refresh {
                // A fresh Bootstrap covers Vault/key/access/User changes. Before its watermark
                // can replace this page, finish any locally accepted Operations named by it.
                for event in changes
                    .events
                    .iter()
                    .filter(|event| event.entity_type == SyncEntityType::Operation)
                {
                    match self
                        .reconcile_resolved_operation_fenced(
                            account_id,
                            &event.entity_id,
                            http,
                            &mut session,
                            auth_budget,
                        )
                        .await
                    {
                        CompletionResult::Completed => {}
                        CompletionResult::Retry | CompletionResult::Failed => {
                            return Ok((session, false));
                        }
                        CompletionResult::Reauthenticate => {
                            return Err(RuntimeError::new(
                                RuntimeErrorCode::AuthenticationRequired,
                                "Sync requires a current Session",
                            ));
                        }
                    }
                }
                let snapshot = self.require_snapshot(account_id)?;
                if snapshot.bootstrap.state == ReplicaState::Ready
                    && snapshot.bootstrap.staging_generation.is_none()
                {
                    match self
                        .replica
                        .mark_refresh_required(MarkRefreshRequiredPlan {
                            guard: guard_from(&snapshot),
                        })
                        .await?
                    {
                        PlanResult::Applied { .. } => {}
                        PlanResult::Stale { .. } => return Err(replica_busy()),
                        PlanResult::Missing => {
                            return Err(RuntimeError::new(
                                RuntimeErrorCode::AccountMissing,
                                "account is not installed",
                            ));
                        }
                    }
                }
                session = self
                    .hydrate_bootstrap_generation(
                        account_id,
                        http,
                        session,
                        cancellation.clone(),
                        auth_budget,
                        last_owned_generation,
                    )
                    .await?;
                continue;
            }
            if changes.events.is_empty() {
                return Ok((session, !changes.has_more));
            }
            let Some(terminal_cursor) = changes
                .cursor
                .as_ref()
                .filter(|cursor| {
                    !cursor.id.is_empty() && Some(cursor.id.as_str()) != since_id.as_deref()
                })
                .map(captured_watermark_from_response)
            else {
                return Ok((session, false));
            };
            let page_operation_ids: Vec<_> = changes
                .events
                .iter()
                .filter(|event| event.entity_type == SyncEntityType::Operation)
                .map(|event| event.entity_id.clone())
                .collect();
            for event in &changes.events {
                // An Operation event names work this Device may still own. Reconciling it here
                // keeps one Sync feed and one Cursor rather than a second parallel path.
                if event.entity_type == SyncEntityType::Operation {
                    match self
                        .reconcile_resolved_operation_fenced(
                            account_id,
                            &event.entity_id,
                            http,
                            &mut session,
                            auth_budget,
                        )
                        .await
                    {
                        CompletionResult::Completed => {
                            if self.require_snapshot(account_id)?.bootstrap.state
                                != ReplicaState::Ready
                            {
                                session = self
                                    .hydrate_bootstrap_generation(
                                        account_id,
                                        http,
                                        session,
                                        cancellation.clone(),
                                        auth_budget,
                                        last_owned_generation,
                                    )
                                    .await?;
                                continue 'catch_up;
                            }
                            continue;
                        }
                        CompletionResult::Retry | CompletionResult::Failed => {
                            return Ok((session, false));
                        }
                        CompletionResult::Reauthenticate => {
                            return Err(RuntimeError::new(
                                RuntimeErrorCode::AuthenticationRequired,
                                "Session is missing or expired",
                            ));
                        }
                    }
                }
                if event.entity_type != SyncEntityType::Item {
                    continue;
                }
                let snapshot = self.require_snapshot(account_id)?;
                let guard = guard_from(&snapshot);
                if snapshot.bootstrap.active_cursor != page_cursor {
                    return Ok((session, false));
                }
                let item = self
                    .fetch_sync_item_authority(
                        account_id,
                        &event.entity_id,
                        http,
                        &mut session,
                        auth_budget,
                        cancellation.clone(),
                    )
                    .await?;
                if let Some(item) = &item {
                    self.validate_authoritative_item(account_id, item)?;
                }
                match self
                    .replica
                    .apply_sync_item_authority(
                        guard,
                        page_cursor.clone(),
                        event.entity_id.clone(),
                        item,
                    )
                    .await
                {
                    Ok(PlanResult::Applied { .. }) => {}
                    Ok(PlanResult::Stale { .. }) | Err(_) => return Ok((session, false)),
                    Ok(PlanResult::Missing) => {
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::AccountMissing,
                            "account is not installed",
                        ));
                    }
                }
            }
            // Install the page's plaintext before the terminal commit exposes its new revision.
            // Otherwise a publication can consume that revision with old Items and suppress the
            // later plaintext delivery as a duplicate, including publications from another Account.
            self.decrypt_visible_items(account_id)?;
            match self
                .advance_sync_page_cursor_fenced(
                    account_id,
                    page_operation_ids,
                    CursorAdvance {
                        expected: page_cursor,
                        next: terminal_cursor,
                    },
                )
                .await
            {
                CompletionResult::Completed => {}
                CompletionResult::Retry | CompletionResult::Failed => return Ok((session, false)),
                CompletionResult::Reauthenticate => {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AuthenticationRequired,
                        "Session is missing or expired",
                    ));
                }
            }
            if !changes.has_more {
                return Ok((session, true));
            }
        }
    }

    async fn fetch_sync_item_authority(
        &self,
        account_id: &AccountId,
        item_id: &str,
        http: &AuthHttpClient<'_>,
        session: &mut CurrentSessionDocument,
        budget: &mut OutcomeResolutionAuthBudget,
        cancellation: RequestCancellation,
    ) -> Result<Option<AuthorityItemRecord>, RuntimeError> {
        let mut answer = http
            .fetch_sync_item_authority(session.token.as_ref(), item_id, cancellation.clone())
            .await?;
        if matches!(answer, AuthenticatedOutcome::ReauthenticationRequired)
            && budget.consume_renewal()
        {
            *session = self
                .renew_session(account_id, session, http, cancellation.clone())
                .await?;
            answer = http
                .fetch_sync_item_authority(session.token.as_ref(), item_id, cancellation)
                .await?;
        }
        match answer {
            AuthenticatedOutcome::Ok(item) => {
                let snapshot = self.require_snapshot(account_id)?;
                let hidden = self.verified_hidden_vault_ids(&snapshot).await?;
                // The Server returns membership authority even for a locally hidden Vault. Use
                // the fetched record's current Vault, since the event can precede a later Move.
                Ok(item
                    .as_ref()
                    .filter(|item| !hidden.contains(&item.vault_id))
                    .map(authority_item_from_bootstrap))
            }
            AuthenticatedOutcome::Transient => Err(RuntimeError::new(
                RuntimeErrorCode::RetryableTransport,
                "Sync Item authority is unavailable",
            )),
            AuthenticatedOutcome::ReauthenticationRequired => Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "Sync requires a current Session",
            )),
        }
    }

    pub(super) async fn renew_session(
        &self,
        account_id: &AccountId,
        session: &CurrentSessionDocument,
        http: &AuthHttpClient<'_>,
        cancellation: RequestCancellation,
    ) -> Result<CurrentSessionDocument, RuntimeError> {
        let refreshed = self
            .request_session_refresh(session, http, cancellation)
            .await?;
        self.publish_session_refresh(account_id, session, refreshed)
            .await
    }

    pub(super) async fn request_session_refresh(
        &self,
        session: &CurrentSessionDocument,
        http: &AuthHttpClient<'_>,
        cancellation: RequestCancellation,
    ) -> Result<crate::server_contract::RefreshSessionResponse, RuntimeError> {
        match http
            .refresh_session(session.token.as_ref(), cancellation)
            .await?
        {
            AuthenticatedOutcome::Ok(refreshed) => Ok(refreshed),
            AuthenticatedOutcome::ReauthenticationRequired => Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "Session is missing or expired",
            )),
            AuthenticatedOutcome::Transient => Err(sync_failure("Session refresh failed")),
        }
    }

    /// Caller holds Account execution and has checked its original source scope.
    pub(super) async fn publish_session_refresh(
        &self,
        account_id: &AccountId,
        session: &CurrentSessionDocument,
        refreshed: crate::server_contract::RefreshSessionResponse,
    ) -> Result<CurrentSessionDocument, RuntimeError> {
        let renewed = self
            .store_renewed_effective_session(session, refreshed)
            .await?;
        self.note_session_available(account_id);
        Ok(renewed)
    }

    pub(super) async fn store_renewed_session(
        &self,
        session: &CurrentSessionDocument,
        refreshed: crate::server_contract::RefreshSessionResponse,
    ) -> Result<CurrentSessionDocument, RuntimeError> {
        let renewed = Self::prepare_renewed_session(session, refreshed)?;
        self.replace_independent_session(session, renewed).await
    }

    /// Replace an exact independent Session while the caller holds Account execution.
    /// A refresh response prepared before Vault-key pruning cannot restore the older document.
    pub(super) async fn replace_independent_session(
        &self,
        expected: &CurrentSessionDocument,
        replacement: CurrentSessionDocument,
    ) -> Result<CurrentSessionDocument, RuntimeError> {
        self.ensure_not_closed()?;
        if expected.provenance != crate::platform_storage::SessionProvenance::Independent
            || replacement.provenance != expected.provenance
            || replacement.account_id != expected.account_id
            || replacement.incarnation != expected.incarnation
            || !self
                .replica
                .snapshot(&expected.account_id)
                .is_some_and(|snapshot| snapshot.incarnation == expected.incarnation)
            || self
                .platform_storage
                .load_current_session(&expected.account_id, &expected.incarnation)
                .await?
                .as_ref()
                != Some(expected)
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "Session changed before guarded replacement",
            ));
        }
        // Owner close registers intent before waiting for Account execution. A primitive read
        // may have been held across that intent even though this caller still owns execution.
        self.ensure_not_closed()?;
        self.platform_storage
            .store_current_session(&replacement)
            .await?;
        Ok(replacement)
    }

    pub(super) fn prepare_renewed_session(
        session: &CurrentSessionDocument,
        refreshed: crate::server_contract::RefreshSessionResponse,
    ) -> Result<CurrentSessionDocument, RuntimeError> {
        let expires_at_ms = parse_session_expiry_ms(&refreshed.expires_at)?;
        let mut renewed = CurrentSessionDocument::new(
            session.account_id.clone(),
            session.incarnation.clone(),
            refreshed.token,
            Some(refreshed.session_id),
            expires_at_ms,
            Some(expires_at_ms),
            session.vault_keys.clone(),
            session.encrypted_private_key.clone(),
        )?;
        renewed.provenance = session.provenance.clone();
        Ok(renewed)
    }

    pub(super) fn decrypt_visible_items(&self, account_id: &AccountId) -> Result<(), RuntimeError> {
        self.decrypt_visible_items_with_publication(account_id, false)
            .map(|_| ())
    }

    pub(super) fn decrypt_visible_items_for_foreground_attachment(
        &self,
        account_id: &AccountId,
    ) -> Result<Option<super::PreparedForegroundAttachmentPublications>, RuntimeError> {
        self.decrypt_visible_items_with_publication(account_id, true)
    }

    fn decrypt_visible_items_with_publication(
        &self,
        account_id: &AccountId,
        foreground_attachment: bool,
    ) -> Result<Option<super::PreparedForegroundAttachmentPublications>, RuntimeError> {
        let snapshot = self.require_snapshot(account_id)?;
        if self.travel_policy_verification_pending(&snapshot)
            || self.account_access_retirement_is_pending(account_id)
        {
            return Ok(None);
        }
        let access = self
            .account_access
            .lock()
            .expect("Account access lock poisoned")
            .get(account_id)
            .copied();
        if access != Some(AccountAccessState::Unlocked) {
            return Ok(None);
        }
        let epoch = *self
            .account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .get(account_id)
            .unwrap_or(&snapshot.lock_epoch);
        if epoch != snapshot.lock_epoch {
            return Ok(None);
        }
        let Some(muk) = self.copy_live_vault_key_material(account_id, &snapshot.incarnation) else {
            return Ok(None);
        };
        let Some(generation_id) = snapshot.bootstrap.active_generation.clone() else {
            return Ok(None);
        };
        let mut projections = Vec::new();
        for ((item_generation, _), item) in &snapshot.bootstrap.items {
            if item_generation != &generation_id {
                continue;
            }
            let Some(vault) = snapshot
                .bootstrap
                .vaults
                .get(&(generation_id.clone(), item.vault_id.clone()))
            else {
                continue;
            };
            match decrypt_item(
                &muk,
                &snapshot.user_id,
                vault,
                &SealedItem::from_authority(item),
                &item.category,
            ) {
                Ok(data) => projections.push(ItemProjection {
                    account_id: account_id.clone(),
                    item_id: item.id.clone(),
                    vault_id: item.vault_id.clone(),
                    data: crate::protocol::PublicItemDraft::from(&data),
                    favorite: item.favorite,
                    deleted_at: item.deleted_at.clone(),
                    attachments: decrypt_attachment_projections(
                        account_id,
                        &muk,
                        &snapshot.user_id,
                        vault,
                        &item.attachments,
                    ),
                    created_at: item.created_at.clone(),
                    updated_at: item.updated_at.clone(),
                    status: ItemProjectionStatus::Authoritative,
                    edit_guard: Some(crate::protocol::ItemEditGuard {
                        account_id: account_id.clone(),
                        incarnation: snapshot.incarnation.clone(),
                        lock_epoch: snapshot.lock_epoch,
                        item_id: item.id.clone(),
                        vault_id: item.vault_id.clone(),
                        item_version: item.version,
                    }),
                    duplicate_source_guard: Some(crate::protocol::ItemDuplicateGuard {
                        account_id: account_id.clone(),
                        incarnation_id: snapshot.incarnation.clone(),
                        lock_epoch: snapshot.lock_epoch,
                        source_item_id: item.id.clone(),
                        vault_id: item.vault_id.clone(),
                        replica_revision: snapshot.revision,
                        source: crate::protocol::DuplicateSourceGuard::Authoritative {
                            item_version: item.version,
                        },
                    }),
                }),
                Err(_) => continue,
            }
        }
        // The encrypted optimistic overlays are Items too. A create the Server has not answered
        // yet is Pending, and one it terminally rejected is Failed with its ciphertext intact.
        // Captured legacy failure is also Failed while its held Operation awaits retained proof.
        for overlay in &snapshot.items {
            if overlay.permanently_deleted {
                projections.retain(|existing| existing.item_id != overlay.item_id);
                continue;
            }
            let Some(vault) = snapshot
                .bootstrap
                .vaults
                .get(&(generation_id.clone(), overlay.vault_id.clone()))
            else {
                continue;
            };
            let status = if snapshot.operations.iter().any(|operation| {
                operation.operation_id == overlay.operation_id && !operation.is_legacy_held()
            }) || snapshot
                .attachment_move_preparations
                .iter()
                .any(|preparation| preparation.operation_id == overlay.operation_id)
                || snapshot
                    .cross_account_moves
                    .iter()
                    .filter_map(|entry| entry.captured())
                    .any(|workflow| {
                        workflow.operation_id == overlay.operation_id
                            && !matches!(
                                workflow.stage,
                                crate::replica::CrossAccountMoveStage::Completed
                                    | crate::replica::CrossAccountMoveStage::Rejected
                            )
                    }) {
                ItemProjectionStatus::Pending
            } else {
                ItemProjectionStatus::Failed
            };
            let Ok(data) = decrypt_item(
                &muk,
                &snapshot.user_id,
                vault,
                &SealedItem::from_overlay(overlay),
                &overlay.category,
            ) else {
                continue;
            };
            // An overlay is this Device's own newer truth, so it replaces any authority row for
            // the same Item until reconciliation removes it.
            projections.retain(|existing| existing.item_id != overlay.item_id);
            projections.push(ItemProjection {
                account_id: account_id.clone(),
                item_id: overlay.item_id.clone(),
                vault_id: overlay.vault_id.clone(),
                data: crate::protocol::PublicItemDraft::from(&data),
                favorite: overlay.favorite,
                deleted_at: overlay.deleted_at.clone(),
                attachments: decrypt_attachment_projections_by_authority(
                    account_id,
                    &muk,
                    &snapshot.user_id,
                    &snapshot,
                    &generation_id,
                    &overlay.attachments,
                ),
                // The instant this Device accepted the create, kept durable with the overlay so
                // a restart cannot reshuffle a list that sorts by it.
                created_at: overlay.created_at.clone(),
                updated_at: overlay.updated_at.clone(),
                status,
                edit_guard: None,
                duplicate_source_guard: Some(crate::protocol::ItemDuplicateGuard {
                    account_id: account_id.clone(),
                    incarnation_id: snapshot.incarnation.clone(),
                    lock_epoch: snapshot.lock_epoch,
                    source_item_id: overlay.item_id.clone(),
                    vault_id: overlay.vault_id.clone(),
                    replica_revision: snapshot.revision,
                    source: crate::protocol::DuplicateSourceGuard::AcceptedOverlay {
                        operation_id: overlay.operation_id.clone(),
                    },
                }),
            });
        }
        projections.sort_by(|left, right| left.item_id.cmp(&right.item_id));
        #[cfg(test)]
        if let Some(hook) = self
            .before_plaintext_commit
            .lock()
            .expect("before plaintext commit hook lock poisoned")
            .clone()
        {
            hook();
        }
        let publication = self.publication.lock().expect("publication lock poisoned");
        let current = self.replica.snapshot(account_id);
        if !current.as_ref().is_some_and(|current| {
            current.incarnation == snapshot.incarnation
                && current.revision == snapshot.revision
                && current.lock_epoch == snapshot.lock_epoch
        }) {
            return Ok(None);
        }
        self.filter_vault_item_projections(&snapshot, &mut projections)?;
        let retirement_intent = self.account_access_retirement_intent(account_id);
        let pending_retirements = retirement_intent
            .lock()
            .expect("pending Account access retirement lock poisoned");
        if *pending_retirements > 0 {
            return Ok(None);
        }
        let current_epoch = *self
            .account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .get(account_id)
            .unwrap_or(&snapshot.lock_epoch);
        if current_epoch != epoch
            || self
                .account_access
                .lock()
                .expect("Account access lock poisoned")
                .get(account_id)
                != Some(&AccountAccessState::Unlocked)
        {
            return Ok(None);
        }
        self.unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .insert(account_id.clone(), projections);
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        drop(pending_retirements);
        drop(publication);
        let prepared = if foreground_attachment && !self.is_closed() {
            Some(self.prepare_all_for_foreground_attachment())
        } else {
            if !foreground_attachment {
                self.publish_all_unless_closed();
            }
            None
        };
        Ok(prepared)
    }

    #[cfg(test)]
    pub(crate) fn set_before_plaintext_commit_hook(
        &self,
        hook: Option<std::sync::Arc<dyn Fn() + Send + Sync>>,
    ) {
        *self
            .before_plaintext_commit
            .lock()
            .expect("before plaintext commit hook lock poisoned") = hook;
    }

    pub(super) async fn abandon_staging(&self, account_id: &AccountId) -> Result<(), RuntimeError> {
        let snapshot = self.require_snapshot(account_id)?;
        let Some(staging) = snapshot.bootstrap.staging_generation.clone() else {
            return Ok(());
        };
        let _ = self
            .replica
            .abandon_bootstrap(AbandonBootstrapPlan {
                guard: guard_from(&snapshot),
                generation_id: staging,
            })
            .await?;
        Ok(())
    }

    pub(super) fn require_snapshot(
        &self,
        account_id: &AccountId,
    ) -> Result<ReplicaSnapshot, RuntimeError> {
        self.replica.snapshot(account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
        })
    }

    pub(super) fn validate_authoritative_item(
        &self,
        account_id: &AccountId,
        item: &AuthorityItemRecord,
    ) -> Result<(), RuntimeError> {
        let snapshot = self.require_snapshot(account_id)?;
        let generation = snapshot
            .bootstrap
            .active_generation
            .as_ref()
            .ok_or_else(|| sync_failure("authoritative Item has no active Bootstrap generation"))?;
        let vault = snapshot
            .bootstrap
            .vaults
            .get(&(generation.clone(), item.vault_id.clone()))
            .ok_or_else(|| sync_failure("authoritative Item Vault is not visible"))?;
        let muk = self
            .copy_live_vault_key_material(account_id, &snapshot.incarnation)
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::AuthenticationRequired,
                    "authoritative Item cannot be validated while locked",
                )
            })?;
        decrypt_item(
            &muk,
            &snapshot.user_id,
            vault,
            &SealedItem::from_authority(item),
            &item.category,
        )
        .map(|_| ())
    }

    pub(super) fn mark_reauthentication_required(&self, account_id: &AccountId) {
        let previous = self
            .waiting_reasons
            .lock()
            .expect("waiting reason lock poisoned")
            .insert(
                account_id.clone(),
                AccountWaitingReason::ReauthenticationRequired,
            );
        if previous == Some(AccountWaitingReason::ReauthenticationRequired) {
            return;
        }
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        self.publish_all_unless_closed();
    }

    pub(super) fn clear_waiting_reason(&self, account_id: &AccountId) {
        self.waiting_reasons
            .lock()
            .expect("waiting reason lock poisoned")
            .remove(account_id);
    }
}

fn guard_from(snapshot: &ReplicaSnapshot) -> BootstrapGuard {
    BootstrapGuard {
        account_id: snapshot.account_id.clone(),
        user_id: snapshot.user_id.clone(),
        incarnation: snapshot.incarnation.clone(),
        expected_replica_revision: snapshot.revision,
        expected_lock_epoch: snapshot.lock_epoch,
    }
}

fn captured_watermark(cursor: Option<&SyncCursorResponse>) -> SyncCursor {
    match cursor {
        Some(cursor) if !cursor.id.is_empty() => SyncCursor::CapturedValue {
            id: cursor.id.clone(),
        },
        _ => SyncCursor::CapturedEmpty,
    }
}

fn captured_watermark_from_response(cursor: &SyncCursorResponse) -> SyncCursor {
    captured_watermark(Some(cursor))
}

fn bootstrap_phase_query(phase: BootstrapPhase) -> &'static str {
    match phase {
        BootstrapPhase::Vaults => "vaults",
        BootstrapPhase::Items => "items",
    }
}

fn bootstrap_page_fingerprint(
    request_cursor: &BootstrapPageCursor,
    raw_body: &[u8],
) -> Sha256Fingerprint {
    let (phase_tag, cursor_variant_tag, cursor_bytes) = match request_cursor {
        BootstrapPageCursor::VaultsInitial => (0_u8, 0_u8, &[][..]),
        BootstrapPageCursor::VaultsAfter { cursor } => (0, 1, cursor.as_bytes()),
        BootstrapPageCursor::ItemsInitial => (1, 0, &[][..]),
        BootstrapPageCursor::ItemsAfter { cursor } => (1, 1, cursor.as_bytes()),
    };
    let cursor_length =
        u64::try_from(cursor_bytes.len()).expect("supported targets fit byte lengths in u64");
    let body_length =
        u64::try_from(raw_body.len()).expect("supported targets fit byte lengths in u64");
    const FRAME_VERSION: &[u8] = b"bootstrap-page-v1";
    let mut identified =
        Vec::with_capacity(FRAME_VERSION.len() + 18 + cursor_bytes.len() + raw_body.len());
    identified.extend_from_slice(FRAME_VERSION);
    identified.push(phase_tag);
    identified.push(cursor_variant_tag);
    identified.extend_from_slice(&cursor_length.to_be_bytes());
    identified.extend_from_slice(cursor_bytes);
    identified.extend_from_slice(&body_length.to_be_bytes());
    identified.extend_from_slice(raw_body);
    Sha256Fingerprint::of_bytes(&identified)
}

struct BootstrapAuthorityPage {
    phase: BootstrapPhase,
    has_more: bool,
    next_cursor: Option<String>,
    watermark: SyncCursor,
    /// Complete raw Vault-page version proof, before Travel visibility removes hidden rows.
    vault_key_version_included: bool,
    vaults: Vec<AuthorityVaultRecord>,
    items: Vec<AuthorityItemRecord>,
}

#[cfg(test)]
#[test]
fn bootstrap_page_fingerprint_binds_the_closed_phase() {
    let body = br#"{"nextCursor":"same"}"#;
    assert_ne!(
        bootstrap_page_fingerprint(&BootstrapPageCursor::VaultsInitial, body),
        bootstrap_page_fingerprint(&BootstrapPageCursor::ItemsInitial, body)
    );
}

#[cfg(test)]
#[test]
fn bootstrap_page_fingerprint_binds_the_phase_scoped_request_cursor() {
    let body = br#"{"nextCursor":"same"}"#;
    let initial = BootstrapPageCursor::ItemsInitial;
    let after = BootstrapPageCursor::ItemsAfter {
        cursor: "same".into(),
    };
    assert_ne!(
        bootstrap_page_fingerprint(&initial, body),
        bootstrap_page_fingerprint(&after, body),
        "ItemsInitial and ItemsAfter(same) need distinct replay fingerprints"
    );
}

fn authority_from_bootstrap_page(
    page: &BootstrapItemsResponse,
) -> Result<BootstrapAuthorityPage, RuntimeError> {
    match page {
        BootstrapItemsResponse::Vaults {
            has_more,
            next_cursor,
            sync_cursor,
            vaults,
            vault_key_version_included,
        } => {
            let vaults = vaults
                .iter()
                .map(authority_vault)
                .collect::<Result<Vec<_>, _>>()?;
            let version_proved = *vault_key_version_included == Some(true)
                && vaults
                    .iter()
                    .all(|vault: &AuthorityVaultRecord| vault.key_version.is_some_and(|v| v > 0));
            Ok(BootstrapAuthorityPage {
                phase: BootstrapPhase::Vaults,
                has_more: *has_more,
                next_cursor: next_cursor.clone(),
                watermark: captured_watermark(sync_cursor.as_ref()),
                vault_key_version_included: version_proved,
                vaults,
                items: Vec::new(),
            })
        }
        BootstrapItemsResponse::Items {
            has_more,
            items,
            next_cursor,
            sync_cursor,
        } => Ok(BootstrapAuthorityPage {
            phase: BootstrapPhase::Items,
            has_more: *has_more,
            next_cursor: next_cursor.clone(),
            watermark: captured_watermark(sync_cursor.as_ref()),
            vault_key_version_included: false,
            vaults: Vec::new(),
            items: items.iter().map(authority_item_from_bootstrap).collect(),
        }),
    }
}

#[cfg(test)]
#[test]
fn raw_vault_page_version_proof_cannot_ignore_a_hidden_unversioned_row() {
    let page: BootstrapItemsResponse = serde_json::from_value(serde_json::json!({
        "phase": "vaults", "hasMore": false, "nextCursor": null, "syncCursor": null,
        "vaultKeyVersionIncluded": true,
        "vaults": [
            {"id":"visible", "name":"Visible", "vaultType":"personal", "role":"owner",
             "icon":null, "imageUrl":null, "encryptedVaultKey":"wrapped", "keyVersion":2},
            {"id":"hidden", "name":"Hidden", "vaultType":"team", "role":"member",
             "icon":null, "imageUrl":null, "encryptedVaultKey":"wrapped"}
        ]
    }))
    .unwrap();
    let mut parsed = authority_from_bootstrap_page(&page).unwrap();
    assert_eq!(parsed.vaults.len(), 2);
    parsed.vaults.retain(|vault| vault.id != "hidden");
    assert!(parsed
        .vaults
        .iter()
        .all(|vault| vault.key_version.is_some()));
    assert!(
        !parsed.vault_key_version_included,
        "a filtered hidden row cannot turn the marked raw page into complete version proof"
    );
}

fn authority_vault(vault: &BootstrapVaultSummary) -> Result<AuthorityVaultRecord, RuntimeError> {
    if vault.key_version.is_some_and(|version| version <= 0) {
        return Err(version_evidence_unavailable());
    }
    Ok(AuthorityVaultRecord {
        id: vault.id.clone(),
        name: vault.name.clone(),
        vault_type: match vault.vault_type {
            VaultType::Personal => AuthorityVaultType::Personal,
            VaultType::Team => AuthorityVaultType::Team,
        },
        icon: vault.icon.clone(),
        image_url: vault.image_url.clone(),
        encrypted_vault_key: vault.encrypted_vault_key.clone(),
        key_version: vault.key_version,
        role: match vault.role {
            VaultRole::Owner => AuthorityVaultRole::Owner,
            VaultRole::Admin => AuthorityVaultRole::Admin,
            VaultRole::Member => AuthorityVaultRole::Member,
            VaultRole::ReadOnly => AuthorityVaultRole::ReadOnly,
        },
    })
}

fn authority_item_from_bootstrap(item: &BootstrapItemResponse) -> AuthorityItemRecord {
    AuthorityItemRecord {
        id: item.id.clone(),
        vault_id: item.vault_id.clone(),
        category: item.category.clone().into(),
        favorite: item.favorite,
        encrypted_data: item.encrypted_data.clone(),
        encryption_iv: item.encryption_iv.clone(),
        encryption_algorithm: item.encryption_algorithm.clone(),
        version: item.version,
        encryption_version: item.encryption_version,
        encrypted_by_user_id: item.encrypted_by_user_id.clone(),
        last_modified_by: item.last_modified_by.clone(),
        created_at: item.created_at.clone(),
        updated_at: item.updated_at.clone(),
        deleted_at: item.deleted_at.clone(),
        attachments: item
            .attachments
            .iter()
            .map(authority_attachment_from_bootstrap)
            .collect(),
    }
}

fn authority_attachment_from_bootstrap(
    attachment: &BootstrapAttachmentResponse,
) -> AuthorityAttachmentRecord {
    AuthorityAttachmentRecord {
        id: attachment.id.clone(),
        item_id: attachment.item_id.clone(),
        vault_id: attachment.vault_id.clone(),
        storage_key: attachment.storage_key.clone(),
        encrypted_name: attachment.encrypted_name.clone(),
        encryption_iv: attachment.encryption_iv.clone(),
        encryption_algorithm: attachment.encryption_algorithm.clone(),
        encrypted_attachment_key: attachment.encrypted_attachment_key.clone(),
        attachment_key_iv: attachment.attachment_key_iv.clone(),
        attachment_key_algorithm: attachment.attachment_key_algorithm.clone(),
        encrypted_content_type: attachment.encrypted_content_type.clone(),
        encrypted_content_type_iv: attachment.encrypted_content_type_iv.clone(),
        envelope_version: attachment.envelope_version,
        file_size: attachment.file_size,
        uploaded_by: attachment.uploaded_by.clone(),
        created_at: attachment.created_at.clone(),
    }
}

pub(super) fn authority_item_from_dto(
    item: ItemResponseDto,
) -> Result<AuthorityItemRecord, RuntimeError> {
    Ok(AuthorityItemRecord {
        id: item.id,
        vault_id: item.vault_id,
        category: item.category.into(),
        favorite: item.favorite,
        encrypted_data: item.encrypted_data,
        encryption_iv: item.encryption_iv,
        encryption_algorithm: item.encryption_algorithm,
        version: item.version,
        encryption_version: item.encryption_version,
        encrypted_by_user_id: item.encrypted_by_user_id,
        last_modified_by: item.last_modified_by,
        created_at: item.created_at,
        updated_at: item.updated_at,
        deleted_at: item.deleted_at,
        attachments: Vec::new(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
/// One sealed Login and the exact AAD binding it was sealed under.
///
/// Authority rows and encrypted optimistic overlays are both this, which is why one reader opens
/// both without either of them pretending to be the other.
pub(super) struct SealedItem<'a> {
    item_id: &'a str,
    vault_id: &'a str,
    encryption_version: i32,
    encrypted_by_user_id: &'a str,
    data: EncryptedData,
}

impl<'a> SealedItem<'a> {
    pub(super) fn from_authority(item: &'a AuthorityItemRecord) -> Self {
        Self {
            item_id: &item.id,
            vault_id: &item.vault_id,
            encryption_version: item.encryption_version,
            encrypted_by_user_id: &item.encrypted_by_user_id,
            data: EncryptedData {
                ciphertext: item.encrypted_data.clone(),
                iv: item.encryption_iv.clone(),
                algorithm: item.encryption_algorithm.clone(),
            },
        }
    }

    pub(super) fn from_overlay(overlay: &'a crate::replica::ReplicaItemRecord) -> Self {
        Self {
            item_id: &overlay.item_id,
            vault_id: &overlay.vault_id,
            encryption_version: overlay.encryption_version,
            encrypted_by_user_id: &overlay.encrypted_by_user_id,
            data: EncryptedData {
                ciphertext: overlay.encrypted_data.clone(),
                iv: overlay.encryption_iv.clone(),
                algorithm: overlay.encryption_algorithm.clone(),
            },
        }
    }
}

pub(super) fn decrypt_item(
    muk: &VaultKeyMaterial,
    user_id: &str,
    vault: &AuthorityVaultRecord,
    item: &SealedItem<'_>,
    category: &AuthorityItemCategory,
) -> Result<ItemDraft, RuntimeError> {
    let vault_key =
        Zeroizing::new(unwrap_vault_key(vault, user_id, muk).map_err(|error| {
            RuntimeError::new(RuntimeErrorCode::InvariantViolation, error.message)
        })?);
    let plaintext = decrypt_with_aad(
        &item.data,
        &vault_key,
        &AadContext {
            vault_id: item.vault_id.to_owned(),
            entity_id: item.item_id.to_owned(),
            entity_type: "item".into(),
            version: u64::try_from(item.encryption_version)
                .map_err(|_| sync_failure("Item encryption version is invalid"))?,
            user_id: item.encrypted_by_user_id.to_owned(),
        },
    )
    .map_err(|_| sync_failure("Item ciphertext could not be decrypted"))?;
    decode_item_plaintext(&plaintext, category)
}

pub(super) fn decode_item_plaintext(
    plaintext: &str,
    category: &AuthorityItemCategory,
) -> Result<ItemDraft, RuntimeError> {
    let invalid = |_| sync_failure("Item plaintext does not match its category");
    Ok(match category {
        AuthorityItemCategory::Login => {
            ItemDraft::Login(serde_json::from_str(plaintext).map_err(invalid)?)
        }
        AuthorityItemCategory::SecureNote => {
            ItemDraft::SecureNote(serde_json::from_str(plaintext).map_err(invalid)?)
        }
        AuthorityItemCategory::CreditCard => {
            ItemDraft::CreditCard(serde_json::from_str(plaintext).map_err(invalid)?)
        }
        AuthorityItemCategory::Identity => {
            ItemDraft::Identity(serde_json::from_str(plaintext).map_err(invalid)?)
        }
        AuthorityItemCategory::Totp => {
            ItemDraft::Authenticator(serde_json::from_str(plaintext).map_err(invalid)?)
        }
    })
}

fn decrypt_attachment_projections(
    account_id: &AccountId,
    muk: &VaultKeyMaterial,
    user_id: &str,
    vault: &AuthorityVaultRecord,
    attachments: &[AuthorityAttachmentRecord],
) -> Vec<AttachmentProjection> {
    let Ok(vault_key) = unwrap_vault_key(vault, user_id, muk) else {
        return Vec::new();
    };
    let vault_key = Zeroizing::new(vault_key);
    attachments
        .iter()
        .filter_map(|attachment| {
            if attachment.vault_id != vault.id || attachment.envelope_version <= 0 {
                return None;
            }
            let scope = |entity_type: &str, version: u64| AadContext {
                vault_id: attachment.vault_id.clone(),
                entity_id: attachment.id.clone(),
                entity_type: entity_type.to_owned(),
                version,
                user_id: attachment.uploaded_by.clone(),
            };
            let mut encoded_key = decrypt_with_aad(
                &EncryptedData {
                    ciphertext: attachment.encrypted_attachment_key.clone(),
                    iv: attachment.attachment_key_iv.clone(),
                    algorithm: attachment.attachment_key_algorithm.clone(),
                },
                &vault_key,
                &scope("attachment_key", attachment.envelope_version as u64),
            )
            .ok()?;
            let decoded_key = BASE64.decode(encoded_key.as_bytes()).ok();
            encoded_key.zeroize();
            let attachment_key = Zeroizing::new(decoded_key?);
            if attachment_key.len() != 32 {
                return None;
            }
            let name = decrypt_with_aad(
                &EncryptedData {
                    ciphertext: attachment.encrypted_name.clone(),
                    iv: attachment.encryption_iv.clone(),
                    algorithm: attachment.encryption_algorithm.clone(),
                },
                &attachment_key,
                &scope("attachment_name", 1),
            )
            .ok()?;
            let content_type = decrypt_with_aad(
                &EncryptedData {
                    ciphertext: attachment.encrypted_content_type.clone(),
                    iv: attachment.encrypted_content_type_iv.clone(),
                    algorithm: attachment.encryption_algorithm.clone(),
                },
                &attachment_key,
                &scope("attachment_content_type", 1),
            )
            .ok()?;
            Some(AttachmentProjection {
                account_id: account_id.clone(),
                attachment_id: attachment.id.clone(),
                item_id: attachment.item_id.clone(),
                vault_id: attachment.vault_id.clone(),
                name,
                content_type,
                file_size: attachment.file_size,
                uploaded_by: attachment.uploaded_by.clone(),
                created_at: attachment.created_at.clone(),
            })
        })
        .collect()
}

fn decrypt_attachment_projections_by_authority(
    account_id: &AccountId,
    muk: &VaultKeyMaterial,
    user_id: &str,
    snapshot: &ReplicaSnapshot,
    generation_id: &BootstrapGenerationId,
    attachments: &[AuthorityAttachmentRecord],
) -> Vec<AttachmentProjection> {
    attachments
        .iter()
        .flat_map(|attachment| {
            snapshot
                .bootstrap
                .vaults
                .get(&(generation_id.clone(), attachment.vault_id.clone()))
                .map(|vault| {
                    decrypt_attachment_projections(
                        account_id,
                        muk,
                        user_id,
                        vault,
                        std::slice::from_ref(attachment),
                    )
                })
                .unwrap_or_default()
        })
        .collect()
}

fn replica_busy() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::InvariantViolation,
        "Replica Bootstrap generation changed during hydration",
    )
}

fn sync_failure(message: &'static str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

fn version_evidence_unavailable() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::VersionEvidenceUnavailable,
        "Complete Vault key-version authority is unavailable",
    )
}

/// Read a fresh Vault phase without publishing authority or installing wrappers. Native independent
/// revalidation uses this same closed bootstrap parser and key validation before clearing exclusions.
pub(super) async fn fresh_readable_vault_ids(
    http: &AuthHttpClient<'_>,
    session: &CurrentSessionDocument,
    user_id: &str,
    key: &VaultKeyMaterial,
    requested: &[String],
    cancellation: RequestCancellation,
) -> Result<Vec<String>, RuntimeError> {
    let mut cursor = None;
    let mut watermark = SyncCursor::Cold;
    let mut seen_cursors = std::collections::HashSet::new();
    let mut seen_requested = std::collections::HashSet::new();
    let mut visible = Vec::new();
    for _ in 0..MAX_BOOTSTRAP_PAGES {
        if cancellation.is_cancelled() {
            return Err(sync_failure("Vault authority verification was cancelled"));
        }
        let pinned = match &watermark {
            SyncCursor::CapturedValue { id } => Some(id.as_str()),
            _ => None,
        };
        let page = http
            .bootstrap_page(
                &session.token,
                "vaults",
                cursor.as_deref(),
                pinned,
                watermark != SyncCursor::Cold,
                cancellation.clone(),
            )
            .await?;
        let AuthenticatedOutcome::Ok(page) = page else {
            return Err(sync_failure(
                "Fresh readable Vault authority is unavailable",
            ));
        };
        let page = authority_from_bootstrap_page(&page.value)?;
        if page.phase != BootstrapPhase::Vaults
            || (watermark != SyncCursor::Cold && page.watermark != watermark)
        {
            return Err(sync_failure(
                "Fresh Vault authority changed its captured phase or watermark",
            ));
        }
        watermark = page.watermark;
        for vault in page.vaults {
            if requested.contains(&vault.id) {
                if !seen_requested.insert(vault.id.clone()) {
                    return Err(sync_failure(
                        "Fresh Vault authority repeated a requested Vault",
                    ));
                }
                if let Ok(opened) = unwrap_vault_key(&vault, user_id, key) {
                    let _opened = Zeroizing::new(opened);
                    visible.push(vault.id);
                }
            }
        }
        if !page.has_more {
            visible.sort();
            return Ok(visible);
        }
        let next = page
            .next_cursor
            .filter(|next| !next.is_empty())
            .ok_or_else(|| sync_failure("Fresh Vault authority omitted its next Cursor"))?;
        if !seen_cursors.insert(next.clone()) {
            return Err(sync_failure("Fresh Vault authority repeated its Cursor"));
        }
        cursor = Some(next);
    }
    Err(sync_failure(
        "Fresh Vault authority exceeded the bootstrap page bound",
    ))
}

#[cfg(test)]
mod item_category_tests {
    use super::*;
    use crate::{
        runtime::create::item_plaintext,
        test_fixtures::{personal_vault, TEST_MASTER_UNLOCK_KEY, TEST_VAULT_ID, TEST_VAULT_KEY},
        AuthenticatorItemData, CreditCardItemData, IdentityItemData, LoginItemData,
        SecureNoteItemData,
    };
    use bittery_crypto_core::{encrypt_with_aad, AadContext};

    #[test]
    fn bootstrap_decrypts_every_authoritative_category_into_the_closed_projection() {
        let cases = vec![
            (
                AuthorityItemCategory::Login,
                ItemDraft::Login(LoginItemData {
                    title: "Login".into(),
                    url: None,
                    urls: vec![],
                    username: None,
                    password: None,
                    password_history: vec![],
                    passkeys: vec![],
                    notes: None,
                    note: None,
                    custom_fields: vec![],
                    tags: vec![],
                    totp_secret: None,
                    totp_issuer: None,
                    totp_account_name: None,
                    totp_algorithm: None,
                    totp_digits: None,
                    totp_period: None,
                }),
            ),
            (
                AuthorityItemCategory::SecureNote,
                ItemDraft::SecureNote(SecureNoteItemData {
                    title: "Note".into(),
                    note: "Body".into(),
                    notes: None,
                    custom_fields: vec![],
                    tags: vec![],
                }),
            ),
            (
                AuthorityItemCategory::CreditCard,
                ItemDraft::CreditCard(CreditCardItemData {
                    title: "Card".into(),
                    cardholder_name: Some("Holder".into()),
                    card_number: Some("4111".into()),
                    cvv: Some("123".into()),
                    expiry_date: Some("12/30".into()),
                    billing_address: None,
                    notes: None,
                    custom_fields: vec![],
                    totp_secret: None,
                    totp_issuer: None,
                    totp_account_name: None,
                    totp_algorithm: None,
                    totp_digits: None,
                    totp_period: None,
                    tags: vec![],
                }),
            ),
            (
                AuthorityItemCategory::Identity,
                ItemDraft::Identity(IdentityItemData {
                    title: "Identity".into(),
                    first_name: None,
                    middle_name: None,
                    last_name: None,
                    email: None,
                    addresses: vec![],
                    phone_numbers: vec![],
                    ssn: None,
                    passport_number: None,
                    drivers_license: None,
                    date_of_birth: None,
                    notes: None,
                    custom_fields: vec![],
                    totp_secret: None,
                    totp_issuer: None,
                    totp_account_name: None,
                    totp_algorithm: None,
                    totp_digits: None,
                    totp_period: None,
                    tags: vec![],
                }),
            ),
            (
                AuthorityItemCategory::Totp,
                ItemDraft::Authenticator(AuthenticatorItemData {
                    title: "Authenticator".into(),
                    totp_secret: "secret".into(),
                    totp_issuer: None,
                    totp_account_name: None,
                    totp_algorithm: None,
                    totp_digits: None,
                    totp_period: None,
                    linked_item_id: Some("login-id".into()),
                    notes: None,
                    custom_fields: vec![],
                    tags: vec![],
                }),
            ),
        ];
        let vault = personal_vault(TEST_VAULT_ID, "user-1");
        for (category, expected) in cases {
            let encrypted = encrypt_with_aad(
                &item_plaintext(&expected).unwrap(),
                &TEST_VAULT_KEY,
                &AadContext {
                    vault_id: TEST_VAULT_ID.into(),
                    entity_id: "item-1".into(),
                    entity_type: "item".into(),
                    version: 1,
                    user_id: "user-1".into(),
                },
            )
            .unwrap();
            let sealed = SealedItem {
                item_id: "item-1",
                vault_id: TEST_VAULT_ID,
                encryption_version: 1,
                encrypted_by_user_id: "user-1",
                data: encrypted,
            };
            assert_eq!(
                decrypt_item(
                    &VaultKeyMaterial {
                        master_unlock_key: Zeroizing::new(TEST_MASTER_UNLOCK_KEY),
                        encrypted_private_key: None
                    },
                    "user-1",
                    &vault,
                    &sealed,
                    &category
                )
                .unwrap(),
                expected
            );
        }
    }

    #[test]
    fn bootstrap_rejects_plaintext_that_does_not_match_authoritative_category() {
        let vault = personal_vault(TEST_VAULT_ID, "user-1");
        let encrypted = encrypt_with_aad(
            r#"{"title":"Login","password":"secret"}"#,
            &TEST_VAULT_KEY,
            &AadContext {
                vault_id: TEST_VAULT_ID.into(),
                entity_id: "item-1".into(),
                entity_type: "item".into(),
                version: 1,
                user_id: "user-1".into(),
            },
        )
        .unwrap();
        let sealed = SealedItem {
            item_id: "item-1",
            vault_id: TEST_VAULT_ID,
            encryption_version: 1,
            encrypted_by_user_id: "user-1",
            data: encrypted,
        };
        assert_eq!(
            decrypt_item(
                &VaultKeyMaterial {
                    master_unlock_key: Zeroizing::new(TEST_MASTER_UNLOCK_KEY),
                    encrypted_private_key: None
                },
                "user-1",
                &vault,
                &sealed,
                &AuthorityItemCategory::SecureNote
            )
            .unwrap_err()
            .code,
            RuntimeErrorCode::InvariantViolation
        );
    }
}
