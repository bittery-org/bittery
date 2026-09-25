use serde::{Deserialize, Serialize};
use std::fmt;

/// A one-time invitation token. Its JSON representation is still a string,
/// while Runtime diagnostics redact the value.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct InvitationToken(crate::SecretString);

impl From<String> for InvitationToken {
    fn from(value: String) -> Self {
        Self(value.into())
    }
}

impl InvitationToken {
    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Borrow the one-time value only for an explicit presentation handoff.
    /// Native bindings copy it into an opaque, redacted object before the Core
    /// response is dropped; ordinary generated records never carry this value.
    pub fn expose_for_delivery(&self) -> &str {
        self.0.as_ref()
    }
}

impl fmt::Debug for InvitationToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("InvitationToken([redacted])")
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvitationComposerVault {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvitationSeatPreviewLine {
    pub id: String,
    pub description: String,
    pub amount_cents: String,
    pub currency: String,
    pub period_start: String,
    pub period_end: String,
    pub quantity: Option<String>,
    pub unit_amount_cents: Option<String>,
    pub is_proration: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvitationSeatPreview {
    pub currency: String,
    pub current_quantity: String,
    pub next_quantity: String,
    pub estimated_next_payment_cents: String,
    pub total_line_items_cents: String,
    pub lines: Vec<InvitationSeatPreviewLine>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvitationComposerData {
    pub team_id: String,
    pub vaults: Vec<InvitationComposerVault>,
    pub billing_enabled: bool,
    pub team_plan_active: bool,
    pub seat_preview: Option<InvitationSeatPreview>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvitationCandidate {
    pub recipient_user_id: String,
    pub public_key: String,
    pub fingerprint: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum InvitationUncertainPhase {
    FirstSend,
    CancelOriginal,
    ReplacementSend,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum InvitationAdminAction {
    Cancel,
    Resend,
}

#[cfg(test)]
mod tests {
    use super::InvitationToken;

    #[test]
    fn one_time_token_keeps_string_wire_shape_without_debug_disclosure() {
        let token = InvitationToken::from("once-only-token".to_owned());
        assert_eq!(
            serde_json::to_string(&token).unwrap(),
            "\"once-only-token\""
        );
        assert!(!format!("{token:?}").contains("once-only-token"));
    }
}
