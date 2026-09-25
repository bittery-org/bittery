//! One accepted semantic Move remains exact through the shared serialized persistence seam.
use super::*;
use crate::replica::{
    create_item_fingerprint, item_operation_fingerprint, CrossAccountMoveBindingStatus,
    CrossAccountMoveChild, CrossAccountMoveDestinationBinding, CrossAccountMoveDisposition,
    CrossAccountMoveEndpoint, CrossAccountMoveIdentity, CrossAccountMoveItemOperation,
    CrossAccountMoveRecord, CrossAccountMoveSourceAuthority, CrossAccountMoveStage,
    CrossAccountMoveStep,
};
const SOURCE: &str = "account-cross-source";
const DESTINATION: &str = "account-cross-destination";
const ADMITTED: &str = "accept semantic Move and unchanged source overlay atomically";
const TARGET_PROVED: &str = "retain exact target proof before preparing source destruction";

#[path = "cross_account_move_attachment_history.rs"]
pub(super) mod attachment_history;

fn accepted_record() -> CrossAccountMoveRecord {
    let source = authority_item(SOURCE, "cross-source-item", 1);
    let mut target = authority_item(DESTINATION, "cross-target-item", 1);
    target.vault_id = "foreign-target-vault".into();
    let body = serde_json::to_vec(&crate::server_contract::CreateItemBody {
        category: crate::server_contract::ItemCategory::Login,
        encrypted_data: target.encrypted_data.clone(),
        encryption_iv: target.encryption_iv.clone(),
        encryption_algorithm: target.encryption_algorithm.clone(),
    })
    .unwrap();
    let child = CrossAccountMoveChild::ItemOperation(CrossAccountMoveItemOperation {
        step: CrossAccountMoveStep::TargetCreate,
        endpoint: CrossAccountMoveEndpoint::Destination,
        operation_id: "cross-target-create".into(),
        kind: OperationKind::CreateItem,
        target: ResourceRef::Item {
            item_id: target.id.clone(),
            vault_id: target.vault_id.clone(),
        },
        request_fingerprint: create_item_fingerprint(&target.vault_id, &target.id, &body),
        request: ImmutableHttpRequest {
            method: HttpMethod::Put,
            path: format!("/api/v1/vaults/{}/items/{}", target.vault_id, target.id),
            headers: vec![HttpHeader {
                name: "Content-Type".into(),
                value: "application/json".into(),
            }],
            body,
        },
        result: None,
    });
    CrossAccountMoveRecord {
        operation_id: "semantic-cross-move".into(),
        source_identity: CrossAccountMoveIdentity {
            server_url: "https://source.example".into(),
            user_id: format!("user-{SOURCE}"),
        },
        destination_identity: CrossAccountMoveIdentity {
            server_url: "https://destination.example".into(),
            user_id: format!("user-{DESTINATION}"),
        },
        source,
        target,
        destination_binding: CrossAccountMoveDestinationBinding {
            account_id: DESTINATION.into(),
            incarnation: incarnation(DESTINATION, "first"),
            binding_revision: 0,
            status: CrossAccountMoveBindingStatus::Active,
        },
        children: vec![child],
        attachments: Vec::new(),
        stage: CrossAccountMoveStage::TargetCreate,
        disposition: CrossAccountMoveDisposition::Ready,
        scheduling: OperationSchedulingState::default(),
        legacy_admission: None,
    }
}
fn source_overlay(record: &CrossAccountMoveRecord) -> ReplicaItemRecord {
    let item = &record.source;
    ReplicaItemRecord {
        account_id: SOURCE.into(),
        operation_id: record.operation_id.clone(),
        item_id: item.id.clone(),
        vault_id: item.vault_id.clone(),
        category: item.category.clone(),
        encrypted_data: item.encrypted_data.clone(),
        encryption_iv: item.encryption_iv.clone(),
        encryption_algorithm: item.encryption_algorithm.clone(),
        encryption_version: item.encryption_version,
        encrypted_by_user_id: item.encrypted_by_user_id.clone(),
        favorite: item.favorite,
        version: item.version,
        created_at: item.created_at.clone(),
        updated_at: item.updated_at.clone(),
        deleted_at: None,
        attachments: item.attachments.clone(),
        permanently_deleted: false,
    }
}
fn source_child(delete: bool) -> CrossAccountMoveChild {
    let (step, kind, route, path, version, operation_id) = if delete {
        (
            CrossAccountMoveStep::SourceDelete,
            OperationKind::PermanentlyDeleteItem,
            "DELETE /api/v1/items/{itemId}/permanent",
            "/api/v1/items/cross-source-item/permanent",
            2,
            "cross-source-delete",
        )
    } else {
        (
            CrossAccountMoveStep::SourceTrash,
            OperationKind::TrashItem,
            "DELETE /api/v1/items/{itemId}",
            "/api/v1/items/cross-source-item",
            1,
            "cross-source-trash",
        )
    };
    CrossAccountMoveChild::ItemOperation(CrossAccountMoveItemOperation {
        step,
        kind,
        endpoint: CrossAccountMoveEndpoint::Source,
        operation_id: operation_id.into(),
        target: ResourceRef::Item {
            item_id: "cross-source-item".into(),
            vault_id: "vault-1".into(),
        },
        request_fingerprint: item_operation_fingerprint(
            kind,
            route,
            "cross-source-item",
            &[],
            version,
        ),
        request: ImmutableHttpRequest {
            method: HttpMethod::Delete,
            path: path.into(),
            body: Vec::new(),
            headers: vec![HttpHeader {
                name: "If-Match".into(),
                value: format!("\"{version}\""),
            }],
        },
        result: None,
    })
}
fn applied(child: &mut CrossAccountMoveChild, version: i32) {
    let child = child.item_mut().unwrap();
    child.result = Some(ObservedOutcome {
        operation_id: child.operation_id.clone(),
        request_fingerprint: child.request_fingerprint,
        result: OperationOutcomeResult::Applied {
            entity_id: child.target.item_id().unwrap().into(),
            version,
        },
    });
}
fn plan(snapshot: &ReplicaSnapshot, mutation: PlanMutation) -> GuardedCommitPlan {
    GuardedCommitPlan::new(
        snapshot.account_id.clone(),
        snapshot.incarnation.clone(),
        snapshot.revision,
        snapshot.lock_epoch,
        vec![mutation],
    )
}
fn advance(
    record: CrossAccountMoveRecord,
    authority: CrossAccountMoveSourceAuthority,
) -> PlanMutation {
    PlanMutation::AdvanceCrossAccountMove {
        operation_id: record.operation_id.clone(),
        expected_binding_revision: record.destination_binding.binding_revision,
        next: Box::new(record),
        source_authority: authority,
    }
}
fn commit(
    history: &mut HistoryBuilder,
    label: &str,
    mutation: PlanMutation,
) -> Result<ReplicaPersistenceRequest, RuntimeError> {
    history.commit_plan(label, plan(history.snapshot(SOURCE).unwrap(), mutation))
}

