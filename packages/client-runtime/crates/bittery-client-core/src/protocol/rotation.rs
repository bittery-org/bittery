use super::*;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RotationIntent {
    VaultMemberRemoval { vault_id: String, user_id: String },
    TeamLeave { team_id: String },
    TeamMemberRemoval { team_id: String, user_id: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RotationPlanSelection {
    pub plan_id: String,
    pub vault_id: String,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "plain_i32_schema")
    )]
    pub expected_key_version: i32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RotationCandidate {
    pub user_id: String,
    pub public_key: String,
    pub fingerprint: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RotationSelection {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub incarnation_id: Incarnation,
    pub lock_epoch: String,
    pub authority_generation_id: String,
    pub intent: RotationIntent,
    pub start_operation_id: String,
    pub plans: Vec<RotationPlanSelection>,
    pub candidates: Vec<RotationCandidate>,
}

/// A nonterminal Team-leave attempt already owned by this Account's Replica journal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamLeaveAttempt {
    pub team_id: String,
    pub start_operation_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "snake_case")]
pub enum RotationStartRejectionCode {
    TeamMemberNotFound,
    PersonalTeamDepartureForbidden,
    TeamOwnerLeaveForbidden,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "snake_case")]
pub enum RotationFinalizeRejectionCode {
    TeamMembershipChanged,
    PersonalTeamDepartureForbidden,
    TeamOwnerLeaveForbidden,
    RotationPlanUnavailable,
    RotationPlanMismatch,
    RotationPlanIncomplete,
    RotationPlanStale,
    RotationPlanSetMismatch,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RotationTerminalOutcome {
    Applied { personal_team_id: String },
    Rejected { code: RotationFinalizeRejectionCode },
}
