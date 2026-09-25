use crate::wire::{decimal_i64, decimal_u64};
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::watch;
use zeroize::{Zeroize, ZeroizeOnDrop};
mod invitations;
mod my_invitations;
mod rotation;
mod team_page;
mod vault_members;
pub use invitations::{
    InvitationAdminAction, InvitationCandidate, InvitationComposerData, InvitationComposerVault,
    InvitationSeatPreview, InvitationSeatPreviewLine, InvitationToken, InvitationUncertainPhase,
};
pub use my_invitations::{MyInvitationAction, MyTeamInvitation};
pub use rotation::{
    RotationCandidate, RotationFinalizeRejectionCode, RotationIntent, RotationPlanSelection,
    RotationSelection, RotationStartRejectionCode, RotationTerminalOutcome, TeamLeaveAttempt,
};
pub use team_page::{
    TeamPageData, TeamPageDetails, TeamPageFieldError, TeamPageInvitation, TeamPageMember,
    TeamPageProblem, TeamPageRole, TeamPageUser,
};
pub use vault_members::{AvailableVaultMember, CurrentVaultMember};

macro_rules! string_id {
    ($name:ident) => {
        #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }
    };
}

string_id!(AccountId);
string_id!(Incarnation);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum ProfileAdmissionImportPhase {
    Preparing,
    Aborting,
    Aborted,
    Committed,
    Complete,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum ProfileAdmissionResetPhase {
    Wiping,
    Wiped,
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
pub enum ProfileAdmissionInspectionState {
    NotStarted {},
    Import {
        admission_id: String,
        phase: ProfileAdmissionImportPhase,
    },
    Reset {
        wipe_id: String,
        phase: ProfileAdmissionResetPhase,
    },
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
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
pub enum RuntimeRequest {
    ListAvailableVaultMembers {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        vault_id: String,
    },
    ListVaultMembers {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        vault_id: String,
    },
    AddVaultMember {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        vault_id: String,
        user_id: String,
        role: crate::server_contract::VaultRole,
    },
    PrepareRotation {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        intent: RotationIntent,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        start_operation_id: Option<String>,
    },
    CompleteRotation {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        selection: RotationSelection,
    },
    InspectRotation {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        start_operation_id: String,
    },
    ListTeamLeaveAttempts {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
    },
    AcknowledgeTeamLeaveAttempt {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        start_operation_id: String,
    },
    ListMyTeamInvitations {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
    },
    AcceptMyTeamInvitation {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        invitation_id: String,
    },
    DeclineMyTeamInvitation {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        invitation_id: String,
    },
    ReadInvitationComposer {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        team_id: String,
    },
    CreateTeamInvitation {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        team_id: String,
        email: String,
        role: crate::server_contract::TeamRole,
    },
    ProvisionTeamInvitation {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        continuation_id: String,
    },
    ReleaseInvitationContinuation {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        continuation_id: String,
    },
    CancelTeamInvitation {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        team_id: String,
        invitation_id: String,
    },
    ResendTeamInvitation {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        team_id: String,
        invitation_id: String,
    },
    ReadTeamPage {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
    },
    InspectProfileAdmission {},
    AbortProfileAdmission {
        admission_id: String,
    },
    RecipientKeyScope {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
    },
    OwnKeyFingerprint {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
    },
    VerifyRecipientKey {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        recipient_user_id: String,
        public_key: String,
        expected_fingerprint: String,
        scope: String,
    },
    VerifiedRecipientKey {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        recipient_user_id: String,
        public_key: String,
        scope: String,
    },
    DisableTravelMode {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        master_password: crate::SecretString,
    },
    EnableTravelMode {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        hidden_vault_ids: Vec<String>,
    },
    SetTravelModeHiddenVaults {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        hidden_vault_ids: Vec<String>,
    },
    RefreshTravelMode {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
    },
    RebootstrapAccountRecovery {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
    },
    InspectRecovery {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "Option<String>")
        )]
        account_id: Option<AccountId>,
    },
    ExportAccountRecovery {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        password: String,
        sink_capability_id: String,
    },
    RepairAccountRecovery {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        password: String,
        source_capability_id: String,
    },
    SignIn {
        server_url: String,
        email: String,
        master_password: String,
        secret_key: String,
        insecure_transport_confirmed: bool,
    },
    BiometricAvailability {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "Vec<String>")
        )]
        account_ids: Vec<AccountId>,
    },
    SetBiometricEnabled {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        enabled: bool,
    },
    BiometricUnlock {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        prompt_message: String,
    },
    BiometricUnlockAccounts {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "Vec<String>")
        )]
        account_ids: Vec<AccountId>,
        prompt_message: String,
    },
    SetMasterPasswordReentryPeriod {
        #[serde(with = "decimal_i64")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "decimal_i64::json_schema")
        )]
        period_ms: i64,
    },
    LocalSecuritySettings {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
    },
    SetInactivityTimeout {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        #[serde(with = "decimal_i64")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "decimal_i64::json_schema")
        )]
        timeout_ms: i64,
    },
    RecordActivity {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        kind: ActivityKind,
    },
    DeviceSetup {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
    },
    QuickUnlockAccounts {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "Vec<String>")
        )]
        account_ids: Vec<AccountId>,
        master_password: String,
    },
    QuickUnlock {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        master_password: String,
    },
    /// Retires this Account's live keys and plaintext delivery while the Device keeps the
    /// material one master password reopens.
    Lock {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
    },
    /// Ends local ownership: the same retirement as `Lock`, and the Device forgets the
    /// Quick Unlock material and Session, so this Account needs a full Sign-in again.
    SignOut {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
    },
    /// Irreversibly removes exactly the explicitly named Account from this Device.
    RemoveAccount {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String", regex(pattern = "^[\\s\\S]+$"))
        )]
        account_id: AccountId,
    },
    /// Uses this installed Account's Runtime-owned Session to request authoritative Server
    /// deletion. The host retains the exact request identity until the workflow is closed.
    DeleteServerAccount {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String", regex(pattern = "^[\\s\\S]+$"))
        )]
        account_id: AccountId,
        confirm_email: String,
        request_id: String,
    },
    /// Irreversibly removes every Runtime-owned Account and Device record.
    Wipe,
    DeleteVault {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        vault_id: String,
    },
    UpdateVault {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        vault_id: String,
        name: Option<String>,
        icon: VaultIconPatch,
        image: VaultImageChange,
    },
    CreateVault {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        name: String,
        vault_type: CreateVaultType,
        icon: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        image_source: Option<VaultImageSourceInput>,
    },
    CreateItem {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        vault_id: String,
        #[serde(deserialize_with = "deserialize_editable_item_draft")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "EditableItemDraft")
        )]
        draft: ItemDraft,
    },
    ImportItems {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        vault_id: String,
        // `replica::MAX_IMPORT_ITEMS` owns the bound every accepting, fetching, and validating
        // path enforces, including the one this schema publishes to hosts.
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(length(max = crate::replica::MAX_IMPORT_ITEMS))
        )]
        items: Vec<ImportItemDraft>,
    },
    UpdateItem {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        item_id: String,
        guard: ItemEditGuard,
        #[serde(deserialize_with = "deserialize_editable_item_draft")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "EditableItemDraft")
        )]
        draft: ItemDraft,
    },
    RemovePasskey {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        item_id: String,
        guard: ItemEditGuard,
        rp_id: String,
        credential_id: String,
        public_key_fingerprint: String,
    },
    DuplicateItem {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        source_item_id: String,
        source_guard: ItemDuplicateGuard,
        title: String,
    },
    SetItemFavorite {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        item_id: String,
        favorite: bool,
    },
    TrashItem {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        item_id: String,
    },
    RestoreItem {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        item_id: String,
    },
    MoveItem {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        item_id: String,
        target_vault_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "Option<String>")
        )]
        target_account_id: Option<AccountId>,
    },
    PrepareCrossAccountMoveResume {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        operation_id: String,
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        target_account_id: AccountId,
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        expected_binding_revision: u64,
    },
    ResumeCrossAccountMove {
        guard: CrossAccountMoveResumeGuard,
    },
    PermanentlyDeleteItem {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        item_id: String,
    },
    CreateShare {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        item_id: String,
        draft: CreateShareDraft,
    },
    AcknowledgeShareResult {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        operation_id: String,
    },
    ListItemShareLinks {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        item_id: String,
    },
    ListShareAccessLogs {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        item_id: String,
        link_id: String,
    },
    RevokeShareLink {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        item_id: String,
        link_id: String,
    },
    RenameAttachment {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        attachment_id: String,
        name: String,
    },
    DeleteAttachment {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        attachment_id: String,
    },
    DownloadAttachment {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        attachment_id: String,
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(length(min = 1, max = 128), regex(pattern = "^[A-Za-z0-9._~-]+$"))
        )]
        sink_capability_id: String,
    },
    UploadAttachment {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        item_id: String,
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(length(min = 1, max = 255))
        )]
        name: String,
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(length(min = 1, max = 255))
        )]
        content_type: String,
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        file_size: u64,
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(length(min = 1, max = 128), regex(pattern = "^[A-Za-z0-9._~-]+$"))
        )]
        source_capability_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum VaultIconPatch {
    Unchanged,
    Clear,
    Set { value: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum VaultImageChange {
    Unchanged,
    Remove,
    Source { source: VaultImageSourceInput },
}

impl fmt::Debug for RuntimeRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ListAvailableVaultMembers {
                account_id,
                vault_id,
            }
            | Self::ListVaultMembers {
                account_id,
                vault_id,
            }
            | Self::AddVaultMember {
                account_id,
                vault_id,
                ..
            } => formatter
                .debug_struct("VaultMembership")
                .field("account_id", account_id)
                .field("vault_id", vault_id)
                .finish_non_exhaustive(),
            Self::PrepareRotation { account_id, .. }
            | Self::CompleteRotation { account_id, .. }
            | Self::InspectRotation { account_id, .. }
            | Self::ListTeamLeaveAttempts { account_id }
            | Self::AcknowledgeTeamLeaveAttempt { account_id, .. } => formatter
                .debug_struct("Rotation")
                .field("account_id", account_id)
                .finish_non_exhaustive(),
            Self::ListMyTeamInvitations { account_id }
            | Self::AcceptMyTeamInvitation { account_id, .. }
            | Self::DeclineMyTeamInvitation { account_id, .. } => formatter
                .debug_struct("MyTeamInvitation")
                .field("account_id", account_id)
                .finish_non_exhaustive(),
            Self::ReadInvitationComposer {
                account_id,
                team_id,
            }
            | Self::CreateTeamInvitation {
                account_id,
                team_id,
                ..
            }
            | Self::CancelTeamInvitation {
                account_id,
                team_id,
                ..
            }
            | Self::ResendTeamInvitation {
                account_id,
                team_id,
                ..
            } => formatter
                .debug_struct("TeamInvitation")
                .field("account_id", account_id)
                .field("team_id", team_id)
                .finish_non_exhaustive(),
            Self::ProvisionTeamInvitation { account_id, .. }
            | Self::ReleaseInvitationContinuation { account_id, .. } => formatter
                .debug_struct("InvitationContinuation")
                .field("account_id", account_id)
                .finish_non_exhaustive(),
            Self::ReadTeamPage { account_id } => formatter
                .debug_struct("ReadTeamPage")
                .field("account_id", account_id)
                .finish(),
            Self::RecipientKeyScope { account_id }
            | Self::OwnKeyFingerprint { account_id }
            | Self::VerifyRecipientKey { account_id, .. }
            | Self::VerifiedRecipientKey { account_id, .. } => formatter
                .debug_struct("RecipientKey")
                .field("account_id", account_id)
                .finish_non_exhaustive(),
            Self::SetTravelModeHiddenVaults {
                account_id,
                hidden_vault_ids,
            } => formatter
                .debug_struct("SetTravelModeHiddenVaults")
                .field("account_id", account_id)
                .field("hidden_vault_count", &hidden_vault_ids.len())
                .finish(),
            Self::EnableTravelMode {
                account_id,
                hidden_vault_ids,
            } => formatter
                .debug_struct("EnableTravelMode")
                .field("account_id", account_id)
                .field("hidden_vault_count", &hidden_vault_ids.len())
                .finish(),
            Self::DisableTravelMode { account_id, .. } => formatter
                .debug_struct("DisableTravelMode")
                .field("account_id", account_id)
                .field("master_password", &"[redacted]")
                .finish(),
            Self::RefreshTravelMode { account_id } => formatter
                .debug_struct("RefreshTravelMode")
                .field("account_id", account_id)
                .finish(),
            Self::RebootstrapAccountRecovery { .. } => {
                formatter.write_str("RebootstrapAccountRecovery([redacted scope])")
            }
            Self::InspectRecovery { account_id } => formatter
                .debug_struct("InspectRecovery")
                .field("account_id", account_id)
                .finish(),
            Self::ExportAccountRecovery { account_id, .. } => formatter
                .debug_struct("ExportAccountRecovery")
                .field("account_id", account_id)
                .field("password_and_capability", &"[redacted]")
                .finish(),
            Self::RepairAccountRecovery { account_id, .. } => formatter
                .debug_struct("RepairAccountRecovery")
                .field("account_id", account_id)
                .field("password_and_capability", &"[redacted]")
                .finish(),
            Self::SignIn {
                server_url, email, ..
            } => formatter
                .debug_struct("SignIn")
                .field("server_url", server_url)
                .field("email", email)
                .field("credentials", &"[redacted]")
                .finish(),
            Self::BiometricAvailability { .. } => {
                formatter.write_str("BiometricAvailability([redacted scope])")
            }
            Self::SetBiometricEnabled { .. } => {
                formatter.write_str("SetBiometricEnabled([redacted scope])")
            }
            Self::BiometricUnlock { .. } | Self::BiometricUnlockAccounts { .. } => {
                formatter.write_str("BiometricUnlock([redacted scope])")
            }
            Self::SetMasterPasswordReentryPeriod { period_ms } => formatter
                .debug_struct("SetMasterPasswordReentryPeriod")
                .field("period_ms", period_ms)
                .finish(),
            Self::LocalSecuritySettings { .. } => {
                formatter.write_str("LocalSecuritySettings([redacted])")
            }
            Self::SetInactivityTimeout { .. } => {
                formatter.write_str("SetInactivityTimeout([redacted])")
            }
            Self::RecordActivity { .. } => formatter.write_str("RecordActivity([redacted])"),
            Self::DeviceSetup { .. } => formatter.write_str("DeviceSetup([redacted])"),
            Self::QuickUnlockAccounts { .. } => {
                formatter.write_str("QuickUnlockAccounts([redacted])")
            }
            Self::QuickUnlock { account_id, .. } => formatter
                .debug_struct("QuickUnlock")
                .field("account_id", account_id)
                .field("credentials", &"[redacted]")
                .finish(),
            Self::Lock { account_id } => formatter
                .debug_struct("Lock")
                .field("account_id", account_id)
                .finish(),
            Self::SignOut { account_id } => formatter
                .debug_struct("SignOut")
                .field("account_id", account_id)
                .finish(),
            Self::RemoveAccount { .. } => formatter.write_str("RemoveAccount([redacted scope])"),
            Self::DeleteServerAccount { .. } => {
                formatter.write_str("DeleteServerAccount([redacted scope and confirmation])")
            }
            Self::AbortProfileAdmission { .. } => formatter.write_str("AbortProfileAdmission"),
            Self::InspectProfileAdmission {} => formatter.write_str("InspectProfileAdmission"),
            Self::Wipe => formatter.write_str("Wipe"),
            Self::DeleteVault {
                account_id,
                vault_id,
            } => formatter
                .debug_struct("DeleteVault")
                .field("account_id", account_id)
                .field("vault_id", vault_id)
                .finish(),
            Self::UpdateVault {
                account_id,
                vault_id,
                ..
            } => formatter
                .debug_struct("UpdateVault")
                .field("account_id", account_id)
                .field("vault_id", vault_id)
                .finish_non_exhaustive(),
            Self::CreateVault {
                account_id,
                name,
                vault_type,
                icon,
                image_source,
            } => formatter
                .debug_struct("CreateVault")
                .field("account_id", account_id)
                .field("name", name)
                .field("vault_type", vault_type)
                .field("icon", icon)
                .field("image_source", &image_source.as_ref().map(|_| "[redacted]"))
                .finish(),
            Self::CreateItem {
                account_id,
                vault_id,
                draft,
            } => formatter
                .debug_struct("CreateItem")
                .field("account_id", account_id)
                .field("vault_id", vault_id)
                .field("draft", draft)
                .finish(),
            Self::ImportItems {
                account_id,
                vault_id,
                items,
            } => formatter
                .debug_struct("ImportItems")
                .field("account_id", account_id)
                .field("vault_id", vault_id)
                .field("item_count", &items.len())
                .field("plaintext", &"[redacted]")
                .finish(),
            Self::UpdateItem {
                account_id,
                item_id,
                draft,
                ..
            } => formatter
                .debug_struct("UpdateItem")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .field("draft", draft)
                .finish(),
            Self::RemovePasskey {
                account_id,
                item_id,
                ..
            } => formatter
                .debug_struct("RemovePasskey")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .finish(),
            Self::DuplicateItem {
                account_id,
                source_item_id,
                ..
            } => formatter
                .debug_struct("DuplicateItem")
                .field("account_id", account_id)
                .field("source_item_id", source_item_id)
                .field("plaintext", &"[redacted]")
                .finish(),
            Self::SetItemFavorite {
                account_id,
                item_id,
                favorite,
            } => formatter
                .debug_struct("SetItemFavorite")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .field("favorite", favorite)
                .finish(),
            Self::TrashItem {
                account_id,
                item_id,
            } => formatter
                .debug_struct("TrashItem")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .finish(),
            Self::RestoreItem {
                account_id,
                item_id,
            } => formatter
                .debug_struct("RestoreItem")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .finish(),
            Self::MoveItem {
                account_id,
                item_id,
                target_vault_id,
                target_account_id,
            } => formatter
                .debug_struct("MoveItem")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .field("target_vault_id", target_vault_id)
                .field("target_account_id", target_account_id)
                .finish(),
            Self::PrepareCrossAccountMoveResume {
                account_id,
                operation_id,
                target_account_id,
                expected_binding_revision,
            } => formatter
                .debug_struct("PrepareCrossAccountMoveResume")
                .field("account_id", account_id)
                .field("operation_id", operation_id)
                .field("target_account_id", target_account_id)
                .field("expected_binding_revision", expected_binding_revision)
                .finish(),
            Self::ResumeCrossAccountMove { guard } => formatter
                .debug_struct("ResumeCrossAccountMove")
                .field("guard", guard)
                .finish(),
            Self::PermanentlyDeleteItem {
                account_id,
                item_id,
            } => formatter
                .debug_struct("PermanentlyDeleteItem")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .finish(),
            Self::CreateShare {
                account_id,
                item_id,
                draft,
            } => formatter
                .debug_struct("CreateShare")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .field("draft", draft)
                .finish(),
            Self::AcknowledgeShareResult {
                account_id,
                operation_id,
            } => formatter
                .debug_struct("AcknowledgeShareResult")
                .field("account_id", account_id)
                .field("operation_id", operation_id)
                .finish(),
            Self::ListItemShareLinks {
                account_id,
                item_id,
            } => formatter
                .debug_struct("ListItemShareLinks")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .finish(),
            Self::ListShareAccessLogs {
                account_id,
                item_id,
                link_id,
            } => formatter
                .debug_struct("ListShareAccessLogs")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .field("link_id", link_id)
                .finish(),
            Self::RevokeShareLink {
                account_id,
                item_id,
                link_id,
            } => formatter
                .debug_struct("RevokeShareLink")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .field("link_id", link_id)
                .finish(),
            Self::RenameAttachment {
                account_id,
                attachment_id,
                ..
            } => formatter
                .debug_struct("RenameAttachment")
                .field("account_id", account_id)
                .field("attachment_id", attachment_id)
                .field("plaintext", &"[redacted]")
                .finish(),
            Self::DeleteAttachment {
                account_id,
                attachment_id,
            } => formatter
                .debug_struct("DeleteAttachment")
                .field("account_id", account_id)
                .field("attachment_id", attachment_id)
                .finish(),
            Self::DownloadAttachment {
                account_id,
                attachment_id,
                ..
            } => formatter
                .debug_struct("DownloadAttachment")
                .field("account_id", account_id)
                .field("attachment_id", attachment_id)
                .field("sink_capability", &"[redacted]")
                .finish(),
            Self::UploadAttachment {
                account_id,
                item_id,
                file_size,
                ..
            } => formatter
                .debug_struct("UploadAttachment")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .field("file_size", file_size)
                .field("plaintext_and_source_capability", &"[redacted]")
                .finish(),
        }
    }
}

