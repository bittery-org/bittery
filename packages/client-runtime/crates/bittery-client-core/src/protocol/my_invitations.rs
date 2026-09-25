use serde::{Deserialize, Serialize};

/// Only authenticated pending Invitations addressed to this User are projected.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MyTeamInvitation {
    pub id: String,
    pub team_id: String,
    pub team_name: String,
    pub role: crate::server_contract::TeamRole,
    pub invited_by: String,
    pub expires_at: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum MyInvitationAction {
    Accept,
    Decline,
}
