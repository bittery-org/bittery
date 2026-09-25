//! Shared Client Runtime policy.
//!
//! This crate deliberately knows no host framework or binding generator. Platform crates translate
//! its closed protocol and execute primitive ports; they do not own Runtime behavior.

// Ticket 19 deliberately lands the closed storage vocabulary before wiring authentication to it.
#[allow(dead_code)]
mod platform_storage;
// Ticket 19 lands the primitive host seam before authentication starts constructing requests.
#[allow(dead_code)]
mod http_transport;
// Ticket 19 keeps Server authentication policy behind one typed Rust-owned HTTP seam.
mod account_email;
mod binary_transfer_integrity;
pub use binary_transfer_integrity::AttachmentUploadIntegrity;
#[allow(dead_code)]
mod auth_http;
// Ticket 19 keeps the complete unchanged SRP/KDF ceremony behind one private deep module.
#[allow(dead_code)]
mod authentication;
// Ticket 19 keeps compatibility wrapping and time conversion private until Account installation.
#[allow(
    dead_code,
    unused_imports,
    reason = "Ticket 28 lands artifact durability before the preparation worker consumes it"
)]
mod attachment_artifact_store;
#[allow(dead_code)]
mod authentication_installation;
// Ticket 21 slice B needs a wall clock the Runtime can wait on, not only read.
mod device_timer;
#[cfg(feature = "binding-test-harness")]
#[doc(hidden)]
pub use device_timer::sleep_device_timer_for_test;
mod profile_admission;
mod protocol;
mod recovery;
mod replica;
mod runtime;
#[cfg(not(target_arch = "wasm32"))]
mod sqlite_schema;
#[cfg(not(target_arch = "wasm32"))]
#[doc(hidden)]
pub use sqlite_schema::validate as validate_native_sqlite_schema;
mod vault_image;
mod wire;

#[cfg(any(test, feature = "binding-test-harness"))]
mod test_fixtures;
#[cfg(test)]
mod tests;

pub mod server_contract {
    include!("generated/server.rs");
}

#[doc(hidden)]
pub use auth_http::{AuthClientConfig, ClientPlatform};
#[cfg(feature = "http-transport-contract-schema")]
#[doc(hidden)]
pub use http_transport::http_transport_contract_schema;
#[doc(hidden)]
pub use http_transport::SerializedHttpExecutor;
#[doc(hidden)]
pub use http_transport::{
    HttpHeader, HttpMethod, HttpRequest, HttpResponse, HttpStreamCommand, HttpStreamResponse,
};