impl RuntimeRequest {
    pub fn account_id(&self) -> Option<&AccountId> {
        match self {
            Self::ListAvailableVaultMembers { account_id, .. }
            | Self::ListVaultMembers { account_id, .. }
            | Self::AddVaultMember { account_id, .. } => Some(account_id),
            Self::PrepareRotation { account_id, .. }
            | Self::CompleteRotation { account_id, .. }
            | Self::InspectRotation { account_id, .. }
            | Self::ListTeamLeaveAttempts { account_id }
            | Self::AcknowledgeTeamLeaveAttempt { account_id, .. } => Some(account_id),
            Self::ListMyTeamInvitations { account_id }
            | Self::AcceptMyTeamInvitation { account_id, .. }
            | Self::DeclineMyTeamInvitation { account_id, .. } => Some(account_id),
            Self::ReadInvitationComposer { account_id, .. }
            | Self::CreateTeamInvitation { account_id, .. }
            | Self::ProvisionTeamInvitation { account_id, .. }
            | Self::ReleaseInvitationContinuation { account_id, .. } => Some(account_id),
            Self::CancelTeamInvitation { account_id, .. }
            | Self::ResendTeamInvitation { account_id, .. } => Some(account_id),
            Self::ReadTeamPage { account_id } => Some(account_id),
            Self::RecipientKeyScope { account_id }
            | Self::OwnKeyFingerprint { account_id }
            | Self::VerifyRecipientKey { account_id, .. }
            | Self::VerifiedRecipientKey { account_id, .. } => Some(account_id),
            Self::DisableTravelMode { account_id, .. }
            | Self::EnableTravelMode { account_id, .. }
            | Self::SetTravelModeHiddenVaults { account_id, .. }
            | Self::RefreshTravelMode { account_id }
            | Self::LocalSecuritySettings { account_id }
            | Self::SetInactivityTimeout { account_id, .. }
            | Self::RecordActivity { account_id, .. } => Some(account_id),
            Self::RebootstrapAccountRecovery { account_id } => Some(account_id),
            Self::InspectRecovery { account_id } => account_id.as_ref(),
            Self::ExportAccountRecovery { account_id, .. }
            | Self::RepairAccountRecovery { account_id, .. } => Some(account_id),
            Self::SignIn { .. }
            | Self::QuickUnlockAccounts { .. }
            | Self::BiometricAvailability { .. }
            | Self::BiometricUnlockAccounts { .. }
            | Self::SetMasterPasswordReentryPeriod { .. } => None,
            Self::SetBiometricEnabled { account_id, .. }
            | Self::BiometricUnlock { account_id, .. } => Some(account_id),
            Self::QuickUnlock { account_id, .. } | Self::DeviceSetup { account_id } => {
                Some(account_id)
            }
            Self::Lock { account_id } | Self::SignOut { account_id } => Some(account_id),
            Self::RemoveAccount { account_id } => Some(account_id),
            Self::DeleteServerAccount { account_id, .. } => Some(account_id),
            Self::AbortProfileAdmission { .. } | Self::InspectProfileAdmission {} | Self::Wipe => {
                None
            }
            Self::CreateVault { account_id, .. }
            | Self::UpdateVault { account_id, .. }
            | Self::DeleteVault { account_id, .. }
            | Self::CreateItem { account_id, .. }
            | Self::ImportItems { account_id, .. }
            | Self::UpdateItem { account_id, .. }
            | Self::RemovePasskey { account_id, .. }
            | Self::DuplicateItem { account_id, .. }
            | Self::SetItemFavorite { account_id, .. }
            | Self::TrashItem { account_id, .. }
            | Self::RestoreItem { account_id, .. }
            | Self::MoveItem { account_id, .. }
            | Self::PrepareCrossAccountMoveResume { account_id, .. }
            | Self::PermanentlyDeleteItem { account_id, .. }
            | Self::CreateShare { account_id, .. }
            | Self::AcknowledgeShareResult { account_id, .. }
            | Self::ListItemShareLinks { account_id, .. }
            | Self::ListShareAccessLogs { account_id, .. }
            | Self::RevokeShareLink { account_id, .. }
            | Self::RenameAttachment { account_id, .. }
            | Self::DeleteAttachment { account_id, .. }
            | Self::DownloadAttachment { account_id, .. }
            | Self::UploadAttachment { account_id, .. } => Some(account_id),
            Self::ResumeCrossAccountMove { guard } => Some(&guard.account_id),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum CreateVaultType {
    Personal,
    Shared,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultImageSourceInput {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(length(min = 1, max = 128), regex(pattern = "^[A-Za-z0-9._~-]+$"))
    )]
    pub capability_id: String,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub byte_length: u64,
    pub content_type: String,
}

impl fmt::Debug for VaultImageSourceInput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VaultImageSourceInput")
            .field("capability", &"[redacted]")
            .field("byte_length", &self.byte_length)
            .field("content_type", &self.content_type)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct CreateShareDraft {
    pub access_mode: ShareAccessMode,
    pub expires_in: ShareExpiration,
    #[serde(default)]
    pub is_one_time_use: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_emails: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShareAllowedEmail {
    pub email: String,
    pub verified: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShareLinkSummary {
    pub id: String,
    pub status: ShareLinkStatus,
    pub access_mode: ShareAccessMode,
    pub is_one_time_use: bool,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "plain_i32_schema")
    )]
    pub access_count: i32,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "optional_plain_i32_schema")
    )]
    pub max_access_count: Option<i32>,
    pub allowed_emails: Vec<ShareAllowedEmail>,
    pub expires_at: String,
    pub created_at: String,
    pub last_accessed_at: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShareAccessLog {
    pub id: String,
    pub accessed_by_email: Option<String>,
    pub ip_address: Option<String>,
    pub user_agent: Option<String>,
    pub success: bool,
    pub failure_reason: Option<String>,
    pub accessed_at: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "snake_case")]
