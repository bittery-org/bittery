use super::{
    attachment_move_scheduler::{
        AttachmentMovePreparationScheduler, PreparationCandidate, SchedulerPass,
    },
    Runtime,
};
use crate::{
    attachment_artifact_store::{
        AttachmentArtifactOwner, AttachmentArtifactStore, AttachmentArtifactStoreRequest,
        AttachmentArtifactStoreResponse, ExclusiveStartupBoundary,
        ProvisionalAttachmentArtifactScope,
    },
    protocol::Incarnation,
    replica::{
        AttachmentMoveProgress, AttachmentMoveRecovery, CrossAccountMoveAttachmentProgress,
        CrossAccountMoveStage, ReplicaSnapshot,
    },
    AccountId, RuntimeError, RuntimeErrorCode,
};
use async_trait::async_trait;
use std::sync::{Arc, Mutex};

#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg(not(target_arch = "wasm32"))]
pub trait AttachmentMoveAccountLease: Send + Sync {
    fn is_live(&self) -> bool;
    async fn lost(&self);
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg(target_arch = "wasm32")]
pub trait AttachmentMoveAccountLease {
    fn is_live(&self) -> bool;
    async fn lost(&self);
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
pub trait AttachmentMoveAccountLeasePort: Send + Sync {
    async fn acquire(
        &self,
        account_id: &AccountId,
    ) -> Result<Option<Box<dyn AttachmentMoveAccountLease>>, RuntimeError>;
}

#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
pub trait AttachmentMoveAccountLeasePort {
    async fn acquire(
        &self,
        account_id: &AccountId,
    ) -> Result<Option<Box<dyn AttachmentMoveAccountLease>>, RuntimeError>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LifecyclePass {
    LeaseUnavailable,
    Swept,
    Driven(SchedulerPass),
    GenerationRetired,
}

pub(crate) struct AttachmentMoveLifecycle {
    lease_port: Arc<dyn AttachmentMoveAccountLeasePort>,
    artifacts: Arc<dyn AttachmentArtifactStore>,
    swept_generations: Mutex<Vec<(AccountId, Incarnation)>>,
}

impl AttachmentMoveLifecycle {
    pub(crate) fn new(
        lease_port: Arc<dyn AttachmentMoveAccountLeasePort>,
        artifacts: Arc<dyn AttachmentArtifactStore>,
    ) -> Self {
        Self {
            lease_port,
            artifacts,
            swept_generations: Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn has_swept(&self, account_id: &AccountId, incarnation: &Incarnation) -> bool {
        self.swept_generations
            .lock()
            .expect("Attachment Move swept-generation lock poisoned")
            .iter()
            .any(|(account, generation)| account == account_id && generation == incarnation)
    }

    pub(crate) fn require_sweep(&self, account_id: &AccountId, incarnation: &Incarnation) {
        self.swept_generations
            .lock()
            .expect("Attachment Move swept-generation lock poisoned")
            .retain(|(account, generation)| account != account_id || generation != incarnation);
    }

    pub(crate) fn artifacts(&self) -> Arc<dyn AttachmentArtifactStore> {
        Arc::clone(&self.artifacts)
    }

    pub(crate) async fn acquire(
        &self,
        account_id: &AccountId,
    ) -> Result<Option<Box<dyn AttachmentMoveAccountLease>>, RuntimeError> {
        self.lease_port.acquire(account_id).await
    }

    pub(crate) async fn run_account(
        &self,
        runtime: &Arc<Runtime>,
        scheduler: &AttachmentMovePreparationScheduler,
        selected: &ReplicaSnapshot,
        operation_id: Option<String>,
        now_ms: u64,
    ) -> Result<LifecyclePass, RuntimeError> {
        let Some(lease) = self.acquire(&selected.account_id).await? else {
            return Ok(LifecyclePass::LeaseUnavailable);
        };
        if !lease.is_live() {
            return Ok(LifecyclePass::LeaseUnavailable);
        }
        if !runtime.generation_is_preparation_eligible(selected) {
            return Ok(LifecyclePass::GenerationRetired);
        }
        let execution_lock = runtime.account_execution_lock(&selected.account_id)?;
        let _execution_guard = execution_lock.lock_owned().await;
        if !lease.is_live() || !runtime.generation_is_preparation_eligible(selected) {
            return Ok(LifecyclePass::GenerationRetired);
        }
        let current = runtime
            .replica
            .load_uncached(&selected.account_id)
            .await?
            .ok_or_else(|| {
                lifecycle_invariant("Attachment Move Account disappeared after lease")
            })?;
        if current.incarnation != selected.incarnation {
            return Ok(LifecyclePass::GenerationRetired);
        }

        // A completed no-due startup sweep prevents a local hot loop. It is not an authority
        // cache: every newly acquired lease that will drive work sweeps again, because another
        // owner may have crashed after publishing or abandoning artifacts.
        let must_sweep =
            operation_id.is_some() || !self.has_swept(&current.account_id, &current.incarnation);
        if must_sweep {
            let inventory = artifact_inventory(&current)?;
            if !lease.is_live() || !runtime.generation_is_preparation_eligible(&current) {
                return Ok(LifecyclePass::GenerationRetired);
            }
            let sweep = self
                .artifacts
                .invoke(AttachmentArtifactStoreRequest::SweepOrphans {
                    boundary: ExclusiveStartupBoundary::proven_by_runtime_startup(),
                    account_id: current.account_id.clone(),
                    live: inventory.live,
                    pending: inventory.pending,
                });
            tokio::pin!(sweep);
            let response = tokio::select! {
                biased;
                () = lease.lost() => return Ok(LifecyclePass::GenerationRetired),
                result = &mut sweep => result?,
            };
            if !matches!(
                response,
                AttachmentArtifactStoreResponse::OrphansSwept { .. }
            ) {
                return Err(lifecycle_invariant(
                    "Attachment artifact store violated the sweep contract",
                ));
            }
            if !lease.is_live() || !runtime.generation_is_preparation_eligible(&current) {
                return Ok(LifecyclePass::GenerationRetired);
            }
            if !self.has_swept(&current.account_id, &current.incarnation) {
                self.swept_generations
                    .lock()
                    .expect("Attachment Move swept-generation lock poisoned")
                    .push((current.account_id.clone(), current.incarnation.clone()));
            }
        }

        let Some(operation_id) = operation_id else {
            return Ok(LifecyclePass::Swept);
        };
        if !lease.is_live() || !runtime.generation_is_preparation_eligible(&current) {
            return Ok(LifecyclePass::GenerationRetired);
        }
        let preparation = current
            .attachment_move_preparations
            .iter()
            .find(|preparation| preparation.operation_id == operation_id)
            .or_else(|| {
                current
                    .operations
                    .iter()
                    .find(|operation| operation.operation_id == operation_id)
                    .and_then(|operation| operation.attachment_move_recovery.as_ref())
                    .map(|recovery| match recovery {
                        AttachmentMoveRecovery::Prepared { preparation }
                        | AttachmentMoveRecovery::RejectStaleAuthority { preparation } => {
                            preparation.as_ref()
                        }
                    })
            })
            .ok_or_else(|| lifecycle_invariant("selected Attachment Move has no durable scope"))?;
        let cancellation = crate::RequestCancellation::new();
        let Ok(_plaintext_lifetime) = runtime.foreground_attachments.register_target(
            &current.account_id,
            &current.incarnation,
            super::foreground_attachment_lifecycle::ForegroundAttachmentTarget::Move {
                source_vault_id: preparation.source_vault_id.clone(),
                destination_vault_id: preparation.target_vault_id.clone(),
                item_id: preparation.item_id.clone(),
            },
            cancellation.clone(),
        ) else {
            return Ok(LifecyclePass::GenerationRetired);
        };
        let mut unlocked = std::collections::HashSet::new();
        unlocked.insert(current.account_id.clone());
        let drive = scheduler.drive_eligible(
            vec![PreparationCandidate {
                account_id: current.account_id,
                operation_id,
                not_before_ms: now_ms,
            }],
            &unlocked,
            now_ms,
        );
        tokio::pin!(drive);
        tokio::select! {
            biased;
            () = cancellation.cancelled() => Ok(LifecyclePass::GenerationRetired),
            () = lease.lost() => Ok(LifecyclePass::GenerationRetired),
            result = &mut drive => Ok(LifecyclePass::Driven(result?)),
        }
    }
}

pub(crate) struct ArtifactInventory {
    pub(crate) live: Vec<AttachmentArtifactOwner>,
    pub(crate) pending: Vec<ProvisionalAttachmentArtifactScope>,
}

#[cfg(test)]
pub(crate) fn live_artifact_owners(
    snapshot: &ReplicaSnapshot,
) -> Result<Vec<AttachmentArtifactOwner>, RuntimeError> {
    Ok(artifact_inventory(snapshot)?.live)
}

pub(crate) fn artifact_inventory(
    snapshot: &ReplicaSnapshot,
) -> Result<ArtifactInventory, RuntimeError> {
    let preparations =
        snapshot
            .attachment_move_preparations
            .iter()
            .chain(snapshot.operations.iter().filter_map(|operation| {
                operation
                    .attachment_move_recovery
                    .as_ref()
                    .map(|recovery| match recovery {
                        AttachmentMoveRecovery::Prepared { preparation }
                        | AttachmentMoveRecovery::RejectStaleAuthority { preparation } => {
                            preparation.as_ref()
                        }
                    })
            }));
    let mut live = Vec::new();
    let mut pending = Vec::new();
    for preparation in preparations {
        if preparation.account_id != snapshot.account_id {
            return Err(lifecycle_invariant(
                "Attachment Move recovery crossed its Account scope",
            ));
        }
        for progress in &preparation.progress {
            match progress {
                AttachmentMoveProgress::Pending { attachment_id, .. } => {
                    pending.push(ProvisionalAttachmentArtifactScope::new(
                        snapshot.account_id.clone(),
                        preparation.operation_id.clone(),
                        attachment_id.clone(),
                    )?);
                }
                AttachmentMoveProgress::Encrypted {
                    attachment_id,
                    artifact,
                    ..
                } => {
                    live.push(AttachmentArtifactOwner::new(
                        snapshot.account_id.clone(),
                        preparation.operation_id.clone(),
                        attachment_id.clone(),
                        artifact.clone(),
                    )?);
                }
            }
        }
    }
    for record in snapshot
        .cross_account_moves
        .iter()
        .filter_map(|record| record.captured())
        .filter(|record| record.stage != CrossAccountMoveStage::Completed)
    {
        for checkpoint in &record.attachments {
            match &checkpoint.progress {
                CrossAccountMoveAttachmentProgress::Pending => {
                    pending.push(ProvisionalAttachmentArtifactScope::new(
                        snapshot.account_id.clone(),
                        record.operation_id.clone(),
                        checkpoint.target_attachment_id.clone(),
                    )?);
                }
                CrossAccountMoveAttachmentProgress::Encrypted { artifact, .. } => {
                    live.push(AttachmentArtifactOwner::new(
                        snapshot.account_id.clone(),
                        record.operation_id.clone(),
                        checkpoint.target_attachment_id.clone(),
                        artifact.clone(),
                    )?);
                }
            }
        }
    }
    live.sort_by(|left, right| {
        left.operation_id()
            .cmp(right.operation_id())
            .then_with(|| left.attachment_id().cmp(right.attachment_id()))
    });
    live.dedup();
    pending.sort_by(|left, right| {
        left.operation_id()
            .cmp(right.operation_id())
            .then_with(|| left.attachment_id().cmp(right.attachment_id()))
    });
    pending.dedup();
    Ok(ArtifactInventory { live, pending })
}

fn lifecycle_invariant(message: &str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

#[cfg(test)]
pub(crate) struct TestAccountLeasePort;

#[cfg(test)]
struct TestAccountLease;

#[cfg(test)]
#[async_trait]
impl AttachmentMoveAccountLease for TestAccountLease {
    fn is_live(&self) -> bool {
        true
    }

    async fn lost(&self) {
        std::future::pending().await
    }
}

#[cfg(test)]
#[async_trait]
impl AttachmentMoveAccountLeasePort for TestAccountLeasePort {
    async fn acquire(
        &self,
        _account_id: &AccountId,
    ) -> Result<Option<Box<dyn AttachmentMoveAccountLease>>, RuntimeError> {
        Ok(Some(Box::new(TestAccountLease)))
    }
}

#[cfg(test)]
pub(crate) struct TestArtifactStore;

#[cfg(test)]
#[async_trait]
impl AttachmentArtifactStore for TestArtifactStore {
    async fn invoke(
        &self,
        request: AttachmentArtifactStoreRequest,
    ) -> Result<AttachmentArtifactStoreResponse, RuntimeError> {
        match request {
            AttachmentArtifactStoreRequest::SweepOrphans { .. } => {
                Ok(AttachmentArtifactStoreResponse::OrphansSwept { deleted: 0 })
            }
            _ => Err(lifecycle_invariant(
                "test startup artifact store received a non-sweep request",
            )),
        }
    }
}