pub(super) fn history() -> Result<History, RuntimeError> {
    let mut history = HistoryBuilder::new(
        "cross-account-move-no-files-retained-child-evidence",
        &[
            "semantic Move has its own row; real child requests never appear as ordinary Operations",
            "lost commit replay and reopen preserve exact immutable target bytes",
            "source overlay persists through Trash; only proven completion removes current source authority",
            "completed semantic evidence reserves identity without claiming a later Item mutation",
        ],
        &[SOURCE, DESTINATION],
    );
    history.install("install source Account", SOURCE, "first")?;
    history.install("install destination Account", DESTINATION, "first")?;
    history.begin_bootstrap(
        "begin current source authority",
        BeginBootstrapPlan {
            guard: guard(SOURCE, 0, 0),
            generation_id: BootstrapGenerationId("generation-1".into()),
        },
    )?;
    for cursor in [
        BootstrapPageCursor::VaultsInitial,
        BootstrapPageCursor::ItemsInitial,
    ] {
        history.stage_bootstrap(
            "stage current source authority",
            stage_page(
                SOURCE,
                1,
                0,
                cursor,
                SyncCursor::CapturedEmpty,
                BootstrapContinuation::Final,
                "cross-source-item",
            ),
        )?;
    }
    history.promote_bootstrap(
        "promote current source authority",
        PromoteBootstrapPlan {
            guard: guard(SOURCE, 1, 0),
            generation_id: BootstrapGenerationId("generation-1".into()),
            additional_retired_vault_ids: Vec::new(),
        },
    )?;
    let mut record = accepted_record();
    let accepted = commit(
        &mut history,
        ADMITTED,
        PlanMutation::AdmitCrossAccountMove {
            source_overlay: Some(source_overlay(&record)),
            record: Box::new(record.clone()),
        },
    )?;
    history.replay(
        "lost admission acknowledgement replays only the exact committed head",
        accepted,
        ReplicaPersistenceResponse::Committed {
            result: PlanResult::Stale {
                actual_revision: history.snapshot(SOURCE).unwrap().revision,
            },
        },
    )?;
    history.load(
        "reopen retains prepared target request and source overlay",
        SOURCE,
    )?;
    applied(&mut record.children[0], 1);
    record.stage = CrossAccountMoveStage::SourceTrash;
    commit(
        &mut history,
        "a foreign target Vault ID cannot retire local source intent",
        PlanMutation::RetireVaults {
            vault_ids: vec![record.target.vault_id.clone()],
        },
    )?;
    commit(
        &mut history,
        "complete unrelated local Vault cleanup without rewriting the Move",
        PlanMutation::CompleteVaultRetirements {
            vault_ids: vec![record.target.vault_id.clone()],
        },
    )?;
    commit(
        &mut history,
        TARGET_PROVED,
        advance(record.clone(), CrossAccountMoveSourceAuthority::Unchanged),
    )?;
    record.children.push(source_child(false));
    commit(
        &mut history,
        "prepare exact source Trash before its HTTP request",
        advance(record.clone(), CrossAccountMoveSourceAuthority::Unchanged),
    )?;
    applied(&mut record.children[1], 2);
    record.stage = CrossAccountMoveStage::SourceDelete;
    commit(
        &mut history,
        "retain Trash proof while source overlay remains visible",
        advance(record.clone(), CrossAccountMoveSourceAuthority::Unchanged),
    )?;
    history.load(
        "reopen retains immutable source and target baselines after Trash",
        SOURCE,
    )?;
    record.children.push(source_child(true));
    commit(
        &mut history,
        "prepare exact source Delete after proven Trash",
        advance(record.clone(), CrossAccountMoveSourceAuthority::Unchanged),
    )?;
    applied(&mut record.children[2], 3);
    commit(
        &mut history,
        "retain Delete proof before current absence decision",
        advance(record.clone(), CrossAccountMoveSourceAuthority::Unchanged),
    )?;
    record.stage = CrossAccountMoveStage::Completed;
    commit(
        &mut history,
        "complete with current source absence atomically",
        advance(record, CrossAccountMoveSourceAuthority::Absent),
    )?;
    history.load(
        "reopen completed evidence without a source overlay or stale source authority",
        SOURCE,
    )?;
    let mut later = accepted_record().children[0]
        .item()
        .unwrap()
        .to_operation()?;
    later.operation_id = "later-source-operation".into();
    later.target = ResourceRef::Item {
        item_id: "cross-source-item".into(),
        vault_id: "vault-1".into(),
    };
    later.request.path = "/api/v1/vaults/vault-1/items/cross-source-item".into();
    later.request_fingerprint =
        create_item_fingerprint("vault-1", "cross-source-item", &later.request.body);
    let mut later_overlay = source_overlay(&accepted_record());
    later_overlay.operation_id = later.operation_id.clone();
    history.commit_plan(
        "completed Move does not claim a later source Item operation",
        GuardedCommitPlan::new(
            SOURCE.into(),
            history.snapshot(SOURCE).unwrap().incarnation.clone(),
            history.snapshot(SOURCE).unwrap().revision,
            0,
            vec![
                PlanMutation::AcceptOperation(later),
                PlanMutation::PutOptimisticItem(later_overlay),
            ],
        ),
    )?;
    history.install(
        "full authentication replaces incarnation without rewriting accepted child bytes",
        SOURCE,
        "replacement",
    )?;
    Ok(history.finish())
}