pub enum ShareLinkStatus {
    Active,
    Expired,
    Exhausted,
    Revoked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "kebab-case")]
pub enum ShareAccessMode {
    Anyone,
    EmailRestricted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
pub enum ShareExpiration {
    #[serde(rename = "1hour")]
    OneHour,
    #[serde(rename = "1day")]
    OneDay,
    #[serde(rename = "7days")]
    SevenDays,
    #[serde(rename = "14days")]
    FourteenDays,
    #[serde(rename = "30days")]
    ThirtyDays,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoginItemData {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub password_history: Vec<PasswordHistoryEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub passkeys: Vec<Passkey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_fields: Vec<CustomField>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_issuer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_account_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_algorithm: Option<TotpAlgorithm>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_digits: Option<TotpDigits>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "optional_plain_u32_schema")
    )]
    pub totp_period: Option<u32>,
}

impl fmt::Debug for LoginItemData {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LoginItemData")
            .field("plaintext", &"[redacted]")
            .field("custom_field_count", &self.custom_fields.len())
            .field("tag_count", &self.tags.len())
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(tag = "category", content = "data", deny_unknown_fields)]
pub enum ItemDraft {
    #[serde(rename = "login")]
    Login(LoginItemData),
    #[serde(rename = "secure-note")]
    SecureNote(SecureNoteItemData),
    #[serde(rename = "credit-card")]
    CreditCard(CreditCardItemData),
    #[serde(rename = "identity")]
    Identity(IdentityItemData),
    #[serde(rename = "authenticator")]
    Authenticator(AuthenticatorItemData),
}

