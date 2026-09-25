//! Legacy lineage and exact child requests on the existing source-owned Move workflow.
use super::*;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    remote = "Self",
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum WorkflowAcceptedPayload {
    Target {
        encryption_version: i32,
        encrypted_by_user_id: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LegacyWorkflowDisposition {
    Normal,
    LegacyFailed,
    LegacyConflicted,
    DestinationReauthorized(LegacyWorkflowAuthorization),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LegacyWorkflowPriorHold {
    LegacyFailed,
    LegacyConflicted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LegacyWorkflowAuthorization {
    pub prior_hold: LegacyWorkflowPriorHold,
    #[serde(with = "decimal_u64")]
    pub binding_revision: u64,
}

impl LegacyWorkflowDisposition {
    pub(crate) fn is_held(self) -> bool {
        matches!(self, Self::LegacyFailed | Self::LegacyConflicted)
    }

    pub(crate) fn prior_hold(self) -> Option<LegacyWorkflowPriorHold> {
        match self {
            Self::Normal => None,
            Self::LegacyFailed => Some(LegacyWorkflowPriorHold::LegacyFailed),
            Self::LegacyConflicted => Some(LegacyWorkflowPriorHold::LegacyConflicted),
            Self::DestinationReauthorized(authorization) => Some(authorization.prior_hold),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LegacyCrossAccountMoveAdmission {
    pub version: u32,
    pub admission_id: String,
    #[serde(with = "decimal_u64")]
    pub source_queue_index: u64,
    pub source_command: LegacyItemCommandV1<WorkflowAcceptedPayload>,
    pub disposition: LegacyWorkflowDisposition,
}

crate::wire::map_only_serde!(
    WorkflowAcceptedPayload,
    LegacyCrossAccountMoveAdmission,
    LegacyWorkflowAuthorization
);

impl LegacyCrossAccountMoveAdmission {
    pub(crate) fn initial_scheduling(&self) -> OperationSchedulingState {
        OperationSchedulingState {
            attempt_count: self.source_command.retry_count,
            not_before_ms: self.source_command.next_attempt_at.unwrap_or(0),
        }
    }

    pub(crate) fn bind(
        self,
        source_identity: CrossAccountMoveIdentity,
        destination_identity: CrossAccountMoveIdentity,
        destination_binding: CrossAccountMoveDestinationBinding,
        source: AuthorityItemRecord,
        target: AuthorityItemRecord,
    ) -> Result<CrossAccountMoveRecord, RuntimeError> {
        if matches!(
            self.disposition,
            LegacyWorkflowDisposition::DestinationReauthorized(_)
        ) {
            return Err(replica_invariant(
                "Initial legacy Move admission cannot authorize a destination",
            ));
        }
        if self.source_command.target_account_id.as_ref() != Some(&destination_binding.account_id)
            || destination_binding.binding_revision != 0
            || destination_binding.status != CrossAccountMoveBindingStatus::Active
        {
            return Err(replica_invariant(
                "Legacy Move initial destination binding differs from its source",
            ));
        }
        let source_account = self.source_command.account_id.clone();
        let mut record = CrossAccountMoveRecord {
            operation_id: self
                .source_command
                .operation_id
                .clone()
                .unwrap_or_else(|| self.source_command.id.clone()),
            source_identity,
            destination_identity,
            destination_binding,
            source,
            target,
            attachments: Vec::new(),
            children: Vec::new(),
            stage: CrossAccountMoveStage::TargetCreate,
            disposition: CrossAccountMoveDisposition::Ready,
            scheduling: self.initial_scheduling(),
            legacy_admission: Some(Box::new(self)),
        };
        record.children.push(
            record
                .legacy_item_child(CrossAccountMoveStep::TargetCreate)?
                .expect("legacy admission present"),
        );
        record.validate(&source_account, &record.source_identity.user_id)?;
        Ok(record)
    }

    pub(crate) fn validate(
        &self,
        source_account: &AccountId,
        record: &CrossAccountMoveRecord,
    ) -> Result<(), RuntimeError> {
        let command = &self.source_command;
        let Some(WorkflowAcceptedPayload::Target {
            encryption_version,
            encrypted_by_user_id,
        }) = &command.encrypted_payload
        else {
            return Err(replica_invariant(
                "Legacy Move accepted target payload reference is missing",
            ));
        };
        let semantic_id = command.operation_id.as_deref().unwrap_or(&command.id);
        let disposition_matches = match self.disposition.prior_hold() {
            None => LegacyItemCommandStatus::is_normal(command.status),
            Some(LegacyWorkflowPriorHold::LegacyFailed) => {
                command.status == Some(LegacyItemCommandStatus::Failed)
            }
            Some(LegacyWorkflowPriorHold::LegacyConflicted) => {
                command.status == Some(LegacyItemCommandStatus::Conflicted)
            }
        };
        if let LegacyWorkflowDisposition::DestinationReauthorized(authorization) = self.disposition
        {
            if authorization.binding_revision < 2
                || match record.destination_binding.status {
                    CrossAccountMoveBindingStatus::Active => {
                        authorization.binding_revision
                            != record.destination_binding.binding_revision
                    }
                    CrossAccountMoveBindingStatus::Retired => {
                        authorization.binding_revision
                            >= record.destination_binding.binding_revision
                    }
                }
            {
                return Err(replica_invariant(
                    "Legacy Move authorization disagrees with its destination binding",
                ));
            }
        }
        if self.version != LEGACY_OPERATION_ADMISSION_VERSION
            || self.admission_id.is_empty()
            || !disposition_matches
            || command.account_id != *source_account
            || command.account_id.as_str().is_empty()
            || command.id.is_empty()
            || command.entity_id.is_empty()
            || command.vault_id.is_empty()
            || command.operation_id.as_ref().is_some_and(String::is_empty)
            || command.attempt_id.as_ref().is_some_and(String::is_empty)
            || command.account_email.as_ref().is_some_and(String::is_empty)
            || command.kind != LegacyItemCommandKind::CrossAccountMove
            || (self.disposition == LegacyWorkflowDisposition::Normal
                && command.conflict_copy_id.is_some())
            || command
                .conflict_copy_id
                .as_ref()
                .is_some_and(String::is_empty)
            || command
                .projection_claim_id
                .as_ref()
                .is_some_and(String::is_empty)
            || command.favorite.is_some()
            || [
                command.timestamp,
                command.retry_count,
                command.next_attempt_at.unwrap_or(0),
                command.projection_claim_expires_at.unwrap_or(0),
            ]
            .into_iter()
            .any(|value| value > 9_007_199_254_740_991)
            || command
                .target_account_id
                .as_ref()
                .is_none_or(|id| id.as_str().is_empty() || id == source_account)
            || ((record.destination_binding.binding_revision == 0 || record.is_legacy_held())
                && command.target_account_id.as_ref()
                    != Some(&record.destination_binding.account_id))
            || (record.is_legacy_held()
                && record.destination_binding.status == CrossAccountMoveBindingStatus::Active
                && record.destination_binding.binding_revision != 0)
            || command.target_item_id.as_deref() != Some(record.target.id.as_str())
            || command.target_vault_id.as_deref() != Some(record.target.vault_id.as_str())
            || command.entity_id != record.source.id
            || command.vault_id != record.source.vault_id
            || command.base_version != record.source.version
            || command.base_version.checked_add(2).is_none()
            || command.category.map(AuthorityItemCategory::from).as_ref()
                != Some(&record.target.category)
            || semantic_id != record.operation_id
            || *encryption_version != 1
            || *encryption_version != record.target.encryption_version
            || encrypted_by_user_id != &record.target.encrypted_by_user_id
            || record.source.encryption_algorithm.is_empty()
            || record.target.encryption_algorithm.is_empty()
            || !record.source.attachments.is_empty()
            || !record.target.attachments.is_empty()
            || !record.attachments.is_empty()
        {
            return Err(replica_invariant(
                "Legacy Move admission disagrees with its immutable accepted workflow",
            ));
        }
        source_timestamp(command.timestamp)?;
        for child in &record.children {
            let child = child
                .item()
                .ok_or_else(|| replica_invariant("Legacy Move cannot invent Attachment history"))?;
            let expected = record
                .legacy_item_child(child.step.clone())?
                .expect("legacy admission present");
            let expected = expected.item().expect("Item child");
            if child.operation_id != expected.operation_id
                || child.kind != expected.kind
                || child.endpoint != expected.endpoint
                || child.target != expected.target
                || child.request != expected.request
                || child.request_fingerprint != expected.request_fingerprint
            {
                return Err(replica_invariant(
                    "Legacy Move child changed its original identity or bytes",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyCreateBody<'a> {
    category: LegacyItemCategory,
    encrypted_data: &'a str,
    encryption_iv: &'a str,
    encryption_algorithm: &'a str,
}

pub(super) fn legacy_target_create_body(
    category: LegacyItemCategory,
    encrypted_data: &str,
    encryption_iv: &str,
    encryption_algorithm: &str,
) -> Result<Vec<u8>, RuntimeError> {
    serde_json::to_vec(&LegacyCreateBody {
        category,
        encrypted_data,
        encryption_iv,
        encryption_algorithm,
    })
    .map_err(|_| replica_invariant("Legacy Move target request cannot be encoded"))
}

impl CrossAccountMoveRecord {
    /// Legacy suffixes reserve future children as well as the already materialized prefix.
    pub(crate) fn reserved_child_operation_ids(&self) -> Vec<String> {
        if let Some(admission) = &self.legacy_admission {
            let semantic = admission
                .source_command
                .operation_id
                .as_deref()
                .unwrap_or(&admission.source_command.id);
            ["create-target", "trash-source", "delete-source"]
                .map(|suffix| format!("{semantic}:{suffix}"))
                .to_vec()
        } else {
            self.children
                .iter()
                .filter_map(CrossAccountMoveChild::item)
                .map(|child| child.operation_id.clone())
                .collect()
        }
    }

    pub(crate) fn legacy_item_child(
        &self,
        step: CrossAccountMoveStep,
    ) -> Result<Option<CrossAccountMoveChild>, RuntimeError> {
        let Some(admission) = &self.legacy_admission else {
            return Ok(None);
        };
        let semantic = admission
            .source_command
            .operation_id
            .as_deref()
            .unwrap_or(&admission.source_command.id);
        let (suffix, endpoint, kind, item, request, fingerprint) = match step {
            CrossAccountMoveStep::TargetCreate => {
                let body = legacy_target_create_body(
                    admission.source_command.category.ok_or_else(|| {
                        replica_invariant("Legacy Move target category is missing")
                    })?,
                    &self.target.encrypted_data,
                    &self.target.encryption_iv,
                    &self.target.encryption_algorithm,
                )?;
                let fingerprint =
                    create_item_fingerprint(&self.target.vault_id, &self.target.id, &body);
                (
                    "create-target",
                    CrossAccountMoveEndpoint::Destination,
                    OperationKind::CreateItem,
                    &self.target,
                    ImmutableHttpRequest {
                        method: HttpMethod::Put,
                        path: format!(
                            "/api/v1/vaults/{}/items/{}",
                            encode_component(&self.target.vault_id),
                            encode_component(&self.target.id)
                        ),
                        headers: vec![HttpHeader {
                            name: "Content-Type".into(),
                            value: "application/json".into(),
                        }],
                        body,
                    },
                    fingerprint,
                )
            }
            CrossAccountMoveStep::SourceTrash | CrossAccountMoveStep::SourceDelete => {
                let delete = step == CrossAccountMoveStep::SourceDelete;
                let version = self
                    .source
                    .version
                    .checked_add(i32::from(delete))
                    .ok_or_else(|| replica_invariant("Legacy Move source version overflowed"))?;
                let (suffix, path_suffix, route, kind) = if delete {
                    (
                        "delete-source",
                        "/permanent",
                        "DELETE /api/v1/items/{itemId}/permanent",
                        OperationKind::PermanentlyDeleteItem,
                    )
                } else {
                    (
                        "trash-source",
                        "",
                        "DELETE /api/v1/items/{itemId}",
                        OperationKind::TrashItem,
                    )
                };
                (
                    suffix,
                    CrossAccountMoveEndpoint::Source,
                    kind,
                    &self.source,
                    ImmutableHttpRequest {
                        method: HttpMethod::Delete,
                        path: format!(
                            "/api/v1/items/{}{path_suffix}",
                            encode_component(&self.source.id)
                        ),
                        headers: vec![HttpHeader {
                            name: "If-Match".into(),
                            value: format!("\"{version}\""),
                        }],
                        body: Vec::new(),
                    },
                    item_operation_fingerprint(kind, route, &self.source.id, &[], version),
                )
            }
        };
        Ok(Some(CrossAccountMoveChild::ItemOperation(
            CrossAccountMoveItemOperation {
                step,
                endpoint,
                operation_id: format!("{semantic}:{suffix}"),
                kind,
                target: ResourceRef::Item {
                    item_id: item.id.clone(),
                    vault_id: item.vault_id.clone(),
                },
                request,
                request_fingerprint: fingerprint,
                result: None,
            },
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    pub(super) fn oracle_record() -> (CrossAccountMoveRecord, Value) {
        let oracle: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../core/src/services/fixtures/legacy-cross-account-request-serialization.json"
        )))
        .unwrap();
        let mut command = oracle["command"].clone();
        let payload = command["encryptedPayload"].clone();
        command["encryptedPayload"] = json!({"type":"target", "encryptionVersion":payload["encryptionVersion"], "encryptedByUserId":payload["encryptedByUserId"]});
        for field in ["timestamp", "retryCount"] {
            command[field] = json!(command[field].as_u64().unwrap().to_string());
        }
        let admission: LegacyCrossAccountMoveAdmission = serde_json::from_value(json!({
            "version":1, "admissionId":"oracle-admission", "sourceQueueIndex":"0", "sourceCommand":command, "disposition":"normal",
        })).unwrap();
        let source = AuthorityItemRecord {
            id: admission.source_command.entity_id.clone(),
            vault_id: admission.source_command.vault_id.clone(),
            category: admission
                .source_command
                .category
                .map(AuthorityItemCategory::from)
                .unwrap(),
            favorite: true,
            encrypted_data: "source-ciphertext".into(),
            encryption_iv: "source-iv".into(),
            encryption_algorithm: "AES-GCM-AAD-V1".into(),
            version: admission.source_command.base_version,
            encryption_version: 3,
            encrypted_by_user_id: "earlier-writer".into(),
            last_modified_by: "earlier-writer".into(),
            created_at: "1970-01-01T00:00:00Z".into(),
            updated_at: "1970-01-01T00:00:00Z".into(),
            deleted_at: None,
            attachments: Vec::new(),
        };
        let mut target = source.clone();
        target.id = admission.source_command.target_item_id.clone().unwrap();
        target.vault_id = admission.source_command.target_vault_id.clone().unwrap();
        target.encrypted_data = payload["encryptedData"].as_str().unwrap().into();
        target.encryption_iv = payload["encryptionIv"].as_str().unwrap().into();
        target.encryption_algorithm = payload["encryptionAlgorithm"].as_str().unwrap().into();
        target.version = 1;
        target.encryption_version = 1;
        target.favorite = false;
        target.encrypted_by_user_id = payload["encryptedByUserId"].as_str().unwrap().into();
        target.last_modified_by = target.encrypted_by_user_id.clone();
        let binding = CrossAccountMoveDestinationBinding {
            account_id: admission.source_command.target_account_id.clone().unwrap(),
            incarnation: "destination-incarnation".into(),
            binding_revision: 0,
            status: CrossAccountMoveBindingStatus::Active,
        };
        let record = admission
            .bind(
                CrossAccountMoveIdentity {
                    server_url: "https://source.legacy.invalid".into(),
                    user_id: "source:user".into(),
                },
                CrossAccountMoveIdentity {
                    server_url: "https://target.legacy.invalid".into(),
                    user_id: target.encrypted_by_user_id.clone(),
                },
                binding,
                source,
                target,
            )
            .unwrap();
        (record, oracle)
    }

    #[test]
    fn stopped_guarded_admission_preserves_independent_owner_and_refuses_reauthorization() {
        use crate::replica::InMemoryReplica;
        for disposition in [
            LegacyWorkflowDisposition::LegacyFailed,
            LegacyWorkflowDisposition::LegacyConflicted,
        ] {
            for active_first in [false, true] {
                let (normal, _) = oracle_record();
                let mut held = normal.clone();
                let admission = held.legacy_admission.as_mut().unwrap();
                admission.disposition = disposition;
                admission.source_command.status = Some(match disposition {
                    LegacyWorkflowDisposition::LegacyFailed => LegacyItemCommandStatus::Failed,
                    LegacyWorkflowDisposition::LegacyConflicted => {
                        LegacyItemCommandStatus::Conflicted
                    }
                    LegacyWorkflowDisposition::Normal
                    | LegacyWorkflowDisposition::DestinationReauthorized(_) => unreachable!(),
                });
                let account = admission.source_command.account_id.clone();
                let state = InMemoryReplica::default();
                state
                    .install(
                        account.clone(),
                        held.source_identity.user_id.clone(),
                        "source-incarnation".into(),
                    )
                    .unwrap();
                state
                    .seed_ready_authority(
                        &account,
                        vec![crate::test_fixtures::personal_vault(
                            &held.source.vault_id,
                            &held.source_identity.user_id,
                        )],
                        vec![held.source.clone()],
                    )
                    .unwrap();
                let execute = |mutations| {
                    let snapshot = state.snapshot(&account).unwrap();
                    state.execute(GuardedCommitPlan::new(
                        account.clone(),
                        snapshot.incarnation,
                        snapshot.revision,
                        snapshot.lock_epoch,
                        mutations,
                    ))
                };
                let baseline = state.snapshot(&account).unwrap();
                for (record, source_overlay) in [
                    (normal, None),
                    (held.clone(), Some(held.source_overlay(&account))),
                ] {
                    assert!(execute(vec![PlanMutation::AdmitCrossAccountMove {
                        record: Box::new(record),
                        source_overlay
                    }])
                    .is_err());
                    assert_eq!(state.snapshot(&account).unwrap(), baseline);
                }
                let mut independent = crate::test_fixtures::test_operation(
                    "independent-newer-owner",
                    &held.source.id,
                );
                independent.target = ResourceRef::Item {
                    item_id: held.source.id.clone(),
                    vault_id: held.source.vault_id.clone(),
                };
                independent.request.path = format!(
                    "/api/v1/vaults/{}/items/{}",
                    encode_component(&held.source.vault_id),
                    encode_component(&held.source.id)
                );
                independent.request_fingerprint = create_item_fingerprint(
                    &held.source.vault_id,
                    &held.source.id,
                    &independent.request.body,
                );
                let mut overlay = held.source_overlay(&account);
                overlay.operation_id = independent.operation_id.clone();
                overlay.encrypted_data = "independent-newer-ciphertext".into();
                let active = || {
                    vec![
                        PlanMutation::AcceptOperation(independent.clone()),
                        PlanMutation::PutOptimisticItem(overlay.clone()),
                    ]
                };
                if active_first {
                    execute(active()).unwrap();
                }
                execute(vec![PlanMutation::AdmitCrossAccountMove {
                    record: Box::new(held.clone()),
                    source_overlay: None,
                }])
                .unwrap();
                if !active_first {
                    execute(active()).unwrap();
                }
                let admitted = state.snapshot(&account).unwrap();
                assert_eq!(admitted.items, vec![overlay.clone()]);
                assert_eq!(admitted.operations, vec![independent.clone()]);
                assert_eq!(
                    admitted.cross_account_moves,
                    vec![CrossAccountMoveEntry::from(held.clone())]
                );
                assert_eq!(admitted.bootstrap, baseline.bootstrap);
                assert!(execute(vec![PlanMutation::PutOptimisticItem(
                    held.source_overlay(&account)
                )])
                .is_err());
                assert_eq!(state.snapshot(&account).unwrap(), admitted);
                for operation_id in held.reserved_child_operation_ids() {
                    let mut collision =
                        crate::test_fixtures::test_operation(&operation_id, "unrelated-item");
                    collision.target = ResourceRef::Item {
                        item_id: "unrelated-item".into(),
                        vault_id: held.source.vault_id.clone(),
                    };
                    collision.request.path = format!(
                        "/api/v1/vaults/{}/items/unrelated-item",
                        encode_component(&held.source.vault_id)
                    );
                    collision.request_fingerprint = create_item_fingerprint(
                        &held.source.vault_id,
                        "unrelated-item",
                        &collision.request.body,
                    );
                    let error =
                        execute(vec![PlanMutation::AcceptOperation(collision)]).unwrap_err();
                    assert!(error.message.contains("child identity"), "{error:?}");
                    assert_eq!(state.snapshot(&account).unwrap(), admitted);
                }
                execute(vec![PlanMutation::RetireCrossAccountMoveDestination {
                    operation_id: held.operation_id.clone(),
                    expected_binding_revision: 0,
                    target_account_id: held.destination_binding.account_id.clone(),
                    target_incarnation: held.destination_binding.incarnation.clone(),
                }])
                .unwrap();
                let retired = state.snapshot(&account).unwrap();
                assert_eq!(
                    retired.cross_account_moves[0]
                        .captured()
                        .unwrap()
                        .legacy_admission,
                    held.legacy_admission
                );
                assert_eq!(retired.items, vec![overlay]);
                for target_account_id in [
                    held.destination_binding.account_id.clone(),
                    AccountId::from("replacement-account"),
                ] {
                    assert!(
                        execute(vec![PlanMutation::ReauthorizeCrossAccountMoveDestination {
                            operation_id: held.operation_id.clone(),
                            expected_binding_revision: 1,
                            destination_account_id: target_account_id,
                            destination_incarnation: "replacement-incarnation".into(),
                            verified_attachments: Vec::new(),
                        }])
                        .is_err()
                    );
                    assert_eq!(state.snapshot(&account).unwrap(), retired);
                }
            }
        }
    }

    #[test]
    fn stopped_workflow_retains_original_children_but_not_active_ownership() {
        for (status, disposition) in [
            ("failed", "legacyFailed"),
            ("conflicted", "legacyConflicted"),
        ] {
            let (normal, _) = oracle_record();
            let mut value = serde_json::to_value(&normal).unwrap();
            value["legacyAdmission"]["disposition"] = json!(disposition);
            value["legacyAdmission"]["sourceCommand"]["status"] = json!(status);
            value["legacyAdmission"]["sourceCommand"]["conflictCopyId"] = json!("independent-copy");
            let held: CrossAccountMoveRecord = serde_json::from_value(value.clone()).unwrap();
            let account = &held
                .legacy_admission
                .as_ref()
                .unwrap()
                .source_command
                .account_id;
            held.validate(account, &held.source_identity.user_id)
                .unwrap();
            assert!(!held.owns_source_item());
            assert_eq!(
                held.reserved_child_operation_ids(),
                normal.reserved_child_operation_ids()
            );
            assert_eq!(held.children, normal.children);
            assert!(held
                .validate_source_overlay(account, &held.source_overlay(account))
                .is_err());
            for mutation in ["status", "targetAccountId", "conflictCopyId"] {
                let mut invalid = value.clone();
                invalid["legacyAdmission"]["sourceCommand"][mutation] = match mutation {
                    "status" => json!("pending"),
                    "targetAccountId" => json!("another-account"),
                    _ => json!(""),
                };
                let invalid: CrossAccountMoveRecord = serde_json::from_value(invalid).unwrap();
                assert!(
                    invalid
                        .validate(account, &held.source_identity.user_id)
                        .is_err(),
                    "{mutation}"
                );
            }
            let mut retired = held.clone();
            retired.destination_binding.status = CrossAccountMoveBindingStatus::Retired;
            retired.destination_binding.binding_revision = 1;
            retired.disposition = CrossAccountMoveDisposition::Blocked {
                reason: CrossAccountMoveBlockedReason::DestinationRetired,
            };
            retired
                .validate(account, &held.source_identity.user_id)
                .unwrap();
            retired.destination_binding.account_id = "another-account".into();
            assert!(retired
                .validate(account, &held.source_identity.user_id)
                .is_err());
            let mut active = held;
            active.destination_binding.binding_revision = 1;
            assert!(active
                .validate(
                    &normal
                        .legacy_admission
                        .as_ref()
                        .unwrap()
                        .source_command
                        .account_id,
                    &normal.source_identity.user_id
                )
                .is_err());
        }
    }

    #[test]
    fn every_original_child_matches_the_actual_typescript_executor_bytes() {
        let (record, oracle) = oracle_record();
        let expected = oracle["captures"].as_array().unwrap();
        assert_eq!(
            record.reserved_child_operation_ids(),
            expected
                .iter()
                .map(|child| child["operationId"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        );
        for (step, expected) in [
            CrossAccountMoveStep::TargetCreate,
            CrossAccountMoveStep::SourceTrash,
            CrossAccountMoveStep::SourceDelete,
        ]
        .into_iter()
        .zip(expected)
        {
            let child = record.legacy_item_child(step).unwrap().unwrap();
            let child = child.item().unwrap();
            assert_eq!(
                child.operation_id,
                expected["operationId"].as_str().unwrap()
            );
            assert_eq!(child.request.path, expected["path"].as_str().unwrap());
            assert_eq!(
                child.request.body,
                expected["body"].as_str().unwrap().as_bytes()
            );
            assert_eq!(
                child.request.method,
                if expected["method"] == "PUT" {
                    HttpMethod::Put
                } else {
                    HttpMethod::Delete
                }
            );
            assert_eq!(
                child
                    .request
                    .headers
                    .iter()
                    .find(|header| header.name == "If-Match")
                    .map(|header| header.value.as_str()),
                expected["ifMatch"].as_str()
            );
        }
        let source_overlay = record.source_overlay(
            &record
                .legacy_admission
                .as_ref()
                .unwrap()
                .source_command
                .account_id,
        );
        assert_eq!(source_overlay.version, 41);
        assert_eq!(source_overlay.encryption_version, 3);
        assert_eq!(source_overlay.encrypted_by_user_id, "earlier-writer");
        assert!(source_overlay.favorite);
        let mut evidence = *record.legacy_admission.clone().unwrap();
        evidence.source_command.operation_id = None;
        evidence.source_command.status = None;
        // The historical attempt remains present but is never a workflow child identity.
        let fallback = evidence
            .bind(
                record.source_identity,
                record.destination_identity,
                record.destination_binding,
                record.source,
                record.target,
            )
            .unwrap();
        assert_eq!(
            fallback.reserved_child_operation_ids(),
            [
                "source-command:cross-account:create-target",
                "source-command:cross-account:trash-source",
                "source-command:cross-account:delete-source",
            ]
        );
        assert!(fallback
            .legacy_admission
            .as_ref()
            .unwrap()
            .source_command
            .operation_id
            .is_none());
        assert!(fallback
            .legacy_admission
            .as_ref()
            .unwrap()
            .source_command
            .attempt_id
            .is_some());
    }

    #[test]
    fn workflow_retry_preserves_lineage_and_refuses_otherwise_valid_metadata_rewrites() {
        use crate::replica::{
            persistence_contract::{reconstruct_snapshot, snapshot_rows, ReplicaHead},
            InMemoryReplica,
        };
        let (record, _) = oracle_record();
        let account = record
            .legacy_admission
            .as_ref()
            .unwrap()
            .source_command
            .account_id
            .clone();
        let state = InMemoryReplica::default();
        state
            .install(
                account.clone(),
                record.source_identity.user_id.clone(),
                "source-incarnation".into(),
            )
            .unwrap();
        state
            .seed_ready_authority(
                &account,
                vec![crate::test_fixtures::personal_vault(
                    &record.source.vault_id,
                    &record.source_identity.user_id,
                )],
                vec![record.source.clone()],
            )
            .unwrap();
        let execute = |mutations| {
            let snapshot = state.snapshot(&account).unwrap();
            state.execute(GuardedCommitPlan::new(
                account.clone(),
                snapshot.incarnation,
                snapshot.revision,
                snapshot.lock_epoch,
                mutations,
            ))
        };
        execute(vec![PlanMutation::AdmitCrossAccountMove {
            record: Box::new(record.clone()),
            source_overlay: Some(record.source_overlay(&account)),
        }])
        .unwrap();
        let mut retried = record.clone();
        retried.scheduling.attempt_count = 1;
        retried.scheduling.not_before_ms = 4_000;
        let advance = |next: CrossAccountMoveRecord| PlanMutation::AdvanceCrossAccountMove {
            operation_id: record.operation_id.clone(),
            expected_binding_revision: 0,
            next: Box::new(next),
            source_authority: CrossAccountMoveSourceAuthority::Unchanged,
        };
        execute(vec![advance(retried.clone())]).unwrap();
        let before = state.snapshot(&account).unwrap();
        let reloaded = reconstruct_snapshot(
            &account,
            Some(ReplicaHead {
                account_id: account.clone(),
                user_id: before.user_id.clone(),
                incarnation: before.incarnation.clone(),
                replica_revision: before.revision,
                lock_epoch: before.lock_epoch,
                failure: before.failure,
            }),
            snapshot_rows(before.clone()).unwrap(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(reloaded, before);
        assert_eq!(
            reloaded.cross_account_moves[0].captured().unwrap(),
            &retried
        );
        assert_eq!(
            reloaded.cross_account_moves[0]
                .captured()
                .unwrap()
                .legacy_admission,
            record.legacy_admission
        );
        for change_index in [false, true] {
            let mut changed = retried.clone();
            let evidence = changed.legacy_admission.as_mut().unwrap();
            if change_index {
                evidence.source_queue_index += 1;
            } else {
                evidence.source_command.id = "rewritten-source-command".into();
            }
            // The semantic ID and request still agree: the guarded immutable-lineage check is essential.
            changed
                .validate(&account, &record.source_identity.user_id)
                .unwrap();
            assert!(execute(vec![advance(changed)]).is_err());
            assert_eq!(state.snapshot(&account).unwrap(), before);
        }
    }

    fn bind_history(
        record: &CrossAccountMoveRecord,
        command: LegacyItemCommandV1<WorkflowAcceptedPayload>,
    ) -> Result<CrossAccountMoveRecord, RuntimeError> {
        let mut admission = *record.legacy_admission.clone().unwrap();
        admission.source_command = command;
        admission.bind(
            record.source_identity.clone(),
            record.destination_identity.clone(),
            record.destination_binding.clone(),
            record.source.clone(),
            record.target.clone(),
        )
    }

    fn scheduling_state(
        account: &AccountId,
        record: &CrossAccountMoveRecord,
    ) -> crate::replica::InMemoryReplica {
        let state = crate::replica::InMemoryReplica::default();
        state
            .install(
                account.clone(),
                record.source_identity.user_id.clone(),
                "source-incarnation".into(),
            )
            .unwrap();
        state
            .seed_ready_authority(
                account,
                vec![crate::test_fixtures::personal_vault(
                    &record.source.vault_id,
                    &record.source_identity.user_id,
                )],
                vec![record.source.clone()],
            )
            .unwrap();
        state
    }

    fn execute_scheduling(
        state: &crate::replica::InMemoryReplica,
        account: &AccountId,
        mutation: PlanMutation,
    ) -> Result<PlanResult, RuntimeError> {
        let snapshot = state.snapshot(account).unwrap();
        state.execute(GuardedCommitPlan::new(
            account.clone(),
            snapshot.incarnation,
            snapshot.revision,
            snapshot.lock_epoch,
            vec![mutation],
        ))
    }

    #[test]
    fn legacy_workflow_history_binds_initial_schedule_and_retains_it_across_live_retry() {
        use crate::replica::persistence_contract::{
            reconstruct_snapshot, snapshot_rows, ReplicaHead,
        };
        let (baseline, _) = oracle_record();
        let mut command = baseline
            .legacy_admission
            .as_ref()
            .unwrap()
            .source_command
            .clone();
        command.status = Some(LegacyItemCommandStatus::Retrying);
        command.retry_count = 5;
        command.next_attempt_at = Some(42_000);
        command.last_error = Some("original target acknowledgement lost".into());
        command.attempt_id = Some("reminted-whole-workflow-attempt".into());
        command.projection_claim_id = Some("departed-projector".into());
        command.projection_claim_expires_at = Some(90_000);
        let account = command.account_id.clone();
        let record = bind_history(&baseline, command.clone()).unwrap();
        assert_eq!(
            record.scheduling,
            OperationSchedulingState {
                attempt_count: 5,
                not_before_ms: 42_000
            }
        );
        assert_eq!(record.stage, CrossAccountMoveStage::TargetCreate);
        assert_eq!(record.disposition, CrossAccountMoveDisposition::Ready);
        assert_eq!(record.children, baseline.children);
        assert_eq!(record.children.len(), 1);
        assert!(record.children[0].item().unwrap().result.is_none());
        assert_eq!(
            record.reserved_child_operation_ids(),
            baseline.reserved_child_operation_ids()
        );
        assert_eq!(
            record.legacy_admission.as_ref().unwrap().source_command,
            command
        );
        let state = scheduling_state(&account, &record);
        let initial = state.snapshot(&account).unwrap();
        for scheduling in [
            OperationSchedulingState::default(),
            OperationSchedulingState {
                attempt_count: 5,
                not_before_ms: 0,
            },
            OperationSchedulingState {
                attempt_count: 6,
                not_before_ms: 42_000,
            },
        ] {
            let mut wrong = record.clone();
            wrong.scheduling = scheduling;
            // Durable validation permits live schedules; only the initial acceptance pins history.
            wrong
                .validate(&account, &record.source_identity.user_id)
                .unwrap();
            assert!(execute_scheduling(
                &state,
                &account,
                PlanMutation::AdmitCrossAccountMove {
                    source_overlay: Some(wrong.source_overlay(&account)),
                    record: Box::new(wrong),
                }
            )
            .is_err());
            assert_eq!(state.snapshot(&account).unwrap(), initial);
        }
        execute_scheduling(
            &state,
            &account,
            PlanMutation::AdmitCrossAccountMove {
                source_overlay: Some(record.source_overlay(&account)),
                record: Box::new(record.clone()),
            },
        )
        .unwrap();
        let mut evolved = record.clone();
        for not_before_ms in [84_000, 0] {
            evolved.scheduling = OperationSchedulingState {
                attempt_count: 6,
                not_before_ms,
            };
            execute_scheduling(
                &state,
                &account,
                PlanMutation::AdvanceCrossAccountMove {
                    operation_id: record.operation_id.clone(),
                    expected_binding_revision: 0,
                    next: Box::new(evolved.clone()),
                    source_authority: CrossAccountMoveSourceAuthority::Unchanged,
                },
            )
            .unwrap();
            let snapshot = state.snapshot(&account).unwrap();
            let reloaded = reconstruct_snapshot(
                &account,
                Some(ReplicaHead {
                    account_id: account.clone(),
                    user_id: snapshot.user_id.clone(),
                    incarnation: snapshot.incarnation.clone(),
                    replica_revision: snapshot.revision,
                    lock_epoch: snapshot.lock_epoch,
                    failure: snapshot.failure,
                }),
                snapshot_rows(snapshot.clone()).unwrap(),
            )
            .unwrap()
            .unwrap();
            assert_eq!(reloaded, snapshot);
            assert_eq!(
                reloaded.cross_account_moves,
                vec![CrossAccountMoveEntry::from(evolved.clone())]
            );
            assert_eq!(evolved.legacy_admission, record.legacy_admission);
            assert_eq!(evolved.children, baseline.children);
            assert_eq!(evolved.stage, CrossAccountMoveStage::TargetCreate);
            assert_eq!(
                evolved.reserved_child_operation_ids(),
                baseline.reserved_child_operation_ids()
            );
        }
        let saved = state.snapshot(&account).unwrap();
        for field in ["retryCount", "nextAttemptAt", "projectionClaimId"] {
            let mut changed = evolved.clone();
            let command = &mut changed.legacy_admission.as_mut().unwrap().source_command;
            match field {
                "retryCount" => command.retry_count = 6,
                "nextAttemptAt" => command.next_attempt_at = Some(84_000),
                "projectionClaimId" => {
                    command.projection_claim_id = Some("replacement-projector".into())
                }
                _ => unreachable!(),
            }
            changed
                .validate(&account, &record.source_identity.user_id)
                .unwrap();
            assert!(
                execute_scheduling(
                    &state,
                    &account,
                    PlanMutation::AdvanceCrossAccountMove {
                        operation_id: record.operation_id.clone(),
                        expected_binding_revision: 0,
                        next: Box::new(changed),
                        source_authority: CrossAccountMoveSourceAuthority::Unchanged,
                    }
                )
                .is_err(),
                "{field}"
            );
            assert_eq!(state.snapshot(&account).unwrap(), saved);
        }
    }

    #[test]
    fn legacy_workflow_normal_statuses_preserve_optional_history_and_bound_source_numbers() {
        const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
        let (baseline, _) = oracle_record();
        for status in [
            None,
            Some(LegacyItemCommandStatus::Staged),
            Some(LegacyItemCommandStatus::Applying),
            Some(LegacyItemCommandStatus::Pending),
            Some(LegacyItemCommandStatus::Retrying),
        ] {
            for (count, deadline, claim, expiry) in [
                (0, None, None, None),
                (3, None, Some("departed"), None),
                (4, Some(42_000), Some("departed"), Some(90_000)),
                (5, Some(0), None, Some(0)),
                (
                    MAX_SAFE_INTEGER,
                    Some(MAX_SAFE_INTEGER),
                    Some("departed"),
                    Some(MAX_SAFE_INTEGER),
                ),
            ] {
                let mut command = baseline
                    .legacy_admission
                    .as_ref()
                    .unwrap()
                    .source_command
                    .clone();
                command.status = status;
                command.retry_count = count;
                command.next_attempt_at = deadline;
                command.last_error = (count != 0).then(|| "historical error".into());
                command.projection_claim_id = claim.map(str::to_owned);
                command.projection_claim_expires_at = expiry;
                let record = bind_history(&baseline, command.clone()).unwrap();
                assert_eq!(
                    record.scheduling,
                    OperationSchedulingState {
                        attempt_count: count,
                        not_before_ms: deadline.unwrap_or(0)
                    }
                );
                assert_eq!(
                    record.legacy_admission.as_ref().unwrap().source_command,
                    command
                );
                assert_eq!(record.children, baseline.children);
                assert_eq!(record.stage, CrossAccountMoveStage::TargetCreate);
            }
        }
        for field in [
            "timestamp",
            "retryCount",
            "nextAttemptAt",
            "projectionClaimExpiresAt",
            "emptyClaim",
            "failed",
            "conflicted",
        ] {
            let mut changed = baseline.clone();
            let command = &mut changed.legacy_admission.as_mut().unwrap().source_command;
            match field {
                "timestamp" => command.timestamp = MAX_SAFE_INTEGER + 1,
                "retryCount" => command.retry_count = MAX_SAFE_INTEGER + 1,
                "nextAttemptAt" => command.next_attempt_at = Some(MAX_SAFE_INTEGER + 1),
                "projectionClaimExpiresAt" => {
                    command.projection_claim_expires_at = Some(MAX_SAFE_INTEGER + 1)
                }
                "emptyClaim" => command.projection_claim_id = Some(String::new()),
                "failed" => command.status = Some(LegacyItemCommandStatus::Failed),
                "conflicted" => command.status = Some(LegacyItemCommandStatus::Conflicted),
                _ => unreachable!(),
            }
            assert!(bind_history(&baseline, command.clone()).is_err(), "{field}");
            let account = command.account_id.clone();
            assert!(
                changed
                    .validate(&account, &changed.source_identity.user_id)
                    .is_err(),
                "{field}"
            );
        }
        for field in [
            "nextAttemptAt",
            "projectionClaimId",
            "projectionClaimExpiresAt",
        ] {
            let mut value =
                serde_json::to_value(baseline.legacy_admission.as_ref().unwrap()).unwrap();
            value["sourceCommand"][field] = Value::Null;
            assert!(
                serde_json::from_value::<LegacyCrossAccountMoveAdmission>(value).is_err(),
                "{field}"
            );
        }
    }

    #[test]
    fn ordinary_workflow_initial_schedule_still_requires_default() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../../../generated/replica-conformance/history-corpus.json"
        ))
        .unwrap();
        let history = corpus["histories"]
            .as_array()
            .unwrap()
            .iter()
            .find(|history| {
                history["name"] == "cross-account-move-no-files-retained-child-evidence"
            })
            .unwrap();
        let (account, record) = history["steps"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|step| step["expectedLoadedState"].as_array().unwrap())
            .find_map(|loaded| {
                loaded["response"]["rows"]
                    .as_array()?
                    .iter()
                    .find_map(|row| {
                        (row["store"] == "crossAccountMoves").then(|| {
                            (
                                AccountId::from(
                                    loaded["response"]["head"]["accountId"].as_str().unwrap(),
                                ),
                                serde_json::from_str::<CrossAccountMoveRecord>(
                                    row["payloadJson"].as_str().unwrap(),
                                )
                                .unwrap(),
                            )
                        })
                    })
            })
            .unwrap();
        assert!(record.legacy_admission.is_none());
        assert_eq!(record.stage, CrossAccountMoveStage::TargetCreate);
        assert!(record.children[0].item().unwrap().result.is_none());
        assert_eq!(record.scheduling, OperationSchedulingState::default());
        let state = scheduling_state(&account, &record);
        let initial = state.snapshot(&account).unwrap();
        for scheduling in [
            OperationSchedulingState {
                attempt_count: 1,
                not_before_ms: 0,
            },
            OperationSchedulingState {
                attempt_count: 0,
                not_before_ms: 42_000,
            },
        ] {
            let mut changed = record.clone();
            changed.scheduling = scheduling;
            changed
                .validate(&account, &record.source_identity.user_id)
                .unwrap();
            assert!(execute_scheduling(
                &state,
                &account,
                PlanMutation::AdmitCrossAccountMove {
                    source_overlay: Some(changed.source_overlay(&account)),
                    record: Box::new(changed),
                }
            )
            .is_err());
            assert_eq!(state.snapshot(&account).unwrap(), initial);
        }
        execute_scheduling(
            &state,
            &account,
            PlanMutation::AdmitCrossAccountMove {
                source_overlay: Some(record.source_overlay(&account)),
                record: Box::new(record.clone()),
            },
        )
        .unwrap();
        assert_eq!(
            state.snapshot(&account).unwrap().cross_account_moves,
            vec![CrossAccountMoveEntry::from(record)]
        );
    }

    #[test]
    fn initial_destination_binding_cannot_drift_but_guarded_reauthorization_preserves_history() {
        use crate::replica::{
            persistence_contract::{reconstruct_snapshot, snapshot_rows, ReplicaHead},
            InMemoryReplica,
        };
        let (record, _) = oracle_record();
        let account = record
            .legacy_admission
            .as_ref()
            .unwrap()
            .source_command
            .account_id
            .clone();
        let state = InMemoryReplica::default();
        state
            .install(
                account.clone(),
                record.source_identity.user_id.clone(),
                "source-incarnation".into(),
            )
            .unwrap();
        state
            .seed_ready_authority(
                &account,
                vec![crate::test_fixtures::personal_vault(
                    &record.source.vault_id,
                    &record.source_identity.user_id,
                )],
                vec![record.source.clone()],
            )
            .unwrap();
        let execute = |mutations| {
            let snapshot = state.snapshot(&account).unwrap();
            state.execute(GuardedCommitPlan::new(
                account.clone(),
                snapshot.incarnation,
                snapshot.revision,
                snapshot.lock_epoch,
                mutations,
            ))
        };
        execute(vec![PlanMutation::AdmitCrossAccountMove {
            record: Box::new(record.clone()),
            source_overlay: Some(record.source_overlay(&account)),
        }])
        .unwrap();
        let reload = |snapshot: ReplicaSnapshot| {
            reconstruct_snapshot(
                &account,
                Some(ReplicaHead {
                    account_id: account.clone(),
                    user_id: snapshot.user_id.clone(),
                    incarnation: snapshot.incarnation.clone(),
                    replica_revision: snapshot.revision,
                    lock_epoch: snapshot.lock_epoch,
                    failure: snapshot.failure,
                }),
                snapshot_rows(snapshot).unwrap(),
            )
        };
        let admitted = state.snapshot(&account).unwrap();
        let mut changed = admitted.clone();
        changed.cross_account_moves[0]
            .captured_mut()
            .unwrap()
            .destination_binding
            .account_id = "substituted-account".into();
        assert!(
            reload(changed).is_err(),
            "persisted revision-zero binding must retain its captured Account identity"
        );
        execute(vec![PlanMutation::RetireCrossAccountMoveDestination {
            operation_id: record.operation_id.clone(),
            expected_binding_revision: 0,
            target_account_id: record.destination_binding.account_id.clone(),
            target_incarnation: record.destination_binding.incarnation.clone(),
        }])
        .unwrap();
        execute(vec![PlanMutation::ReauthorizeCrossAccountMoveDestination {
            operation_id: record.operation_id.clone(),
            expected_binding_revision: 1,
            destination_account_id: "reauthorized-account".into(),
            destination_incarnation: "reauthorized-incarnation".into(),
            verified_attachments: Vec::new(),
        }])
        .unwrap();
        let reauthorized = reload(state.snapshot(&account).unwrap()).unwrap().unwrap();
        let reauthorized = reauthorized.cross_account_moves[0].captured().unwrap();
        assert_eq!(reauthorized.destination_binding.binding_revision, 2);
        assert_eq!(
            reauthorized.destination_binding.account_id,
            AccountId::from("reauthorized-account")
        );
        assert_eq!(reauthorized.legacy_admission, record.legacy_admission);
        assert_eq!(reauthorized.children, record.children);
    }

    #[test]
    fn workflow_lineage_and_payload_reference_are_closed_map_only_objects() {
        let (record, _) = oracle_record();
        let admission = record.legacy_admission.as_ref().unwrap();
        let raw = serde_json::to_string(admission).unwrap();
        for malformed in [
            raw.replace("\"version\":1", "\"version\":1,\"version\":1"),
            raw.replace(
                "\"retryCount\":\"0\"",
                "\"retryCount\":\"0\",\"retryCount\":\"0\"",
            ),
        ] {
            assert!(serde_json::from_str::<LegacyCrossAccountMoveAdmission>(&malformed).is_err());
        }
        for field in [
            "outer-array",
            "command-array",
            "payload-array",
            "payload-null",
            "payload-unknown",
            "ordinary-reference",
            "unknown-disposition",
        ] {
            let mut value = serde_json::to_value(admission).unwrap();
            match field {
                "outer-array" => value = json!([]),
                "command-array" => value["sourceCommand"] = json!([]),
                "payload-array" => value["sourceCommand"]["encryptedPayload"] = json!([]),
                "payload-null" => value["sourceCommand"]["encryptedPayload"] = Value::Null,
                "payload-unknown" => {
                    value["sourceCommand"]["encryptedPayload"]["ciphertext"] =
                        json!("duplicate-owner")
                }
                "ordinary-reference" => {
                    value["sourceCommand"]["encryptedPayload"]
                        .as_object_mut()
                        .unwrap()
                        .remove("type");
                }
                "unknown-disposition" => value["disposition"] = json!("legacyPaused"),
                _ => unreachable!(),
            }
            assert!(
                serde_json::from_value::<LegacyCrossAccountMoveAdmission>(value).is_err(),
                "{field}"
            );
        }
        let source = serde_json::to_value(&admission.source_command).unwrap();
        assert!(
            serde_json::from_value::<LegacyItemCommandV1>(source).is_err(),
            "ordinary request evidence cannot reference workflow payload"
        );
    }
}

#[cfg(test)]
#[path = "legacy_cross_account_reauthorization_tests.rs"]
mod reauthorization_tests;
