//! One workflow owner with either complete captured authority or explicitly unavailable source evidence.
use super::*;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self", untagged)]
pub(crate) enum CrossAccountMoveEntry {
    Captured(Box<CrossAccountMoveRecord>),
    LegacySourceUnavailable(Box<LegacySourceUnavailableMove>),
}
crate::wire::map_only_serde!(CrossAccountMoveEntry);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
enum UnavailableSourceTag {
    #[serde(rename = "legacySourceUnavailable")]
    LegacySourceUnavailable,
}
impl<'de> Deserialize<'de> for UnavailableSourceTag {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if String::deserialize(deserializer)? == "legacySourceUnavailable" {
            Ok(Self::LegacySourceUnavailable)
        } else {
            Err(serde::de::Error::custom(
                "unknown Cross-Account Move evidence form",
            ))
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LegacySourceUnavailableMove {
    #[serde(rename = "type")]
    kind: UnavailableSourceTag,
    version: u32,
    pub operation_id: String,
    #[serde(deserialize_with = "strict_map")]
    pub source_identity: CrossAccountMoveIdentity,
    #[serde(deserialize_with = "strict_map")]
    pub destination_identity: CrossAccountMoveIdentity,
    #[serde(deserialize_with = "strict_map")]
    pub destination_binding: CrossAccountMoveDestinationBinding,
    #[serde(deserialize_with = "strict_target_create")]
    pub target_create: CrossAccountMoveItemOperation,
    #[serde(deserialize_with = "strict_map")]
    pub scheduling: OperationSchedulingState,
    pub legacy_admission: Box<LegacyCrossAccountMoveAdmission>,
}
crate::wire::map_only_serde!(LegacySourceUnavailableMove);

// The parked wire reuses domain types without widening their new control objects to positional
// arrays. These remote definitions only customize this boundary; Captured keeps its old wire.
fn strict_map<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<T, D::Error> {
    struct Object<T>(std::marker::PhantomData<T>);
    impl<'de, T: Deserialize<'de>> serde::de::Visitor<'de> for Object<T> {
        type Value = T;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("a typed control object")
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(self, map: A) -> Result<T, A::Error> {
            T::deserialize(serde::de::value::MapAccessDeserializer::new(map))
        }
    }
    deserializer.deserialize_map(Object(std::marker::PhantomData))
}

#[derive(Deserialize)]
#[serde(
    remote = "CrossAccountMoveItemOperation",
    rename_all = "camelCase",
    deny_unknown_fields
)]
struct StrictTargetCreate {
    #[serde(deserialize_with = "strict_target_create_step")]
    step: CrossAccountMoveStep,
    endpoint: CrossAccountMoveEndpoint,
    operation_id: String,
    kind: OperationKind,
    #[serde(deserialize_with = "strict_map")]
    target: ResourceRef,
    #[serde(deserialize_with = "strict_request")]
    request: ImmutableHttpRequest,
    request_fingerprint: Sha256Fingerprint,
    #[serde(deserialize_with = "crate::wire::required_nullable")]
    result: Option<ObservedOutcome>,
}

fn strict_target_create_step<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<CrossAccountMoveStep, D::Error> {
    // Internally tagged unit variants otherwise accept positional arrays and ignore extra map
    // fields. This one-field object is the complete step schema for the parked Create request.
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Step {
        #[serde(rename = "type")]
        kind: String,
    }
    let step: Step = strict_map(deserializer)?;
    if step.kind == "targetCreate" {
        Ok(CrossAccountMoveStep::TargetCreate)
    } else {
        Err(serde::de::Error::custom(
            "unavailable source evidence requires its fixed target Create step",
        ))
    }
}

#[derive(Deserialize)]
#[serde(
    remote = "ImmutableHttpRequest",
    rename_all = "camelCase",
    deny_unknown_fields
)]
struct StrictRequest {
    method: HttpMethod,
    path: String,
    #[serde(deserialize_with = "strict_headers")]
    headers: Vec<HttpHeader>,
    body: Vec<u8>,
}

fn strict_headers<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<HttpHeader>, D::Error> {
    struct Header(HttpHeader);
    impl<'de> Deserialize<'de> for Header {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            strict_map(deserializer).map(Self)
        }
    }
    Vec::<Header>::deserialize(deserializer)
        .map(|headers| headers.into_iter().map(|header| header.0).collect())
}