/// The ordinary Item surface. Credential metadata is visible, but signing material is not.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(tag = "category", content = "data", deny_unknown_fields)]
pub enum PublicItemDraft {
    #[serde(rename = "login")]
    Login(PublicLoginItemData),
    #[serde(rename = "secure-note")]
    SecureNote(SecureNoteItemData),
    #[serde(rename = "credit-card")]
    CreditCard(CreditCardItemData),
    #[serde(rename = "identity")]
    Identity(IdentityItemData),
    #[serde(rename = "authenticator")]
    Authenticator(AuthenticatorItemData),
}

/// A normal Create or Update cannot submit a credential, even if the caller forges JSON.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(tag = "category", content = "data", deny_unknown_fields)]
pub enum EditableItemDraft {
    #[serde(rename = "login")]
    Login(EditableLoginItemData),
    #[serde(rename = "secure-note")]
    SecureNote(SecureNoteItemData),
    #[serde(rename = "credit-card")]
    CreditCard(CreditCardItemData),
    #[serde(rename = "identity")]
    Identity(IdentityItemData),
    #[serde(rename = "authenticator")]
    Authenticator(AuthenticatorItemData),
}

impl EditableItemDraft {
    pub fn into_private(self, passkeys: Vec<Passkey>) -> ItemDraft {
        match self {
            Self::Login(value) => ItemDraft::Login(value.into_private(passkeys)),
            Self::SecureNote(value) => ItemDraft::SecureNote(value),
            Self::CreditCard(value) => ItemDraft::CreditCard(value),
            Self::Identity(value) => ItemDraft::Identity(value),
            Self::Authenticator(value) => ItemDraft::Authenticator(value),
        }
    }
}

fn deserialize_editable_item_draft<'de, D>(deserializer: D) -> Result<ItemDraft, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(EditableItemDraft::deserialize(deserializer)?.into_private(Vec::new()))
}

impl From<&ItemDraft> for PublicItemDraft {
    fn from(value: &ItemDraft) -> Self {
        match value {
            ItemDraft::Login(value) => Self::Login(PublicLoginItemData::from(value)),
            ItemDraft::SecureNote(value) => Self::SecureNote(value.clone()),
            ItemDraft::CreditCard(value) => Self::CreditCard(value.clone()),
            ItemDraft::Identity(value) => Self::Identity(value.clone()),
            ItemDraft::Authenticator(value) => Self::Authenticator(value.clone()),
        }
    }
}

impl PublicItemDraft {
    pub fn title(&self) -> &str {
        match self {
            Self::Login(value) => &value.editable.title,
            Self::SecureNote(value) => &value.title,
            Self::CreditCard(value) => &value.title,
            Self::Identity(value) => &value.title,
            Self::Authenticator(value) => &value.title,
        }
    }

    pub fn password(&self) -> Option<&str> {
        match self {
            Self::Login(value) => value.editable.password.as_deref(),
            _ => None,
        }
    }
}

impl fmt::Debug for PublicItemDraft {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let category = match self {
            Self::Login(_) => "login",
            Self::SecureNote(_) => "secure-note",
            Self::CreditCard(_) => "credit-card",
            Self::Identity(_) => "identity",
            Self::Authenticator(_) => "authenticator",
        };
        formatter
            .debug_struct("PublicItemDraft")
            .field("category", &category)
            .field("plaintext", &"[redacted]")
            .finish()
    }
}

/// Ordinary callers can edit the Login fields shown in the UI, never its credential array.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditableLoginItemData {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub password_history: Vec<PasswordHistoryEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_fields: Vec<CustomField>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_issuer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_account_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_algorithm: Option<TotpAlgorithm>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_digits: Option<TotpDigits>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "optional_plain_u32_schema")
    )]
    pub totp_period: Option<u32>,
}

impl From<&LoginItemData> for EditableLoginItemData {
    fn from(value: &LoginItemData) -> Self {
        Self {
            title: value.title.clone(),
            url: value.url.clone(),
            urls: value.urls.clone(),
            username: value.username.clone(),
            password: value.password.clone(),
            password_history: value.password_history.clone(),
            notes: value.notes.clone(),
            note: value.note.clone(),
            custom_fields: value.custom_fields.clone(),
            tags: value.tags.clone(),
            totp_secret: value.totp_secret.clone(),
            totp_issuer: value.totp_issuer.clone(),
            totp_account_name: value.totp_account_name.clone(),
            totp_algorithm: value.totp_algorithm,
            totp_digits: value.totp_digits,
            totp_period: value.totp_period,
        }
    }
}

impl EditableLoginItemData {
    pub fn into_private(self, passkeys: Vec<Passkey>) -> LoginItemData {
        LoginItemData {
            title: self.title,
            url: self.url,
            urls: self.urls,
            username: self.username,
            password: self.password,
            password_history: self.password_history,
            passkeys,
            notes: self.notes,
            note: self.note,
            custom_fields: self.custom_fields,
            tags: self.tags,
            totp_secret: self.totp_secret,
            totp_issuer: self.totp_issuer,
            totp_account_name: self.totp_account_name,
            totp_algorithm: self.totp_algorithm,
            totp_digits: self.totp_digits,
            totp_period: self.totp_period,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicLoginItemData {
    #[serde(flatten)]
    pub editable: EditableLoginItemData,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub passkeys: Vec<PublicPasskey>,
}

impl From<&LoginItemData> for PublicLoginItemData {
    fn from(value: &LoginItemData) -> Self {
        Self {
            editable: EditableLoginItemData::from(value),
            passkeys: value.passkeys.iter().map(PublicPasskey::from).collect(),
        }
    }
}

impl std::ops::Deref for PublicLoginItemData {
    type Target = EditableLoginItemData;

    fn deref(&self) -> &Self::Target {
        &self.editable
    }
}

/// One plaintext Import draft. The host supplies only category data and Favorite; Rust owns the
/// final Item identity, ciphertext, and immutable batch request.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportItemDraft {
    pub draft: ItemDraft,
    #[serde(default)]
    pub favorite: bool,
}

impl fmt::Debug for ImportItemDraft {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImportItemDraft")
            .field("category", &self.draft.category())
            .field("favorite", &self.favorite)
            .field("plaintext", &"[redacted]")
            .finish()
    }
}

impl fmt::Debug for ItemDraft {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ItemDraft")
            .field("category", &self.category())
            .field("plaintext", &"[redacted]")
            .finish()
    }
}

impl ItemDraft {
    pub fn category(&self) -> ItemCategory {
        match self {
            Self::Login(_) => ItemCategory::Login,
            Self::SecureNote(_) => ItemCategory::SecureNote,
            Self::CreditCard(_) => ItemCategory::CreditCard,
            Self::Identity(_) => ItemCategory::Identity,
            Self::Authenticator(_) => ItemCategory::Authenticator,
        }
    }

    pub fn title(&self) -> &str {
        match self {
            Self::Login(value) => &value.title,
            Self::SecureNote(value) => &value.title,
            Self::CreditCard(value) => &value.title,
            Self::Identity(value) => &value.title,
            Self::Authenticator(value) => &value.title,
        }
    }

    pub fn password(&self) -> Option<&str> {
        match self {
            Self::Login(value) => value.password.as_deref(),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "kebab-case")]
pub enum ItemCategory {
    Login,
    SecureNote,
    CreditCard,
    Identity,
    Authenticator,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasswordHistoryEntry {
    pub password: String,
    pub changed_at: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Passkey {
    pub credential_id: String,
    pub rp_id: String,
    pub rp_name: String,
    pub user_handle: String,
    pub user_name: String,
    pub user_display_name: String,
    pub private_key: String,
    pub public_key: String,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "plain_i32_schema")
    )]
    pub algorithm: i32,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "plain_u32_schema")
    )]
    pub sign_count: u32,
    pub transports: Vec<String>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<PasskeyStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_reason: Option<PasskeyStatusReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_updated_at: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicPasskey {
    pub credential_id: String,
    pub rp_id: String,
    pub rp_name: String,
    pub user_handle: String,
    pub user_name: String,
    pub user_display_name: String,
    pub public_key: String,
    /// Stale-selection evidence over the exact persisted public-key String, not a trust root.
    pub public_key_fingerprint: String,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "plain_i32_schema")
    )]
    pub algorithm: i32,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "plain_u32_schema")
    )]
    pub sign_count: u32,
    pub transports: Vec<String>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<PasskeyStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_reason: Option<PasskeyStatusReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_updated_at: Option<String>,
}

