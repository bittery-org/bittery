use super::*;
use foreground_attachment_lifecycle::{VaultForegroundRetirement, VaultRetirementProof};

/// A first fence is irreversible even when filtering its retained projection reports an error.
/// Keep its existing handoff available until the caller has released every publication guard.
pub(super) struct VaultRetirementPublication {
    pub(super) retirement: VaultForegroundRetirement,
    pub(super) token: Option<Arc<DeliveryToken>>,
    pub(super) projection_error: Option<RuntimeError>,
}

impl Runtime {
    /// Publish the selective fence before any fallible persistence or host cleanup. The caller
    /// advances native authority and drains the returned old delivery token outside publication.
    pub(super) fn begin_vault_retirement_publication(
        &self,
        snapshot: &ReplicaSnapshot,
        vault_ids: &[String],
        proof: VaultRetirementProof,
    ) -> Result<(VaultForegroundRetirement, Option<Arc<DeliveryToken>>), RuntimeError> {
        let publication = self.publication.lock().expect("publication lock poisoned");
        let result =
            self.begin_vault_retirement_under_publication(&publication, snapshot, vault_ids, proof);
        drop(publication);
        let publication = result?;
        publication.retirement.notify_retirement();
        if let Some(error) = publication.projection_error {
            self.wake_dispatch();
            if let Some(token) = &publication.token {
                token.wait_for_other_threads();
            }
            return Err(error);
        }
        Ok((publication.retirement, publication.token))
    }

    /// The native caller acquires its state before this publication guard, then emits the returned
    /// retirement notification only after both guards are released.
    pub(super) fn begin_vault_retirement_under_publication(
        &self,
        _publication: &std::sync::MutexGuard<'_, ()>,
        snapshot: &ReplicaSnapshot,
        vault_ids: &[String],
        proof: VaultRetirementProof,
    ) -> Result<VaultRetirementPublication, RuntimeError> {
        self.ensure_not_closed()?;
        let current = self
            .replica
            .snapshot(&snapshot.account_id)
            .ok_or_else(vault_fenced)?;
        if current.incarnation != snapshot.incarnation
            || current.revision != snapshot.revision
            || current.lock_epoch != snapshot.lock_epoch
        {
            return Err(vault_fenced());
        }
        let retirement = self.foreground_attachments.begin_vault_retirement(
            &snapshot.account_id,
            &snapshot.incarnation,
            vault_ids,
            proof,
        )?;
        let token = self.invalidate_delivery(&snapshot.account_id);
        let projection_error = if let Some(items) = self
            .unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .get_mut(&snapshot.account_id)
        {
            self.filter_vault_item_projections(snapshot, items).err()
        } else {
            None
        };
        Ok(VaultRetirementPublication {
            retirement,
            token,
            projection_error,
        })
    }

    pub(super) fn require_vault_accepting_work(
        &self,
        snapshot: &ReplicaSnapshot,
        vault_id: &str,
    ) -> Result<(), RuntimeError> {
        if self.travel_policy_verification_pending(snapshot) {
            return Err(super::travel_policy::pending_policy());
        }
        snapshot.require_vault_accepting_work(vault_id)?;
        if self.vault_is_fenced(snapshot, vault_id) {
            return Err(vault_fenced());
        }
        Ok(())
    }

    pub(super) fn vault_is_fenced(&self, snapshot: &ReplicaSnapshot, vault_id: &str) -> bool {
        snapshot
            .rotation_attempts
            .iter()
            .any(|attempt| attempt.fences_vault(vault_id))
            || snapshot
                .bootstrap
                .pending_vault_retirements
                .iter()
                .any(|id| id == vault_id)
            || self.foreground_attachments.is_vault_fenced(
                &snapshot.account_id,
                &snapshot.incarnation,
                vault_id,
            )
    }

    pub(super) fn filter_vault_item_projections(
        &self,
        snapshot: &ReplicaSnapshot,
        projections: &mut Vec<ItemProjection>,
    ) -> Result<(), RuntimeError> {
        let mut ids = self
            .foreground_attachments
            .fenced_vault_ids(&snapshot.account_id, &snapshot.incarnation);
        ids.extend(snapshot.bootstrap.pending_vault_retirements.iter().cloned());
        ids.extend(snapshot.rotation_fenced_vault_ids());
        ids.sort();
        ids.dedup();
        if ids.is_empty() {
            return Ok(());
        }
        let mut affected = HashSet::new();
        for operation in &snapshot.operations {
            if operation.touches_vaults(&ids)? {
                affected.insert(operation.operation_id.as_str());
            }
        }
        for preparation in &snapshot.attachment_move_preparations {
            if ids.contains(&preparation.source_vault_id)
                || ids.contains(&preparation.target_vault_id)
            {
                affected.insert(preparation.operation_id.as_str());
            }
        }
        projections.retain(|item| {
            !ids.contains(&item.vault_id)
                && (item.status == crate::ItemProjectionStatus::Authoritative
                    || !snapshot.items.iter().any(|overlay| {
                        overlay.item_id == item.item_id
                            && affected.contains(overlay.operation_id.as_str())
                    }))
        });
        Ok(())
    }
}