pub use account_email::{normalize_account_email, NormalizedAccountEmail};
#[cfg(not(target_arch = "wasm32"))]
#[doc(hidden)]
pub use attachment_artifact_store::SqliteAttachmentArtifactStore;
#[cfg(feature = "binding-test-harness")]
#[doc(hidden)]
pub use attachment_artifact_store::{
    seed_attachment_artifact_recovery_test_history, sweep_attachment_artifact_recovery_test_history,
};
#[doc(hidden)]
pub use attachment_artifact_store::{
    ArtifactChunkWrite, ArtifactPublication, AttachmentArtifactInventoryContinuation,
    AttachmentArtifactInventoryFamily, AttachmentArtifactInventoryPage,
    AttachmentArtifactInventorySchema, AttachmentArtifactOwner, AttachmentArtifactPhysicalKey,
    AttachmentArtifactStore, AttachmentArtifactStoreRequest, AttachmentArtifactStoreResponse,
    ExclusiveStartupBoundary, ProvisionalAttachmentArtifactRecovery,
    ProvisionalAttachmentArtifactScope, ProvisionalAttachmentArtifactStore,
    ProvisionalAttachmentArtifactStoreRequest, ProvisionalAttachmentArtifactStoreResponse,
    ProvisionalAttachmentArtifactWriter, PublishedArtifactChunk, ARTIFACT_CHUNK_BYTES,
};
#[cfg(feature = "platform-storage-contract-schema")]
#[doc(hidden)]
pub use platform_storage::platform_storage_contract_schema;
#[doc(hidden)]
pub use platform_storage::SerializedPlatformStorageExecutor;
#[doc(hidden)]
pub use platform_storage::{
    PlatformStorageArea, PlatformStorageDeleteResult, PlatformStorageInventoryContinuation,
    PlatformStorageInventoryFamily, PlatformStorageKeysPage, PlatformStorageRequest,
    PlatformStorageResponse, SecretString,
};
#[cfg(feature = "profile-admission-contract-schema")]
#[doc(hidden)]
pub use profile_admission::profile_admission_contract_schema;
#[doc(hidden)]
pub use profile_admission::{
    LegacyProfileFormat, ProfileAccountCredentialField, ProfileAdmissionRequest,
    ProfileAdmissionResponse, ProfileAdmissionSource, ProfileGlobalCredentialField,
    ProfileLegacyResetScope, ProfileResetFamilyScope, ProfileResetFileBinding,
    ProfileResetPreparedResult, ProfileResetResult, ProfileResetSnapshot,
    ProfileSnapshotCloseSelector, ProfileSourceCleanupReopenResult, ProfileSourceCleanupReopenStep,
    ProfileSourceCleanupSnapshot, ProfileSourceContinuation, ProfileSourceDeleteResult,
    ProfileSourceEvidenceDigest, ProfileSourceFamily, ProfileSourceFamilyInventory,
    ProfileSourceManifestDigest, ProfileSourceManifestEntry, ProfileSourceManifestHeader,
    ProfileSourceObservation, ProfileSourcePage, ProfileSourcePresence, ProfileSourceReopenStep,
    ProfileSourceSelector, ProfileSourceSnapshot, ProfileSourceStringEncoding,
    ProfileSourceValueKind, ProfileSourceVerificationResult, ProfileSourceVerifyStep,
    SerializedProfileAdmissionExecutor, PROFILE_SOURCE_BINARY_BYTES, PROFILE_SOURCE_CONTROL_BYTES,
    PROFILE_SOURCE_CURSOR_BYTES, PROFILE_SOURCE_IDENTITY_BYTES, PROFILE_SOURCE_MANIFEST_VERSION,
};
#[cfg(feature = "runtime-protocol-contract-schema")]
#[doc(hidden)]
pub use protocol::runtime_protocol_contract_schema;
pub use protocol::{
    AccountAccessState, AccountDisplayIdentity, AccountId, AccountStatus,
    AccountUnlockCapabilities, AccountUnlockResult, AccountWaitingReason, ActivityKind, Address,
    AttachmentProjection, AuthenticatorItemData, AvailableVaultMember,
    BiometricAccountAvailability, BiometricAccountUnlock, BiometricFailure, BiometricHardware,
    BiometricKind, CreateShareDraft, CreateVaultType, CreditCardItemData,
    CrossAccountMoveBlockedReason, CrossAccountMoveDisposition, CrossAccountMovePhase,
    CrossAccountMoveProjection, CrossAccountMoveResumeGuard, CrossAccountMoveWaitingReason,
    CurrentVaultMember, CustomField, CustomFieldKind, DeviceSetupDisclosure, DuplicateSourceGuard,
    EditableItemDraft, EditableLoginItemData, IdentityItemData, ImportItemDraft, Incarnation,
    InvitationAdminAction, InvitationCandidate, InvitationComposerData, InvitationComposerVault,
    InvitationSeatPreview, InvitationSeatPreviewLine, InvitationToken, InvitationUncertainPhase,
    ItemCategory, ItemDraft, ItemDuplicateGuard, ItemEditGuard, ItemProjection,
    ItemProjectionStatus, ItemsProjection, LoginItemData, MyInvitationAction, MyTeamInvitation,
    ObservationControl, ObservationRequest, ObservationSink, OperationProjection,
    OperationProjectionKind, OperationResolution, OperationsProjection, Passkey, PasskeyStatus,
    PasskeyStatusReason, PasswordHistoryEntry, PendingShareResult, PendingShareResultsProjection,
    PhoneNumber, ProfileAdmissionCleanupStatus, ProfileAdmissionImportPhase,
    ProfileAdmissionInspectionState, ProfileAdmissionResetPhase, PublicItemDraft,
    PublicLoginItemData, PublicPasskey, RecoveryBound, RecoveryClassification,
    RecoveryDeviceStatus, RecoveryMaintenanceStatus, RecoverySchemaStatus, RecoveryStorageState,
    RequestCancellation, RotationCandidate, RotationFinalizeRejectionCode, RotationIntent,
    RotationPlanSelection, RotationSelection, RotationStartRejectionCode, RotationTerminalOutcome,
    RuntimeError, RuntimeErrorCode, RuntimeOutcome, RuntimeProjection, RuntimeRequest,
    RuntimeResponse, RuntimeStatusProjection, SecureNoteItemData, ServerAccountDeletionOutcome,
    ShareAccessLog, ShareAccessMode, ShareAllowedEmail, ShareExpiration, ShareLinkStatus,
    ShareLinkSummary, StorageRecoveryAccount, StorageRecoveryDiagnostics, TeamLeaveAttempt,
    TeardownPhase, TeardownScope, TeardownStatus, TotpAlgorithm, TotpDigits,
    TravelModeCommandResult, TravelModeEnforcement, TravelModePolicy, TravelModeProjection,
    VaultExportItem, VaultExportProjection, VaultExportRetirementReason, VaultIconPatch,
    VaultImageChange, VaultImageSourceInput, VaultProjection, VaultProjectionRole,
    VaultProjectionType, WritableVaultCatalogProjection, WritableVaultProjection,
};