impl From<&Passkey> for PublicPasskey {
    fn from(value: &Passkey) -> Self {
        Self {
            credential_id: value.credential_id.clone(),
            rp_id: value.rp_id.clone(),
            rp_name: value.rp_name.clone(),
            user_handle: value.user_handle.clone(),
            user_name: value.user_name.clone(),
            user_display_name: value.user_display_name.clone(),
            public_key: value.public_key.clone(),
            public_key_fingerprint: public_key_fingerprint(&value.public_key),
            algorithm: value.algorithm,
            sign_count: value.sign_count,
            transports: value.transports.clone(),
            created_at: value.created_at.clone(),
            last_used_at: value.last_used_at.clone(),
            status: value.status,
            status_reason: value.status_reason,
            status_updated_at: value.status_updated_at.clone(),
        }
    }
}

pub(crate) fn public_key_fingerprint(public_key: &str) -> String {
    format!("{:x}", Sha256::digest(public_key.as_bytes()))
}

#[cfg(test)]
mod public_key_fingerprint_tests {
    #[test]
    fn hashes_exact_utf8_bytes_in_lowercase_hex() {
        assert_eq!(
            super::public_key_fingerprint("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_ne!(
            super::public_key_fingerprint("abc"),
            super::public_key_fingerprint("ABC")
        );
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "kebab-case")]
pub enum PasskeyStatus {
    Active,
    Suspect,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "kebab-case")]
pub enum PasskeyStatusReason {
    Manual,
    UnknownCredential,
    SigningError,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
pub enum TotpAlgorithm {
    #[serde(rename = "SHA1")]
    Sha1,
    #[serde(rename = "SHA256")]
    Sha256,
    #[serde(rename = "SHA512")]
    Sha512,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TotpDigits {
    Six,
    Seven,
    Eight,
}

impl Serialize for TotpDigits {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(match self {
            Self::Six => 6,
            Self::Seven => 7,
            Self::Eight => 8,
        })
    }
}

impl<'de> Deserialize<'de> for TotpDigits {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match u8::deserialize(deserializer)? {
            6 => Ok(Self::Six),
            7 => Ok(Self::Seven),
            8 => Ok(Self::Eight),
            _ => Err(serde::de::Error::custom("TOTP digits must be 6, 7, or 8")),
        }
    }
}

#[cfg(feature = "runtime-protocol-contract-schema")]
impl schemars::JsonSchema for TotpDigits {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "TotpDigits".into()
    }
    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({ "type": "integer", "enum": [6, 7, 8] })
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecureNoteItemData {
    pub title: String,
    pub note: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_fields: Vec<CustomField>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreditCardItemData {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cardholder_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cvv: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expiry_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub billing_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_fields: Vec<CustomField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_issuer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_account_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_algorithm: Option<TotpAlgorithm>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_digits: Option<TotpDigits>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "optional_plain_u32_schema")
    )]
    pub totp_period: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Address {
    pub id: String,
    pub street: String,
    pub city: String,
    pub state: String,
    pub zip: String,
    pub country: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhoneNumber {
    pub id: String,
    pub label: String,
    pub number: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityItemData {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub middle_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub addresses: Vec<Address>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub phone_numbers: Vec<PhoneNumber>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssn: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passport_number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drivers_license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_of_birth: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_fields: Vec<CustomField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_issuer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_account_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_algorithm: Option<TotpAlgorithm>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_digits: Option<TotpDigits>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "optional_plain_u32_schema")
    )]
    pub totp_period: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthenticatorItemData {
    pub title: String,
    pub totp_secret: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_issuer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_account_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_algorithm: Option<TotpAlgorithm>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_digits: Option<TotpDigits>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "optional_plain_u32_schema")
    )]
    pub totp_period: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked_item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_fields: Vec<CustomField>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomField {
    pub id: String,
    pub label: String,
    pub value: String,
    #[serde(rename = "type")]
    pub field_type: CustomFieldKind,
}

impl fmt::Debug for CustomField {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CustomField")
            .field("plaintext", &"[redacted]")
            .field("field_type", &self.field_type)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum CustomFieldKind {
    Text,
    Password,
    Email,
    Url,
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
pub enum RuntimeResponse {
    AvailableVaultMembers {
        members: Vec<AvailableVaultMember>,
    },
    VaultMembers {
        members: Vec<CurrentVaultMember>,
    },
    VaultMemberAdded {
        vault_id: String,
        user_id: String,
    },
    VaultMemberAddUncertain {
        vault_id: String,
        user_id: String,
        current_role: Option<crate::server_contract::VaultRole>,
    },
    RotationPrepared {
        selection: RotationSelection,
    },
    RotationStartPending {
        start_operation_id: String,
    },
    TeamLeaveAttempts {
        attempts: Vec<TeamLeaveAttempt>,
    },
    TeamLeaveAttemptAcknowledged,
    RotationStartRejected {
        code: RotationStartRejectionCode,
    },
    RotationPreparationRequiresCrypto {
        start_operation_id: String,
        plans: Vec<RotationPlanSelection>,
    },
    RotationAttemptConsumed {
        start_operation_id: String,
    },
    RotationFinalizePending {
        finalize_operation_id: String,
    },
    RotationRefreshRequired {
        finalize_operation_id: String,
        outcome: RotationTerminalOutcome,
    },
    RotationCompleted {
        personal_team_id: String,
    },
    RotationRejected {
        code: RotationFinalizeRejectionCode,
    },
    MyTeamInvitations {
        invitations: Vec<MyTeamInvitation>,
    },
    MyTeamInvitationAccepted {
        team_id: String,
        team_name: String,
    },
    /// The Server confirmed acceptance, but Core has not installed fresh Vault authority.
    MyTeamInvitationAcceptRefreshRequired {
        team_id: String,
        team_name: String,
    },
    MyTeamInvitationDeclined,
    /// A lost reply never proves a mutation's result, even when later reads show absence.
    MyTeamInvitationUncertain {
        action: MyInvitationAction,
        invitation_id: String,
        pending: Option<bool>,
        current_team_id: Option<String>,
    },
    InvitationComposer {
        composer: Box<InvitationComposerData>,
    },
    TeamInvitationCreated {
        invitation_id: String,
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        token: invitations::InvitationToken,
        candidate: Option<InvitationCandidate>,
        continuation_id: Option<String>,
    },
    TeamInvitationProvisioned {
        invitation_id: String,
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        token: invitations::InvitationToken,
    },
    TeamInvitationProvisioningNotRequired {
        invitation_id: String,
    },
    TeamInvitationUncertain {
        phase: InvitationUncertainPhase,
        original_invitation_id: Option<String>,
    },
    InvitationContinuationReleased,
    TeamInvitationCancelled {
        invitation_id: String,
    },
    TeamInvitationResent {
        invitation_id: String,
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        token: InvitationToken,
    },
    TeamInvitationAdminUncertain {
        action: InvitationAdminAction,
        invitation_id: String,
        pending: Option<bool>,
    },
    TeamPage {
        page: Box<TeamPageData>,
    },
    ProfileAdmissionAborted {
        admission_id: String,
    },
    ProfileAdmissionInspection {
        state: ProfileAdmissionInspectionState,
    },
    CrossAccountMoveResumePrepared {
        guard: CrossAccountMoveResumeGuard,
    },
    RecipientKeyScope {
        scope: String,
    },
    OwnKeyFingerprint {
        user_id: String,
        fingerprint: String,
    },
    RecipientKeyVerified,
    VerifiedRecipientKey {
        public_key: String,
    },
    TravelMode {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        result: TravelModeCommandResult,
    },
    ActivityRecorded,
    LocalSecuritySettings {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        #[serde(with = "decimal_i64")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "decimal_i64::json_schema")
        )]
        inactivity_timeout_ms: i64,
        #[serde(with = "decimal_i64")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "decimal_i64::json_schema")
        )]
        master_password_reentry_period_ms: i64,
    },
    DeviceSetup {
        disclosure: DeviceSetupDisclosure,
    },
    AccountsUnlocked {
        accounts: Vec<AccountUnlockResult>,
    },
    BiometricAvailability {
        hardware: BiometricHardware,
        accounts: Vec<BiometricAccountAvailability>,
        #[serde(with = "decimal_i64")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "decimal_i64::json_schema")
        )]
        master_password_reentry_period_ms: i64,
    },
    BiometricEnabled {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        enabled: bool,
    },
    BiometricUnlock {
        accounts: Vec<BiometricAccountUnlock>,
    },
    MasterPasswordReentryPeriod {
        #[serde(with = "decimal_i64")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "decimal_i64::json_schema")
        )]
        period_ms: i64,
    },
    RecoveryDiagnosed {
        diagnostics: StorageRecoveryDiagnostics,
    },
    RecoveryExported {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        classification: RecoveryClassification,
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        byte_length: u64,
    },
    RecoveryRepaired {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        replica_revision: u64,
    },
    SignedIn {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        user_id: String,
    },
    /// The Account access state this Device holds after a `Lock` or `SignOut`. An Account this
    /// Device does not have answers `SignedOut`, because that is what it is.
    AccessChanged {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        access: AccountAccessState,
    },
    ServerAccountDeletion {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String", regex(pattern = "^[\\s\\S]+$"))
        )]
        account_id: AccountId,
        request_id: String,
        outcome: ServerAccountDeletionOutcome,
    },
    VaultDeletionAccepted {
        operation_id: String,
        vault_id: String,
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        replica_revision: u64,
    },
    VaultUpdateAccepted {
        operation_id: String,
        vault_id: String,
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        replica_revision: u64,
    },
    VaultCreationAccepted {
        operation_id: String,
        vault_id: String,
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        replica_revision: u64,
    },
    Accepted {
        operation_id: String,
        item_id: String,
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        replica_revision: u64,
    },
    ImportBatchAccepted {
        operation_id: String,
        vault_id: String,
        item_ids: Vec<String>,
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        replica_revision: u64,
    },
    ShareResultAcknowledged {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        operation_id: String,
    },
    ItemShareLinks {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        item_id: String,
        links: Vec<ShareLinkSummary>,
        base_share_url: String,
    },
    ShareAccessLogs {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        link_id: String,
        logs: Vec<ShareAccessLog>,
    },
    ShareLinkRevoked {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        link_id: String,
    },
    AttachmentRenamed {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        attachment_id: String,
    },
    AttachmentDeleted {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        attachment_id: String,
    },
    AttachmentDownloaded {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        attachment_id: String,
    },
    AttachmentUploaded {
        attachment_id: String,
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        replica_revision: u64,
    },
    Teardown {
        scope: TeardownScope,
        status: TeardownStatus,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(length(max = 4))
        )]
        failures: Vec<TeardownPhase>,
    },
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
pub enum TeardownScope {
    Account {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String", regex(pattern = "^[\\s\\S]+$"))
        )]
        account_id: AccountId,
    },
    Device,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum TeardownStatus {
    Complete,
    Incomplete,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum ServerAccountDeletionOutcome {
    Deleted,
    ConfirmationEmailMismatch,
    Blocked,
}

/// Closed, bounded failure vocabulary. It deliberately carries no host detail or identity.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum TeardownPhase {
    AttachmentArtifacts,
    HostCleanup,
    PlatformStorage,
    Replica,
}