fn vault_fenced() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::Cancelled,
        "Vault authority is being retired",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Sink(Mutex<Vec<RuntimeProjection>>);
    impl ObservationSink for Sink {
        fn publish(&self, projection: RuntimeProjection) {
            self.0.lock().unwrap().push(projection);
        }
    }
    #[test]
    fn filtered_delivery_with_unchanged_revision_is_not_suppressed_after_retirement() {
        let sink = Arc::new(Sink::default());
        let subscription =
            Subscription::new(ObservationRequest::WritableVaultCatalog, sink.clone(), 0);
        let old = Arc::new(DeliveryToken::new());
        let project = |token| ProjectedDelivery {
            dependency_revision: None,
            projection: RuntimeProjection::WritableVaultCatalog(WritableVaultCatalogProjection {
                revision: 7,
                vaults: vec![],
            }),
            generation: None,
            tokens: vec![token],
        };
        subscription.publish(project(old.clone()));
        old.invalidate();
        subscription.publish(project(Arc::new(DeliveryToken::new())));
        assert_eq!(
            sink.0.lock().unwrap().len(),
            2,
            "the filtered replacement must publish even before the physical revision changes"
        );
    }
    #[test]
    fn catalog_delivery_requires_every_captured_account_token() {
        let sink = Arc::new(Sink::default());
        let subscription =
            Subscription::new(ObservationRequest::WritableVaultCatalog, sink.clone(), 0);
        let first = Arc::new(DeliveryToken::new());
        let second = Arc::new(DeliveryToken::new());
        second.invalidate();
        subscription.publish(ProjectedDelivery {
            dependency_revision: None,
            projection: RuntimeProjection::WritableVaultCatalog(WritableVaultCatalogProjection {
                revision: 7,
                vaults: vec![],
            }),
            generation: None,
            tokens: vec![first.clone(), second],
        });
        assert!(sink.0.lock().unwrap().is_empty());
        assert!(
            first.state.lock().unwrap().active.is_empty(),
            "partially admitted leases must drain on another Account's refusal"
        );
    }

    #[tokio::test]
    async fn hidden_source_move_overlay_is_filtered_but_new_visible_authority_is_not() {
        let harness = operation_fixtures::seeded_with_existing_item(true, false).await;
        harness
            .accept_existing(RuntimeRequest::MoveItem {
                account_id: harness.account_id.clone(),
                item_id: "item-existing".into(),
                target_vault_id: "vault-2".into(),
                target_account_id: None,
            })
            .await;
        harness
            .runtime
            .decrypt_visible_items(&harness.account_id)
            .unwrap();
        let snapshot = harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap();
        let mut items = harness
            .runtime
            .unlocked_items
            .lock()
            .unwrap()
            .get(&harness.account_id)
            .unwrap()
            .clone();
        assert_eq!(items.len(), 1);
        assert!(items[0].status == crate::ItemProjectionStatus::Pending);
        assert_eq!(items[0].vault_id, "vault-2");
        let current = items[0].clone();
        let (_retirement, _token) = harness
            .runtime
            .begin_vault_retirement_publication(
                &snapshot,
                &[crate::test_fixtures::TEST_VAULT_ID.into()],
                VaultRetirementProof::DurableJournal {
                    revision: snapshot.revision,
                },
            )
            .unwrap();
        harness
            .runtime
            .filter_vault_item_projections(&snapshot, &mut items)
            .unwrap();
        assert!(
            items.is_empty(),
            "the exact accepted Move source is hidden even when its optimistic destination is visible"
        );
        let mut current = vec![ItemProjection {
            status: crate::ItemProjectionStatus::Authoritative,
            ..current
        }];
        harness
            .runtime
            .filter_vault_item_projections(&snapshot, &mut current)
            .unwrap();
        assert_eq!(
            current.len(),
            1,
            "an old Move cannot erase later current authority for the same Item in another visible Vault"
        );
        let RuntimeProjection::Items(projected) = harness
            .runtime
            .projection(&ObservationRequest::Items {
                account_id: harness.account_id.clone(),
            })
            .unwrap()
            .projection
        else {
            panic!("Items projection");
        };
        assert!(projected.items.is_empty());
        assert_eq!(projected.vaults.len(), 1);
        assert_eq!(projected.vaults[0].vault_id, "vault-2");
        assert_eq!(
            harness
                .runtime
                .replica
                .snapshot(&harness.account_id)
                .unwrap(),
            snapshot,
            "the synchronous visibility fence must not mutate durable accepted work"
        );
    }

    #[tokio::test]
    async fn decryption_started_before_retirement_cannot_restore_hidden_plaintext() {
        let harness = operation_fixtures::seeded_with_existing_item(true, false).await;
        let runtime = Arc::downgrade(&harness.runtime);
        let account = harness.account_id.clone();
        harness
            .runtime
            .set_before_plaintext_commit_hook(Some(Arc::new(move || {
                let runtime = runtime.upgrade().unwrap();
                let snapshot = runtime.replica.snapshot(&account).unwrap();
                runtime
                    .begin_vault_retirement_publication(
                        &snapshot,
                        &[crate::test_fixtures::TEST_VAULT_ID.into()],
                        VaultRetirementProof::DurableJournal {
                            revision: snapshot.revision,
                        },
                    )
                    .unwrap();
            })));
        harness
            .runtime
            .decrypt_visible_items(&harness.account_id)
            .unwrap();
        harness.runtime.set_before_plaintext_commit_hook(None);
        assert!(harness
            .runtime
            .unlocked_items
            .lock()
            .unwrap()
            .get(&harness.account_id)
            .unwrap()
            .is_empty());
        assert_eq!(
            harness
                .runtime
                .replica
                .snapshot(&harness.account_id)
                .unwrap()
                .bootstrap
                .snapshot()
                .visible_items
                .len(),
            1,
            "the projection fence precedes physical authority removal"
        );
    }

    #[tokio::test]
    async fn transient_retirement_refuses_new_work_without_waiting_for_the_journal() {
        use operation_fixtures::*;
        let harness = seeded_with_existing_item(true, false).await;
        let account_id = harness.account_id.clone();
        let vault_id = crate::test_fixtures::TEST_VAULT_ID.to_owned();
        let before = harness.runtime.replica.snapshot(&account_id).unwrap();
        harness
            .runtime
            .begin_vault_retirement_publication(
                &before,
                std::slice::from_ref(&vault_id),
                VaultRetirementProof::DurableJournal {
                    revision: before.revision,
                },
            )
            .unwrap();
        for request in [
            RuntimeRequest::CreateItem {
                account_id: account_id.clone(),
                vault_id: vault_id.clone(),
                draft: draft(),
            },
            RuntimeRequest::ImportItems {
                account_id: account_id.clone(),
                vault_id: vault_id.clone(),
                items: vec![],
            },
            RuntimeRequest::UpdateVault {
                account_id: account_id.clone(),
                vault_id: vault_id.clone(),
                name: Some("rename".into()),
                icon: crate::VaultIconPatch::Unchanged,
                image: crate::VaultImageChange::Unchanged,
            },
            RuntimeRequest::DeleteVault {
                account_id: account_id.clone(),
                vault_id,
            },
            RuntimeRequest::TrashItem {
                account_id: account_id.clone(),
                item_id: "item-existing".into(),
            },
            RuntimeRequest::MoveItem {
                account_id: account_id.clone(),
                item_id: "item-existing".into(),
                target_vault_id: "vault-2".into(),
                target_account_id: None,
            },
            RuntimeRequest::CreateShare {
                account_id: account_id.clone(),
                item_id: "item-existing".into(),
                draft: crate::CreateShareDraft {
                    access_mode: crate::ShareAccessMode::Anyone,
                    expires_in: crate::ShareExpiration::SevenDays,
                    is_one_time_use: false,
                    allowed_emails: vec![],
                },
            },
        ] {
            let error = harness
                .runtime
                .request(request, RequestCancellation::new())
                .await
                .unwrap_err();
            assert_eq!(error.code, RuntimeErrorCode::Cancelled);
        }
        assert_eq!(
            harness.runtime.replica.snapshot(&account_id).unwrap(),
            before
        );
        assert!(harness.server.requests.lock().unwrap().is_empty());
    }
}
