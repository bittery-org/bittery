use super::*;
use crate::attachment_artifact_store::{
    AttachmentArtifactStoreRequest, AttachmentArtifactStoreResponse,
};
use crate::replica::AttachmentMoveRecovery;

impl Runtime {
    /// The lifecycle owner invokes this after the selected loans drain, holding Account execution.
    pub(super) async fn sweep_retired_move_artifacts(
        &self,
        snapshot: &ReplicaSnapshot,
        vault_ids: &[String],
    ) -> Result<(), RuntimeError> {
        let require_current = || {
            self.ensure_not_closed()?;
            if !self
                .replica
                .snapshot(&snapshot.account_id)
                .is_some_and(|current| {
                    current.incarnation == snapshot.incarnation
                        && current.revision == snapshot.revision
                        && current.lock_epoch == snapshot.lock_epoch
                })
            {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::Cancelled,
                    "Artifact retirement scope changed",
                ));
            }
            Ok(())
        };
        require_current()?;
        let mut operation_ids = Vec::new();
        for operation in &snapshot.operations {
            if operation.kind == OperationKind::MoveItem && operation.touches_vaults(vault_ids)? {
                operation_ids.push(operation.operation_id.clone());
            }
        }
        operation_ids.extend(
            snapshot
                .receipts
                .iter()
                .filter(|receipt| {
                    receipt.kind == OperationKind::MoveItem
                        && vault_ids.iter().any(|id| id == receipt.vault_id())
                })
                .map(|receipt| receipt.operation_id.clone()),
        );
        let preparations = snapshot.attachment_move_preparations.iter().chain(
            snapshot
                .operations
                .iter()
                .filter_map(|operation| operation.attachment_move_recovery.as_ref())
                .map(|recovery| match recovery {
                    AttachmentMoveRecovery::Prepared { preparation }
                    | AttachmentMoveRecovery::RejectStaleAuthority { preparation } => {
                        preparation.as_ref()
                    }
                }),
        );
        for preparation in preparations {
            if !vault_ids.contains(&preparation.source_vault_id)
                && !vault_ids.contains(&preparation.target_vault_id)
            {
                continue;
            }
            operation_ids.push(preparation.operation_id.clone());
        }
        // The destination Vault belongs to another Account. Only source Vault identity can
        // select this Account's workflow, even when both Servers happen to use the same ID.
        operation_ids.extend(
            snapshot
                .cross_account_moves
                .iter()
                .filter_map(|record| record.captured())
                .filter(|record| {
                    !record.attachments.is_empty() && vault_ids.contains(&record.source.vault_id)
                })
                .map(|record| record.operation_id.clone()),
        );
        operation_ids.sort();
        operation_ids.dedup();
        if operation_ids.is_empty() {
            return Ok(());
        }
        let inventory = attachment_move_lifecycle::artifact_inventory(snapshot)?;
        let live = inventory
            .live
            .into_iter()
            .filter(|owner| operation_ids.iter().any(|id| id == owner.operation_id()))
            .collect();
        let pending = inventory
            .pending
            .into_iter()
            .filter(|scope| operation_ids.iter().any(|id| id == scope.operation_id()))
            .collect();
        let lifecycle = self
            .attachment_move_lifecycle
            .lock()
            .expect("Attachment Move lifecycle lock poisoned")
            .clone();
        let lifecycle = lifecycle.ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::StorageUnavailable,
                "Selected artifact retirement requires its storage capability",
            )
        })?;
        match lifecycle
            .artifacts()
            .invoke(AttachmentArtifactStoreRequest::SweepOperationOrphans {
                account_id: snapshot.account_id.clone(),
                operation_ids,
                live,
                pending,
            })
            .await?
        {
            AttachmentArtifactStoreResponse::OrphansSwept { .. } => require_current(),
            _ => Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Artifact store refused scoped retirement cleanup",
            )),
        }
    }
}