macro_rules! strict_remote_map {
    ($function:ident, $wire:ident, $value:ty) => {
        fn $function<'de, D: serde::Deserializer<'de>>(
            deserializer: D,
        ) -> Result<$value, D::Error> {
            struct Object;
            impl<'de> serde::de::Visitor<'de> for Object {
                type Value = $value;
                fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                    f.write_str("a typed control object")
                }
                fn visit_map<A: serde::de::MapAccess<'de>>(
                    self,
                    map: A,
                ) -> Result<Self::Value, A::Error> {
                    $wire::deserialize(serde::de::value::MapAccessDeserializer::new(map))
                }
            }
            deserializer.deserialize_map(Object)
        }
    };
}
strict_remote_map!(
    strict_target_create,
    StrictTargetCreate,
    CrossAccountMoveItemOperation
);
strict_remote_map!(strict_request, StrictRequest, ImmutableHttpRequest);

impl From<CrossAccountMoveRecord> for CrossAccountMoveEntry {
    fn from(record: CrossAccountMoveRecord) -> Self {
        Self::Captured(Box::new(record))
    }
}
impl From<Box<CrossAccountMoveRecord>> for CrossAccountMoveEntry {
    fn from(record: Box<CrossAccountMoveRecord>) -> Self {
        Self::Captured(record)
    }
}
impl From<LegacySourceUnavailableMove> for CrossAccountMoveEntry {
    fn from(record: LegacySourceUnavailableMove) -> Self {
        Self::LegacySourceUnavailable(Box::new(record))
    }
}

impl CrossAccountMoveEntry {
    pub(crate) fn captured(&self) -> Option<&CrossAccountMoveRecord> {
        match self {
            Self::Captured(record) => Some(record),
            Self::LegacySourceUnavailable(_) => None,
        }
    }
    pub(crate) fn captured_mut(&mut self) -> Option<&mut CrossAccountMoveRecord> {
        match self {
            Self::Captured(record) => Some(record),
            Self::LegacySourceUnavailable(_) => None,
        }
    }
    #[cfg(test)]
    pub(crate) fn into_captured(self) -> Option<CrossAccountMoveRecord> {
        match self {
            Self::Captured(record) => Some(*record),
            Self::LegacySourceUnavailable(_) => None,
        }
    }
    pub(crate) fn source_unavailable(&self) -> Option<&LegacySourceUnavailableMove> {
        match self {
            Self::Captured(_) => None,
            Self::LegacySourceUnavailable(record) => Some(record),
        }
    }
    pub(crate) fn operation_id(&self) -> &str {
        match self {
            Self::Captured(record) => &record.operation_id,
            Self::LegacySourceUnavailable(record) => &record.operation_id,
        }
    }
    pub(crate) fn source_item_id(&self) -> &str {
        match self {
            Self::Captured(record) => &record.source.id,
            Self::LegacySourceUnavailable(record) => {
                &record.legacy_admission.source_command.entity_id
            }
        }
    }
    pub(crate) fn source_vault_id(&self) -> &str {
        match self {
            Self::Captured(record) => &record.source.vault_id,
            Self::LegacySourceUnavailable(record) => {
                &record.legacy_admission.source_command.vault_id
            }
        }
    }
    pub(crate) fn source_identity(&self) -> &CrossAccountMoveIdentity {
        match self {
            Self::Captured(record) => &record.source_identity,
            Self::LegacySourceUnavailable(record) => &record.source_identity,
        }
    }
    pub(crate) fn destination_identity(&self) -> &CrossAccountMoveIdentity {
        match self {
            Self::Captured(record) => &record.destination_identity,
            Self::LegacySourceUnavailable(record) => &record.destination_identity,
        }
    }
    pub(crate) fn destination_binding(&self) -> &CrossAccountMoveDestinationBinding {
        match self {
            Self::Captured(record) => &record.destination_binding,
            Self::LegacySourceUnavailable(record) => &record.destination_binding,
        }
    }
    fn destination_binding_mut(&mut self) -> &mut CrossAccountMoveDestinationBinding {
        match self {
            Self::Captured(record) => &mut record.destination_binding,
            Self::LegacySourceUnavailable(record) => &mut record.destination_binding,
        }
    }
    pub(crate) fn destination_vault_id(&self) -> &str {
        match self {
            Self::Captured(record) => &record.target.vault_id,
            Self::LegacySourceUnavailable(record) => record
                .legacy_admission
                .source_command
                .target_vault_id
                .as_deref()
                .unwrap_or(""),
        }
    }
    pub(crate) fn scheduling(&self) -> &OperationSchedulingState {
        match self {
            Self::Captured(record) => &record.scheduling,
            Self::LegacySourceUnavailable(record) => &record.scheduling,
        }
    }
    pub(crate) fn owns_source_item(&self) -> bool {
        match self {
            Self::Captured(record) => record.owns_source_item(),
            Self::LegacySourceUnavailable(record) => !record.legacy_admission.disposition.is_held(),
        }
    }
    pub(crate) fn reserved_child_operation_ids(&self) -> Vec<String> {
        match self {
            Self::Captured(record) => record.reserved_child_operation_ids(),
            Self::LegacySourceUnavailable(record) => {
                ["create-target", "trash-source", "delete-source"]
                    .into_iter()
                    .map(|suffix| format!("{}:{suffix}", record.operation_id))
                    .collect()
            }
        }
    }
    pub(crate) fn validate(&self, account: &AccountId, user_id: &str) -> Result<(), RuntimeError> {
        match self {
            Self::Captured(record) => record.validate(account, user_id),
            Self::LegacySourceUnavailable(record) => record.validate(account, user_id),
        }
    }
    pub(super) fn validate_source_overlay(
        &self,
        account: &AccountId,
        overlay: &ReplicaItemRecord,
    ) -> Result<(), RuntimeError> {
        match self {
            Self::Captured(record) => record.validate_source_overlay(account, overlay),
            Self::LegacySourceUnavailable(_) => Err(replica_invariant(
                "Unavailable source evidence cannot own an Item overlay",
            )),
        }
    }
    pub(super) fn retire_destination(
        &mut self,
        revision: u64,
        account: &AccountId,
        incarnation: &Incarnation,
    ) -> Result<(), RuntimeError> {
        let binding = self.destination_binding_mut();
        if binding.binding_revision != revision
            || binding.account_id != *account
            || binding.incarnation != *incarnation
            || binding.status != CrossAccountMoveBindingStatus::Active
        {
            return Err(replica_invariant(
                "Cross-Account Move retirement has no exact destination binding",
            ));
        }
        binding.binding_revision = increment_revision(binding.binding_revision)?;
        binding.status = CrossAccountMoveBindingStatus::Retired;
        if let Some(record) = self.captured_mut() {
            if !matches!(
                record.stage,
                CrossAccountMoveStage::Completed | CrossAccountMoveStage::Rejected
            ) {
                record.disposition = CrossAccountMoveDisposition::Blocked {
                    reason: CrossAccountMoveBlockedReason::DestinationRetired,
                };
            }
        }
        Ok(())
    }
}