#[cfg(test)]
#[path = "cross_account_move_attachment_conformance.rs"]
mod attachment_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::replica::{
        CrossAccountMoveWaitingReason, Replica, SerializedReplicaExecutor,
        SerializedReplicaPersistence,
    };

    pub(super) async fn loaded(adapter: &SqliteReplica) -> ReplicaPersistenceResponse {
        let request = serde_json::to_string(&ReplicaPersistenceRequest::Load {
            account_id: SOURCE.into(),
        })
        .unwrap();
        serde_json::from_str(
            &SerializedReplicaExecutor::invoke(adapter, request)
                .await
                .unwrap(),
        )
        .unwrap()
    }

    pub(super) fn coverage(
        response: &ReplicaPersistenceResponse,
    ) -> Result<crate::replica::recovery::CoverageProof, RuntimeError> {
        let ReplicaPersistenceResponse::Loaded {
            head: Some(head),
            rows,
        } = response
        else {
            panic!("loaded rows");
        };
        let mut coverage = crate::replica::recovery::RecoveryCoverage::new(head.clone())?;
        for row in rows {
            coverage.push_row(row.store, &row.key.record_id, &row.payload_json)?;
        }
        coverage.finish()
    }

    #[tokio::test]
    async fn serialized_sqlite_target_create_rejection_keeps_its_closed_result_set() {
        let path = std::env::temp_dir().join(format!(
            "bittery-cross-move-rejection-{}.sqlite",
            bittery_crypto_core::generate_uuid()
        ));
        let adapter = Arc::new(SqliteReplica::open(&path).unwrap());
        for step in &history().unwrap().steps {
            SerializedReplicaExecutor::invoke(
                adapter.as_ref(),
                serde_json::to_string(&step.request).unwrap(),
            )
            .await
            .unwrap();
            if step.label == ADMITTED {
                break;
            }
        }
        let before = loaded(adapter.as_ref()).await;
        let replica = Replica::new(Arc::new(SerializedReplicaPersistence::new(adapter.clone())));
        let snapshot = replica.load(&SOURCE.into()).await.unwrap().unwrap();
        drop(replica);
        let mut rejected = snapshot.cross_account_moves[0].captured().unwrap().clone();
        rejected.stage = CrossAccountMoveStage::Rejected;
        rejected.disposition = CrossAccountMoveDisposition::Rejected {
            code: OperationRejectionCode::VaultReadOnly,
        };
        let child = rejected.children[0].item_mut().unwrap();
        child.result = Some(ObservedOutcome {
            operation_id: child.operation_id.clone(),
            request_fingerprint: child.request_fingerprint,
            result: OperationOutcomeResult::Rejected {
                code: OperationRejectionCode::VaultReadOnly,
            },
        });
        let prepared = prepare_commit(
            snapshot.clone(),
            plan(
                &snapshot,
                advance(rejected, CrossAccountMoveSourceAuthority::Unchanged),
            ),
        )
        .expect("a real target-create refusal must be durably representable")
        .wire;
        for code in [
            OperationRejectionCode::ItemNotFound,
            OperationRejectionCode::ItemVersionConflict,
            OperationRejectionCode::TargetVaultReadOnly,
        ] {
            let mut forged = prepared.clone();
            let row = forged
                .writes
                .iter_mut()
                .find_map(|write| match write {
                    PreparedReplicaWrite::Put { row }
                        if row.store == ReplicaStore::CrossAccountMoves =>
                    {
                        Some(row)
                    }
                    _ => None,
                })
                .unwrap();
            let mut record: CrossAccountMoveRecord =
                serde_json::from_str(&row.payload_json).unwrap();
            record.disposition = CrossAccountMoveDisposition::Rejected { code };
            record.children[0]
                .item_mut()
                .unwrap()
                .result
                .as_mut()
                .unwrap()
                .result = OperationOutcomeResult::Rejected { code };
            row.payload_json = serde_json::to_string(&record).unwrap();
            let error = SerializedReplicaExecutor::invoke(
                adapter.as_ref(),
                serde_json::to_string(&ReplicaPersistenceRequest::Commit { prepared: forged })
                    .unwrap(),
            )
            .await
            .unwrap_err();
            assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
            assert_eq!(
                loaded(adapter.as_ref()).await,
                before,
                "a rejection from another Item operation kind cannot change physical rows or head"
            );
        }
        let response = SerializedReplicaExecutor::invoke(
            adapter.as_ref(),
            serde_json::to_string(&ReplicaPersistenceRequest::Commit { prepared }).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(
            serde_json::from_str::<ReplicaPersistenceResponse>(&response).unwrap(),
            ReplicaPersistenceResponse::Committed {
                result: PlanResult::Applied {
                    replica_revision: snapshot.revision + 1
                }
            }
        );
        let retained = loaded(adapter.as_ref()).await;
        coverage(&retained).expect("the original failed source overlay remains recoverable");
        drop(adapter);
        let reopened = SqliteReplica::open(&path).unwrap();
        assert_eq!(loaded(&reopened).await, retained);
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn serialized_sqlite_move_refuses_unprepared_or_changed_children_without_rewriting_rows()
    {
        let history = history().unwrap();
        let path = std::env::temp_dir().join(format!(
            "bittery-cross-move-proof-{}.sqlite",
            bittery_crypto_core::generate_uuid()
        ));
        let adapter = Arc::new(SqliteReplica::open(&path).unwrap());
        for step in &history.steps {
            let request = serde_json::to_string(&step.request).unwrap();
            SerializedReplicaExecutor::invoke(adapter.as_ref(), request)
                .await
                .unwrap();
            if step.label == TARGET_PROVED {
                break;
            }
        }
        let before = loaded(adapter.as_ref()).await;
        drop(adapter);
        let adapter = Arc::new(SqliteReplica::open(&path).unwrap());
        assert_eq!(
            loaded(adapter.as_ref()).await,
            before,
            "actual close/reopen must preserve exact row JSON"
        );
        let replica = Replica::new(Arc::new(SerializedReplicaPersistence::new(adapter.clone())));
        let snapshot = replica.load(&SOURCE.into()).await.unwrap().unwrap();
        let accepted = snapshot.cross_account_moves[0].captured().unwrap().clone();
        let mut unprepared_proof = accepted.clone();
        let mut trash = source_child(false);
        applied(&mut trash, 2);
        unprepared_proof.children.push(trash);
        let mut changed_request = accepted.clone();
        changed_request.children[0]
            .item_mut()
            .unwrap()
            .request
            .body
            .push(b' ');
        let mut changed_fingerprint = accepted.clone();
        changed_fingerprint.children[0]
            .item_mut()
            .unwrap()
            .request_fingerprint = Sha256Fingerprint::of_bytes(b"replacement");
        let mut false_completion = accepted.clone();
        false_completion.stage = CrossAccountMoveStage::Completed;
        for (next, authority) in [
            (unprepared_proof, CrossAccountMoveSourceAuthority::Unchanged),
            (changed_request, CrossAccountMoveSourceAuthority::Unchanged),
            (
                changed_fingerprint,
                CrossAccountMoveSourceAuthority::Unchanged,
            ),
            (false_completion, CrossAccountMoveSourceAuthority::Absent),
            (accepted.clone(), CrossAccountMoveSourceAuthority::Absent),
        ] {
            let error = replica
                .execute(plan(&snapshot, advance(next, authority)))
                .await
                .unwrap_err();
            assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
            assert_eq!(
                loaded(adapter.as_ref()).await,
                before,
                "rejected mutation must never rewrite accepted bytes or advance the head"
            );
        }
        let mut changed_overlay = source_overlay(&accepted);
        changed_overlay.encrypted_data = "replacement-ciphertext".into();
        let error = replica
            .execute(plan(
                &snapshot,
                PlanMutation::PutOptimisticItem(changed_overlay),
            ))
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        assert_eq!(loaded(adapter.as_ref()).await, before);
        let mut prepared = accepted;
        prepared.children.push(source_child(false));
        replica
            .execute(plan(
                &snapshot,
                advance(prepared, CrossAccountMoveSourceAuthority::Unchanged),
            ))
            .await
            .unwrap();
        let prepared_rows = loaded(adapter.as_ref()).await;
        let prepared_snapshot = replica
            .load_uncached(&SOURCE.into())
            .await
            .unwrap()
            .unwrap();
        let proof = coverage(&prepared_rows).unwrap();
        assert!(proof
            .accepted_rows()
            .any(|row| row.store == ReplicaStore::CrossAccountMoves));
        let mut contradictory_rejection = prepared_snapshot.cross_account_moves[0]
            .captured()
            .unwrap()
            .clone();
        let trash = contradictory_rejection.children[1].item_mut().unwrap();
        trash.result = Some(ObservedOutcome {
            operation_id: trash.operation_id.clone(),
            request_fingerprint: trash.request_fingerprint,
            result: OperationOutcomeResult::Rejected {
                code: OperationRejectionCode::ItemVersionConflict,
            },
        });
        assert_eq!(
            replica
                .execute(plan(
                    &prepared_snapshot,
                    advance(
                        contradictory_rejection,
                        CrossAccountMoveSourceAuthority::Unchanged,
                    ),
                ))
                .await
                .unwrap_err()
                .code,
            RuntimeErrorCode::InvariantViolation
        );
        assert_eq!(loaded(adapter.as_ref()).await, prepared_rows);
        replica
            .execute(plan(
                &prepared_snapshot,
                PlanMutation::RetireVaults {
                    vault_ids: vec!["vault-1".into()],
                },
            ))
            .await
            .unwrap();
        let retired = replica
            .load_uncached(&SOURCE.into())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            retired.cross_account_moves,
            prepared_snapshot.cross_account_moves
        );
        assert!(retired.items.is_empty());
        let retired_rows = loaded(adapter.as_ref()).await;
        assert!(coverage(&retired_rows)
            .unwrap()
            .accepted_rows()
            .any(|row| row.store == ReplicaStore::CrossAccountMoves));
        let mut damaged = retired_rows.clone();
        let ReplicaPersistenceResponse::Loaded { rows, .. } = &mut damaged else {
            panic!("loaded rows");
        };
        let workflow = rows
            .iter_mut()
            .find(|row| row.store == ReplicaStore::CrossAccountMoves)
            .unwrap();
        let mut payload: serde_json::Value = serde_json::from_str(&workflow.payload_json).unwrap();
        payload["children"][0]["result"]["result"]["version"] = 2.into();
        workflow.payload_json = serde_json::to_string(&payload).unwrap();
        assert_eq!(
            coverage(&damaged).err().unwrap().code,
            RuntimeErrorCode::InvariantViolation
        );
        assert_eq!(loaded(adapter.as_ref()).await, retired_rows);
        let prepared_rows = retired_rows;
        drop(replica);
        drop(adapter);
        let reopened = SqliteReplica::open(&path).unwrap();
        assert_eq!(loaded(&reopened).await, prepared_rows);
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn serialized_sqlite_move_refuses_contradictory_completed_or_retired_dispositions() {
        let history = history().unwrap();
        let path = std::env::temp_dir().join(format!(
            "bittery-cross-move-disposition-{}.sqlite",
            bittery_crypto_core::generate_uuid()
        ));
        let adapter = Arc::new(SqliteReplica::open(&path).unwrap());
        for step in &history.steps {
            SerializedReplicaExecutor::invoke(
                adapter.as_ref(),
                serde_json::to_string(&step.request).unwrap(),
            )
            .await
            .unwrap();
            if step.label == "retain Delete proof before current absence decision" {
                break;
            }
        }
        let replica = Replica::new(Arc::new(SerializedReplicaPersistence::new(adapter.clone())));
        let snapshot = replica.load(&SOURCE.into()).await.unwrap().unwrap();
        let before = loaded(adapter.as_ref()).await;
        let accepted = snapshot.cross_account_moves[0].captured().unwrap().clone();
        let mut contradictory = accepted.clone();
        contradictory.stage = CrossAccountMoveStage::Completed;
        contradictory.disposition = CrossAccountMoveDisposition::Waiting {
            reason: CrossAccountMoveWaitingReason::AccountLocked,
        };
        assert_eq!(
            replica
                .execute(plan(
                    &snapshot,
                    advance(contradictory, CrossAccountMoveSourceAuthority::Absent),
                ))
                .await
                .unwrap_err()
                .code,
            RuntimeErrorCode::InvariantViolation
        );
        assert_eq!(loaded(adapter.as_ref()).await, before);
        replica
            .execute(plan(
                &snapshot,
                PlanMutation::RetireCrossAccountMoveDestination {
                    operation_id: accepted.operation_id.clone(),
                    expected_binding_revision: accepted.destination_binding.binding_revision,
                    target_account_id: accepted.destination_binding.account_id,
                    target_incarnation: accepted.destination_binding.incarnation,
                },
            ))
            .await
            .unwrap();
        let retired = replica
            .load_uncached(&SOURCE.into())
            .await
            .unwrap()
            .unwrap();
        let retired_rows = loaded(adapter.as_ref()).await;
        let mut implicit_resume = retired.cross_account_moves[0].captured().unwrap().clone();
        implicit_resume.disposition = CrossAccountMoveDisposition::Ready;
        assert_eq!(
            replica
                .execute(plan(
                    &retired,
                    advance(
                        implicit_resume.clone(),
                        CrossAccountMoveSourceAuthority::Unchanged
                    ),
                ))
                .await
                .unwrap_err()
                .code,
            RuntimeErrorCode::InvariantViolation
        );
        assert_eq!(loaded(adapter.as_ref()).await, retired_rows);
        let mut damaged = retired_rows.clone();
        let ReplicaPersistenceResponse::Loaded { rows, .. } = &mut damaged else {
            panic!("loaded rows");
        };
        rows.iter_mut()
            .find(|row| row.store == ReplicaStore::CrossAccountMoves)
            .unwrap()
            .payload_json = serde_json::to_string(&implicit_resume).unwrap();
        assert_eq!(
            coverage(&damaged).err().unwrap().code,
            RuntimeErrorCode::InvariantViolation
        );
        assert!(coverage(&retired_rows).is_ok());
        drop(replica);
        drop(adapter);
        let reopened = SqliteReplica::open(&path).unwrap();
        assert_eq!(loaded(&reopened).await, retired_rows);
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }
    #[tokio::test]
    async fn serialized_sqlite_rejected_move_reconciliation_requires_exact_present_authority() {
        let history = history().unwrap();
        let path = std::env::temp_dir().join(format!(
            "bittery-cross-move-reconciliation-{}.sqlite",
            bittery_crypto_core::generate_uuid()
        ));
        let adapter = Arc::new(SqliteReplica::open(&path).unwrap());
        for step in &history.steps {
            SerializedReplicaExecutor::invoke(
                adapter.as_ref(),
                serde_json::to_string(&step.request).unwrap(),
            )
            .await
            .unwrap();
            if step.label == "prepare exact source Delete after proven Trash" {
                break;
            }
        }
        let replica = Replica::new(Arc::new(SerializedReplicaPersistence::new(adapter.clone())));
        let active = replica.load(&SOURCE.into()).await.unwrap().unwrap();
        let active_rows = loaded(adapter.as_ref()).await;
        assert_eq!(active.items.len(), 1);
        let mut fresh = active.cross_account_moves[0]
            .captured()
            .unwrap()
            .source
            .clone();
        fresh.version = 2;
        fresh.deleted_at = Some("1700000000000".into());
        let reconciled_candidate =
            |current: &ReplicaSnapshot, item: Option<AuthorityItemRecord>| {
                let mut next = current.clone();
                next.revision += 1;
                next.items.clear();
                let key = (
                    next.bootstrap.active_generation.clone().unwrap(),
                    fresh.id.clone(),
                );
                match item {
                    Some(item) => {
                        next.bootstrap.items.insert(key, item);
                    }
                    None => {
                        next.bootstrap.items.remove(&key);
                    }
                }
                next
            };
        let premature = reconciled_candidate(&active, Some(fresh.clone()));
        assert_eq!(
            prepare_bootstrap_commit(active.clone(), premature, true)
                .err()
                .unwrap()
                .code,
            RuntimeErrorCode::InvariantViolation,
            "fresh authority never releases an active Move's accepted source"
        );
        assert_eq!(loaded(adapter.as_ref()).await, active_rows);

        let mut record = active.cross_account_moves[0].captured().unwrap().clone();
        let delete = record.children.last_mut().unwrap().item_mut().unwrap();
        delete.result = Some(ObservedOutcome {
            operation_id: delete.operation_id.clone(),
            request_fingerprint: delete.request_fingerprint,
            result: OperationOutcomeResult::Rejected {
                code: OperationRejectionCode::VaultReadOnly,
            },
        });
        record.stage = CrossAccountMoveStage::Rejected;
        record.disposition = CrossAccountMoveDisposition::Rejected {
            code: OperationRejectionCode::VaultReadOnly,
        };
        replica
            .execute(plan(
                &active,
                advance(record, CrossAccountMoveSourceAuthority::Unchanged),
            ))
            .await
            .unwrap();
        let rejected = replica
            .load_uncached(&SOURCE.into())
            .await
            .unwrap()
            .unwrap();
        let rejected_rows = loaded(adapter.as_ref()).await;
        assert!(
            coverage(&rejected_rows).is_ok(),
            "the exact failed overlay remains recoverable before fresh authority"
        );
        let mut old = fresh.clone();
        old.version = 1;
        let older = reconciled_candidate(&rejected, Some(old));
        let missing = reconciled_candidate(&rejected, None);
        let mut rewritten = reconciled_candidate(&rejected, Some(fresh.clone()));
        applied(
            &mut rewritten.cross_account_moves[0]
                .captured_mut()
                .unwrap()
                .children[1],
            3,
        );
        for (label, candidate) in [
            ("authority older than proved source Trash", older),
            ("missing current source authority", missing),
            ("rewritten retained child proof", rewritten),
        ] {
            assert_eq!(
                prepare_bootstrap_commit(rejected.clone(), candidate, true)
                    .err()
                    .unwrap()
                    .code,
                RuntimeErrorCode::InvariantViolation,
                "{label} cannot discard the accepted source overlay"
            );
            assert_eq!(
                loaded(adapter.as_ref()).await,
                rejected_rows,
                "{label} changed physical rows"
            );
        }
        let mut corrupted = rejected_rows.clone();
        let ReplicaPersistenceResponse::Loaded { rows, .. } = &mut corrupted else {
            panic!("loaded rows")
        };
        let row = rows
            .iter_mut()
            .find(|row| row.store == ReplicaStore::CrossAccountMoves)
            .unwrap();
        let mut changed: CrossAccountMoveRecord = serde_json::from_str(&row.payload_json).unwrap();
        applied(&mut changed.children[1], 3);
        row.payload_json = serde_json::to_string(&changed).unwrap();
        assert_eq!(
            coverage(&corrupted).err().unwrap().code,
            RuntimeErrorCode::InvariantViolation
        );
        assert_eq!(loaded(adapter.as_ref()).await, rejected_rows);

        let result = replica
            .apply_sync_item_authority(
                BootstrapGuard {
                    account_id: rejected.account_id.clone(),
                    user_id: rejected.user_id.clone(),
                    incarnation: rejected.incarnation.clone(),
                    expected_replica_revision: rejected.revision,
                    expected_lock_epoch: rejected.lock_epoch,
                },
                rejected.bootstrap.active_cursor.clone(),
                fresh.id.clone(),
                Some(fresh.clone()),
            )
            .await
            .unwrap();
        assert!(matches!(result, PlanResult::Applied { .. }));
        let after = replica
            .load_uncached(&SOURCE.into())
            .await
            .unwrap()
            .unwrap();
        assert!(after.items.is_empty());
        assert_eq!(after.cross_account_moves, rejected.cross_account_moves);
        assert_eq!(
            after.bootstrap.items.get(&(
                after.bootstrap.active_generation.clone().unwrap(),
                fresh.id.clone()
            )),
            Some(&fresh)
        );
        let committed_rows = loaded(adapter.as_ref()).await;
        assert!(
            coverage(&committed_rows).is_ok(),
            "reconciled evidence remains recoverable without an overlay"
        );
        drop(replica);
        drop(adapter);
        let reopened = SqliteReplica::open(&path).unwrap();
        assert_eq!(
            loaded(&reopened).await,
            committed_rows,
            "actual SQLite owner reopen preserves authority and exact retained proof"
        );
        assert!(coverage(&loaded(&reopened).await).is_ok());
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }
    #[tokio::test]
    async fn serialized_attachment_authority_reconciliation_persists_rejected_overlay_removal() {
        let history = history().unwrap();
        let path = std::env::temp_dir().join(format!(
            "bittery-cross-move-attachment-authority-{}.sqlite",
            bittery_crypto_core::generate_uuid()
        ));
        let adapter = Arc::new(SqliteReplica::open(&path).unwrap());
        for step in &history.steps {
            SerializedReplicaExecutor::invoke(
                adapter.as_ref(),
                serde_json::to_string(&step.request).unwrap(),
            )
            .await
            .unwrap();
            if step.label == "prepare exact source Delete after proven Trash" {
                break;
            }
        }
        let replica = Replica::new(Arc::new(SerializedReplicaPersistence::new(adapter.clone())));
        let active = replica.load(&SOURCE.into()).await.unwrap().unwrap();
        let mut record = active.cross_account_moves[0].captured().unwrap().clone();
        let delete = record.children.last_mut().unwrap().item_mut().unwrap();
        delete.result = Some(ObservedOutcome {
            operation_id: delete.operation_id.clone(),
            request_fingerprint: delete.request_fingerprint,
            result: OperationOutcomeResult::Rejected {
                code: OperationRejectionCode::VaultReadOnly,
            },
        });
        record.stage = CrossAccountMoveStage::Rejected;
        record.disposition = CrossAccountMoveDisposition::Rejected {
            code: OperationRejectionCode::VaultReadOnly,
        };
        replica
            .execute(plan(
                &active,
                advance(record, CrossAccountMoveSourceAuthority::Unchanged),
            ))
            .await
            .unwrap();
        let rejected = replica
            .load_uncached(&SOURCE.into())
            .await
            .unwrap()
            .unwrap();
        let mut fresh = rejected.cross_account_moves[0]
            .captured()
            .unwrap()
            .source
            .clone();
        fresh.version = 2;
        fresh.deleted_at = Some("1700000000000".into());
        let result = replica
            .execute_foreground_attachment_exact(crate::replica::ForegroundAttachmentCommitPlan {
                guard: GuardedCommitPlan::new(
                    rejected.account_id.clone(),
                    rejected.incarnation.clone(),
                    rejected.revision,
                    rejected.lock_epoch,
                    Vec::new(),
                ),
                attachment_id: "absent-attachment".into(),
                attachment_present: false,
                item: fresh.clone(),
            })
            .await
            .unwrap();
        assert!(matches!(
            result,
            crate::replica::ForegroundAttachmentCommitResult::Applied { .. }
        ));
        let cached = replica.snapshot(&SOURCE.into()).unwrap();
        assert!(
            cached.items.is_empty(),
            "fresh authority releases the failed source overlay in the Domain"
        );
        let physical = replica
            .load_uncached(&SOURCE.into())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            physical, cached,
            "the serialized commit must persist the same rejected-overlay removal that the Domain published"
        );
        assert!(physical.items.is_empty());
        assert_eq!(physical.cross_account_moves, rejected.cross_account_moves);
        let committed_rows = loaded(adapter.as_ref()).await;
        assert!(coverage(&committed_rows).is_ok());
        drop(replica);
        drop(adapter);
        let reopened = SqliteReplica::open(&path).unwrap();
        assert_eq!(loaded(&reopened).await, committed_rows);
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }
}