/// The declared envelope every external Runtime request answers with.
///
/// Serde would otherwise emit its externally tagged `Result` spelling, an implicit wire shape no
/// contract describes. This adjacent tagging matches `RuntimeProjection`, and it keeps the
/// success payload intact: `RuntimeResponse` is itself internally tagged on `type`, so an
/// internally tagged envelope would collide with it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum RuntimeOutcome {
    Succeeded(RuntimeResponse),
    Failed(RuntimeError),
}

impl From<Result<RuntimeResponse, RuntimeError>> for RuntimeOutcome {
    fn from(value: Result<RuntimeResponse, RuntimeError>) -> Self {
        match value {
            Ok(response) => Self::Succeeded(response),
            Err(error) => Self::Failed(error),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ObservationRequest {
    VaultExport {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        vault_ids: Vec<String>,
    },
    TravelMode {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
    },
    WritableVaultCatalog,
    Items {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
    },
    Operations {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
    },
    PendingShareResults {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
    },
    RuntimeStatus {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "Option<String>")
        )]
        account_id: Option<AccountId>,
    },
}

impl ObservationRequest {
    pub fn account_id(&self) -> Option<&AccountId> {
        match self {
            Self::VaultExport { account_id, .. }
            | Self::TravelMode { account_id }
            | Self::Items { account_id }
            | Self::Operations { account_id }
            | Self::PendingShareResults { account_id } => Some(account_id),
            Self::RuntimeStatus { account_id } => account_id.as_ref(),
            Self::WritableVaultCatalog => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TravelModeProjection {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub revision: u64,
    pub last_verified_policy: Option<TravelModePolicy>,
    pub enforcement: TravelModeEnforcement,
}

/// Presentation of verified durable metadata; timestamps retain decimal millisecond wire values.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TravelModePolicy {
    pub enabled: bool,
    pub hidden_vault_ids: Vec<String>,
    pub server_enabled_at_ms: Option<String>,
    pub server_updated_at_ms: Option<String>,
    #[serde(deserialize_with = "crate::wire::required_nullable")]
    pub verified_at_ms: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum TravelModeEnforcement {
    Unverified,
    Retiring,
    Ready,
    Refreshing,
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
pub enum TravelModeCommandResult {
    Confirmed {
        policy: TravelModePolicy,
        enforcement: TravelModeEnforcement,
    },
    RetryRequired {
        policy: TravelModePolicy,
    },
    Uncertain {
        last_verified_policy: Option<TravelModePolicy>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum RuntimeProjection {
    VaultExport(VaultExportProjection),
    TravelMode(TravelModeProjection),
    WritableVaultCatalog(WritableVaultCatalogProjection),
    Items(ItemsProjection),
    Operations(OperationsProjection),
    PendingShareResults(PendingShareResultsProjection),
    RuntimeStatus(RuntimeStatusProjection),
}

impl RuntimeProjection {
    pub fn revision(&self) -> u64 {
        match self {
            Self::TravelMode(value) => value.revision,
            Self::WritableVaultCatalog(value) => value.revision,
            Self::Items(value) => value.replica_revision,
            Self::VaultExport(value) => value.replica_revision,
            Self::Operations(value) => value.replica_revision,
            Self::PendingShareResults(value) => value.replica_revision,
            Self::RuntimeStatus(value) => value.revision,
        }
    }

    pub fn item_count(&self) -> usize {
        match self {
            Self::TravelMode(_) => 0,
            Self::WritableVaultCatalog(_) => 0,
            Self::Items(value) => value.items.len(),
            Self::VaultExport(value) => value.items.len(),
            Self::Operations(_) => 0,
            Self::PendingShareResults(_) => 0,
            Self::RuntimeStatus(_) => 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct WritableVaultCatalogProjection {
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub revision: u64,
    pub vaults: Vec<WritableVaultProjection>,
}

/// Non-secret authority metadata for every currently unlocked writable Vault on this Device.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct WritableVaultProjection {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    pub vault_id: String,
    pub name: String,
    pub vault_type: VaultProjectionType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    pub role: VaultProjectionRole,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct PendingShareResultsProjection {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub replica_revision: u64,
    pub results: Vec<PendingShareResult>,
}

impl fmt::Debug for PendingShareResultsProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingShareResultsProjection")
            .field("account_id", &self.account_id)
            .field("replica_revision", &self.replica_revision)
            .field("result_count", &self.results.len())
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct PendingShareResult {
    pub operation_id: String,
    pub item_id: String,
    pub share_link_id: String,
    pub share_url: String,
    pub expires_at: String,
}

impl fmt::Debug for PendingShareResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingShareResult")
            .field("operation_id", &self.operation_id)
            .field("item_id", &self.item_id)
            .field("share_link_id", &self.share_link_id)
            .field("share_url", &"[redacted]")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[cfg(test)]
mod pending_share_secret_tests {
    use super::PendingShareResult;

    fn requires_zeroize_on_drop<T: zeroize::ZeroizeOnDrop>() {}

    #[test]
    fn core_pending_share_result_owns_its_url_as_a_zeroizing_secret() {
        requires_zeroize_on_drop::<PendingShareResult>();
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct ItemsProjection {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub replica_revision: u64,
    pub items: Vec<ItemProjection>,
    /// The Vaults these Items live in, so a host can name one and can tell a reader from a
    /// writer without asking a second source. Present for the first slice's create affordance;
    /// full Vault metadata still belongs to the read path that owns it.
    pub vaults: Vec<VaultProjection>,
}

/// Plaintext only the foreground, scoped Export loan can deliver.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultExportProjection {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub replica_revision: u64,
    pub items: Vec<VaultExportItem>,
    pub vaults: Vec<VaultProjection>,
}

impl fmt::Debug for VaultExportProjection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VaultExportProjection")
            .field("account_id", &self.account_id)
            .field("replica_revision", &self.replica_revision)
            .field("item_count", &self.items.len())
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultExportItem {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    pub item_id: String,
    pub vault_id: String,
    pub data: ItemDraft,
    pub favorite: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<AttachmentProjection>,
    pub created_at: String,
    pub updated_at: String,
    pub status: ItemProjectionStatus,
}

impl fmt::Debug for VaultExportItem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VaultExportItem")
            .field("account_id", &self.account_id)
            .field("item_id", &self.item_id)
            .field("vault_id", &self.vault_id)
            .field("plaintext", &"[redacted]")
            .finish()
    }
}

/// One Vault as an Items reader needs it: enough to label it and to know what may be written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct VaultProjection {
    pub vault_id: String,
    pub name: String,
    pub vault_type: VaultProjectionType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    /// This Account's membership in the Vault. A host derives "may I write an Item here"
    /// from it (anything but `ReadOnly`), and the manage affordances an Owner or Admin has
    /// and a Member does not. The first slice's narrower create rule filters on the Vault
    /// type as well.
    pub role: VaultProjectionRole,
}

/// One Account's membership in one Vault.
///
/// The values are the Server's own closed `VaultRole` set, spelled the way the Server spells
/// them, so a host that already renders a role does not need a second vocabulary and a
/// translation table between the two.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "kebab-case")]
pub enum VaultProjectionRole {
    Owner,
    Admin,
    Member,
    ReadOnly,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum VaultProjectionType {
    Personal,
    Team,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct ItemProjection {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    pub item_id: String,
    pub vault_id: String,
    pub data: PublicItemDraft,
    pub favorite: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<AttachmentProjection>,
    pub created_at: String,
    pub updated_at: String,
    pub status: ItemProjectionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit_guard: Option<ItemEditGuard>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duplicate_source_guard: Option<ItemDuplicateGuard>,
}

/// Stateless evidence of the authoritative Item version the caller actually edited.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemEditGuard {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub incarnation: Incarnation,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub lock_epoch: u64,
    pub item_id: String,
    pub vault_id: String,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "plain_i32_schema")
    )]
    pub item_version: i32,
}

/// Selection evidence for same-Vault Duplicate. This names either one confirmed Item version
/// or one exact locally accepted encrypted overlay, never a synthetic confirmed authority row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemDuplicateGuard {
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
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub lock_epoch: u64,
    pub source_item_id: String,
    pub vault_id: String,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub replica_revision: u64,
    pub source: DuplicateSourceGuard,
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
pub enum DuplicateSourceGuard {
    Authoritative {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "plain_i32_schema")
        )]
        item_version: i32,
    },
    AcceptedOverlay {
        operation_id: String,
    },
}

#[cfg(test)]
mod duplicate_source_guard_tests {
    use super::DuplicateSourceGuard;

    #[test]
    fn nested_guard_fields_use_the_generated_camel_case_wire_contract() {
        assert_eq!(
            serde_json::to_value(DuplicateSourceGuard::Authoritative { item_version: 2 }).unwrap(),
            serde_json::json!({"type":"authoritative","itemVersion":2})
        );
        assert_eq!(
            serde_json::to_value(DuplicateSourceGuard::AcceptedOverlay {
                operation_id: "operation-1".into(),
            })
            .unwrap(),
            serde_json::json!({"type":"acceptedOverlay","operationId":"operation-1"})
        );
    }
}

#[cfg(test)]
impl ItemEditGuard {
    pub(crate) fn test_fixture(account_id: AccountId, item_id: &str) -> Self {
        Self {
            account_id,
            incarnation: Incarnation::from("incarnation-1"),
            lock_epoch: 0,
            item_id: item_id.into(),
            vault_id: "vault-1".into(),
            item_version: 1,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentProjection {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    pub attachment_id: String,
    pub item_id: String,
    pub vault_id: String,
    pub name: String,
    pub content_type: String,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "plain_i32_schema")
    )]
    pub file_size: i32,
    pub uploaded_by: String,
    pub created_at: String,
}

#[cfg(feature = "runtime-protocol-contract-schema")]
fn plain_i32_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({
        "type": "integer",
        "minimum": i32::MIN,
        "maximum": i32::MAX
    })
}

#[cfg(feature = "runtime-protocol-contract-schema")]
fn plain_u32_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "type": "integer", "minimum": 0, "maximum": u32::MAX })
}

