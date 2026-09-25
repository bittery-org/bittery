//! One physical Account installation transaction for independent and borrowed authentication.
//! Callers retain catalog and Account execution admission and own final access publication.
use super::*;
use crate::platform_storage::{
    AccountMetadataDocument, CurrentSessionDocument, QuickUnlockDocument,
};

pub(super) struct InstallationDocuments<'a> {
    pub metadata: &'a AccountMetadataDocument,
    pub quick_unlock: Option<&'a QuickUnlockDocument>,
    pub current_session: Option<&'a CurrentSessionDocument>,
}

pub(super) enum InstallationCommitFailure {
    BeforeReplica(RuntimeError),
    AfterReplica {
        error: RuntimeError,
        snapshot: Option<Box<ReplicaSnapshot>>,
    },
}

impl Runtime {
    pub(super) async fn persist_account_installation(
        &self,
        original_catalog: Option<&DeviceCatalogDocument>,
        previous_snapshot: Option<&ReplicaSnapshot>,
        documents: InstallationDocuments<'_>,
    ) -> Result<ReplicaSnapshot, InstallationCommitFailure> {
        let metadata = documents.metadata;
        let account_id = &metadata.account_id;
        let incarnation = &metadata.incarnation;
        if documents.quick_unlock.is_some() != documents.current_session.is_some() {
            return Err(InstallationCommitFailure::BeforeReplica(startup_invariant(
                "Independent installation credentials must be prepared together",
            )));
        }
        if documents.quick_unlock.is_some_and(|quick| {
            quick.account_id != *account_id || quick.incarnation != *incarnation
        }) || documents.current_session.is_some_and(|session| {
            session.account_id != *account_id
                || session.incarnation != *incarnation
                || !matches!(
                    session.provenance,
                    crate::platform_storage::SessionProvenance::Independent
                )
        }) {
            return Err(InstallationCommitFailure::BeforeReplica(startup_invariant(
                "Installation documents must share one independent Account generation",
            )));
        }
        let catalog = original_catalog.cloned().unwrap_or(
            DeviceCatalogDocument::new(Vec::new())
                .map_err(InstallationCommitFailure::BeforeReplica)?,
        );
        let staged_catalog = stage_catalog_install(
            &catalog,
            account_id.clone(),
            incarnation.clone(),
            previous_snapshot.map(|snapshot| snapshot.incarnation.clone()),
        )
        .map_err(InstallationCommitFailure::BeforeReplica)?;
        let staged = async {
            self.ensure_not_closed()?;
            self.platform_storage
                .store_device_catalog(&staged_catalog)
                .await?;
            self.ensure_not_closed()?;
            self.platform_storage
                .store_account_metadata(metadata)
                .await?;
            self.ensure_not_closed()?;
            if let Some(quick_unlock) = documents.quick_unlock {
                self.platform_storage
                    .store_quick_unlock(quick_unlock)
                    .await?;
                self.ensure_not_closed()?;
            }
            Ok::<(), RuntimeError>(())
        }
        .await;
        if let Err(error) = staged {
            self.rollback_pre_replica_install(original_catalog, account_id, incarnation)
                .await;
            return Err(InstallationCommitFailure::BeforeReplica(error));
        }

        let installed = match self
            .replica
            .install_or_replace(
                account_id.clone(),
                metadata.user_id.clone(),
                incarnation.clone(),
            )
            .await
        {
            Ok(snapshot) => snapshot,
            Err(error) => match self.replica.load_uncached(account_id).await {
                Ok(durable)
                    if durable_installation_is_unchanged(durable.as_ref(), previous_snapshot) =>
                {
                    self.rollback_pre_replica_install(original_catalog, account_id, incarnation)
                        .await;
                    return Err(InstallationCommitFailure::BeforeReplica(error));
                }
                Ok(Some(snapshot))
                    if snapshot.incarnation == *incarnation
                        && snapshot.user_id == metadata.user_id =>
                {
                    return Err(InstallationCommitFailure::AfterReplica {
                        error,
                        snapshot: Some(Box::new(snapshot)),
                    });
                }
                Ok(Some(snapshot)) => {
                    return Err(InstallationCommitFailure::AfterReplica {
                        error: startup_invariant(
                            "Replica changed to an unexpected generation during installation",
                        ),
                        snapshot: Some(Box::new(snapshot)),
                    });
                }
                Ok(None) | Err(_) => {
                    return Err(InstallationCommitFailure::AfterReplica {
                        error: startup_invariant(
                            "Replica installation outcome could not be established",
                        ),
                        snapshot: None,
                    });
                }
            },
        };
        let promoted = async {
            self.ensure_not_closed()?;
            let promoted = promote_catalog_install(&staged_catalog, account_id, incarnation)?;
            self.platform_storage
                .store_device_catalog(&promoted)
                .await?;
            self.ensure_not_closed()?;
            if let Some(session) = documents.current_session {
                self.platform_storage.store_current_session(session).await?;
            }
            Ok::<(), RuntimeError>(())
        }
        .await;
        promoted.map_err(|error| InstallationCommitFailure::AfterReplica {
            error,
            snapshot: Some(Box::new(installed.clone())),
        })?;
        Ok(installed)
    }
}
