use super::outcome::CompletionResult;
use crate::{
    auth_http::{AuthHttpClient, AuthenticatedOutcome},
    authentication_installation::parse_session_expiry_ms,
    platform_storage::CurrentSessionDocument,
    protocol::{LoginCustomField, LoginItemProjection},
    replica::{
        AbandonBootstrapPlan, AuthorityItemCategory, AuthorityItemRecord, AuthorityVaultRecord,
        AuthorityVaultRole, AuthorityVaultType, BeginBootstrapPlan, BootstrapContinuation,
        BootstrapGenerationId, BootstrapGuard, BootstrapPageCursor, MarkRefreshRequiredPlan,
        PlanResult, PromoteBootstrapPlan, ReplicaSnapshot, ReplicaState, Sha256Fingerprint,
        StageBootstrapPagePlan, StageBootstrapPageResult, SyncCursor,
    },
    server_contract::{
        BootstrapItemResponse, BootstrapItemsResponse, BootstrapVaultSummary, ItemCategory,
        ItemResponseDto, SyncCursorResponse, SyncEntityType, VaultRole, VaultType,
    },
    AccountAccessState, AccountId, AccountWaitingReason, CustomFieldKind, ItemProjectionStatus,
    RequestCancellation, Runtime, RuntimeError, RuntimeErrorCode,
};
use bittery_crypto_core::{
    decrypt_vault_key_with_muk, decrypt_with_aad, AadContext, EncryptedData, WrappedVaultKeyData,
};
use serde::Deserialize;
use std::sync::atomic::Ordering;

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
        let snapshot = self.replica.snapshot(account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
        })?;
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
            .platform_storage
            .load_current_session(account_id, &snapshot.incarnation)
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
            Ok(()) => Ok(()),
            Err(error) if error.code == RuntimeErrorCode::AuthenticationRequired => {
                self.mark_reauthentication_required(account_id);
                Err(error)
            }
            Err(error) => Err(error),
        }
    }

    async fn run_bootstrap(
        &self,
        account_id: &AccountId,
        http: &AuthHttpClient<'_>,
        mut session: CurrentSessionDocument,
        cancellation: RequestCancellation,
    ) -> Result<(), RuntimeError> {
        session = self
            .hydrate_bootstrap_generation(account_id, http, session, cancellation.clone())
            .await?;
        session = self
            .catch_up_changes(account_id, http, session, cancellation.clone())
            .await?;
        let _ = self
            .observe_sse_hint(http, session.token.as_ref(), cancellation)
            .await?;
        self.decrypt_visible_items(account_id)?;
        Ok(())
    }

    async fn hydrate_bootstrap_generation(
        &self,
        account_id: &AccountId,
        http: &AuthHttpClient<'_>,
        mut session: CurrentSessionDocument,
        cancellation: RequestCancellation,
    ) -> Result<CurrentSessionDocument, RuntimeError> {
        let snapshot = self.require_snapshot(account_id)?;
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
                    generation_id,
                })
                .await?
            {
                PlanResult::Applied { .. } => {}
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
            let request_cursor = match &generation.next_page_cursor {
                BootstrapPageCursor::Initial => None,
                BootstrapPageCursor::After { cursor } => Some(cursor.clone()),
            };
            let captured = generation.pinned_watermark != SyncCursor::Cold;
            let pinned = match &generation.pinned_watermark {
                SyncCursor::CapturedValue { id } => Some(id.clone()),
                _ => None,
            };
            let mut token = session.token.as_ref().to_owned();
            let mut page = http
                .bootstrap_page(
                    &token,
                    request_cursor.as_deref(),
                    pinned.as_deref(),
                    captured,
                    cancellation.clone(),
                )
                .await?;
            if matches!(page, AuthenticatedOutcome::ReauthenticationRequired) {
                session = self
                    .renew_session(account_id, &session, http, cancellation.clone())
                    .await?;
                token = session.token.as_ref().to_owned();
                page = http
                    .bootstrap_page(
                        &token,
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
                    self.abandon_staging(account_id).await?;
                    return Err(sync_failure("Sync Server request failed"));
                }
                AuthenticatedOutcome::ReauthenticationRequired => {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AuthenticationRequired,
                        "Session is missing or expired",
                    ));
                }
            };
            let watermark = captured_watermark(page.value.sync_cursor.as_ref());
            if captured && watermark != generation.pinned_watermark {
                self.abandon_staging(account_id).await?;
                return Err(sync_failure("Bootstrap watermark changed between pages"));
            }
            let continuation = if page.value.has_more {
                let next_cursor = page
                    .value
                    .next_cursor
                    .clone()
                    .ok_or_else(|| sync_failure("Bootstrap page is missing its next Cursor"))?;
                BootstrapContinuation::More { next_cursor }
            } else {
                BootstrapContinuation::Final
            };
            let (vaults, items) = authority_from_bootstrap_page(&page.value)?;
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
            match self
                .replica
                .stage_bootstrap_page(StageBootstrapPagePlan {
                    guard: guard_from(&snapshot),
                    generation_id: staging,
                    page_identity: generation.next_page_identity,
                    request_cursor: generation.next_page_cursor,
                    raw_response_fingerprint: Sha256Fingerprint::of_bytes(&page.raw_body),
                    pinned_watermark: watermark,
                    continuation,
                    vaults,
                    items,
                })
                .await?
            {
                StageBootstrapPageResult::Applied | StageBootstrapPageResult::Replayed => {}
                StageBootstrapPageResult::ReplayMismatch => {
                    self.abandon_staging(account_id).await?;
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

        let snapshot = self.require_snapshot(account_id)?;
        let staging = snapshot
            .bootstrap
            .staging_generation
            .clone()
            .ok_or_else(replica_busy)?;
        match self
            .replica
            .promote_bootstrap(PromoteBootstrapPlan {
                guard: guard_from(&snapshot),
                generation_id: staging,
            })
            .await?
        {
            PlanResult::Applied { .. } => Ok(session),
            PlanResult::Stale { .. } => Err(replica_busy()),
            PlanResult::Missing => Err(RuntimeError::new(
                RuntimeErrorCode::AccountMissing,
                "account is not installed",
            )),
        }
    }

    async fn catch_up_changes(
        &self,
        account_id: &AccountId,
        http: &AuthHttpClient<'_>,
        mut session: CurrentSessionDocument,
        cancellation: RequestCancellation,
    ) -> Result<CurrentSessionDocument, RuntimeError> {
        loop {
            let snapshot = self.require_snapshot(account_id)?;
            if snapshot.bootstrap.state != ReplicaState::Ready {
                return Ok(session);
            }
            let since_id = match &snapshot.bootstrap.active_cursor {
                SyncCursor::CapturedValue { id } => Some(id.clone()),
                SyncCursor::CapturedEmpty => None,
                SyncCursor::Cold => return Ok(session),
            };
            let mut token = session.token.as_ref().to_owned();
            let mut changes = http
                .sync_changes(&token, since_id.as_deref(), cancellation.clone())
                .await?;
            if matches!(changes, AuthenticatedOutcome::ReauthenticationRequired) {
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
                AuthenticatedOutcome::Transient => return Ok(session),
                AuthenticatedOutcome::ReauthenticationRequired => {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AuthenticationRequired,
                        "Session is missing or expired",
                    ));
                }
            };
            if changes.requires_full_refresh {
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
                    .hydrate_bootstrap_generation(account_id, http, session, cancellation.clone())
                    .await?;
                continue;
            }
            if changes.events.is_empty() {
                return Ok(session);
            }
            for event in &changes.events {
                // An Operation event names work this Device may still own. Reconciling it here
                // keeps one Sync feed and one Cursor rather than a second parallel path.
                if event.entity_type == SyncEntityType::Operation {
                    match self
                        .reconcile_resolved_operation(
                            account_id,
                            &event.entity_id,
                            http,
                            &session,
                            changes
                                .cursor
                                .as_ref()
                                .map(captured_watermark_from_response),
                        )
                        .await
                    {
                        CompletionResult::Completed => continue,
                        CompletionResult::Retry | CompletionResult::Failed => return Ok(session),
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
                let mut token = session.token.as_ref().to_owned();
                let mut fetched = http
                    .fetch_item(&token, &event.entity_id, cancellation.clone())
                    .await?;
                if matches!(fetched, AuthenticatedOutcome::ReauthenticationRequired) {
                    session = self
                        .renew_session(account_id, &session, http, cancellation.clone())
                        .await?;
                    token = session.token.as_ref().to_owned();
                    fetched = http
                        .fetch_item(&token, &event.entity_id, cancellation.clone())
                        .await?;
                }
                let item = match fetched {
                    AuthenticatedOutcome::Ok(item) => item,
                    AuthenticatedOutcome::Transient => return Ok(session),
                    AuthenticatedOutcome::ReauthenticationRequired => {
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::AuthenticationRequired,
                            "Session is missing or expired",
                        ));
                    }
                };
                let snapshot = self.require_snapshot(account_id)?;
                let expected = snapshot.bootstrap.active_cursor.clone();
                let next_cursor = changes
                    .cursor
                    .as_ref()
                    .map(captured_watermark_from_response)
                    .unwrap_or(expected.clone());
                match self
                    .replica
                    .apply_authoritative_item(
                        account_id,
                        expected,
                        next_cursor,
                        authority_item_from_dto(item)?,
                    )
                    .await
                {
                    Ok(PlanResult::Applied { .. }) => {}
                    Ok(PlanResult::Stale { .. }) | Err(_) => return Ok(session),
                    Ok(PlanResult::Missing) => {
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::AccountMissing,
                            "account is not installed",
                        ));
                    }
                }
            }
            if !changes.has_more {
                return Ok(session);
            }
        }
    }

    async fn observe_sse_hint(
        &self,
        http: &AuthHttpClient<'_>,
        token: &str,
        cancellation: RequestCancellation,
    ) -> Result<Vec<u8>, RuntimeError> {
        match http.sse_wakeup(token, cancellation).await? {
            AuthenticatedOutcome::Ok(body) => Ok(body),
            AuthenticatedOutcome::ReauthenticationRequired => Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "Session is missing or expired",
            )),
            AuthenticatedOutcome::Transient => Ok(Vec::new()),
        }
    }

    pub(super) async fn renew_session(
        &self,
        account_id: &AccountId,
        session: &CurrentSessionDocument,
        http: &AuthHttpClient<'_>,
        cancellation: RequestCancellation,
    ) -> Result<CurrentSessionDocument, RuntimeError> {
        match http
            .refresh_session(session.token.as_ref(), cancellation)
            .await?
        {
            AuthenticatedOutcome::Ok(refreshed) => {
                let expires_at_ms = parse_session_expiry_ms(&refreshed.expires_at)?;
                let renewed = CurrentSessionDocument::new(
                    session.account_id.clone(),
                    session.incarnation.clone(),
                    refreshed.token.clone(),
                    Some(refreshed.session_id.clone()),
                    expires_at_ms,
                    Some(expires_at_ms),
                    session.vault_keys.clone(),
                    session.encrypted_private_key.clone(),
                )?;
                self.platform_storage
                    .store_current_session(&renewed)
                    .await?;
                self.note_session_available(account_id);
                Ok(renewed)
            }
            AuthenticatedOutcome::ReauthenticationRequired => Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "Session is missing or expired",
            )),
            AuthenticatedOutcome::Transient => Err(sync_failure("Session refresh failed")),
        }
    }

    pub(super) fn decrypt_visible_items(&self, account_id: &AccountId) -> Result<(), RuntimeError> {
        let snapshot = self.require_snapshot(account_id)?;
        let access = self
            .account_access
            .lock()
            .expect("Account access lock poisoned")
            .get(account_id)
            .copied();
        if access != Some(AccountAccessState::Unlocked) {
            return Ok(());
        }
        let epoch = *self
            .account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .get(account_id)
            .unwrap_or(&snapshot.lock_epoch);
        if epoch != snapshot.lock_epoch {
            return Ok(());
        }
        let Some(muk) = self.copy_live_master_unlock_key(account_id, &snapshot.incarnation) else {
            return Ok(());
        };
        let Some(generation_id) = snapshot.bootstrap.active_generation.clone() else {
            return Ok(());
        };
        let mut projections = Vec::new();
        for ((item_generation, _), item) in &snapshot.bootstrap.items {
            if item_generation != &generation_id || item.deleted_at.is_some() {
                continue;
            }
            if item.category != AuthorityItemCategory::Login {
                continue;
            }
            let Some(vault) = snapshot
                .bootstrap
                .vaults
                .get(&(generation_id.clone(), item.vault_id.clone()))
            else {
                continue;
            };
            match decrypt_login_item(
                &muk,
                &snapshot.user_id,
                vault,
                &SealedLoginItem::from_authority(item),
            ) {
                Ok(projection) => projections.push(LoginItemProjection {
                    account_id: account_id.clone(),
                    item_id: item.id.clone(),
                    vault_id: item.vault_id.clone(),
                    title: projection.title,
                    url: projection.url,
                    urls: projection.urls,
                    username: projection.username,
                    password: projection.password,
                    notes: projection.notes,
                    note: projection.note,
                    custom_fields: projection.custom_fields,
                    tags: projection.tags,
                    favorite: item.favorite,
                    created_at: item.created_at.clone(),
                    updated_at: item.updated_at.clone(),
                    status: ItemProjectionStatus::Authoritative,
                }),
                Err(_) => continue,
            }
        }
        // The encrypted optimistic overlays are Items too. A create the Server has not answered
        // yet is Pending, and one it terminally rejected is Failed with its ciphertext intact.
        for overlay in &snapshot.items {
            let Some(vault) = snapshot
                .bootstrap
                .vaults
                .get(&(generation_id.clone(), overlay.vault_id.clone()))
            else {
                continue;
            };
            let status = if snapshot
                .operations
                .iter()
                .any(|operation| operation.operation_id == overlay.operation_id)
            {
                ItemProjectionStatus::Pending
            } else {
                ItemProjectionStatus::Failed
            };
            let Ok(projection) = decrypt_login_item(
                &muk,
                &snapshot.user_id,
                vault,
                &SealedLoginItem::from_overlay(overlay),
            ) else {
                continue;
            };
            // An overlay is this Device's own newer truth, so it replaces any authority row for
            // the same Item until reconciliation removes it.
            projections.retain(|existing| existing.item_id != overlay.item_id);
            projections.push(LoginItemProjection {
                account_id: account_id.clone(),
                item_id: overlay.item_id.clone(),
                vault_id: overlay.vault_id.clone(),
                title: projection.title,
                url: projection.url,
                urls: projection.urls,
                username: projection.username,
                password: projection.password,
                notes: projection.notes,
                note: projection.note,
                custom_fields: projection.custom_fields,
                tags: projection.tags,
                favorite: false,
                // The instant this Device accepted the create, kept durable with the overlay so
                // a restart cannot reshuffle a list that sorts by it.
                created_at: overlay.created_at.clone(),
                updated_at: overlay.created_at.clone(),
                status,
            });
        }
        projections.sort_by(|left, right| left.item_id.cmp(&right.item_id));
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
            return Ok(());
        }
        self.unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .insert(account_id.clone(), projections);
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        self.publish_all_unless_closed();
        Ok(())
    }

    async fn abandon_staging(&self, account_id: &AccountId) -> Result<(), RuntimeError> {
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

    fn require_snapshot(&self, account_id: &AccountId) -> Result<ReplicaSnapshot, RuntimeError> {
        self.replica.snapshot(account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
        })
    }

    pub(super) fn mark_reauthentication_required(&self, account_id: &AccountId) {
        self.waiting_reasons
            .lock()
            .expect("waiting reason lock poisoned")
            .insert(
                account_id.clone(),
                AccountWaitingReason::ReauthenticationRequired,
            );
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

fn authority_from_bootstrap_page(
    page: &BootstrapItemsResponse,
) -> Result<(Vec<AuthorityVaultRecord>, Vec<AuthorityItemRecord>), RuntimeError> {
    let mut vaults = Vec::new();
    let mut items = Vec::new();
    for item in &page.items {
        if let Some(vault) = &item.vault {
            let converted = authority_vault(vault)?;
            if vaults
                .iter()
                .all(|existing: &AuthorityVaultRecord| existing.id != converted.id)
            {
                vaults.push(converted);
            }
        }
        items.push(authority_item_from_bootstrap(item)?);
    }
    Ok((vaults, items))
}

fn authority_vault(vault: &BootstrapVaultSummary) -> Result<AuthorityVaultRecord, RuntimeError> {
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
        role: match vault.role {
            VaultRole::Owner => AuthorityVaultRole::Owner,
            VaultRole::Admin => AuthorityVaultRole::Admin,
            VaultRole::Member => AuthorityVaultRole::Member,
            VaultRole::ReadOnly => AuthorityVaultRole::ReadOnly,
        },
    })
}