impl LegacySourceUnavailableMove {
    pub(crate) fn bind(
        admission: LegacyCrossAccountMoveAdmission,
        source_identity: CrossAccountMoveIdentity,
        destination_identity: CrossAccountMoveIdentity,
        destination_binding: CrossAccountMoveDestinationBinding,
        target_create: CrossAccountMoveItemOperation,
    ) -> Result<Self, RuntimeError> {
        let record = Self {
            kind: UnavailableSourceTag::LegacySourceUnavailable,
            version: 1,
            operation_id: admission.source_command.id.clone(),
            source_identity,
            destination_identity,
            destination_binding,
            target_create,
            scheduling: admission.initial_scheduling(),
            legacy_admission: Box::new(admission),
        };
        record.validate(
            &record.legacy_admission.source_command.account_id,
            &record.source_identity.user_id,
        )?;
        if record.destination_binding.status != CrossAccountMoveBindingStatus::Active
            || record.destination_binding.binding_revision != 0
        {
            return Err(replica_invariant(
                "Unavailable source admission requires its original active binding",
            ));
        }
        Ok(record)
    }

    fn validate(&self, account: &AccountId, user_id: &str) -> Result<(), RuntimeError> {
        validate_cross_account_identity(&self.source_identity)?;
        validate_cross_account_identity(&self.destination_identity)?;
        let admission = &self.legacy_admission;
        let command = &admission.source_command;
        let Some(WorkflowAcceptedPayload::Target {
            encryption_version,
            encrypted_by_user_id,
        }) = &command.encrypted_payload
        else {
            return Err(replica_invariant(
                "Unavailable source Move has no original target payload reference",
            ));
        };
        // Supported histories remain parked; attempt and hold status preserve producer provenance.
        let supported_history = match command.status {
            Some(LegacyItemCommandStatus::Staged) => {
                admission.disposition == LegacyWorkflowDisposition::Normal
                    && command.retry_count == 0
                    && command.attempt_id.as_deref() == Some(self.operation_id.as_str())
                    && command
                        .projection_claim_id
                        .as_deref()
                        .is_some_and(|claim| !claim.is_empty())
                    && command.projection_claim_expires_at.is_some()
                    && command.next_attempt_at.is_none()
                    && command.last_error.is_none()
                    && command.conflict_copy_id.is_none()
            }
            Some(LegacyItemCommandStatus::Applying) => {
                admission.disposition == LegacyWorkflowDisposition::Normal
                    && command.retry_count == 0
                    && command.attempt_id.as_deref() == Some(self.operation_id.as_str())
                    && command.projection_claim_id.is_none()
                    && command.projection_claim_expires_at.is_none()
                    && command.next_attempt_at.is_none()
                    && command.last_error.is_none()
                    && command.conflict_copy_id.is_none()
            }
            Some(LegacyItemCommandStatus::Pending) => {
                admission.disposition == LegacyWorkflowDisposition::Normal
                    && command.retry_count == 0
                    && command.attempt_id.as_deref() == Some(self.operation_id.as_str())
            }
            Some(LegacyItemCommandStatus::Retrying) => {
                admission.disposition == LegacyWorkflowDisposition::Normal
                    && (1..=4).contains(&command.retry_count)
                    && command
                        .attempt_id
                        .as_deref()
                        .is_some_and(|attempt| !attempt.is_empty() && attempt != self.operation_id)
                    && command.next_attempt_at.is_some()
                    && command.last_error.is_some()
            }
            Some(LegacyItemCommandStatus::Failed) => {
                admission.disposition == LegacyWorkflowDisposition::LegacyFailed
                    && match command.retry_count {
                        0 => {
                            command.attempt_id.as_deref() == Some(self.operation_id.as_str())
                                && command.next_attempt_at.is_none()
                        }
                        1..=4 => command.attempt_id.as_deref().is_some_and(|attempt| {
                            !attempt.is_empty()
                                && (attempt != self.operation_id
                                    || command.next_attempt_at.is_some())
                        }),
                        5 => {
                            command
                                .attempt_id
                                .as_deref()
                                .is_some_and(|attempt| !attempt.is_empty())
                                && command.next_attempt_at.is_none()
                        }
                        _ => false,
                    }
                    && command.last_error.is_some()
            }
            Some(LegacyItemCommandStatus::Conflicted) => {
                admission.disposition == LegacyWorkflowDisposition::LegacyConflicted
                    && match command.retry_count {
                        0 => command.attempt_id.as_deref() == Some(self.operation_id.as_str()),
                        1..=4 => command
                            .attempt_id
                            .as_deref()
                            .is_some_and(|attempt| !attempt.is_empty()),
                        _ => false,
                    }
                    && command.next_attempt_at.is_none()
                    && command.last_error.is_some()
                    && command
                        .conflict_copy_id
                        .as_deref()
                        .is_some_and(|id| !id.is_empty())
            }
            _ => false,
        };
        if self.version != 1
            || admission.version != LEGACY_OPERATION_ADMISSION_VERSION
            || admission.admission_id.is_empty()
            || !supported_history
            || command.id != self.operation_id
            || self.operation_id.is_empty()
            || command.operation_id.as_deref() != Some(self.operation_id.as_str())
            || command.kind != LegacyItemCommandKind::CrossAccountMove
            || command.account_id != *account
            || account.as_str().is_empty()
            || self.source_identity.user_id != user_id
            || self.source_identity == self.destination_identity
            || command.entity_id.is_empty()
            || command.vault_id.is_empty()
            || command.base_version < 1
            || command.base_version.checked_add(2).is_none()
            || command.favorite.is_some()
            || (command.status != Some(LegacyItemCommandStatus::Conflicted)
                && command.conflict_copy_id.is_some())
            || command.account_email.as_ref().is_some_and(String::is_empty)
            || command
                .projection_claim_id
                .as_ref()
                .is_some_and(String::is_empty)
            || command.target_account_id.as_ref() != Some(&self.destination_binding.account_id)
            || self.destination_binding.account_id == *account
            || self.destination_binding.account_id.as_str().is_empty()
            || self.destination_binding.incarnation.as_str().is_empty()
            || command
                .target_item_id
                .as_ref()
                .is_none_or(|id| id.is_empty() || id == &command.entity_id)
            || command
                .target_vault_id
                .as_ref()
                .is_none_or(String::is_empty)
            || *encryption_version != 1
            || encrypted_by_user_id != &self.destination_identity.user_id
            || self.scheduling != admission.initial_scheduling()
            || match self.destination_binding.status {
                CrossAccountMoveBindingStatus::Active => {
                    self.destination_binding.binding_revision != 0
                }
                CrossAccountMoveBindingStatus::Retired => {
                    self.destination_binding.binding_revision != 1
                }
            }
            || [
                command.timestamp,
                command.retry_count,
                command.next_attempt_at.unwrap_or(0),
                command.projection_claim_expires_at.unwrap_or(0),
            ]
            .into_iter()
            .any(|value| value > 9_007_199_254_740_991)
        {
            return Err(replica_invariant(
                "Unavailable source Move disagrees with its original command history",
            ));
        }
        source_timestamp(command.timestamp)?;
        let target_id = command.target_item_id.as_deref().unwrap_or("");
        let target_vault = command.target_vault_id.as_deref().unwrap_or("");
        let create = &self.target_create;
        let body: crate::server_contract::CreateItemBody =
            serde_json::from_slice(&create.request.body).map_err(|_| {
                replica_invariant("Unavailable source Move target request is invalid")
            })?;
        let canonical = legacy_cross_account_admission::legacy_target_create_body(
            command.category.ok_or_else(|| {
                replica_invariant("Unavailable source target category is missing")
            })?,
            &body.encrypted_data,
            &body.encryption_iv,
            &body.encryption_algorithm,
        )?;
        if create.step != CrossAccountMoveStep::TargetCreate
            || create.endpoint != CrossAccountMoveEndpoint::Destination
            || create.kind != OperationKind::CreateItem
            || create.operation_id != format!("{}:create-target", self.operation_id)
            || create.target
                != (ResourceRef::Item {
                    item_id: target_id.into(),
                    vault_id: target_vault.into(),
                })
            || create.result.is_some()
            || create.request.method != HttpMethod::Put
            || create.request.path
                != format!(
                    "/api/v1/vaults/{}/items/{}",
                    encode_component(target_vault),
                    encode_component(target_id)
                )
            || create.request.headers
                != [HttpHeader {
                    name: "Content-Type".into(),
                    value: "application/json".into(),
                }]
            || create.request.body != canonical
            || body.encrypted_data.is_empty()
            || body.encryption_iv.is_empty()
            || body.encryption_algorithm.is_empty()
            || command.category.map(AuthorityItemCategory::from)
                != Some(AuthorityItemCategory::from(body.category))
            || create.request_fingerprint
                != create_item_fingerprint(target_vault, target_id, &create.request.body)
        {
            return Err(replica_invariant(
                "Unavailable source Move changed its original target request",
            ));
        }
        verify_item_request_path(&create.to_operation()?, true)?;
        Ok(())
    }
}