#[cfg(feature = "runtime-protocol-contract-schema")]
fn optional_plain_u32_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "type": ["integer", "null"], "minimum": 0, "maximum": u32::MAX })
}

impl fmt::Debug for AttachmentProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AttachmentProjection")
            .field("account_id", &self.account_id)
            .field("attachment_id", &self.attachment_id)
            .field("item_id", &self.item_id)
            .field("vault_id", &self.vault_id)
            .field("plaintext", &"[redacted]")
            .finish()
    }
}

impl fmt::Debug for ItemProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ItemProjection")
            .field("account_id", &self.account_id)
            .field("item_id", &self.item_id)
            .field("vault_id", &self.vault_id)
            .field("plaintext", &"[redacted]")
            .field("status", &self.status)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum ItemProjectionStatus {
    Pending,
    Authoritative,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatusProjection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_admission_cleanup: Option<ProfileAdmissionCleanupStatus>,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "Option<String>")
    )]
    pub account_id: Option<AccountId>,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub revision: u64,
    pub accounts: Vec<AccountStatus>,
    pub closed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProfileAdmissionCleanupStatus {
    Pending {
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        pending_obligations: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub replica_revision: u64,
    pub access: AccountAccessState,
    #[serde(default)]
    pub unlock_capabilities: AccountUnlockCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_identity: Option<AccountDisplayIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting_reason: Option<AccountWaitingReason>,
    pub failure: Option<RuntimeErrorCode>,
}

/// Core-supported Account unlock actions. Biometric eligibility retains its dedicated projection.
/// Desktop authorization may require opening or reconnecting Desktop before its explicit ceremony.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountUnlockCapabilities {
    pub password: bool,
    pub desktop: bool,
    pub sign_in: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct AccountUnlockResult {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    pub failure: Option<RuntimeErrorCode>,
}

/// The non-secret identity a host may render for one installed Account.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct AccountDisplayIdentity {
    pub email: String,
    pub name: String,
    pub team_name: Option<String>,
    pub team_avatar_url: Option<String>,
    pub server_url: String,
    pub secret_key_hint: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum AccountWaitingReason {
    ReauthenticationRequired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum BiometricKind {
    TouchId,
    FaceId,
    WindowsHello,
    Fingerprint,
    Face,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct BiometricHardware {
    pub has_hardware: bool,
    pub is_enrolled: bool,
    pub kind: Option<BiometricKind>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum BiometricFailure {
    Unavailable,
    NotEnrolled,
    NotEnabled,
    PasswordRequired,
    Cancelled,
    Failed,
    LockedOut,
    AccountChanged,
    TravelUnverified,
    StorageUnavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct BiometricAccountAvailability {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    pub enabled: bool,
    pub failure: Option<BiometricFailure>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct BiometricAccountUnlock {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    /// None means the explicitly requested Account unlocked successfully.
    pub failure: Option<BiometricFailure>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum AccountAccessState {
    SignedOut,
    Locked,
    Unlocked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    any(
        feature = "persistence-contract-schema",
        feature = "runtime-protocol-contract-schema"
    ),
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RuntimeErrorCode {
    RecipientKeyUnverified,
    RecipientKeyChanged,
    RecipientFingerprintMismatch,
    RuntimeClosed,
    Cancelled,
    AccountMissing,
    AccountAlreadyInstalled,
    AccountFailed,
    AuthenticationRequired,
    AuthenticationUnavailable,
    CredentialUnavailable,
    StorageUnavailable,
    RetryableTransport,
    VersionEvidenceUnavailable,
    AuthorityMissing,
    AccessDenied,
    ReadOnly,
    QuotaExceeded,
    SizeRejected,
    SourceFailure,
    SinkFailure,
    InvariantViolation,
}

/// Closed recovery implementation guards; these are not Account capacity limits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    any(
        feature = "runtime-protocol-contract-schema",
        feature = "recovery-contract-schema"
    ),
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryBound {
    RecordBytes,
    ArchiveBytes,
    RecordCount,
    ArtifactCount,
    ReportBytes,
    SummaryBytes,
    ControlBytes,
    CursorBytes,
    ChunkBytes,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[error("{code:?}: {message}")]
pub struct RuntimeError {
    pub code: RuntimeErrorCode,
    pub message: String,
    #[serde(
        default,
        rename = "recoveryBound",
        skip_serializing_if = "Option::is_none"
    )]
    pub recovery_bound: Option<RecoveryBound>,
    #[serde(
        default,
        rename = "teamPageProblem",
        skip_serializing_if = "Option::is_none"
    )]
    pub team_page_problem: Option<Box<TeamPageProblem>>,
}

impl RuntimeError {
    pub(crate) fn new(code: RuntimeErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            recovery_bound: None,
            team_page_problem: None,
        }
    }
}

#[cfg(feature = "runtime-protocol-contract-schema")]
#[derive(schemars::JsonSchema)]
#[allow(dead_code)]
struct RuntimeProtocolContract {
    request: RuntimeRequest,
    outcome: RuntimeOutcome,
    observation: ObservationRequest,
    projection: RuntimeProjection,
    observation_control: ObservationControl,
}

#[cfg(feature = "runtime-protocol-contract-schema")]
#[doc(hidden)]
pub fn runtime_protocol_contract_schema() -> schemars::Schema {
    let mut settings = schemars::generate::SchemaSettings::draft2020_12();
    settings.contract = schemars::generate::Contract::Serialize;
    settings
        .into_generator()
        .into_root_schema_for::<RuntimeProtocolContract>()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum VaultExportRetirementReason {
    ScopeRetired,
    RuntimeClosed,
    ConnectionClosed,
}

/// Nonplaintext terminal controls bypass revoked plaintext delivery tokens.
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
pub enum ObservationControl {
    VaultExportRetired { reason: VaultExportRetirementReason },
}

pub trait ObservationSink: Send + Sync + 'static {
    fn publish(&self, projection: RuntimeProjection);
    fn control(&self, _control: ObservationControl) {}
}

struct CancellationState {
    cancelled: AtomicBool,
    changed: watch::Sender<bool>,
}

#[derive(Clone)]
pub struct RequestCancellation(Arc<CancellationState>);

impl Default for RequestCancellation {
    fn default() -> Self {
        let (changed, _) = watch::channel(false);
        Self(Arc::new(CancellationState {
            cancelled: AtomicBool::new(false),
            changed,
        }))
    }
}

impl RequestCancellation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        if !self.0.cancelled.swap(true, Ordering::SeqCst) {
            self.0.changed.send_replace(true);
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::SeqCst)
    }

    pub async fn cancelled(&self) {
        let mut changed = self.0.changed.subscribe();
        while !*changed.borrow_and_update() {
            if changed.changed().await.is_err() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod server_account_deletion_protocol_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn server_account_deletion_protocol_is_explicit_scoped_and_redacted() {
        let request = RuntimeRequest::DeleteServerAccount {
            account_id: AccountId::from("account-1"),
            confirm_email: "user@example.com".into(),
            request_id: "018f05c4-7b6a-4a89-9237-2e612fa96d01".into(),
        };
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            json!({
                "type": "deleteServerAccount",
                "accountId": "account-1",
                "confirmEmail": "user@example.com",
                "requestId": "018f05c4-7b6a-4a89-9237-2e612fa96d01"
            })
        );
        assert!(!format!("{request:?}").contains("user@example.com"));

        let response = RuntimeResponse::ServerAccountDeletion {
            account_id: AccountId::from("account-1"),
            request_id: "018f05c4-7b6a-4a89-9237-2e612fa96d01".into(),
            outcome: ServerAccountDeletionOutcome::Deleted,
        };
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            json!({
                "type": "serverAccountDeletion",
                "accountId": "account-1",
                "requestId": "018f05c4-7b6a-4a89-9237-2e612fa96d01",
                "outcome": "deleted"
            })
        );
    }
}

/// Non-secret progress from accepted Operations and their durable terminal receipts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct OperationsProjection {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub replica_revision: u64,
    pub operations: Vec<OperationProjection>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct OperationProjection {
    pub operation_id: String,
    pub kind: OperationProjectionKind,
    /// Terminal receipts do not retain historical scheduling diagnostics.
    pub attempt_count: Option<String>,
    pub next_attempt_at_ms: Option<String>,
    pub resolution: OperationResolution,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "optional_import_count_schema")
    )]
    pub imported_count: Option<u16>,
    pub rejection_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cross_account_move: Option<CrossAccountMoveProjection>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct CrossAccountMoveProjection {
    pub phase: CrossAccountMovePhase,
    pub destination_server_url: String,
    pub destination_user_id: String,
    pub destination_vault_id: String,
    pub source_visible: bool,
    pub disposition: CrossAccountMoveDisposition,
}