fn authority_item_from_bootstrap(
    item: &BootstrapItemResponse,
) -> Result<AuthorityItemRecord, RuntimeError> {
    Ok(AuthorityItemRecord {
        id: item.id.clone(),
        vault_id: item.vault_id.clone(),
        category: item_category(item.category.clone())?,
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
        attachments: Vec::new(),
    })
}

pub(super) fn authority_item_from_dto(
    item: ItemResponseDto,
) -> Result<AuthorityItemRecord, RuntimeError> {
    Ok(AuthorityItemRecord {
        id: item.id,
        vault_id: item.vault_id,
        category: item_category(item.category)?,
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

fn item_category(category: ItemCategory) -> Result<AuthorityItemCategory, RuntimeError> {
    Ok(match category {
        ItemCategory::Login => AuthorityItemCategory::Login,
        ItemCategory::SecureNote => AuthorityItemCategory::SecureNote,
        ItemCategory::CreditCard => AuthorityItemCategory::CreditCard,
        ItemCategory::Identity => AuthorityItemCategory::Identity,
        ItemCategory::Totp => AuthorityItemCategory::Totp,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecryptedLoginPayload {
    title: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    urls: Vec<String>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    custom_fields: Vec<LoginCustomFieldPayload>,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Deserialize)]
struct LoginCustomFieldPayload {
    id: String,
    label: String,
    value: String,
    #[serde(rename = "type")]
    field_type: CustomFieldKind,
}

struct DecryptedLogin {
    title: String,
    url: Option<String>,
    urls: Vec<String>,
    username: Option<String>,
    password: Option<String>,
    notes: Option<String>,
    note: Option<String>,
    custom_fields: Vec<LoginCustomField>,
    tags: Vec<String>,
}

/// One sealed Login and the exact AAD binding it was sealed under.
///
/// Authority rows and encrypted optimistic overlays are both this, which is why one reader opens
/// both without either of them pretending to be the other.
struct SealedLoginItem<'a> {
    item_id: &'a str,
    vault_id: &'a str,
    encryption_version: i32,
    encrypted_by_user_id: &'a str,
    data: EncryptedData,
}

impl<'a> SealedLoginItem<'a> {
    fn from_authority(item: &'a AuthorityItemRecord) -> Self {
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

    fn from_overlay(overlay: &'a crate::replica::ReplicaItemRecord) -> Self {
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

fn decrypt_login_item(
    muk: &[u8; 32],
    user_id: &str,
    vault: &AuthorityVaultRecord,
    item: &SealedLoginItem<'_>,
) -> Result<DecryptedLogin, RuntimeError> {
    let wrapped: WrappedVaultKeyData = serde_json::from_str(&vault.encrypted_vault_key)
        .map_err(|_| sync_failure("wrapped Vault key is invalid"))?;
    if wrapped.context.vault_id != vault.id || wrapped.context.user_id != user_id {
        return Err(sync_failure("wrapped Vault key context does not match"));
    }
    let vault_key = decrypt_vault_key_with_muk(&vault.encrypted_vault_key, muk, &wrapped.context)
        .map_err(|_| sync_failure("Vault key could not be unwrapped"))?;
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
    let payload: DecryptedLoginPayload = serde_json::from_str(&plaintext)
        .map_err(|_| sync_failure("Item plaintext is not a Login"))?;
    Ok(DecryptedLogin {
        title: payload.title,
        url: payload.url,
        urls: payload.urls,
        username: payload.username,
        password: payload.password,
        notes: payload.notes,
        note: payload.note,
        custom_fields: payload
            .custom_fields
            .into_iter()
            .map(|field| LoginCustomField {
                id: field.id,
                label: field.label,
                value: field.value,
                field_type: field.field_type,
            })
            .collect(),
        tags: payload.tags,
    })
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