impl AccountReplica {
    pub(super) fn admit_legacy_source_unavailable_move(
        &mut self,
        record: LegacySourceUnavailableMove,
    ) -> Result<(), RuntimeError> {
        record.validate(&self.account_id, &self.user_id)?;
        let command = &record.legacy_admission.source_command;
        let held = record.legacy_admission.disposition.is_held();
        self.bootstrap.validate()?;
        self.snapshot()
            .require_vault_accepting_work(&command.vault_id)?;
        if !self
            .bootstrap
            .snapshot()
            .visible_vaults
            .iter()
            .any(|vault| {
                vault.id == command.vault_id && (held || vault.role != AuthorityVaultRole::ReadOnly)
            })
        {
            return Err(replica_invariant(
                "Unavailable source Move requires its permitted current source Vault",
            ));
        }
        if self.bootstrap.state != ReplicaState::Ready
            || record.destination_binding.status != CrossAccountMoveBindingStatus::Active
            || record.destination_binding.binding_revision != 0
            || self
                .bootstrap
                .pending_vault_retirements
                .contains(&command.vault_id)
            || self
                .bootstrap
                .active_generation
                .as_ref()
                .and_then(|generation| {
                    self.bootstrap
                        .items
                        .get(&(generation.clone(), command.entity_id.clone()))
                })
                .is_some()
            || (!held
                && (self
                    .snapshot()
                    .item_has_optimistic_owner(&command.entity_id)
                    || self.items.contains_key(&command.entity_id)))
            || self.operations.contains_key(&record.operation_id)
            || self.receipts.contains_key(&record.operation_id)
            || self
                .attachment_move_preparations
                .contains_key(&record.operation_id)
            || self.cross_account_moves.contains_key(&record.operation_id)
        {
            return Err(replica_invariant(
                "Unavailable source Move admission conflicts with authority or accepted work",
            ));
        }
        let mut next = self.clone();
        next.cross_account_moves
            .insert(record.operation_id.clone(), record.into());
        next.validate_durable_work()?;
        self.cross_account_moves = next.cross_account_moves;
        Ok(())
    }
}