#[cfg(feature = "persistence-contract-schema")]
#[doc(hidden)]
pub use replica::persistence_contract_schema;
#[cfg(all(feature = "replica-conformance", not(target_arch = "wasm32")))]
#[doc(hidden)]
pub use replica::replica_conformance::generate_replica_conformance_corpus;
#[doc(hidden)]
pub use replica::SerializedReplicaExecutor;
#[cfg(not(target_arch = "wasm32"))]
#[doc(hidden)]
pub use replica::SqliteReplica;
#[doc(hidden)]
pub use runtime::{
    AttachmentDownloadFacade, AttachmentDownloadSink, AttachmentDownloadSinkError,
    AttachmentDownloadSinkPort, AttachmentMoveAccountLease, AttachmentMoveAccountLeasePort,
    AttachmentMoveDownload, AttachmentMoveDownloadRequest, AttachmentMovePreparationFacade,
    AttachmentMoveTransferError, AttachmentMoveTransferPort, AttachmentMoveUpload,
    AttachmentMoveUploadGrant, AttachmentUploadBinary, AttachmentUploadBinaryOutcome,
    AttachmentUploadFacade, AttachmentUploadSource, AttachmentUploadSourceError,
    AttachmentUploadSourcePort, AttachmentUploadTransferPort, TeardownHostCleanup,
    TeardownHostCleanupRequest, TeardownHostCleanupResponse,
};
pub use runtime::{ObservationHandle, Runtime};
pub use vault_image::protected::{ProtectedImageMetadata, ProtectedImageWitness};
#[cfg(not(target_arch = "wasm32"))]
pub use vault_image::SqliteVaultImageArtifactStore;
pub use vault_image::{
    MemoryVaultImageArtifactStore, PreparedVaultImage, VaultImageArtifactGeneration,
    VaultImageArtifactMetadata, VaultImageArtifactPort, VaultImageArtifactScope,
    VaultImageChunkWrite, VaultImageIngress, VaultImageIngressFacade, VaultImagePublication,
    VaultImageSource, VaultImageSourceError, VaultImageSourceGrant, VaultImageSourcePort,
    VAULT_IMAGE_CHUNK_BYTES, VAULT_IMAGE_MAX_BYTES,
};
#[doc(hidden)]
pub use vault_image::{
    VaultImageInventoryContinuation, VaultImageInventoryFamily, VaultImageInventoryPage,
    VaultImageInventorySchema, VaultImagePhysicalKey,
};

#[doc(hidden)]
pub use recovery::control::{
    RecoveryControlRequest, RecoveryControlResponse, RecoveryExpectedRow, RecoveryPhysicalSchemas,
    RecoveryRecord, RecoveryUnavailableReason, SerializedRecoveryExecutor,
};
pub use recovery::limits::{RECOVERY_CHUNK_BYTES, RECOVERY_CONTROL_BYTES, RECOVERY_MAX_FILE_BYTES};
#[cfg(not(target_arch = "wasm32"))]
pub use recovery::sqlite::SqliteRecoveryStorage;
pub use replica::persistence_contract::{ReplicaHead, ReplicaStore};

#[doc(hidden)]
#[cfg(feature = "runtime-protocol-contract-schema")]
pub use runtime::native_authority_contract_schema;
pub use runtime::{BiometricPort, BiometricPromptResult};
pub use runtime::{
    NativeAccountAuthority, NativeAccountProfile, NativeAccountScope, NativeAuthorityFacade,
    NativeAuthorityRequest, NativeAuthorityResponse, NativeAuthoritySnapshot,
    NativeChallengePurpose, NativeImportChallenge, NativeIndependentRevalidationReply,
    NativePolicyVerification, NativeRestrictionAcknowledgement, NativeRestrictionAdoption,
    NativeRestrictionBatch, NativeRestrictionDisposition, NativeRestrictionEvidence,
    NativeRestrictiveContinuity, NativeSourceAttachment, NativeTransferReply, NativeTravelEvidence,
};

#[cfg(test)]
mod account_email_tests {
    use super::normalize_account_email;

    #[test]
    fn account_email_normalization_uses_shared_crypto_core_vectors_and_utf8_byte_limit() {
        assert_eq!(
            normalize_account_email("  MU\u{0308}LLER@EXAMPLE.COM  ")
                .expect("valid email")
                .as_str(),
            "müller@example.com"
        );
        assert_eq!(
            normalize_account_email("ＭＵ̈ＬＬＥＲ＠ＥＸＡＭＰＬＥ．ＣＯＭ")
                .expect("valid email")
                .as_str(),
            "müller@example.com"
        );
        let boundary = format!("{}@example.com", "a".repeat(242));
        assert_eq!(boundary.len(), 254);
        assert!(normalize_account_email(&boundary).is_ok());
        assert!(normalize_account_email(&format!("a{boundary}")).is_err());
        assert!(normalize_account_email(" \t\n ").is_err());
    }
}

#[cfg(feature = "recovery-contract-schema")]
#[doc(hidden)]
pub use recovery::control::recovery_contract_schema;
mod recipient_keys;