/// Stateless stale-input evidence. Both Accounts and current Server authority are still checked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CrossAccountMoveResumeGuard {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub source_incarnation: Incarnation,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub source_lock_epoch: u64,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub target_account_id: AccountId,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub target_incarnation: Incarnation,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub target_lock_epoch: u64,
    pub operation_id: String,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub binding_revision: u64,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub source_replica_revision: u64,
    pub owner_incarnation: String,
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
pub enum CrossAccountMovePhase {
    TargetCreate,
    Attachments {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "plain_u32_schema")
        )]
        next_index: u32,
    },
    SourceTrash,
    SourceDelete,
    Completed,
    Rejected,
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
pub enum CrossAccountMoveDisposition {
    Ready,
    LegacyHeld,
    Waiting {
        reason: CrossAccountMoveWaitingReason,
    },
    Blocked {
        reason: CrossAccountMoveBlockedReason,
    },
    Rejected {
        code: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum CrossAccountMoveWaitingReason {
    AccountLocked,
    Offline,
    PolicyVerificationPending,
    AccessUnavailable,
    AttachmentAccessDenied,
    AttachmentQuotaExceeded,
    AttachmentSizeRejected,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum CrossAccountMoveBlockedReason {
    DestinationRetired,
    MissingSourceEvidence,
    SourceChanged,
    TargetChanged,
    MissingProof,
    MissingArtifact,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum OperationResolution {
    Pending,
    Applied,
    Rejected,
    LegacyFailed,
    LegacyConflicted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum OperationProjectionKind {
    CreateVault,
    UpdateVault,
    DeleteVault,
    CreateItem,
    UpdateItem,
    SetItemFavorite,
    TrashItem,
    RestoreItem,
    MoveItem,
    PermanentlyDeleteItem,
    CreateShare,
    ImportItems,
    CreateVaultMemberRemovalRotationPlans,
    FinalizeVaultMemberRemovalRotationPlans,
    CreateTeamLeaveRotationPlans,
    FinalizeTeamLeaveRotationPlans,
    CreateTeamMemberRemovalRotationPlans,
    FinalizeTeamMemberRemovalRotationPlans,
}

impl From<crate::replica::OperationKind> for OperationProjectionKind {
    fn from(value: crate::replica::OperationKind) -> Self {
        match value {
            crate::replica::OperationKind::CreateVault => Self::CreateVault,
            crate::replica::OperationKind::UpdateVault => Self::UpdateVault,
            crate::replica::OperationKind::DeleteVault => Self::DeleteVault,
            crate::replica::OperationKind::CreateItem => Self::CreateItem,
            crate::replica::OperationKind::UpdateItem => Self::UpdateItem,
            crate::replica::OperationKind::SetItemFavorite => Self::SetItemFavorite,
            crate::replica::OperationKind::TrashItem => Self::TrashItem,
            crate::replica::OperationKind::RestoreItem => Self::RestoreItem,
            crate::replica::OperationKind::MoveItem => Self::MoveItem,
            crate::replica::OperationKind::PermanentlyDeleteItem => Self::PermanentlyDeleteItem,
            crate::replica::OperationKind::CreateShare => Self::CreateShare,
            crate::replica::OperationKind::ImportItems => Self::ImportItems,
            crate::replica::OperationKind::CreateVaultMemberRemovalRotationPlans => {
                Self::CreateVaultMemberRemovalRotationPlans
            }
            crate::replica::OperationKind::FinalizeVaultMemberRemovalRotationPlans => {
                Self::FinalizeVaultMemberRemovalRotationPlans
            }
            crate::replica::OperationKind::CreateTeamLeaveRotationPlans => {
                Self::CreateTeamLeaveRotationPlans
            }
            crate::replica::OperationKind::FinalizeTeamLeaveRotationPlans => {
                Self::FinalizeTeamLeaveRotationPlans
            }
            crate::replica::OperationKind::CreateTeamMemberRemovalRotationPlans => {
                Self::CreateTeamMemberRemovalRotationPlans
            }
            crate::replica::OperationKind::FinalizeTeamMemberRemovalRotationPlans => {
                Self::FinalizeTeamMemberRemovalRotationPlans
            }
        }
    }
}

#[cfg(feature = "runtime-protocol-contract-schema")]
fn optional_import_count_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "type": ["integer", "null"], "minimum": 0, "maximum": 200 })
}

#[cfg(feature = "runtime-protocol-contract-schema")]
fn optional_plain_i32_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "type": ["integer", "null"], "minimum": -2147483648_i64, "maximum": 2147483647_i64 })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageRecoveryDiagnostics {
    pub failure: Option<RuntimeErrorCode>,
    pub maintenance: RecoveryMaintenanceStatus,
    pub schema: RecoverySchemaStatus,
    pub device: RecoveryDeviceStatus,
    pub accounts: Vec<StorageRecoveryAccount>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageRecoveryAccount {
    pub email: Option<String>,
    pub server_url: Option<String>,
    pub user_id: Option<String>,
    pub can_rebootstrap: bool,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    pub state: RecoveryStorageState,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "optional_plain_u32_schema")
    )]
    pub operation_count: Option<u32>,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "optional_plain_u32_schema")
    )]
    pub receipt_count: Option<u32>,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "optional_plain_u32_schema")
    )]
    pub missing_artifacts: Option<u32>,
    pub can_export: bool,
    pub can_repair: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryClassification {
    Complete,
    Partial,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryMaintenanceStatus {
    Available,
    Unsupported,
    Busy,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum RecoverySchemaStatus {
    Supported,
    Unsupported,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryDeviceStatus {
    FreshOrUnknown,
    KnownAccounts,
    StorageUnavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryStorageState {
    Ready,
    Corrupt,
    Missing,
    Unknown,
    Unreadable,
}

/// Transient setup disclosure: never part of an observation or persisted projection.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceSetupDisclosure {
    #[zeroize(skip)]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    #[zeroize(skip)]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub incarnation: Incarnation,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub lock_epoch: u64,
    pub email: String,
    pub server_url: String,
    pub team_name: Option<String>,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub secret_key: crate::SecretString,
}
impl fmt::Debug for DeviceSetupDisclosure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DeviceSetupDisclosure([redacted])")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum ActivityKind {
    Interaction,
    Focus,
    Blur,
}
