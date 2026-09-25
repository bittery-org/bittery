use crate::server_contract::{ErrorCode, InvitationStatus};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum TeamPageRole {
    Owner,
    Admin,
    Member,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamPageUser {
    pub id: String,
    pub name: String,
    pub email: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamPageDetails {
    pub id: String,
    pub name: String,
    pub image_url: Option<String>,
    pub owner_id: String,
    pub owner_name: String,
    pub user_role: TeamPageRole,
    pub member_count: String,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "nullable_integer_schema")
    )]
    pub member_limit: Option<i32>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamPageMember {
    pub user_id: String,
    pub name: String,
    pub email: String,
    pub role: TeamPageRole,
    pub joined_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamPageInvitation {
    pub id: String,
    pub email: String,
    pub role: TeamPageRole,
    pub status: InvitationStatus,
    pub invited_by: String,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamPageData {
    pub user: TeamPageUser,
    pub team: Option<TeamPageDetails>,
    pub members: Vec<TeamPageMember>,
    pub invitations: Vec<TeamPageInvitation>,
    pub team_management_enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamPageFieldError {
    pub pointer: String,
    pub code: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamPageProblem {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "integer_schema")
    )]
    pub status: i32,
    pub code: ErrorCode,
    pub message: String,
    pub request_id: String,
    pub retryable: bool,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "nullable_integer_schema")
    )]
    pub retry_after_seconds: Option<u32>,
    pub field_errors: Vec<TeamPageFieldError>,
}

#[cfg(feature = "runtime-protocol-contract-schema")]
fn integer_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "type": "integer", "minimum": 0 })
}

#[cfg(feature = "runtime-protocol-contract-schema")]
fn nullable_integer_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "type": ["integer", "null"], "minimum": 0 })
}
