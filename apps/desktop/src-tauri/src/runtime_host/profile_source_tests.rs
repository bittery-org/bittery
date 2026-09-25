//! Run only the exact ignored test in its isolated child; ordinary keychain tests install mocks.
//! cargo test --lib runtime_host::profile_source::tests::actual_file_pages_preserve_split_utf8_and_release_snapshot -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_credential_selectors_preserve_original_strings_and_missing_references -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_malformed_credential_maps_are_refused_and_preserved -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::cancelled_actual_page_is_drained_before_close_acknowledges -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_manifest_verification_detects_only_selected_physical_changes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_reopen_streams_large_manifest_and_replays_only_completed_steps -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::cancelled_actual_verification_entry_is_drained_before_close_acknowledges -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_profile_directory_replacement_is_changed_with_same_file_objects -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::close_releases_provisional_reopen_readers -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_populated_profile_commits_locked_with_real_crypto_and_storage -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_admitted_create_reconciles_retained_server_outcome -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_cleanup_reopens_exact_manifest_and_deletes_only_matching_source -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::cancelled_actual_cleanup_delete_is_drained_before_close_acknowledges -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_profile_reset_uses_durable_scope_and_preserves_foreign_data -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_crash_after_device_secret_write_reopens_and_completes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_crash_after_quick_unlock_write_reopens_and_completes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_crash_after_legacy_session_evidence_write_reopens_and_completes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_crash_after_global_local_security_write_reopens_and_completes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_crash_after_account_metadata_write_reopens_and_completes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_crash_after_account_local_security_write_reopens_and_completes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_crash_after_replica_install_reopens_and_completes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_crash_after_account_checkpoint_catalog_write_reopens_and_completes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_crash_after_committed_catalog_write_reopens_and_completes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_crash_after_legacy_device_plain_store_cleanup_reopens_and_completes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_crash_after_protected_credential_cleanup_reopens_and_completes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_crash_after_final_cleanup_checkpoint_reopens_and_completes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_crash_after_wipe_reset_intent_reopens_and_completes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_crash_after_wipe_store_deletion_reopens_and_completes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_crash_after_wipe_store_receipt_reopens_and_completes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_crash_after_wipe_sync_store_deletion_reopens_and_completes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_crash_after_wipe_sync_store_receipt_reopens_and_completes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_crash_after_wipe_credentials_deletion_reopens_and_completes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_crash_after_wipe_credentials_receipt_reopens_and_completes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_crash_after_wipe_device_plain_prefix_deletion_reopens_and_completes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_crash_after_wipe_device_secret_prefix_deletion_reopens_and_completes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_crash_after_wipe_wiped_catalog_write_reopens_and_completes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::profile_source::tests::actual_crash_after_populated_replica_wipe_reopens_and_completes -- --ignored --exact --nocapture --test-threads=1

use super::super::device_lease::DeviceLeaseMode;
use super::super::files::NativeFiles;
use super::super::http::NativeHttpExecutor;
use super::super::storage::NativePlatformStorage;
use super::*;
use bittery_client_core::{
    AccountAccessState, AccountId, AttachmentMoveAccountLease, AttachmentMoveAccountLeasePort,
    AttachmentMoveDownload, AttachmentMoveDownloadRequest, AttachmentMovePreparationFacade,
    AttachmentMoveTransferError, AttachmentMoveTransferPort, AttachmentMoveUpload,
    AttachmentMoveUploadGrant, AuthClientConfig, ClientPlatform, LegacyProfileFormat,
    ObservationRequest, ObservationSink, PlatformStorageArea, PlatformStorageRequest,
    PlatformStorageResponse, ProfileAccountCredentialField, ProfileAdmissionRequest,
    ProfileAdmissionResponse, ProfileAdmissionSource, ProfileGlobalCredentialField,
    ProfileLegacyResetScope, ProfileResetFamilyScope, ProfileResetFileBinding,
    ProfileResetPreparedResult, ProfileResetResult, ProfileResetSnapshot,
    ProfileSourceCleanupReopenResult, ProfileSourceCleanupReopenStep, ProfileSourceCleanupSnapshot,
    ProfileSourceContinuation, ProfileSourceDeleteResult, ProfileSourceFamily,
    ProfileSourceManifestDigest, ProfileSourceManifestEntry, ProfileSourceManifestHeader,
    ProfileSourceObservation, ProfileSourceReopenStep, ProfileSourceSelector,
    ProfileSourceStringEncoding, ProfileSourceVerificationResult, ProfileSourceVerifyStep,
    RequestCancellation, Runtime, RuntimeProjection, RuntimeRequest, RuntimeResponse, SecretString,
    SerializedHttpExecutor, SerializedPlatformStorageExecutor, SerializedProfileAdmissionExecutor,
    SerializedReplicaExecutor, SqliteAttachmentArtifactStore, SqliteReplica,
    SqliteVaultImageArtifactStore, TeardownHostCleanup, TeardownHostCleanupRequest,
    TeardownHostCleanupResponse, TeardownStatus, VaultImageIngressFacade, VaultImageSource,
    VaultImageSourceError, VaultImageSourceGrant, VaultImageSourcePort,
    PROFILE_SOURCE_BINARY_BYTES, PROFILE_SOURCE_CONTROL_BYTES, PROFILE_SOURCE_MANIFEST_VERSION,
};
use keyring::Entry;
use serde_json::json;

const TEST: &str = "runtime_host::profile_source::tests::actual_file_pages_preserve_split_utf8_and_release_snapshot";
const CREDENTIAL_TEST: &str = "runtime_host::profile_source::tests::actual_credential_selectors_preserve_original_strings_and_missing_references";
const MALFORMED_CREDENTIAL_TEST: &str = "runtime_host::profile_source::tests::actual_malformed_credential_maps_are_refused_and_preserved";
const CANCELLED_PAGE_TEST: &str = "runtime_host::profile_source::tests::cancelled_actual_page_is_drained_before_close_acknowledges";
const VERIFICATION_TEST: &str = "runtime_host::profile_source::tests::actual_manifest_verification_detects_only_selected_physical_changes";
const REOPEN_TEST: &str = "runtime_host::profile_source::tests::actual_reopen_streams_large_manifest_and_replays_only_completed_steps";
const CANCELLED_VERIFICATION_TEST: &str = "runtime_host::profile_source::tests::cancelled_actual_verification_entry_is_drained_before_close_acknowledges";
const PROFILE_IDENTITY_TEST: &str = "runtime_host::profile_source::tests::actual_profile_directory_replacement_is_changed_with_same_file_objects";
const PROVISIONAL_CLOSE_TEST: &str =
    "runtime_host::profile_source::tests::close_releases_provisional_reopen_readers";
const POPULATED_ADMISSION_TEST: &str = "runtime_host::profile_source::tests::actual_populated_profile_commits_locked_with_real_crypto_and_storage";
const POPULATED_CACHE_TEST: &str = "runtime_host::profile_source::tests::actual_populated_cache_reopens_offline_with_decryptable_ciphertext";
const LOST_CREATE_TEST: &str = "runtime_host::profile_source::tests::actual_admitted_create_reconciles_retained_server_outcome";
const CLEANUP_TEST: &str = "runtime_host::profile_source::tests::actual_cleanup_reopens_exact_manifest_and_deletes_only_matching_source";
const CANCELLED_CLEANUP_TEST: &str = "runtime_host::profile_source::tests::cancelled_actual_cleanup_delete_is_drained_before_close_acknowledges";
const RESET_TEST: &str = "runtime_host::profile_source::tests::actual_profile_reset_uses_durable_scope_and_preserves_foreign_data";
const RESET_WIPE_TEST: &str =
    "runtime_host::profile_source::tests::actual_runtime_wipe_resets_native_legacy_sources";
const DEVICE_SECRET_CRASH_TEST: &str = "runtime_host::profile_source::tests::actual_crash_after_device_secret_write_reopens_and_completes";
const QUICK_UNLOCK_CRASH_TEST: &str = "runtime_host::profile_source::tests::actual_crash_after_quick_unlock_write_reopens_and_completes";
const LEGACY_SESSION_EVIDENCE_CRASH_TEST: &str = "runtime_host::profile_source::tests::actual_crash_after_legacy_session_evidence_write_reopens_and_completes";
const GLOBAL_LOCAL_SECURITY_CRASH_TEST: &str = "runtime_host::profile_source::tests::actual_crash_after_global_local_security_write_reopens_and_completes";
const ACCOUNT_METADATA_CRASH_TEST: &str = "runtime_host::profile_source::tests::actual_crash_after_account_metadata_write_reopens_and_completes";
const ACCOUNT_LOCAL_SECURITY_CRASH_TEST: &str = "runtime_host::profile_source::tests::actual_crash_after_account_local_security_write_reopens_and_completes";
const REPLICA_INSTALL_CRASH_TEST: &str =
    "runtime_host::profile_source::tests::actual_crash_after_replica_install_reopens_and_completes";
const ACCOUNT_CHECKPOINT_CRASH_TEST: &str = "runtime_host::profile_source::tests::actual_crash_after_account_checkpoint_catalog_write_reopens_and_completes";
const COMMITTED_CATALOG_CRASH_TEST: &str =
    "runtime_host::profile_source::tests::actual_crash_after_committed_catalog_write_reopens_and_completes";
const DESKTOP_STORE_CLEANUP_CRASH_TEST: &str = "runtime_host::profile_source::tests::actual_crash_after_legacy_device_plain_store_cleanup_reopens_and_completes";
const PROTECTED_CREDENTIAL_CLEANUP_CRASH_TEST: &str = "runtime_host::profile_source::tests::actual_crash_after_protected_credential_cleanup_reopens_and_completes";
const FINAL_CLEANUP_CHECKPOINT_CRASH_TEST: &str = "runtime_host::profile_source::tests::actual_crash_after_final_cleanup_checkpoint_reopens_and_completes";
const WIPE_RESET_INTENT_CRASH_TEST: &str =
    "runtime_host::profile_source::tests::actual_crash_after_wipe_reset_intent_reopens_and_completes";
const WIPE_STORE_DELETION_CRASH_TEST: &str =
    "runtime_host::profile_source::tests::actual_crash_after_wipe_store_deletion_reopens_and_completes";
const WIPE_STORE_RECEIPT_CRASH_TEST: &str =
    "runtime_host::profile_source::tests::actual_crash_after_wipe_store_receipt_reopens_and_completes";
const WIPE_SYNC_STORE_DELETION_CRASH_TEST: &str = "runtime_host::profile_source::tests::actual_crash_after_wipe_sync_store_deletion_reopens_and_completes";
const WIPE_SYNC_STORE_RECEIPT_CRASH_TEST: &str = "runtime_host::profile_source::tests::actual_crash_after_wipe_sync_store_receipt_reopens_and_completes";
const WIPE_CREDENTIALS_DELETION_CRASH_TEST: &str = "runtime_host::profile_source::tests::actual_crash_after_wipe_credentials_deletion_reopens_and_completes";
const WIPE_CREDENTIALS_RECEIPT_CRASH_TEST: &str = "runtime_host::profile_source::tests::actual_crash_after_wipe_credentials_receipt_reopens_and_completes";
const WIPE_DEVICE_PLAIN_PREFIX_DELETION_CRASH_TEST: &str = "runtime_host::profile_source::tests::actual_crash_after_wipe_device_plain_prefix_deletion_reopens_and_completes";
const WIPE_DEVICE_SECRET_PREFIX_DELETION_CRASH_TEST: &str = "runtime_host::profile_source::tests::actual_crash_after_wipe_device_secret_prefix_deletion_reopens_and_completes";
const WIPE_WIPED_CATALOG_WRITE_CRASH_TEST: &str = "runtime_host::profile_source::tests::actual_crash_after_wipe_wiped_catalog_write_reopens_and_completes";
const POPULATED_REPLICA_WIPE_CRASH_TEST: &str = "runtime_host::profile_source::tests::actual_crash_after_populated_replica_wipe_reopens_and_completes";
const CHILD: &str = "BITTERY91_PROFILE_SOURCE_OS_CHILD";
const CRASH_CHILD: &str = "BITTERY91_PROFILE_CRASH_CHILD";
const CRASH_DIRECTORY: &str = "BITTERY91_PROFILE_CRASH_DIRECTORY";
const CRASH_IDENTITY: &str = "BITTERY91_PROFILE_CRASH_IDENTITY";
const CRASH_MARKER: &str = "BITTERY91_PROFILE_CRASH_MARKER";
const CRASH_ACCOUNT_ID: &str = "BITTERY91_PROFILE_CRASH_ACCOUNT_ID";
const CRASH_CUT: &str = "BITTERY91_PROFILE_CRASH_CUT";
const SERVICE: &str = "com.bittery.desktop";
const CRASH_DEVICE_KEY: &str = "bittery:runtime:platform-storage:device-key";
const CRASH_DEVICE_CATALOG_KEY: &str = "bittery:runtime:platform-storage:device-catalog";
const CRASH_LOCAL_SECURITY_KEY: &str = "bittery:runtime:platform-storage:local-security";
const CRASH_PLATFORM_PREFIX: &str = "bittery:runtime:platform-storage:";
const WIPE_CRASH_RUNTIME_PLAIN_KEY: &str = "bittery:runtime:platform-storage:wipe-owned-fixture";
const WIPE_CRASH_FOREIGN_PLATFORM_KEY: &str = "foreign:runtime-preserved-fixture";
const WIPE_CRASH_NEAR_MISS_PLATFORM_KEY: &str = "bittery:runtime:platform-storagex:wipe-near-miss";
const WIPE_CRASH_MALFORMED_CATALOG: &str = "malformed initial DeviceCatalog evidence";

fn require(condition: bool, message: &'static str) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}

struct AdmissionNoNetwork;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CrashWriteCut {
    DeviceKey,
    QuickUnlock,
    LegacySessionEvidence,
    GlobalLocalSecurity,
    AccountMetadata,
    AccountLocalSecurity,
    ReplicaInstall,
    AccountCheckpoint,
    CommittedCatalog,
    DesktopStoreCleanup,
    ProtectedCredentialCleanup,
    FinalCleanupCheckpoint,
    WipeResetIntent,
    WipeStoreDeletion,
    WipeStoreReceipt,
    WipeSyncStoreDeletion,
    WipeSyncStoreReceipt,
    WipeCredentialsDeletion,
    WipeCredentialsReceipt,
    WipeDevicePlainPrefixDeletion,
    WipeDeviceSecretPrefixDeletion,
    WipePopulatedReplicaDeletion,
    WipeWipedCatalogWrite,
}

#[derive(Clone, Copy)]
enum CrashKeySelector {
    Exact(&'static str),
    AccountDocument(&'static str),
    AccountScopedDocument(&'static str),
    CatalogWrite(CrashCatalogWritePhase),
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum CrashCatalogWritePhase {
    AccountCheckpoint,
    Committed,
    FinalCleanupCheckpoint,
    ResetWiping,
    ResetStoreReceipt,
    ResetSyncStoreReceipt,
    ResetCredentialsReceipt,
    ResetWiped,
}

#[derive(Clone, Copy)]
enum CrashSourceDeleteSelector {
    DesktopStoreWholeFile,
    AccountSecretKey,
}

#[derive(Clone, Copy)]
enum CrashSourceResetSelector {
    Store,
    SyncStore,
    Credentials,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum CrashCleanupEntry {
    DesktopStore,
    DeviceKey,
    AccountSecretKey,
    AccountSessionData,
}

#[derive(Clone, Copy, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum CrashCatalogAccountCheckpoint {
    Unwritten,
    Verified,
}

#[derive(Clone, Copy, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum CrashCatalogCleanupDisposition {
    Pending,
    Absent,
}

#[derive(Clone, Copy)]
enum CrashCutTarget {
    PlatformWrite {
        area: PlatformStorageArea,
        key: CrashKeySelector,
    },
    PlatformDeletePrefix {
        area: PlatformStorageArea,
        prefix: &'static str,
        preserve_key: Option<&'static str>,
    },
    SourceDelete(CrashSourceDeleteSelector),
    SourceReset(CrashSourceResetSelector),
    ReplicaInstall,
    ReplicaWipe,
}

struct CrashWriteCutSpec {
    environment_value: &'static str,
    test_name: &'static str,
    marker_file: &'static str,
    marker_contents: &'static [u8],
    target: CrashCutTarget,
    completed_secret_documents: &'static [&'static str],
    completed_plain_documents: &'static [&'static str],
}

impl CrashWriteCut {
    fn spec(self) -> CrashWriteCutSpec {
        match self {
            Self::DeviceKey => CrashWriteCutSpec {
                environment_value: "device-key",
                test_name: DEVICE_SECRET_CRASH_TEST,
                marker_file: "device-key-write.marker",
                marker_contents: b"device-key-write-completed\n",
                target: CrashCutTarget::PlatformWrite {
                    area: PlatformStorageArea::DeviceSecret,
                    key: CrashKeySelector::Exact(CRASH_DEVICE_KEY),
                },
                completed_secret_documents: &[],
                completed_plain_documents: &[],
            },
            Self::QuickUnlock => CrashWriteCutSpec {
                environment_value: "quick-unlock",
                test_name: QUICK_UNLOCK_CRASH_TEST,
                marker_file: "quick-unlock-write.marker",
                marker_contents: b"quick-unlock-write-completed\n",
                target: CrashCutTarget::PlatformWrite {
                    area: PlatformStorageArea::DeviceSecret,
                    key: CrashKeySelector::AccountDocument("quick-unlock"),
                },
                completed_secret_documents: &["quick-unlock"],
                completed_plain_documents: &["local-security", "metadata"],
            },
            Self::LegacySessionEvidence => CrashWriteCutSpec {
                environment_value: "legacy-session-evidence",
                test_name: LEGACY_SESSION_EVIDENCE_CRASH_TEST,
                marker_file: "legacy-session-evidence-write.marker",
                marker_contents: b"legacy-session-evidence-write-completed\n",
                target: CrashCutTarget::PlatformWrite {
                    area: PlatformStorageArea::DeviceSecret,
                    key: CrashKeySelector::AccountDocument("legacy-session-evidence"),
                },
                completed_secret_documents: &["quick-unlock", "legacy-session-evidence"],
                completed_plain_documents: &[
                    "local-security",
                    "metadata",
                    "account-local-security",
                ],
            },
            Self::GlobalLocalSecurity => CrashWriteCutSpec {
                environment_value: "global-local-security",
                test_name: GLOBAL_LOCAL_SECURITY_CRASH_TEST,
                marker_file: "global-local-security-write.marker",
                marker_contents: b"global-local-security-write-completed\n",
                target: CrashCutTarget::PlatformWrite {
                    area: PlatformStorageArea::DevicePlain,
                    key: CrashKeySelector::Exact(CRASH_LOCAL_SECURITY_KEY),
                },
                completed_secret_documents: &[],
                completed_plain_documents: &["local-security"],
            },
            Self::AccountMetadata => CrashWriteCutSpec {
                environment_value: "account-metadata",
                test_name: ACCOUNT_METADATA_CRASH_TEST,
                marker_file: "account-metadata-write.marker",
                marker_contents: b"account-metadata-write-completed\n",
                target: CrashCutTarget::PlatformWrite {
                    area: PlatformStorageArea::DevicePlain,
                    key: CrashKeySelector::AccountDocument("metadata"),
                },
                completed_secret_documents: &[],
                completed_plain_documents: &["local-security", "metadata"],
            },
            Self::AccountLocalSecurity => CrashWriteCutSpec {
                environment_value: "account-local-security",
                test_name: ACCOUNT_LOCAL_SECURITY_CRASH_TEST,
                marker_file: "account-local-security-write.marker",
                marker_contents: b"account-local-security-write-completed\n",
                target: CrashCutTarget::PlatformWrite {
                    area: PlatformStorageArea::DevicePlain,
                    key: CrashKeySelector::AccountScopedDocument("local-security"),
                },
                completed_secret_documents: &["quick-unlock"],
                completed_plain_documents: &[
                    "local-security",
                    "metadata",
                    "account-local-security",
                ],
            },
            Self::ReplicaInstall => CrashWriteCutSpec {
                environment_value: "replica-install",
                test_name: REPLICA_INSTALL_CRASH_TEST,
                marker_file: "replica-install.marker",
                marker_contents: b"replica-install-committed\n",
                target: CrashCutTarget::ReplicaInstall,
                completed_secret_documents: &["quick-unlock", "legacy-session-evidence"],
                completed_plain_documents: &[
                    "local-security",
                    "metadata",
                    "account-local-security",
                ],
            },
            Self::AccountCheckpoint => CrashWriteCutSpec {
                environment_value: "account-checkpoint",
                test_name: ACCOUNT_CHECKPOINT_CRASH_TEST,
                marker_file: "account-checkpoint-catalog.marker",
                marker_contents: b"account-checkpoint-catalog-write-completed\n",
                target: CrashCutTarget::PlatformWrite {
                    area: PlatformStorageArea::DevicePlain,
                    key: CrashKeySelector::CatalogWrite(CrashCatalogWritePhase::AccountCheckpoint),
                },
                completed_secret_documents: &["quick-unlock", "legacy-session-evidence"],
                completed_plain_documents: &[
                    "local-security",
                    "metadata",
                    "account-local-security",
                ],
            },
            Self::CommittedCatalog => CrashWriteCutSpec {
                environment_value: "committed-catalog",
                test_name: COMMITTED_CATALOG_CRASH_TEST,
                marker_file: "committed-catalog.marker",
                marker_contents: b"committed-catalog-write-completed\n",
                target: CrashCutTarget::PlatformWrite {
                    area: PlatformStorageArea::DevicePlain,
                    key: CrashKeySelector::CatalogWrite(CrashCatalogWritePhase::Committed),
                },
                completed_secret_documents: &["quick-unlock", "legacy-session-evidence"],
                completed_plain_documents: &[
                    "local-security",
                    "metadata",
                    "account-local-security",
                ],
            },
            Self::DesktopStoreCleanup => CrashWriteCutSpec {
                environment_value: "desktop-store-cleanup",
                test_name: DESKTOP_STORE_CLEANUP_CRASH_TEST,
                marker_file: "desktop-store-cleanup.marker",
                marker_contents: b"desktop-store-source-delete-completed\n",
                target: CrashCutTarget::SourceDelete(
                    CrashSourceDeleteSelector::DesktopStoreWholeFile,
                ),
                completed_secret_documents: &["quick-unlock", "legacy-session-evidence"],
                completed_plain_documents: &[
                    "local-security",
                    "metadata",
                    "account-local-security",
                ],
            },
            Self::ProtectedCredentialCleanup => CrashWriteCutSpec {
                environment_value: "protected-credential-cleanup",
                test_name: PROTECTED_CREDENTIAL_CLEANUP_CRASH_TEST,
                marker_file: "protected-credential-cleanup.marker",
                marker_contents: b"protected-credential-source-delete-completed\n",
                target: CrashCutTarget::SourceDelete(CrashSourceDeleteSelector::AccountSecretKey),
                completed_secret_documents: &["quick-unlock", "legacy-session-evidence"],
                completed_plain_documents: &[
                    "local-security",
                    "metadata",
                    "account-local-security",
                ],
            },
            Self::FinalCleanupCheckpoint => CrashWriteCutSpec {
                environment_value: "final-cleanup-checkpoint",
                test_name: FINAL_CLEANUP_CHECKPOINT_CRASH_TEST,
                marker_file: "final-cleanup-checkpoint.marker",
                marker_contents: b"final-source-cleanup-checkpoint-completed\n",
                target: CrashCutTarget::PlatformWrite {
                    area: PlatformStorageArea::DevicePlain,
                    key: CrashKeySelector::CatalogWrite(
                        CrashCatalogWritePhase::FinalCleanupCheckpoint,
                    ),
                },
                completed_secret_documents: &["quick-unlock", "legacy-session-evidence"],
                completed_plain_documents: &[
                    "local-security",
                    "metadata",
                    "account-local-security",
                ],
            },
            Self::WipeResetIntent => CrashWriteCutSpec {
                environment_value: "wipe-reset-intent",
                test_name: WIPE_RESET_INTENT_CRASH_TEST,
                marker_file: "wipe-reset-intent.marker",
                marker_contents: b"wipe-reset-intent-write-completed\n",
                target: CrashCutTarget::PlatformWrite {
                    area: PlatformStorageArea::DevicePlain,
                    key: CrashKeySelector::CatalogWrite(CrashCatalogWritePhase::ResetWiping),
                },
                completed_secret_documents: &[],
                completed_plain_documents: &[],
            },
            Self::WipeStoreDeletion => CrashWriteCutSpec {
                environment_value: "wipe-store-deletion",
                test_name: WIPE_STORE_DELETION_CRASH_TEST,
                marker_file: "wipe-store-deletion.marker",
                marker_contents: b"wipe-store-source-reset-completed\n",
                target: CrashCutTarget::SourceReset(CrashSourceResetSelector::Store),
                completed_secret_documents: &[],
                completed_plain_documents: &[],
            },
            Self::WipeStoreReceipt => CrashWriteCutSpec {
                environment_value: "wipe-store-receipt",
                test_name: WIPE_STORE_RECEIPT_CRASH_TEST,
                marker_file: "wipe-store-receipt.marker",
                marker_contents: b"wipe-store-receipt-write-completed\n",
                target: CrashCutTarget::PlatformWrite {
                    area: PlatformStorageArea::DevicePlain,
                    key: CrashKeySelector::CatalogWrite(CrashCatalogWritePhase::ResetStoreReceipt),
                },
                completed_secret_documents: &[],
                completed_plain_documents: &[],
            },
            Self::WipeSyncStoreDeletion => CrashWriteCutSpec {
                environment_value: "wipe-sync-store-deletion",
                test_name: WIPE_SYNC_STORE_DELETION_CRASH_TEST,
                marker_file: "wipe-sync-store-deletion.marker",
                marker_contents: b"wipe-sync-store-source-reset-completed\n",
                target: CrashCutTarget::SourceReset(CrashSourceResetSelector::SyncStore),
                completed_secret_documents: &[],
                completed_plain_documents: &[],
            },
            Self::WipeSyncStoreReceipt => CrashWriteCutSpec {
                environment_value: "wipe-sync-store-receipt",
                test_name: WIPE_SYNC_STORE_RECEIPT_CRASH_TEST,
                marker_file: "wipe-sync-store-receipt.marker",
                marker_contents: b"wipe-sync-store-receipt-write-completed\n",
                target: CrashCutTarget::PlatformWrite {
                    area: PlatformStorageArea::DevicePlain,
                    key: CrashKeySelector::CatalogWrite(
                        CrashCatalogWritePhase::ResetSyncStoreReceipt,
                    ),
                },
                completed_secret_documents: &[],
                completed_plain_documents: &[],
            },
            Self::WipeCredentialsDeletion => CrashWriteCutSpec {
                environment_value: "wipe-credentials-deletion",
                test_name: WIPE_CREDENTIALS_DELETION_CRASH_TEST,
                marker_file: "wipe-credentials-deletion.marker",
                marker_contents: b"wipe-credentials-source-reset-completed\n",
                target: CrashCutTarget::SourceReset(CrashSourceResetSelector::Credentials),
                completed_secret_documents: &[],
                completed_plain_documents: &[],
            },
            Self::WipeCredentialsReceipt => CrashWriteCutSpec {
                environment_value: "wipe-credentials-receipt",
                test_name: WIPE_CREDENTIALS_RECEIPT_CRASH_TEST,
                marker_file: "wipe-credentials-receipt.marker",
                marker_contents: b"wipe-credentials-receipt-write-completed\n",
                target: CrashCutTarget::PlatformWrite {
                    area: PlatformStorageArea::DevicePlain,
                    key: CrashKeySelector::CatalogWrite(
                        CrashCatalogWritePhase::ResetCredentialsReceipt,
                    ),
                },
                completed_secret_documents: &[],
                completed_plain_documents: &[],
            },
            Self::WipeDevicePlainPrefixDeletion => CrashWriteCutSpec {
                environment_value: "wipe-device-plain-prefix-deletion",
                test_name: WIPE_DEVICE_PLAIN_PREFIX_DELETION_CRASH_TEST,
                marker_file: "wipe-device-plain-prefix-deletion.marker",
                marker_contents: b"wipe-device-plain-prefix-deletion-completed\n",
                target: CrashCutTarget::PlatformDeletePrefix {
                    area: PlatformStorageArea::DevicePlain,
                    prefix: CRASH_PLATFORM_PREFIX,
                    preserve_key: Some(CRASH_DEVICE_CATALOG_KEY),
                },
                completed_secret_documents: &[],
                completed_plain_documents: &[],
            },
            Self::WipeDeviceSecretPrefixDeletion => CrashWriteCutSpec {
                environment_value: "wipe-device-secret-prefix-deletion",
                test_name: WIPE_DEVICE_SECRET_PREFIX_DELETION_CRASH_TEST,
                marker_file: "wipe-device-secret-prefix-deletion.marker",
                marker_contents: b"wipe-device-secret-prefix-deletion-completed\n",
                target: CrashCutTarget::PlatformDeletePrefix {
                    area: PlatformStorageArea::DeviceSecret,
                    prefix: CRASH_PLATFORM_PREFIX,
                    preserve_key: None,
                },
                completed_secret_documents: &[],
                completed_plain_documents: &[],
            },
            Self::WipeWipedCatalogWrite => CrashWriteCutSpec {
                environment_value: "wipe-wiped-catalog-write",
                test_name: WIPE_WIPED_CATALOG_WRITE_CRASH_TEST,
                marker_file: "wipe-wiped-catalog-write.marker",
                marker_contents: b"wipe-wiped-catalog-write-completed\n",
                target: CrashCutTarget::PlatformWrite {
                    area: PlatformStorageArea::DevicePlain,
                    key: CrashKeySelector::CatalogWrite(CrashCatalogWritePhase::ResetWiped),
                },
                completed_secret_documents: &[],
                completed_plain_documents: &[],
            },
            Self::WipePopulatedReplicaDeletion => CrashWriteCutSpec {
                environment_value: "wipe-populated-replica-deletion",
                test_name: POPULATED_REPLICA_WIPE_CRASH_TEST,
                marker_file: "wipe-populated-replica-deletion.marker",
                marker_contents: b"wipe-populated-replica-deletion-committed\n",
                target: CrashCutTarget::ReplicaWipe,
                completed_secret_documents: &[],
                completed_plain_documents: &[],
            },
        }
    }

    fn environment_value(self) -> &'static str {
        self.spec().environment_value
    }

    fn from_environment(value: &str) -> Result<Self, String> {
        match value {
            "device-key" => Ok(Self::DeviceKey),
            "quick-unlock" => Ok(Self::QuickUnlock),
            "legacy-session-evidence" => Ok(Self::LegacySessionEvidence),
            "global-local-security" => Ok(Self::GlobalLocalSecurity),
            "account-metadata" => Ok(Self::AccountMetadata),
            "account-local-security" => Ok(Self::AccountLocalSecurity),
            "replica-install" => Ok(Self::ReplicaInstall),
            "account-checkpoint" => Ok(Self::AccountCheckpoint),
            "committed-catalog" => Ok(Self::CommittedCatalog),
            "desktop-store-cleanup" => Ok(Self::DesktopStoreCleanup),
            "protected-credential-cleanup" => Ok(Self::ProtectedCredentialCleanup),
            "final-cleanup-checkpoint" => Ok(Self::FinalCleanupCheckpoint),
            "wipe-reset-intent" => Ok(Self::WipeResetIntent),
            "wipe-store-deletion" => Ok(Self::WipeStoreDeletion),
            "wipe-store-receipt" => Ok(Self::WipeStoreReceipt),
            "wipe-sync-store-deletion" => Ok(Self::WipeSyncStoreDeletion),
            "wipe-sync-store-receipt" => Ok(Self::WipeSyncStoreReceipt),
            "wipe-credentials-deletion" => Ok(Self::WipeCredentialsDeletion),
            "wipe-credentials-receipt" => Ok(Self::WipeCredentialsReceipt),
            "wipe-device-plain-prefix-deletion" => Ok(Self::WipeDevicePlainPrefixDeletion),
            "wipe-device-secret-prefix-deletion" => Ok(Self::WipeDeviceSecretPrefixDeletion),
            "wipe-populated-replica-deletion" => Ok(Self::WipePopulatedReplicaDeletion),
            "wipe-wiped-catalog-write" => Ok(Self::WipeWipedCatalogWrite),
            _ => Err("Crash child has an unknown physical write cut".into()),
        }
    }

    fn test_name(self) -> &'static str {
        self.spec().test_name
    }

    fn marker_file(self) -> &'static str {
        self.spec().marker_file
    }

    fn marker_contents(self) -> &'static [u8] {
        self.spec().marker_contents
    }

    fn matches_write(self, request: &PlatformStorageRequest, account_id: &str) -> bool {
        let PlatformStorageRequest::Set { area, key, value } = request else {
            return false;
        };
        let spec = self.spec();
        match spec.target {
            CrashCutTarget::PlatformWrite {
                area: expected_area,
                key: selector,
            } if area == &expected_area => match selector {
                CrashKeySelector::Exact(expected) => key.as_str() == expected,
                CrashKeySelector::AccountDocument(document) => {
                    matches_account_document(key.as_str(), account_id, document)
                }
                CrashKeySelector::AccountScopedDocument(document) => {
                    key.as_str() == crash_account_scoped_document_key(account_id, document).as_str()
                }
                CrashKeySelector::CatalogWrite(phase) => {
                    key.as_str() == CRASH_DEVICE_CATALOG_KEY
                        && matches_catalog_write_phase(value.as_ref(), phase, account_id)
                }
            },
            CrashCutTarget::PlatformWrite { .. }
            | CrashCutTarget::PlatformDeletePrefix { .. }
            | CrashCutTarget::SourceDelete(_)
            | CrashCutTarget::SourceReset(_)
            | CrashCutTarget::ReplicaInstall
            | CrashCutTarget::ReplicaWipe => false,
        }
    }

    fn matches_delete_prefix(self, request: &PlatformStorageRequest) -> bool {
        let CrashCutTarget::PlatformDeletePrefix {
            area: expected_area,
            prefix: expected_prefix,
            preserve_key: expected_preserve_key,
        } = self.spec().target
        else {
            return false;
        };
        matches!(
            request,
            PlatformStorageRequest::DeletePrefix {
                area,
                prefix,
                preserve_key,
            } if *area == expected_area
                && prefix == expected_prefix
                && preserve_key.as_deref() == expected_preserve_key
        )
    }

    fn selected_source_delete(
        self,
        request: &ProfileAdmissionRequest,
        account_id: &str,
    ) -> Option<(String, String, u64)> {
        let CrashCutTarget::SourceDelete(selector) = self.spec().target else {
            return None;
        };
        let ProfileAdmissionRequest::DeleteCapturedSource {
            snapshot_handle,
            admission_id,
            index,
            expected_entry,
        } = request
        else {
            return None;
        };
        if snapshot_handle.is_empty() || admission_id.is_empty() {
            return None;
        }
        let selected = match selector {
            CrashSourceDeleteSelector::DesktopStoreWholeFile => {
                expected_entry.family == ProfileSourceFamily::DesktopStore
                    && expected_entry.selector == (ProfileSourceSelector::WholeFile {})
                    && matches!(
                        &expected_entry.observation,
                        ProfileSourceObservation::FileBytes { .. }
                    )
            }
            CrashSourceDeleteSelector::AccountSecretKey => {
                expected_entry.family == ProfileSourceFamily::DesktopCredentials
                    && expected_entry.selector
                        == (ProfileSourceSelector::AccountCredential {
                            account_id: account_id.into(),
                            field: ProfileAccountCredentialField::SecretKey,
                        })
                    && matches!(
                        &expected_entry.observation,
                        ProfileSourceObservation::StoredString { .. }
                    )
            }
        };
        selected.then(|| (snapshot_handle.clone(), admission_id.clone(), *index))
    }

    fn is_source_delete(self) -> bool {
        matches!(self.spec().target, CrashCutTarget::SourceDelete(_))
    }

    fn is_wipe(self) -> bool {
        matches!(
            self,
            Self::WipeResetIntent
                | Self::WipeStoreDeletion
                | Self::WipeStoreReceipt
                | Self::WipeSyncStoreDeletion
                | Self::WipeSyncStoreReceipt
                | Self::WipeCredentialsDeletion
                | Self::WipeCredentialsReceipt
                | Self::WipeDevicePlainPrefixDeletion
                | Self::WipeDeviceSecretPrefixDeletion
                | Self::WipePopulatedReplicaDeletion
                | Self::WipeWipedCatalogWrite
        )
    }

    fn is_terminal_wiped_write(self) -> bool {
        self == Self::WipeWipedCatalogWrite
    }

    fn tracks_initial_wipe_identity(self) -> bool {
        matches!(
            self,
            Self::WipeDevicePlainPrefixDeletion
                | Self::WipeDeviceSecretPrefixDeletion
                | Self::WipeWipedCatalogWrite
        )
    }

    fn is_source_reset(self) -> bool {
        matches!(self.spec().target, CrashCutTarget::SourceReset(_))
    }

    fn selected_reset_family(
        self,
        request: &ProfileAdmissionRequest,
    ) -> Option<(String, String, ProfileSourceFamily)> {
        let CrashCutTarget::SourceReset(selector) = self.spec().target else {
            return None;
        };
        let ProfileAdmissionRequest::ResetLegacySourceFamily {
            reset_handle,
            wipe_id,
            family,
        } = request
        else {
            return None;
        };
        let expected_family = match selector {
            CrashSourceResetSelector::Store => ProfileSourceFamily::DesktopStore,
            CrashSourceResetSelector::SyncStore => ProfileSourceFamily::DesktopSyncStore,
            CrashSourceResetSelector::Credentials => ProfileSourceFamily::DesktopCredentials,
        };
        (!reset_handle.is_empty() && !wipe_id.is_empty() && *family == expected_family)
            .then(|| (reset_handle.clone(), wipe_id.clone(), expected_family))
    }

    fn is_cleanup(self) -> bool {
        matches!(
            self,
            Self::DesktopStoreCleanup
                | Self::ProtectedCredentialCleanup
                | Self::FinalCleanupCheckpoint
        )
    }

    fn is_replica_install(self) -> bool {
        matches!(self.spec().target, CrashCutTarget::ReplicaInstall)
    }

    fn has_installed_replica(self) -> bool {
        matches!(
            self,
            Self::ReplicaInstall
                | Self::AccountCheckpoint
                | Self::CommittedCatalog
                | Self::DesktopStoreCleanup
                | Self::ProtectedCredentialCleanup
                | Self::FinalCleanupCheckpoint
        )
    }

    fn completed_secret_documents(self) -> &'static [&'static str] {
        self.spec().completed_secret_documents
    }

    fn completed_plain_documents(self) -> &'static [&'static str] {
        self.spec().completed_plain_documents
    }
}

fn matches_account_document(key: &str, account_id: &str, document: &str) -> bool {
    let account_prefix = format!(
        "{CRASH_PLATFORM_PREFIX}account:{}:{account_id}:incarnation:",
        account_id.len()
    );
    key.strip_prefix(&account_prefix)
        .and_then(|length_generation_document| {
            let mut components = length_generation_document.splitn(3, ':');
            let declared_generation_length = components.next()?.parse::<usize>().ok()?;
            let generation = components.next()?;
            let actual_document = components.next()?;
            Some(declared_generation_length == generation.len() && actual_document == document)
        })
        .unwrap_or(false)
}

fn crash_account_scoped_document_key(account_id: &str, document: &str) -> String {
    format!(
        "{CRASH_PLATFORM_PREFIX}account:{}:{account_id}:{document}",
        account_id.len()
    )
}

fn crash_cleanup_entry(
    entry: &ProfileSourceManifestEntry,
    account_id: &str,
) -> Option<CrashCleanupEntry> {
    match (&entry.family, &entry.selector, &entry.observation) {
        (
            ProfileSourceFamily::DesktopStore,
            ProfileSourceSelector::WholeFile {},
            ProfileSourceObservation::FileBytes { .. },
        ) => Some(CrashCleanupEntry::DesktopStore),
        (
            ProfileSourceFamily::DesktopCredentials,
            ProfileSourceSelector::GlobalCredential {
                field: ProfileGlobalCredentialField::DeviceKey,
            },
            ProfileSourceObservation::StoredString { .. },
        ) => Some(CrashCleanupEntry::DeviceKey),
        (
            ProfileSourceFamily::DesktopCredentials,
            ProfileSourceSelector::AccountCredential {
                account_id: captured_account_id,
                field: ProfileAccountCredentialField::SecretKey,
            },
            ProfileSourceObservation::StoredString { .. },
        ) if captured_account_id.as_str() == account_id => {
            Some(CrashCleanupEntry::AccountSecretKey)
        }
        (
            ProfileSourceFamily::DesktopCredentials,
            ProfileSourceSelector::AccountCredential {
                account_id: captured_account_id,
                field: ProfileAccountCredentialField::SessionData,
            },
            ProfileSourceObservation::StoredString { .. },
        ) if captured_account_id.as_str() == account_id => {
            Some(CrashCleanupEntry::AccountSessionData)
        }
        _ => None,
    }
}

fn crash_cleanup_receipts(
    catalog: &serde_json::Value,
    account_id: &str,
) -> Option<std::collections::BTreeMap<CrashCleanupEntry, (u64, CrashCatalogCleanupDisposition)>> {
    let progress = &catalog["profileAdmission"]["progress"];
    let manifest_entries = progress["manifest"]["entries"].as_array()?;
    let obligations = progress["sourceCleanup"].as_array()?;
    if obligations.is_empty() {
        return None;
    }
    let mut receipts = std::collections::BTreeMap::new();
    for obligation in obligations {
        let manifest_index = obligation["manifestEntryIndex"]
            .as_str()?
            .parse::<u64>()
            .ok()?;
        let index = usize::try_from(manifest_index).ok()?;
        let entry: ProfileSourceManifestEntry =
            serde_json::from_value(manifest_entries.get(index)?.clone()).ok()?;
        let target = crash_cleanup_entry(&entry, account_id)?;
        let disposition = serde_json::from_value(obligation["disposition"].clone()).ok()?;
        if receipts
            .insert(target, (manifest_index, disposition))
            .is_some()
        {
            return None;
        }
    }
    let expected = std::collections::BTreeSet::from([
        CrashCleanupEntry::DesktopStore,
        CrashCleanupEntry::DeviceKey,
        CrashCleanupEntry::AccountSecretKey,
        CrashCleanupEntry::AccountSessionData,
    ]);
    (receipts
        .keys()
        .copied()
        .collect::<std::collections::BTreeSet<_>>()
        == expected)
        .then_some(receipts)
}

struct CrashCleanupIdentity {
    admission_id: String,
    manifest_digest: String,
    incarnation: String,
}

fn require_crash_cleanup_journal(
    catalog: &serde_json::Value,
    cut: CrashWriteCut,
    fixture: &CrashAdmissionFixture,
    expected_profile_identity: &str,
) -> Result<CrashCleanupIdentity, String> {
    let admission = &catalog["profileAdmission"];
    require(
        admission["kind"] == "import" && admission["phase"] == "committed",
        "Cleanup crash journal is not a Committed import",
    )?;
    let admission_id = admission["admissionId"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or("Cleanup crash journal has no admission identity")?
        .to_owned();
    require(
        admission["source"]["profileIdentity"] == expected_profile_identity,
        "Cleanup crash journal changed its source profile identity",
    )?;
    let manifest_digest = admission["manifestDigest"]
        .as_str()
        .filter(|value| value.len() == 64)
        .ok_or("Cleanup crash journal has no exact manifest digest")?
        .to_owned();
    let progress_accounts = admission["progress"]["accounts"]
        .as_array()
        .ok_or("Cleanup crash journal has no Account progress")?;
    let [progress_account] = progress_accounts.as_slice() else {
        return Err("Cleanup crash journal changed its single Account scope".into());
    };
    let accounts = catalog["accounts"]
        .as_array()
        .ok_or("Cleanup crash catalog has no active Accounts")?;
    let [catalog_account] = accounts.as_slice() else {
        return Err("Cleanup crash catalog changed its single active Account".into());
    };
    let incarnation = progress_account["incarnation"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or("Cleanup crash journal has no Account incarnation")?
        .to_owned();
    let checkpoint = serde_json::from_value::<CrashCatalogAccountCheckpoint>(
        progress_account["checkpoint"].clone(),
    )
    .map_err(|_| "Cleanup crash Account checkpoint is malformed")?;
    require(
        progress_account["accountId"] == fixture.account_id
            && checkpoint == CrashCatalogAccountCheckpoint::Verified
            && catalog_account["accountId"] == fixture.account_id
            && catalog_account["activeIncarnation"] == incarnation
            && catalog_account["pendingInstall"].is_null()
            && catalog_account["pendingRetirement"].is_null(),
        "Cleanup crash journal lost its exact active Account incarnation",
    )?;
    let receipts = crash_cleanup_receipts(catalog, &fixture.account_id)
        .ok_or("Cleanup crash journal changed its exact captured source targets")?;
    for (target, (_, disposition)) in &receipts {
        let already_deleted = match cut {
            CrashWriteCut::DesktopStoreCleanup => false,
            CrashWriteCut::ProtectedCredentialCleanup => matches!(
                target,
                CrashCleanupEntry::DesktopStore | CrashCleanupEntry::DeviceKey
            ),
            CrashWriteCut::FinalCleanupCheckpoint => true,
            _ => return Err("Cleanup journal assertion received a non-cleanup cut".into()),
        };
        let expected = if already_deleted {
            CrashCatalogCleanupDisposition::Absent
        } else {
            CrashCatalogCleanupDisposition::Pending
        };
        require(
            *disposition == expected,
            "Cleanup crash journal has the wrong durable source-cleanup receipt",
        )?;
    }
    Ok(CrashCleanupIdentity {
        admission_id,
        manifest_digest,
        incarnation,
    })
}

fn source_delete_marker_contents(cut: CrashWriteCut, admission_id: &str, index: u64) -> Vec<u8> {
    let mut contents = cut.marker_contents().to_vec();
    contents.extend_from_slice(format!("admissionId={admission_id}\nindex={index}\n").as_bytes());
    contents
}

fn require_crash_legacy_source_state(
    directory: &Path,
    physical: &Entry,
    fixture: &CrashAdmissionFixture,
    cut: CrashWriteCut,
) -> Result<(), String> {
    let store_path = directory.join("store.json");
    let sync_store_path = directory.join("sync-store.json");
    let store_was_removed = matches!(
        cut,
        CrashWriteCut::DesktopStoreCleanup
            | CrashWriteCut::ProtectedCredentialCleanup
            | CrashWriteCut::FinalCleanupCheckpoint
    );
    require(
        if store_was_removed {
            !store_path
                .try_exists()
                .map_err(|_| "Cannot inspect cleaned legacy DevicePlain file")?
        } else {
            std::fs::read(&store_path)
                .map_err(|_| "Cannot verify captured legacy DevicePlain file")?
                == fixture.store
        },
        "Cleanup crash cut has the wrong captured legacy DevicePlain file state",
    )?;
    require(
        !sync_store_path
            .try_exists()
            .map_err(|_| "Cannot inspect absent legacy Sync file")?,
        "Cleanup crash cut unexpectedly created the absent legacy Sync file",
    )?;

    let removed = match cut {
        CrashWriteCut::DesktopStoreCleanup => std::collections::BTreeSet::new(),
        CrashWriteCut::ProtectedCredentialCleanup => std::collections::BTreeSet::from([
            "bittery_device_key".to_owned(),
            format!("bittery_account_{}_secret_key", fixture.account_id),
        ]),
        CrashWriteCut::FinalCleanupCheckpoint => std::collections::BTreeSet::from([
            "bittery_device_key".to_owned(),
            format!("bittery_account_{}_secret_key", fixture.account_id),
            format!("bittery_account_{}_session_data", fixture.account_id),
        ]),
        _ => return Err("Legacy source assertion received a non-cleanup cut".into()),
    };
    let actual = read_crash_fixture_keychain(physical)?;
    for (key, expected) in &fixture.protected {
        if removed.contains(key) {
            require(
                !actual.contains_key(key),
                "Cleanup crash cut retained a successfully deleted legacy credential",
            )?;
        } else {
            require(
                actual.get(key).map(|value| value.as_str()) == Some(expected.as_str()),
                "Cleanup crash cut changed an unrelated or not-yet-deleted legacy credential",
            )?;
        }
    }
    require(
        actual
            .get("unrelated_crash_fixture_entry")
            .is_some_and(|value| value.as_str() == "preserved"),
        "Cleanup crash cut removed the unrelated protected entry",
    )
}

fn matches_catalog_write_phase(
    value: &str,
    requested: CrashCatalogWritePhase,
    account_id: &str,
) -> bool {
    let Ok(catalog) = serde_json::from_str::<serde_json::Value>(value) else {
        return false;
    };
    if matches!(
        requested,
        CrashCatalogWritePhase::ResetWiping
            | CrashCatalogWritePhase::ResetStoreReceipt
            | CrashCatalogWritePhase::ResetSyncStoreReceipt
            | CrashCatalogWritePhase::ResetCredentialsReceipt
            | CrashCatalogWritePhase::ResetWiped
    ) {
        let Some(reset) = wipe_reset_catalog_view(&catalog) else {
            return false;
        };
        if requested == CrashCatalogWritePhase::ResetWiped {
            return reset.phase == bittery_client_core::ProfileAdmissionResetPhase::Wiped
                && reset.revision == 4
                && reset.remaining.is_empty();
        }
        return reset.phase == bittery_client_core::ProfileAdmissionResetPhase::Wiping
            && match requested {
                CrashCatalogWritePhase::ResetWiping => {
                    reset.revision == 0
                        && reset.remaining
                            == [
                                ProfileSourceFamily::DesktopStore,
                                ProfileSourceFamily::DesktopSyncStore,
                                ProfileSourceFamily::DesktopCredentials,
                            ]
                }
                CrashCatalogWritePhase::ResetStoreReceipt => {
                    reset.revision == 1
                        && reset.remaining
                            == [
                                ProfileSourceFamily::DesktopSyncStore,
                                ProfileSourceFamily::DesktopCredentials,
                            ]
                }
                CrashCatalogWritePhase::ResetSyncStoreReceipt => {
                    reset.revision == 2
                        && reset.remaining == [ProfileSourceFamily::DesktopCredentials]
                }
                CrashCatalogWritePhase::ResetCredentialsReceipt => {
                    reset.revision == 3 && reset.remaining.is_empty()
                }
                CrashCatalogWritePhase::ResetWiped => false,
                _ => false,
            };
    }
    let admission = &catalog["profileAdmission"];
    if admission["kind"] != "import" || admission["admissionId"].as_str().is_none_or(str::is_empty)
    {
        return false;
    }
    let Ok(phase) = serde_json::from_value::<bittery_client_core::ProfileAdmissionImportPhase>(
        admission["phase"].clone(),
    ) else {
        return false;
    };
    let Some(cleanup) = crash_cleanup_receipts(&catalog, account_id) else {
        return false;
    };
    let cleanup_is = |expected| {
        cleanup
            .values()
            .all(|(_, disposition)| *disposition == expected)
    };
    let Some(progress_accounts) = admission["progress"]["accounts"].as_array() else {
        return false;
    };
    let [progress_account] = progress_accounts.as_slice() else {
        return false;
    };
    let Some(accounts) = catalog["accounts"].as_array() else {
        return false;
    };
    let [catalog_account] = accounts.as_slice() else {
        return false;
    };
    let Some(incarnation) = progress_account["incarnation"].as_str() else {
        return false;
    };
    let Ok(checkpoint) = serde_json::from_value::<CrashCatalogAccountCheckpoint>(
        progress_account["checkpoint"].clone(),
    ) else {
        return false;
    };
    if incarnation.is_empty()
        || progress_account["accountId"].as_str() != Some(account_id)
        || catalog_account["accountId"].as_str() != Some(account_id)
        || checkpoint != CrashCatalogAccountCheckpoint::Verified
        || catalog_account
            .get("pendingRetirement")
            .is_some_and(|value| !value.is_null())
    {
        return false;
    }
    match requested {
        CrashCatalogWritePhase::AccountCheckpoint => {
            cleanup_is(CrashCatalogCleanupDisposition::Pending)
                && phase == bittery_client_core::ProfileAdmissionImportPhase::Preparing
                && catalog_account
                    .get("activeIncarnation")
                    .is_some_and(|value| value.is_null())
                && catalog_account["pendingInstall"]["incarnation"].as_str() == Some(incarnation)
                && catalog_account["pendingInstall"]
                    .get("expectedActiveIncarnation")
                    .is_some_and(|value| value.is_null())
        }
        CrashCatalogWritePhase::Committed => {
            cleanup_is(CrashCatalogCleanupDisposition::Pending)
                && phase == bittery_client_core::ProfileAdmissionImportPhase::Committed
                && catalog_account["activeIncarnation"].as_str() == Some(incarnation)
                && catalog_account
                    .get("pendingInstall")
                    .is_some_and(|value| value.is_null())
        }
        CrashCatalogWritePhase::FinalCleanupCheckpoint => {
            cleanup_is(CrashCatalogCleanupDisposition::Absent)
                && phase == bittery_client_core::ProfileAdmissionImportPhase::Committed
                && catalog_account["activeIncarnation"].as_str() == Some(incarnation)
                && catalog_account
                    .get("pendingInstall")
                    .is_some_and(|value| value.is_null())
        }
        CrashCatalogWritePhase::ResetWiping
        | CrashCatalogWritePhase::ResetStoreReceipt
        | CrashCatalogWritePhase::ResetSyncStoreReceipt
        | CrashCatalogWritePhase::ResetCredentialsReceipt
        | CrashCatalogWritePhase::ResetWiped => false,
    }
}

struct WipeResetCatalogView {
    wipe_id: String,
    phase: bittery_client_core::ProfileAdmissionResetPhase,
    revision: u64,
    scope: ProfileLegacyResetScope,
    remaining: Vec<ProfileSourceFamily>,
}

fn wipe_reset_catalog_view(catalog: &serde_json::Value) -> Option<WipeResetCatalogView> {
    let admission = &catalog["profileAdmission"];
    let wipe_id = admission["wipeId"]
        .as_str()
        .filter(|value| !value.is_empty())?
        .to_owned();
    let phase = serde_json::from_value::<bittery_client_core::ProfileAdmissionResetPhase>(
        admission["phase"].clone(),
    )
    .ok()?;
    let revision_text = admission["revision"].as_str()?;
    let revision = revision_text.parse::<u64>().ok()?;
    if revision.to_string() != revision_text {
        return None;
    }
    let scope =
        serde_json::from_value::<ProfileLegacyResetScope>(admission["scope"]["scope"].clone())
            .ok()?;
    let remaining =
        serde_json::from_value::<Vec<ProfileSourceFamily>>(admission["remainingFamilies"].clone())
            .ok()?;
    if admission["kind"] != "reset"
        || admission["version"] != 1
        || admission["scope"]["type"] != "legacyProfile"
        || scope.validate().is_err()
        || !catalog["accounts"].as_array().is_some_and(Vec::is_empty)
    {
        return None;
    }
    Some(WipeResetCatalogView {
        wipe_id,
        phase,
        revision,
        scope,
        remaining,
    })
}

struct HoldAfterSelectedPlatformWrite {
    inner: Arc<NativePlatformStorage>,
    marker: PathBuf,
    cut: CrashWriteCut,
    account_id: String,
    expected_wipe_scope: Option<ProfileLegacyResetScope>,
    initial_wipe_id: std::sync::Mutex<Option<String>>,
}

struct HoldAfterSelectedSourceDeletion {
    inner: Arc<NativeProfileSource>,
    marker: PathBuf,
    cut: CrashWriteCut,
    account_id: String,
}

struct ObserveWipeReset {
    inner: Arc<dyn SerializedProfileAdmissionExecutor>,
    cut: Option<CrashWriteCut>,
    marker: Option<PathBuf>,
    replay_absence: Option<(String, ProfileSourceFamily)>,
    replay_absence_observed: Arc<std::sync::atomic::AtomicBool>,
    retry_scope: Option<ProfileLegacyResetScope>,
    retry_wipe_id: Option<String>,
    retry_reset_handle: Arc<std::sync::Mutex<Option<String>>>,
    retry_families_observed: Arc<std::sync::Mutex<Vec<ProfileSourceFamily>>>,
}

enum ObservedWipeRetryRequest {
    Prepare,
    Family {
        reset_handle: String,
        wipe_id: String,
        family: ProfileSourceFamily,
    },
}

fn crash_fixture_error(message: &'static str) -> RuntimeError {
    RuntimeError {
        code: bittery_client_core::RuntimeErrorCode::InvariantViolation,
        message: message.into(),
        recovery_bound: None,
        team_page_problem: None,
    }
}

fn write_synced_crash_marker(path: &Path, contents: &[u8]) -> Result<(), RuntimeError> {
    use std::io::Write;

    let mut marker = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| crash_fixture_error("Crash fixture could not create its write marker"))?;
    marker
        .write_all(contents)
        .map_err(|_| crash_fixture_error("Crash fixture could not write its marker"))?;
    marker
        .sync_all()
        .map_err(|_| crash_fixture_error("Crash fixture could not sync its marker"))
}

#[async_trait]
impl SerializedPlatformStorageExecutor for HoldAfterSelectedPlatformWrite {
    async fn invoke(
        &self,
        request_json: Zeroizing<String>,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        let request: PlatformStorageRequest =
            serde_json::from_str(&request_json).map_err(|_| RuntimeError {
                code: bittery_client_core::RuntimeErrorCode::InvariantViolation,
                message: "Crash fixture received an invalid platform request".into(),
                recovery_bound: None,
                team_page_problem: None,
            })?;
        let catalog_view = self.wipe_catalog_set_view(&request)?;
        let selected = self.cut.matches_write(&request, &self.account_id)
            || self.cut.matches_delete_prefix(&request);
        drop(request);

        let response = self.inner.invoke(request_json).await?;
        if selected || catalog_view.is_some() {
            let observed: PlatformStorageResponse = serde_json::from_str(&response)
                .map_err(|_| crash_fixture_error("Selected platform response is malformed"))?;
            if !matches!(observed, PlatformStorageResponse::Done) {
                return Err(crash_fixture_error(
                    "Selected platform operation did not return Done",
                ));
            }
        }
        if let Some(view) = catalog_view.as_ref() {
            self.observe_wipe_catalog_write(view)?;
        }
        if selected {
            let mut marker = self.cut.marker_contents().to_vec();
            if self.cut.tracks_initial_wipe_identity() {
                let initial_wipe_id = self
                    .initial_wipe_id
                    .lock()
                    .map_err(|_| crash_fixture_error("Wipe identity lock is poisoned"))?;
                let wipe_id = initial_wipe_id.as_ref().ok_or_else(|| {
                    crash_fixture_error("Selected Wipe cut preceded the initial Wiping catalog Set")
                })?;
                marker.extend_from_slice(format!("wipeId={wipe_id}\n").as_bytes());
            }
            write_synced_crash_marker(&self.marker, &marker)?;

            // Keep the successful platform write unacknowledged to Core until the parent kills us.
            std::future::pending::<()>().await;
        }
        Ok(response)
    }
}

impl HoldAfterSelectedPlatformWrite {
    fn wipe_catalog_set_view(
        &self,
        request: &PlatformStorageRequest,
    ) -> Result<Option<WipeResetCatalogView>, RuntimeError> {
        if !self.cut.tracks_initial_wipe_identity() {
            return Ok(None);
        }
        let PlatformStorageRequest::Set {
            area: PlatformStorageArea::DevicePlain,
            key,
            value,
        } = request
        else {
            return Ok(None);
        };
        if key != CRASH_DEVICE_CATALOG_KEY {
            return Ok(None);
        }
        let catalog: serde_json::Value = serde_json::from_str(value.as_ref())
            .map_err(|_| crash_fixture_error("Wipe catalog Set is malformed"))?;
        let view = wipe_reset_catalog_view(&catalog)
            .ok_or_else(|| crash_fixture_error("Wipe catalog Set has no valid reset record"))?;
        let expected_scope = self
            .expected_wipe_scope
            .as_ref()
            .ok_or_else(|| crash_fixture_error("Terminal Wipe cut has no pre-cut scope"))?;
        if &view.scope != expected_scope {
            return Err(crash_fixture_error(
                "Wipe catalog Set changed its original physical scope",
            ));
        }
        Ok(Some(view))
    }

    fn observe_wipe_catalog_write(&self, view: &WipeResetCatalogView) -> Result<(), RuntimeError> {
        let mut initial_wipe_id = self
            .initial_wipe_id
            .lock()
            .map_err(|_| crash_fixture_error("Wipe identity lock is poisoned"))?;
        match (view.phase, view.revision) {
            (bittery_client_core::ProfileAdmissionResetPhase::Wiping, 0) => {
                let expected_remaining = [
                    ProfileSourceFamily::DesktopStore,
                    ProfileSourceFamily::DesktopSyncStore,
                    ProfileSourceFamily::DesktopCredentials,
                ];
                if initial_wipe_id.is_some() || view.remaining.as_slice() != expected_remaining {
                    return Err(crash_fixture_error(
                        "Initial Wiping catalog Set was repeated or changed its pending families",
                    ));
                }
                *initial_wipe_id = Some(view.wipe_id.clone());
            }
            (bittery_client_core::ProfileAdmissionResetPhase::Wiping, 1..=3) => {
                let expected_remaining: &[ProfileSourceFamily] = match view.revision {
                    1 => &[
                        ProfileSourceFamily::DesktopSyncStore,
                        ProfileSourceFamily::DesktopCredentials,
                    ],
                    2 => &[ProfileSourceFamily::DesktopCredentials],
                    3 => &[],
                    _ => unreachable!(),
                };
                if view.remaining.as_slice() != expected_remaining
                    || initial_wipe_id.as_deref() != Some(view.wipe_id.as_str())
                {
                    return Err(crash_fixture_error(
                        "Wiping catalog changed the original wipe ID or receipt frontier",
                    ));
                }
            }
            (bittery_client_core::ProfileAdmissionResetPhase::Wiped, 4)
                if view.remaining.is_empty()
                    && self.cut.is_terminal_wiped_write()
                    && initial_wipe_id.as_deref() == Some(view.wipe_id.as_str()) => {}
            _ => {
                return Err(crash_fixture_error(
                    "Observed Wipe catalog Set is outside the expected prefix or terminal frontier",
                ));
            }
        }
        Ok(())
    }
}

#[async_trait]
impl SerializedProfileAdmissionExecutor for HoldAfterSelectedSourceDeletion {
    async fn invoke(
        &self,
        request_json: Zeroizing<String>,
    ) -> Result<(Zeroizing<String>, Option<Zeroizing<Vec<u8>>>), RuntimeError> {
        let request: ProfileAdmissionRequest = serde_json::from_str(&request_json)
            .map_err(|_| crash_fixture_error("Crash fixture received an invalid source request"))?;
        let selected = self.cut.selected_source_delete(&request, &self.account_id);
        drop(request);

        let response = self.inner.invoke(request_json).await?;
        if let Some((snapshot_handle, admission_id, index)) = selected {
            let observed: ProfileAdmissionResponse = serde_json::from_str(response.0.as_str())
                .map_err(|_| {
                    crash_fixture_error("Crash fixture received an invalid source delete result")
                })?;
            let ProfileAdmissionResponse::SourceCleanupResult {
                snapshot_handle: observed_handle,
                admission_id: observed_admission,
                index: observed_index,
                result: ProfileSourceDeleteResult::Deleted {},
            } = observed
            else {
                return Err(crash_fixture_error(
                    "Selected captured-source deletion did not return Deleted",
                ));
            };
            if observed_handle != snapshot_handle
                || observed_admission != admission_id
                || observed_index != index
                || response.1.is_some()
            {
                return Err(crash_fixture_error(
                    "Selected captured-source deletion receipt changed its exact scope",
                ));
            }
            let marker = source_delete_marker_contents(self.cut, &admission_id, index);
            write_synced_crash_marker(&self.marker, &marker)?;

            // The physical deletion succeeded, but Core has not received its cleanup receipt.
            std::future::pending::<()>().await;
        }
        Ok(response)
    }
}

#[async_trait]
impl SerializedProfileAdmissionExecutor for ObserveWipeReset {
    async fn invoke(
        &self,
        request_json: Zeroizing<String>,
    ) -> Result<(Zeroizing<String>, Option<Zeroizing<Vec<u8>>>), RuntimeError> {
        let request: ProfileAdmissionRequest = serde_json::from_str(&request_json)
            .map_err(|_| crash_fixture_error("Wipe observer received an invalid source request"))?;
        let selected_cut = self
            .cut
            .and_then(|cut| cut.selected_reset_family(&request).map(|ids| (cut, ids)));
        let retry_request = match (&self.retry_scope, &request) {
            (
                Some(scope),
                ProfileAdmissionRequest::PrepareLegacyProfileReset {
                    wipe_id,
                    format,
                    expected_scope,
                },
            ) => {
                if Some(wipe_id.as_str()) != self.retry_wipe_id.as_deref()
                    || *format != LegacyProfileFormat::DesktopLegacyV1
                    || expected_scope.as_ref() != Some(scope)
                {
                    return Err(crash_fixture_error(
                        "Fresh Wipe preparation changed its original scope or wipe ID",
                    ));
                }
                Some(ObservedWipeRetryRequest::Prepare)
            }
            (
                Some(scope),
                ProfileAdmissionRequest::ResetLegacySourceFamily {
                    reset_handle,
                    wipe_id,
                    family,
                },
            ) => {
                let acquired_handle = self
                    .retry_reset_handle
                    .lock()
                    .map_err(|_| crash_fixture_error("Fresh reset handle lock is poisoned"))?
                    .clone()
                    .ok_or_else(|| {
                        crash_fixture_error(
                            "Fresh family reset was requested before exact handle acquisition",
                        )
                    })?;
                let expected_family = scope.families.iter().any(|entry| entry.family == *family);
                let previously_observed = self
                    .retry_families_observed
                    .lock()
                    .map_err(|_| crash_fixture_error("Fresh family observation lock is poisoned"))?
                    .contains(family);
                if reset_handle != &acquired_handle
                    || Some(wipe_id.as_str()) != self.retry_wipe_id.as_deref()
                    || !expected_family
                    || previously_observed
                {
                    return Err(crash_fixture_error(
                        "Fresh family request changed its exact scope, handle, wipe ID, or uniqueness",
                    ));
                }
                Some(ObservedWipeRetryRequest::Family {
                    reset_handle: reset_handle.clone(),
                    wipe_id: wipe_id.clone(),
                    family: *family,
                })
            }
            _ => None,
        };
        let replay = match (&request, &self.replay_absence) {
            (
                ProfileAdmissionRequest::ResetLegacySourceFamily {
                    wipe_id, family, ..
                },
                Some((expected_wipe_id, expected_family)),
            ) if wipe_id == expected_wipe_id && family == expected_family => {
                Some((wipe_id.clone(), *family))
            }
            _ => None,
        };
        drop(request);

        let response = self.inner.invoke(request_json).await?;
        match retry_request {
            Some(ObservedWipeRetryRequest::Prepare) => {
                let observed: ProfileAdmissionResponse = serde_json::from_str(response.0.as_str())
                    .map_err(|_| {
                        crash_fixture_error("Fresh Wipe preparation response is invalid")
                    })?;
                let ProfileAdmissionResponse::ProfileResetPrepared {
                    result: ProfileResetPreparedResult::Prepared { snapshot },
                } = observed
                else {
                    return Err(crash_fixture_error(
                        "Fresh Wipe provider did not acquire its exact reset scope",
                    ));
                };
                if snapshot.reset_handle.is_empty()
                    || Some(snapshot.wipe_id.as_str()) != self.retry_wipe_id.as_deref()
                    || self.retry_scope.as_ref() != Some(&snapshot.scope)
                    || response.1.is_some()
                {
                    return Err(crash_fixture_error(
                        "Fresh Wipe provider changed its acquired handle, scope, or wipe ID",
                    ));
                }
                let mut reset_handle = self
                    .retry_reset_handle
                    .lock()
                    .map_err(|_| crash_fixture_error("Fresh reset handle lock is poisoned"))?;
                if reset_handle.replace(snapshot.reset_handle).is_some() {
                    return Err(crash_fixture_error(
                        "Fresh Wipe provider acquired its reset handle more than once",
                    ));
                }
            }
            Some(ObservedWipeRetryRequest::Family {
                reset_handle,
                wipe_id,
                family,
            }) => {
                require_observed_wipe_family_result(
                    &response,
                    &reset_handle,
                    &wipe_id,
                    family,
                    ProfileResetResult::AlreadyAbsent {},
                )?;
                self.retry_families_observed
                    .lock()
                    .map_err(|_| crash_fixture_error("Fresh family observation lock is poisoned"))?
                    .push(family);
            }
            None => {}
        }
        if let Some((cut, (expected_handle, expected_wipe_id, expected_family))) = selected_cut {
            require_observed_wipe_family_result(
                &response,
                &expected_handle,
                &expected_wipe_id,
                expected_family,
                ProfileResetResult::Reset {},
            )?;
            let family_label = wipe_crash_family_label(expected_family).ok_or_else(|| {
                crash_fixture_error("Wipe source cut selected an unsupported closed family")
            })?;
            let mut marker = cut.marker_contents().to_vec();
            marker.extend_from_slice(
                format!(
                    "resetHandle={expected_handle}\nwipeId={expected_wipe_id}\nfamily={family_label}\nresult=reset\n"
                )
                .as_bytes(),
            );
            let path = self
                .marker
                .as_ref()
                .ok_or_else(|| crash_fixture_error("Wipe cut has no source marker path"))?;
            write_synced_crash_marker(path, &marker)?;

            // Native source deletion is complete, but Core has not received its closed result.
            std::future::pending::<()>().await;
        }
        if let Some((expected_wipe_id, expected_family)) = replay {
            require_observed_wipe_family_result(
                &response,
                "",
                &expected_wipe_id,
                expected_family,
                ProfileResetResult::AlreadyAbsent {},
            )?;
            self.replay_absence_observed
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
        Ok(response)
    }
}

struct CountProfileAdmissionRequests {
    inner: Arc<dyn SerializedProfileAdmissionExecutor>,
    calls: Arc<std::sync::atomic::AtomicUsize>,
}

#[async_trait]
impl SerializedProfileAdmissionExecutor for CountProfileAdmissionRequests {
    async fn invoke(
        &self,
        request_json: Zeroizing<String>,
    ) -> Result<(Zeroizing<String>, Option<Zeroizing<Vec<u8>>>), RuntimeError> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.inner.invoke(request_json).await
    }
}

fn require_observed_wipe_family_result(
    response: &(Zeroizing<String>, Option<Zeroizing<Vec<u8>>>),
    expected_handle: &str,
    expected_wipe_id: &str,
    expected_family: ProfileSourceFamily,
    expected_result: ProfileResetResult,
) -> Result<(), RuntimeError> {
    let observed: ProfileAdmissionResponse = serde_json::from_str(response.0.as_str())
        .map_err(|_| crash_fixture_error("Wipe observer received an invalid family result"))?;
    let ProfileAdmissionResponse::ProfileResetFamilyResult {
        reset_handle,
        wipe_id,
        family,
        result,
    } = observed
    else {
        return Err(crash_fixture_error(
            "Wipe observer received the wrong closed family response",
        ));
    };
    let result_matches = matches!(
        (expected_result, result),
        (ProfileResetResult::Reset {}, ProfileResetResult::Reset {})
            | (
                ProfileResetResult::AlreadyAbsent {},
                ProfileResetResult::AlreadyAbsent {}
            )
    );
    if reset_handle.is_empty()
        || (!expected_handle.is_empty() && reset_handle != expected_handle)
        || wipe_id != expected_wipe_id
        || family != expected_family
        || !result_matches
        || response.1.is_some()
    {
        return Err(crash_fixture_error(
            "Wipe source result changed its exact handle, wipe ID, family, or outcome",
        ));
    }
    Ok(())
}

fn wipe_crash_family_label(family: ProfileSourceFamily) -> Option<&'static str> {
    match family {
        ProfileSourceFamily::DesktopStore => Some("desktopStore"),
        ProfileSourceFamily::DesktopSyncStore => Some("desktopSyncStore"),
        ProfileSourceFamily::DesktopCredentials => Some("desktopCredentials"),
        ProfileSourceFamily::ExtensionLocal
        | ProfileSourceFamily::ExtensionSession
        | ProfileSourceFamily::ExtensionRecords => None,
    }
}

struct HoldAfterSelectedReplicaInstall {
    inner: Arc<SqliteReplica>,
    marker: PathBuf,
    account_id: String,
    cut: CrashWriteCut,
}

fn replica_install_targets_account(
    request_json: &str,
    account_id: &str,
) -> Result<bool, RuntimeError> {
    let request: serde_json::Value = serde_json::from_str(request_json)
        .map_err(|_| crash_fixture_error("Crash fixture received an invalid Replica request"))?;
    Ok(request["type"] == "install" && request["prepared"]["nextHead"]["accountId"] == account_id)
}

#[async_trait]
impl SerializedReplicaExecutor for HoldAfterSelectedReplicaInstall {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        let selected = replica_install_targets_account(&request_json, &self.account_id)?;

        let response = self.inner.invoke(request_json).await?;
        if selected {
            let result: serde_json::Value = serde_json::from_str(&response).map_err(|_| {
                crash_fixture_error("Crash fixture received an invalid Replica Install result")
            })?;
            if result["type"] != "installed" || result["result"]["type"] != "applied" {
                return Err(crash_fixture_error(
                    "Crash fixture Replica Install was not durably applied",
                ));
            }
            write_synced_crash_marker(&self.marker, self.cut.marker_contents())?;

            // Keep the committed Replica result unacknowledged until the parent kills this child.
            std::future::pending::<()>().await;
        }
        Ok(response)
    }
}

struct HoldAfterPopulatedReplicaWipe {
    inner: Arc<SqliteReplica>,
    marker: PathBuf,
}

#[async_trait]
impl SerializedReplicaExecutor for HoldAfterPopulatedReplicaWipe {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        let selected = serde_json::from_str::<serde_json::Value>(&request_json)
            .map_err(|_| crash_fixture_error("Wipe fixture received invalid Replica request"))?
            == json!({"type":"wipeDevice"});
        let response = self.inner.invoke(request_json).await?;
        if selected {
            if serde_json::from_str::<serde_json::Value>(&response).ok()
                != Some(json!({"type":"deviceWiped"}))
            {
                return Err(crash_fixture_error(
                    "Committed populated Replica Wipe returned the wrong response",
                ));
            }
            write_synced_crash_marker(
                &self.marker,
                CrashWriteCut::WipePopulatedReplicaDeletion.marker_contents(),
            )?;
            std::future::pending::<()>().await;
        }
        Ok(response)
    }
}

struct RefuseReplicaReinstall {
    inner: Arc<SqliteReplica>,
    account_id: String,
}

#[async_trait]
impl SerializedReplicaExecutor for RefuseReplicaReinstall {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        if replica_install_targets_account(&request_json, &self.account_id)? {
            return Err(crash_fixture_error(
                "Admission attempted another Replica Install during crash recovery",
            ));
        }
        self.inner.invoke(request_json).await
    }
}

struct GatedNativeHttp {
    inner: NativeHttpExecutor,
    calls: std::sync::atomic::AtomicU64,
    allowed: std::sync::atomic::AtomicBool,
}

impl GatedNativeHttp {
    fn new() -> Result<Self, RuntimeError> {
        Ok(Self {
            inner: NativeHttpExecutor::new()?,
            calls: std::sync::atomic::AtomicU64::new(0),
            allowed: std::sync::atomic::AtomicBool::new(false),
        })
    }

    fn calls(&self) -> u64 {
        self.calls.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn allow(&self) {
        self.allowed
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

#[async_trait]
impl SerializedHttpExecutor for GatedNativeHttp {
    async fn invoke(&self, request: Zeroizing<String>) -> Result<String, RuntimeError> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if !self.allowed.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(json!({"type":"networkFailure"}).to_string());
        }
        self.inner.invoke(request).await
    }

    fn cancel(&self, dispatch_id: &str) {
        self.inner.cancel(dispatch_id);
    }
}

const ADMISSION_SRP_SALT: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const ADMISSION_SRP_ATTEMPT: &str = "actual-cache-login-attempt";

struct AdmissionSrpState {
    server: bittery_crypto_core::SrpServer,
    verifier: String,
    server_ephemeral: bittery_crypto_core::srp6a::Ephemeral,
}

struct AdmissionSrpNetwork {
    state: Mutex<AdmissionSrpState>,
    calls: std::sync::atomic::AtomicU64,
    offline: std::sync::atomic::AtomicBool,
    kdf_profile: bittery_crypto_core::KdfProfile,
    email: String,
    user_id: String,
    secret_key_hint: String,
    vault_id: String,
    wrapped_vault_key: String,
}

impl AdmissionSrpNetwork {
    fn new(
        master_password: &str,
        secret_key: &str,
        email: String,
        user_id: String,
        vault_id: String,
        wrapped_vault_key: String,
        kdf_profile: bittery_crypto_core::KdfProfile,
    ) -> Result<Self, String> {
        use bittery_crypto_core::srp6a::{HashAlgorithm, PrimeGroup};

        let client = bittery_crypto_core::SrpClient::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
        let server = bittery_crypto_core::SrpServer::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
        let derived =
            bittery_crypto_core::derive_keys(master_password, secret_key, &email, &kdf_profile)
                .map_err(|_| "Cannot derive actual cached SRP verifier")?;
        let srp_password = Zeroizing::new(String::from_utf8_lossy(&derived.auth_key).into_owned());
        let private_key = Zeroizing::new(
            client
                .derive_safe_private_key(ADMISSION_SRP_SALT, &srp_password, None)
                .map_err(|_| "Cannot derive actual cached SRP private key")?,
        );
        let verifier = client
            .derive_verifier(&private_key)
            .map_err(|_| "Cannot derive actual cached SRP verifier")?;
        let server_ephemeral = server
            .generate_ephemeral(&verifier)
            .map_err(|_| "Cannot generate actual cached SRP challenge")?;
        Ok(Self {
            state: Mutex::new(AdmissionSrpState {
                server,
                verifier,
                server_ephemeral,
            }),
            calls: std::sync::atomic::AtomicU64::new(0),
            offline: std::sync::atomic::AtomicBool::new(false),
            kdf_profile,
            email,
            user_id,
            secret_key_hint: bittery_crypto_core::get_secret_key_hint(secret_key),
            vault_id,
            wrapped_vault_key,
        })
    }

    fn call_count(&self) -> u64 {
        self.calls.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn go_offline(&self) {
        self.offline
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

fn admission_http_completed(status: u16, body: serde_json::Value) -> String {
    json!({
        "type":"completed",
        "status":status,
        "headers":[{"name":"Content-Type","value":"application/json"}],
        "body":serde_json::to_vec(&body).expect("fixture response serializes")
    })
    .to_string()
}

#[async_trait]
impl SerializedHttpExecutor for AdmissionSrpNetwork {
    async fn invoke(&self, request_json: Zeroizing<String>) -> Result<String, RuntimeError> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if self.offline.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(json!({"type":"networkFailure"}).to_string());
        }
        let request: serde_json::Value =
            serde_json::from_str(&request_json).expect("Runtime emits typed HTTP requests");
        let url = request["url"]
            .as_str()
            .expect("Runtime HTTP request has a URL");
        if url.ends_with("/api/v1/auth/login-attempts") {
            let body: Vec<u8> =
                serde_json::from_value(request["body"].clone()).expect("start body is bytes");
            let body: serde_json::Value =
                serde_json::from_slice(&body).expect("start body is JSON");
            assert_eq!(body["email"], self.email);
            let state = self.state.lock().unwrap();
            return Ok(admission_http_completed(
                201,
                json!({
                    "attemptId":ADMISSION_SRP_ATTEMPT,
                    "kdfParams":{
                        "algorithm":self.kdf_profile.algorithm,
                        "iterations":self.kdf_profile.iterations,
                        "schemaVersion":self.kdf_profile.schema_version
                    },
                    "salt":ADMISSION_SRP_SALT,
                    "serverPublicKey":state.server_ephemeral.public
                }),
            ));
        }
        if url.ends_with(&format!(
            "/api/v1/auth/login-attempts/{ADMISSION_SRP_ATTEMPT}/finish"
        )) {
            let body: Vec<u8> =
                serde_json::from_value(request["body"].clone()).expect("finish body is bytes");
            let body: serde_json::Value =
                serde_json::from_slice(&body).expect("finish body is JSON");
            let state = self.state.lock().unwrap();
            let session = state
                .server
                .derive_session(
                    &state.server_ephemeral.secret,
                    body["clientPublicKey"]
                        .as_str()
                        .expect("finish has client public key"),
                    ADMISSION_SRP_SALT,
                    "",
                    &state.verifier,
                    body["clientProof"]
                        .as_str()
                        .expect("finish has client proof"),
                )
                .expect("Runtime must prove the fixture password and Secret Key");
            return Ok(admission_http_completed(
                200,
                json!({
                    "expiresAt":"2099-01-01T00:00:00Z",
                    "serverProof":session.proof,
                    "sessionId":"actual-cache-session",
                    "token":"actual-cache-token",
                    "user":{
                        "email":self.email,
                        "encryptedPrivateKey":"retained-private-key",
                        "id":self.user_id,
                        "name":"Actual cached admission",
                        "publicKey":"actual-cache-public-key",
                        "secretKeyHint":self.secret_key_hint,
                        "teamAvatarUrl":null,
                        "teamName":null
                    },
                    "vaultKeys":{
                        "hasMore":false,
                        "items":[{
                            "encryptedVaultKey":self.wrapped_vault_key,
                            "role":"owner",
                            "vaultIcon":null,
                            "vaultId":self.vault_id,
                            "vaultImageUrl":null,
                            "vaultName":"Actual Offline Vault",
                            "vaultType":"personal"
                        }],
                        "nextCursor":null
                    }
                }),
            ));
        }
        if url
            .split(['?', '#'])
            .next()
            .is_some_and(|path| path.ends_with("/api/v1/travel-mode"))
        {
            return Ok(admission_http_completed(
                200,
                json!({
                    "enabled":false,
                    "enabledAt":null,
                    "hiddenVaultIds":[],
                    "updatedAt":"2026-09-21T00:00:00Z"
                }),
            ));
        }
        if url
            .split(['?', '#'])
            .next()
            .is_some_and(|path| path.ends_with("/api/v1/sync/changes"))
        {
            return Ok(admission_http_completed(
                200,
                json!({
                    "cursor":null,
                    "events":[],
                    "hasMore":false,
                    "requiresFullRefresh":false
                }),
            ));
        }
        Ok(json!({"type":"networkFailure"}).to_string())
    }

    fn cancel(&self, _: &str) {}
}

struct AdmissionDeviceWipe;

#[async_trait]
impl TeardownHostCleanup for AdmissionDeviceWipe {
    async fn invoke(
        &self,
        request: TeardownHostCleanupRequest,
    ) -> Result<TeardownHostCleanupResponse, RuntimeError> {
        assert!(matches!(request, TeardownHostCleanupRequest::WipeDevice));
        Ok(TeardownHostCleanupResponse::DeviceWiped)
    }
}

#[async_trait]
impl SerializedHttpExecutor for AdmissionNoNetwork {
    async fn invoke(&self, _: Zeroizing<String>) -> Result<String, RuntimeError> {
        panic!("profile admission must not use the network")
    }

    fn cancel(&self, _: &str) {}
}

#[async_trait]
impl AttachmentMoveTransferPort for AdmissionNoNetwork {
    async fn open_source(
        &self,
        _: AttachmentMoveDownloadRequest,
    ) -> Result<Box<dyn AttachmentMoveDownload>, AttachmentMoveTransferError> {
        panic!("profile admission must not download Attachments")
    }

    async fn open_upload(
        &self,
        _: &AccountId,
        _: &str,
        _: &AttachmentMoveUploadGrant,
        _: &bittery_client_core::AttachmentArtifactOwner,
    ) -> Result<Box<dyn AttachmentMoveUpload>, AttachmentMoveTransferError> {
        panic!("profile admission must not upload Attachments")
    }
}

struct AdmissionLiveLease;

#[async_trait]
impl AttachmentMoveAccountLease for AdmissionLiveLease {
    fn is_live(&self) -> bool {
        true
    }

    async fn lost(&self) {
        std::future::pending().await
    }
}

struct AdmissionLiveLeasePort;

#[async_trait]
impl AttachmentMoveAccountLeasePort for AdmissionLiveLeasePort {
    async fn acquire(
        &self,
        _: &AccountId,
    ) -> Result<Option<Box<dyn AttachmentMoveAccountLease>>, RuntimeError> {
        Ok(Some(Box::new(AdmissionLiveLease)))
    }
}

struct AdmissionUnusedImageSource;

#[async_trait]
impl VaultImageSourcePort for AdmissionUnusedImageSource {
    async fn claim(
        &self,
        _: &VaultImageSourceGrant,
    ) -> Result<Box<dyn VaultImageSource>, VaultImageSourceError> {
        panic!("profile admission must not claim Vault image input")
    }

    async fn retire_account(&self, _: &str, _: &AccountId) -> Result<(), VaultImageSourceError> {
        Ok(())
    }

    async fn complete_account_retirement(
        &self,
        _: &str,
        _: &AccountId,
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }

    async fn begin_acceptance(
        &self,
        _: &str,
        _: &AccountId,
        _: &str,
    ) -> Result<(), VaultImageSourceError> {
        panic!("profile admission must not accept Vault image input")
    }

    async fn end_acceptance(
        &self,
        _: &str,
        _: &AccountId,
        _: &str,
    ) -> Result<(), VaultImageSourceError> {
        panic!("profile admission must not release Vault image input")
    }

    async fn retire_vaults(
        &self,
        _: &str,
        _: &AccountId,
        _: &[String],
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }

    async fn complete_vault_retirement(
        &self,
        _: &str,
        _: &AccountId,
        _: &[String],
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }

    async fn forget_account_vault_retirements(
        &self,
        _: &str,
        _: &AccountId,
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }

    async fn retire_runtime(&self, _: &str) -> Result<(), VaultImageSourceError> {
        Ok(())
    }
}

#[derive(Default)]
struct AdmissionSink(Mutex<Vec<RuntimeProjection>>);

impl ObservationSink for AdmissionSink {
    fn publish(&self, projection: RuntimeProjection) {
        self.0.lock().unwrap().push(projection);
    }
}

async fn invoke(
    source: &NativeProfileSource,
    request: serde_json::Value,
) -> Result<(ProfileAdmissionResponse, Option<Zeroizing<Vec<u8>>>), String> {
    let kind = request["type"]
        .as_str()
        .ok_or("Fixture request has no type")?;
    let (response, binary) = source
        .invoke(Zeroizing::new(request.to_string()))
        .await
        .map_err(|error| format!("Native source {kind} failed: {:?}", error.code))?;
    require(
        response.len() <= 262_144,
        "Native source control exceeds its bound",
    )?;
    require(
        binary.as_ref().is_none_or(|bytes| bytes.len() <= 262_144),
        "Native source binary exceeds its bound",
    )?;
    let response =
        serde_json::from_str(&response).map_err(|_| "Native source response is invalid")?;
    Ok((response, binary))
}

async fn admission_runtime(
    directory: &Path,
    platform: Arc<NativePlatformStorage>,
    source: Option<Arc<NativeProfileSource>>,
) -> Result<Arc<Runtime>, String> {
    admission_runtime_with_http(directory, platform, source, Arc::new(AdmissionNoNetwork)).await
}

async fn admission_runtime_with_http(
    directory: &Path,
    platform: Arc<NativePlatformStorage>,
    source: Option<Arc<NativeProfileSource>>,
    http: Arc<dyn SerializedHttpExecutor>,
) -> Result<Arc<Runtime>, String> {
    admission_runtime_with_executor(directory, platform, source, http).await
}

async fn admission_runtime_with_executor(
    directory: &Path,
    platform: Arc<dyn SerializedPlatformStorageExecutor>,
    source: Option<Arc<NativeProfileSource>>,
    http: Arc<dyn SerializedHttpExecutor>,
) -> Result<Arc<Runtime>, String> {
    let replica: Arc<dyn SerializedReplicaExecutor> = Arc::new(
        SqliteReplica::open(directory.join("replica.sqlite"))
            .map_err(|_| "Cannot open actual admission Replica")?,
    );
    admission_runtime_with_replica_executor(directory, replica, platform, source, http).await
}

async fn admission_runtime_with_source_executor(
    directory: &Path,
    platform: Arc<dyn SerializedPlatformStorageExecutor>,
    source: Arc<dyn SerializedProfileAdmissionExecutor>,
) -> Result<Arc<Runtime>, String> {
    let runtime =
        admission_runtime_with_executor(directory, platform, None, Arc::new(AdmissionNoNetwork))
            .await?;
    runtime
        .set_profile_admission_source(ProfileAdmissionSource::Legacy {
            format: LegacyProfileFormat::DesktopLegacyV1,
            executor: source,
        })
        .await
        .map_err(|_| "Cannot install held physical cleanup source")?;
    Ok(runtime)
}

async fn admission_runtime_with_replica_executor(
    directory: &Path,
    replica: Arc<dyn SerializedReplicaExecutor>,
    platform: Arc<dyn SerializedPlatformStorageExecutor>,
    source: Option<Arc<NativeProfileSource>>,
    http: Arc<dyn SerializedHttpExecutor>,
) -> Result<Arc<Runtime>, String> {
    let artifacts = Arc::new(
        SqliteAttachmentArtifactStore::open(directory.join("attachments.sqlite"))
            .map_err(|_| "Cannot open actual admission artifact store")?,
    );
    let images = Arc::new(
        SqliteVaultImageArtifactStore::open(directory.join("vault-images.sqlite"))
            .map_err(|_| "Cannot open actual admission image store")?,
    );
    let attachment_network = Arc::new(AdmissionNoNetwork);
    let runtime = Runtime::with_configured_serialized_executors_and_attachment_move_preparation(
        replica,
        platform,
        http,
        AuthClientConfig::new(
            "actual-profile-admission".into(),
            ClientPlatform::Desktop,
            "test".into(),
        )
        .map_err(|_| "Cannot configure actual admission Runtime")?,
        AttachmentMovePreparationFacade::new(artifacts.clone(), artifacts, attachment_network),
        Arc::new(AdmissionLiveLeasePort),
    );
    runtime.install_vault_image_ingress(
        VaultImageIngressFacade::new(
            bittery_crypto_core::generate_uuid(),
            Arc::new(AdmissionUnusedImageSource),
            images,
        )
        .map_err(|_| "Cannot install actual admission image ingress")?,
    );
    runtime.install_teardown_host_cleanup(Arc::new(AdmissionDeviceWipe));
    if let Some(source) = source {
        runtime
            .set_profile_admission_source(ProfileAdmissionSource::Legacy {
                format: LegacyProfileFormat::DesktopLegacyV1,
                executor: source,
            })
            .await
            .map_err(|_| "Cannot install actual native profile source")?;
    }
    Ok(runtime)
}

async fn platform_value(
    platform: &NativePlatformStorage,
    area: PlatformStorageArea,
    key: String,
) -> Result<Option<Zeroizing<String>>, String> {
    let response = platform
        .invoke(Zeroizing::new(
            serde_json::to_string(&PlatformStorageRequest::Get { area, key })
                .map_err(|_| "Cannot encode platform read")?,
        ))
        .await
        .map_err(|_| "Actual platform read failed")?;
    let response: PlatformStorageResponse =
        serde_json::from_str(&response).map_err(|_| "Actual platform reply is malformed")?;
    let PlatformStorageResponse::Value { value } = &response else {
        return Err("Actual platform read returned the wrong response".into());
    };
    Ok(value
        .as_ref()
        .map(|value| Zeroizing::new(value.to_string())))
}

async fn set_crash_platform_value(
    platform: &NativePlatformStorage,
    area: PlatformStorageArea,
    key: &str,
    value: &str,
) -> Result<(), String> {
    let request = PlatformStorageRequest::Set {
        area,
        key: key.into(),
        value: SecretString::from(value.to_owned()),
    };
    let response = platform
        .invoke(Zeroizing::new(
            serde_json::to_string(&request).map_err(|_| "Cannot encode crash platform write")?,
        ))
        .await
        .map_err(|_| "Actual crash fixture platform write failed")?;
    let response: PlatformStorageResponse = serde_json::from_str(&response)
        .map_err(|_| "Actual crash fixture platform reply is malformed")?;
    require(
        matches!(response, PlatformStorageResponse::Done),
        "Actual crash fixture platform write returned the wrong response",
    )
}

fn encode_legacy_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(&mut encoded, "%{byte:02X}").expect("writing to String cannot fail");
        }
    }
    encoded
}

async fn actual_replica_rows(
    directory: &Path,
    account_id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let replica = SqliteReplica::open(directory.join("replica.sqlite"))
        .map_err(|_| "Cannot reopen actual admission Replica")?;
    let loaded = SerializedReplicaExecutor::invoke(
        &replica,
        json!({"type":"load","accountId":account_id}).to_string(),
    )
    .await
    .map_err(|_| "Cannot load actual admitted cache")?;
    let loaded: serde_json::Value =
        serde_json::from_str(&loaded).map_err(|_| "Actual Replica load is malformed")?;
    loaded["rows"]
        .as_array()
        .cloned()
        .ok_or_else(|| "Actual Replica load has no rows".into())
}

fn row_payload(rows: &[serde_json::Value], store: &str) -> Result<serde_json::Value, String> {
    rows.iter()
        .find(|row| row["store"] == store)
        .and_then(|row| row["payloadJson"].as_str())
        .ok_or_else(|| format!("Actual Replica has no {store} row"))
        .and_then(|payload| {
            serde_json::from_str(payload).map_err(|_| format!("Actual {store} row is malformed"))
        })
}

fn require_locked(runtime: &Arc<Runtime>, account_id: &str) -> Result<(), String> {
    require_access(runtime, account_id, AccountAccessState::Locked)
}

fn require_access(
    runtime: &Arc<Runtime>,
    account_id: &str,
    expected: AccountAccessState,
) -> Result<(), String> {
    let sink = Arc::new(AdmissionSink::default());
    let observation = runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            sink.clone(),
        )
        .map_err(|_| "Committed admission did not publish Runtime status")?;
    let matched = matches!(
        sink.0.lock().unwrap().last(),
        Some(RuntimeProjection::RuntimeStatus(status))
            if !status.closed
                && status.accounts.len() == 1
                && status.accounts[0].account_id.as_str() == account_id
                && status.accounts[0].access == expected
    );
    observation.close();
    require(matched, "Actual Account access state differs")
}

fn manifest(
    snapshot: &ProfileSourceSnapshot,
    store: &[u8],
    sync_store: &[u8],
    device_key: &str,
) -> Result<(ProfileSourceManifestHeader, Vec<ProfileSourceManifestEntry>), String> {
    let identity = |family| {
        snapshot
            .families
            .iter()
            .find(|inventory| inventory.family == family)
            .and_then(|inventory| inventory.file_identity.clone())
            .ok_or("Present source file has no stable identity")
    };
    let entries = vec![
        ProfileSourceManifestEntry::from_evidence(
            LegacyProfileFormat::DesktopLegacyV1,
            ProfileSourceFamily::DesktopStore,
            ProfileSourceSelector::WholeFile {},
            ProfileSourceObservation::FileBytes {
                length: store.len() as u64,
            },
            Some(identity(ProfileSourceFamily::DesktopStore)?),
            store,
        )
        .map_err(|_| "Cannot frame store manifest evidence")?,
        ProfileSourceManifestEntry::from_evidence(
            LegacyProfileFormat::DesktopLegacyV1,
            ProfileSourceFamily::DesktopSyncStore,
            ProfileSourceSelector::WholeFile {},
            ProfileSourceObservation::FileBytes {
                length: sync_store.len() as u64,
            },
            Some(identity(ProfileSourceFamily::DesktopSyncStore)?),
            sync_store,
        )
        .map_err(|_| "Cannot frame Sync manifest evidence")?,
        ProfileSourceManifestEntry::from_evidence(
            LegacyProfileFormat::DesktopLegacyV1,
            ProfileSourceFamily::DesktopCredentials,
            ProfileSourceSelector::GlobalCredential {
                field: ProfileGlobalCredentialField::DeviceKey,
            },
            ProfileSourceObservation::StoredString {
                encoding: ProfileSourceStringEncoding::Utf8,
                length: device_key.len() as u64,
            },
            None,
            device_key.as_bytes(),
        )
        .map_err(|_| "Cannot frame DeviceKey manifest evidence")?,
    ];
    let mut digest = ProfileSourceManifestDigest::new(
        LegacyProfileFormat::DesktopLegacyV1,
        &snapshot.profile_identity,
        entries.len() as u64,
    )
    .map_err(|_| "Cannot start source manifest digest")?;
    for entry in &entries {
        digest
            .append(entry)
            .map_err(|_| "Cannot append source manifest entry")?;
    }
    let entries_sha256 = digest
        .finish()
        .map_err(|_| "Cannot finish source manifest digest")?;
    Ok((
        ProfileSourceManifestHeader {
            version: PROFILE_SOURCE_MANIFEST_VERSION,
            format: LegacyProfileFormat::DesktopLegacyV1,
            profile_identity: snapshot.profile_identity.clone(),
            recorded_capture_id: snapshot.capture_id.clone(),
            entry_count: entries.len() as u64,
            entries_sha256,
        },
        entries,
    ))
}

fn manifest_with_missing_accounts(
    snapshot: &ProfileSourceSnapshot,
    store: &[u8],
    sync_store: &[u8],
    device_key: &str,
    account_count: usize,
) -> Result<(ProfileSourceManifestHeader, Vec<ProfileSourceManifestEntry>), String> {
    let (_, mut entries) = manifest(snapshot, store, sync_store, device_key)?;
    for account in 0..account_count {
        let account_id = format!("account-{account:04}-{}", "x".repeat(96));
        for field in [
            ProfileAccountCredentialField::SecretKey,
            ProfileAccountCredentialField::SessionData,
            ProfileAccountCredentialField::JwtToken,
            ProfileAccountCredentialField::VaultKeys,
            ProfileAccountCredentialField::EncryptedPrivateKey,
        ] {
            entries.push(
                ProfileSourceManifestEntry::from_evidence(
                    LegacyProfileFormat::DesktopLegacyV1,
                    ProfileSourceFamily::DesktopCredentials,
                    ProfileSourceSelector::AccountCredential {
                        account_id: account_id.clone().into(),
                        field,
                    },
                    ProfileSourceObservation::Missing {},
                    None,
                    &[],
                )
                .map_err(|_| "Cannot frame missing Account credential evidence")?,
            );
        }
    }
    let mut digest = ProfileSourceManifestDigest::new(
        LegacyProfileFormat::DesktopLegacyV1,
        &snapshot.profile_identity,
        entries.len() as u64,
    )
    .map_err(|_| "Cannot start large source manifest digest")?;
    for entry in &entries {
        digest
            .append(entry)
            .map_err(|_| "Cannot append large source manifest entry")?;
    }
    let entries_sha256 = digest
        .finish()
        .map_err(|_| "Cannot finish large source manifest digest")?;
    Ok((
        ProfileSourceManifestHeader {
            version: PROFILE_SOURCE_MANIFEST_VERSION,
            format: LegacyProfileFormat::DesktopLegacyV1,
            profile_identity: snapshot.profile_identity.clone(),
            recorded_capture_id: snapshot.capture_id.clone(),
            entry_count: entries.len() as u64,
            entries_sha256,
        },
        entries,
    ))
}

async fn verify_manifest(
    source: &NativeProfileSource,
    attempt: &str,
    snapshot: &ProfileSourceSnapshot,
    header: &ProfileSourceManifestHeader,
    entries: &[ProfileSourceManifestEntry],
) -> Result<ProfileSourceVerificationResult, String> {
    let (started, binary) = invoke(
        source,
        serde_json::to_value(ProfileAdmissionRequest::VerifySourceSnapshot {
            step: ProfileSourceVerifyStep::Start {
                verification_attempt_id: attempt.to_owned(),
                snapshot_handle: snapshot.snapshot_handle.clone(),
                header: header.clone(),
            },
        })
        .map_err(|_| "Cannot encode Verify Start")?,
    )
    .await?;
    require(binary.is_none(), "Verify Start returned binary")?;
    let ProfileAdmissionResponse::SourceSnapshotVerification { mut result } = started else {
        return Err("Verify Start returned the wrong response".into());
    };
    for (index, expected_entry) in entries.iter().enumerate() {
        let cursor = match result {
            ProfileSourceVerificationResult::Started {
                ref verification_cursor,
                next_index: 0,
            } if index == 0 => verification_cursor.clone(),
            ProfileSourceVerificationResult::Matched {
                ref verification_cursor,
                next_index,
            } if next_index == index as u64 => verification_cursor.clone(),
            ProfileSourceVerificationResult::Changed {}
            | ProfileSourceVerificationResult::Unavailable {} => return Ok(result),
            _ => return Err("Verify did not advance one manifest entry".into()),
        };
        let (response, binary) = invoke(
            source,
            serde_json::to_value(ProfileAdmissionRequest::VerifySourceSnapshot {
                step: ProfileSourceVerifyStep::Entry {
                    verification_cursor: cursor,
                    index: index as u64,
                    expected_entry: expected_entry.clone(),
                },
            })
            .map_err(|_| "Cannot encode Verify Entry")?,
        )
        .await?;
        require(binary.is_none(), "Verify Entry returned binary")?;
        let ProfileAdmissionResponse::SourceSnapshotVerification { result: next } = response else {
            return Err("Verify Entry returned the wrong response".into());
        };
        result = next;
    }
    let cursor = match result {
        ProfileSourceVerificationResult::Matched {
            ref verification_cursor,
            next_index,
        } if next_index == entries.len() as u64 => verification_cursor.clone(),
        ProfileSourceVerificationResult::Changed {}
        | ProfileSourceVerificationResult::Unavailable {} => return Ok(result),
        _ => return Err("Verify did not reach manifest Finish".into()),
    };
    let (finished, binary) = invoke(
        source,
        serde_json::to_value(ProfileAdmissionRequest::VerifySourceSnapshot {
            step: ProfileSourceVerifyStep::Finish {
                verification_cursor: cursor,
            },
        })
        .map_err(|_| "Cannot encode Verify Finish")?,
    )
    .await?;
    require(binary.is_none(), "Verify Finish returned binary")?;
    let ProfileAdmissionResponse::SourceSnapshotVerification { result } = finished else {
        return Err("Verify Finish returned the wrong response".into());
    };
    Ok(result)
}

async fn reopen_cleanup_manifest(
    source: &NativeProfileSource,
    attempt: &str,
    admission_id: &str,
    header: &ProfileSourceManifestHeader,
    entries: &[ProfileSourceManifestEntry],
) -> Result<ProfileSourceCleanupSnapshot, String> {
    let start = serde_json::to_value(ProfileAdmissionRequest::ReopenSourceForCleanup {
        step: ProfileSourceCleanupReopenStep::Start {
            verification_attempt_id: attempt.to_owned(),
            admission_id: admission_id.to_owned(),
            header: header.clone(),
        },
    })
    .map_err(|_| "Cannot encode cleanup Reopen Start")?;
    let started = invoke(source, start.clone()).await?;
    require(
        started == invoke(source, start).await? && started.1.is_none(),
        "Lost cleanup Reopen Start did not replay",
    )?;
    let ProfileAdmissionResponse::SourceCleanupReopen { result } = started.0 else {
        return Err("Cleanup Reopen Start returned the wrong response".into());
    };
    let mut cursor = match result {
        ProfileSourceCleanupReopenResult::Started {
            verification_cursor,
            next_index: 0,
        } => verification_cursor,
        _ => return Err("Cleanup Reopen Start returned an invalid receipt".into()),
    };
    for (index, expected_entry) in entries.iter().enumerate() {
        let request = serde_json::to_value(ProfileAdmissionRequest::ReopenSourceForCleanup {
            step: ProfileSourceCleanupReopenStep::Entry {
                verification_cursor: cursor,
                index: index as u64,
                expected_entry: expected_entry.clone(),
            },
        })
        .map_err(|_| "Cannot encode cleanup Reopen Entry")?;
        let accepted = invoke(source, request.clone()).await?;
        if index == 0 {
            require(
                accepted == invoke(source, request).await?,
                "Lost cleanup Reopen Entry did not replay",
            )?;
        }
        require(accepted.1.is_none(), "Cleanup Reopen Entry returned binary")?;
        let ProfileAdmissionResponse::SourceCleanupReopen { result } = accepted.0 else {
            return Err("Cleanup Reopen Entry returned the wrong response".into());
        };
        cursor = match result {
            ProfileSourceCleanupReopenResult::Accepted {
                verification_cursor,
                next_index,
            } if next_index == index as u64 + 1 => verification_cursor,
            _ => return Err("Cleanup Reopen Entry did not advance exactly once".into()),
        };
    }
    let finish = serde_json::to_value(ProfileAdmissionRequest::ReopenSourceForCleanup {
        step: ProfileSourceCleanupReopenStep::Finish {
            verification_cursor: cursor,
        },
    })
    .map_err(|_| "Cannot encode cleanup Reopen Finish")?;
    let finished = invoke(source, finish.clone()).await?;
    require(
        finished == invoke(source, finish).await? && finished.1.is_none(),
        "Lost cleanup Reopen Finish did not replay",
    )?;
    let ProfileAdmissionResponse::SourceCleanupReopen {
        result: ProfileSourceCleanupReopenResult::Reopened { snapshot },
    } = finished.0
    else {
        return Err("Cleanup Reopen Finish did not publish its restricted snapshot".into());
    };
    Ok(snapshot)
}

async fn delete_captured(
    source: &NativeProfileSource,
    snapshot: &ProfileSourceCleanupSnapshot,
    index: u64,
    expected_entry: &ProfileSourceManifestEntry,
) -> Result<ProfileSourceDeleteResult, String> {
    let (response, binary) = invoke(
        source,
        serde_json::to_value(ProfileAdmissionRequest::DeleteCapturedSource {
            snapshot_handle: snapshot.snapshot_handle.clone(),
            admission_id: snapshot.admission_id.clone(),
            index,
            expected_entry: expected_entry.clone(),
        })
        .map_err(|_| "Cannot encode captured-source deletion")?,
    )
    .await?;
    require(binary.is_none(), "Captured-source deletion returned binary")?;
    let ProfileAdmissionResponse::SourceCleanupResult {
        snapshot_handle,
        admission_id,
        index: response_index,
        result,
    } = response
    else {
        return Err("Captured-source deletion returned the wrong response".into());
    };
    require(
        snapshot_handle == snapshot.snapshot_handle
            && admission_id == snapshot.admission_id
            && response_index == index,
        "Captured-source deletion receipt escaped its exact scope",
    )?;
    Ok(result)
}

async fn prepare_reset(
    source: &NativeProfileSource,
    wipe_id: &str,
    expected_scope: Option<ProfileLegacyResetScope>,
) -> Result<ProfileResetPreparedResult, String> {
    let (response, binary) = invoke(
        source,
        serde_json::to_value(ProfileAdmissionRequest::PrepareLegacyProfileReset {
            wipe_id: wipe_id.to_owned(),
            format: LegacyProfileFormat::DesktopLegacyV1,
            expected_scope,
        })
        .map_err(|_| "Cannot encode legacy reset preparation")?,
    )
    .await?;
    require(binary.is_none(), "Legacy reset preparation returned binary")?;
    let ProfileAdmissionResponse::ProfileResetPrepared { result } = response else {
        return Err("Legacy reset preparation returned the wrong response".into());
    };
    Ok(result)
}

async fn reset_family(
    source: &NativeProfileSource,
    snapshot: &ProfileResetSnapshot,
    family: ProfileSourceFamily,
) -> Result<ProfileResetResult, String> {
    let (response, binary) = invoke(
        source,
        serde_json::to_value(ProfileAdmissionRequest::ResetLegacySourceFamily {
            reset_handle: snapshot.reset_handle.clone(),
            wipe_id: snapshot.wipe_id.clone(),
            family,
        })
        .map_err(|_| "Cannot encode legacy family reset")?,
    )
    .await?;
    require(binary.is_none(), "Legacy family reset returned binary")?;
    let ProfileAdmissionResponse::ProfileResetFamilyResult {
        reset_handle,
        wipe_id,
        family: response_family,
        result,
    } = response
    else {
        return Err("Legacy family reset returned the wrong response".into());
    };
    require(
        reset_handle == snapshot.reset_handle
            && wipe_id == snapshot.wipe_id
            && response_family == family,
        "Legacy family reset receipt escaped its scope",
    )?;
    Ok(result)
}

fn unique_entry() -> Result<(String, Entry), String> {
    let identity = format!("bittery91-source-{}", bittery_crypto_core::generate_uuid());
    let physical =
        Entry::new(SERVICE, &identity).map_err(|_| "Cannot select actual fixture entry")?;
    match physical.get_password() {
        Err(keyring::Error::NoEntry) => {}
        Ok(value) => {
            drop(Zeroizing::new(value));
            return Err("Unique source fixture credential already exists".into());
        }
        Err(_) => {
            return Err("Actual OS keychain unavailable; source acceptance cannot run".into())
        }
    }
    Ok((identity, physical))
}

fn cleanup_entry(
    identity: &str,
    physical: Entry,
    result: Result<(), String>,
) -> Result<(), String> {
    let _ = physical.delete_credential();
    match physical.get_password() {
        Err(keyring::Error::NoEntry) => result,
        Ok(value) => {
            drop(Zeroizing::new(value));
            Err(format!(
                "Actual source fixture credential cleanup failed for {identity}"
            ))
        }
        Err(_) => Err(format!(
            "Actual source fixture cleanup unproved for {identity}"
        )),
    }
}

struct ProfileDirectoryReplacement {
    original: PathBuf,
    displaced: PathBuf,
    restored: bool,
}

impl ProfileDirectoryReplacement {
    fn new(original: PathBuf, displaced: PathBuf) -> Self {
        Self {
            original,
            displaced,
            restored: false,
        }
    }

    fn restore(&mut self) -> Result<(), String> {
        for name in ["store.json", "sync-store.json"] {
            let replacement_file = self.original.join(name);
            if replacement_file
                .try_exists()
                .map_err(|_| "Cannot inspect replacement profile file")?
            {
                std::fs::rename(&replacement_file, self.displaced.join(name))
                    .map_err(|_| "Cannot restore retained profile file object")?;
            }
        }
        if self
            .original
            .try_exists()
            .map_err(|_| "Cannot inspect replacement profile directory")?
        {
            std::fs::remove_dir(&self.original)
                .map_err(|_| "Cannot remove replacement profile directory")?;
        }
        std::fs::rename(&self.displaced, &self.original)
            .map_err(|_| "Cannot restore original profile directory object")?;
        self.restored = true;
        Ok(())
    }
}

impl Drop for ProfileDirectoryReplacement {
    fn drop(&mut self) {
        if self.restored {
            return;
        }
        for name in ["store.json", "sync-store.json"] {
            let replacement_file = self.original.join(name);
            if replacement_file.exists() {
                let _ = std::fs::rename(&replacement_file, self.displaced.join(name));
            }
        }
        let _ = std::fs::remove_dir(&self.original);
        let _ = std::fs::rename(&self.displaced, &self.original);
    }
}

async fn require_capability_released(directory: &Path) -> Result<(), String> {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if NativeDeviceLease::try_acquire(directory, DeviceLeaseMode::Exclusive)
                .map_err(|_| "Cannot verify final profile capability release")?
                .is_some()
            {
                return Ok::<_, String>(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .map_err(|_| "Final source jobs did not release the exclusive lease")?
}

fn has_open_source_handle(path: &Path) -> Result<bool, String> {
    Ok(std::fs::read_dir("/proc/self/fd")
        .map_err(|_| "Cannot inspect actual source file descriptors")?
        .filter_map(|entry| std::fs::read_link(entry.ok()?.path()).ok())
        .any(|open| open == path))
}

fn has_open_or_deleted_source_handle(path: &Path) -> Result<bool, String> {
    let deleted = format!("{} (deleted)", path.display());
    Ok(std::fs::read_dir("/proc/self/fd")
        .map_err(|_| "Cannot inspect actual source file descriptors")?
        .filter_map(|entry| std::fs::read_link(entry.ok()?.path()).ok())
        .any(|open| open == path || open.to_string_lossy() == deleted))
}

async fn require_source_handle_closed(path: &Path) -> Result<(), String> {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while has_open_source_handle(path)? {
            tokio::task::yield_now().await;
        }
        Ok::<_, String>(())
    })
    .await
    .map_err(|_| "Close acknowledged while retaining the actual source reader")?
}

async fn actual_case() -> Result<(), String> {
    let (identity, physical) = unique_entry()?;

    let result = async {
        let entry =
            Entry::new(SERVICE, &identity).map_err(|_| "Cannot create actual source owner")?;
        let vault = Arc::new(KeychainVault::from_entry(
            entry,
            format!("desktop-keyring-test-v1:{identity}"),
        ));
        let (directory, source) = NativeProfileSource::isolated_fixture(vault.clone())
            .map_err(|_| "Cannot create exclusively held isolated source fixture")?;
        vault
            .set_value("bittery_device_key", "cached-original")
            .map_err(|_| "Cannot warm the isolated ordinary keychain owner")?;
        let original_secret =
            Zeroizing::new("{\n  \"bittery_device_key\" : \"physical-original\"\n}\n".to_owned());
        physical
            .set_password(&original_secret)
            .map_err(|_| "Cannot seed actual source credentials")?;

        let mut original = br#"{"opaque":""#.to_vec();
        original.resize(PROFILE_SOURCE_BINARY_BYTES - 1, b'x');
        original.extend_from_slice("🦀".as_bytes());
        original.extend_from_slice(b"-retained-tail\"}\n");
        require(
            std::str::from_utf8(&original).is_ok(),
            "Original file must be valid UTF8",
        )?;
        require(
            std::str::from_utf8(&original[..PROFILE_SOURCE_BINARY_BYTES]).is_err(),
            "Fixture must split a UTF8 character at the physical page limit",
        )?;
        let sync_original = b"{\n \"bittery_sync_client_id\": \"retained-client\"\n}\n";
        let store_path = directory.path().join("store.json");
        let sync_path = directory.path().join("sync-store.json");
        std::fs::write(&store_path, &original).map_err(|_| "Cannot seed source store")?;
        std::fs::write(&sync_path, sync_original).map_err(|_| "Cannot seed source Sync store")?;

        let exercised: Result<(), String> = async {
            let (begun, binary) = invoke(
                &source,
                json!({
                    "type": "beginSourceSnapshot", "format": "desktopLegacyV1"
                }),
            )
            .await?;
            require(binary.is_none(), "Begin must not return binary")?;
            let ProfileAdmissionResponse::SourceSnapshot { snapshot } = begun else {
                return Err("Begin did not return a snapshot".into());
            };
            require(
                snapshot.format == LegacyProfileFormat::DesktopLegacyV1
                    && snapshot.session_instance.is_none()
                    && !snapshot.snapshot_handle.is_empty()
                    && !snapshot.capture_id.is_empty()
                    && !snapshot.profile_identity.is_empty(),
                "Begin returned invalid native identity",
            )?;
            require(
                snapshot.families.len() == 3
                    && snapshot.families[0].family == ProfileSourceFamily::DesktopStore
                    && snapshot.families[0].presence == ProfileSourcePresence::Present
                    && snapshot.families[0]
                        .file_identity
                        .as_ref()
                        .is_some_and(|value| !value.is_empty())
                    && snapshot.families[1].family == ProfileSourceFamily::DesktopSyncStore
                    && snapshot.families[1].presence == ProfileSourcePresence::Present
                    && snapshot.families[1]
                        .file_identity
                        .as_ref()
                        .is_some_and(|value| !value.is_empty())
                    && snapshot.families[2].family == ProfileSourceFamily::DesktopCredentials
                    && snapshot.families[2].presence == ProfileSourcePresence::Present
                    && snapshot.families[2].file_identity.is_none(),
                "Begin did not inventory all physical families",
            )?;
            let (repeated, repeated_binary) = invoke(
                &source,
                json!({
                    "type": "beginSourceSnapshot", "format": "desktopLegacyV1"
                }),
            )
            .await?;
            require(
                repeated
                    == ProfileAdmissionResponse::SourceSnapshot {
                        snapshot: snapshot.clone(),
                    }
                    && repeated_binary.is_none(),
                "Repeated Begin did not retain the same snapshot",
            )?;

            for (family, expected) in [
                (ProfileSourceFamily::DesktopStore, original.as_slice()),
                (
                    ProfileSourceFamily::DesktopSyncStore,
                    sync_original.as_slice(),
                ),
            ] {
                let mut cursor: Option<String> = None;
                let mut bytes = Zeroizing::new(Vec::new());
                let mut previous = None;
                loop {
                    let (response, binary) = invoke(
                        &source,
                        json!({
                            "type": "readSourcePage", "snapshotHandle": snapshot.snapshot_handle,
                            "family": family, "selector": {"type": "wholeFile"}, "cursor": cursor
                        }),
                    )
                    .await?;
                    let ProfileAdmissionResponse::SourcePage(page) = response else {
                        return Err("Read did not return a source page".into());
                    };
                    page.validate_for(
                        &snapshot.snapshot_handle,
                        family,
                        &ProfileSourceSelector::WholeFile {},
                        bytes.len() as u64,
                        previous.as_ref(),
                        binary.as_ref().map(|value| value.as_slice()),
                    )
                    .map_err(|_| "Native file page failed shared correlation/length validation")?;
                    require(
                        page.observation
                            == ProfileSourceObservation::FileBytes {
                                length: expected.len() as u64,
                            },
                        "Native file observation changed the original physical length",
                    )?;
                    let binary = binary.ok_or("Present file page must retain binary ownership")?;
                    bytes.extend_from_slice(&binary);
                    require(
                        bytes.len() <= expected.len(),
                        "Native source returned excess bytes",
                    )?;
                    previous = Some(page.observation);
                    match page.continuation {
                        ProfileSourceContinuation::More { cursor: next } => {
                            require(
                                cursor.as_ref() != Some(&next),
                                "Native source cursor did not progress",
                            )?;
                            cursor = Some(next);
                        }
                        ProfileSourceContinuation::End {} => break,
                    }
                }
                require(
                    bytes.as_slice() == expected,
                    "Native paging changed original file bytes",
                )?;
            }
            Ok(())
        }
        .await;

        // Even the expected first Read refusal must prove closure and preservation before failure
        // escapes this fixture. Snapshot Close releases readers but retains the profile capability.
        let (closed, binary) = invoke(
            &source,
            json!({
                "type": "closeSourceSnapshot", "selector": {"type": "currentCapability"}
            }),
        )
        .await?;
        require(
            closed == ProfileAdmissionResponse::SourceSnapshotClosed {} && binary.is_none(),
            "Close did not acknowledge physical reader release",
        )?;
        require(
            std::fs::read(&store_path).map_err(|_| "Cannot verify original source store")?
                == original,
            "Snapshot operations changed original source file bytes",
        )?;
        require(
            std::fs::read(&sync_path).map_err(|_| "Cannot verify original source Sync store")?
                == sync_original,
            "Snapshot operations changed original Sync bytes",
        )?;
        let retained = Zeroizing::new(
            physical
                .get_password()
                .map_err(|_| "Cannot verify actual source credential bytes")?,
        );
        require(
            retained.as_bytes() == original_secret.as_bytes(),
            "Source capture changed physical credential bytes",
        )?;
        let cached = vault
            .get_value("bittery_device_key")
            .map_err(|_| "Cannot verify ordinary cache")?
            .map(Zeroizing::new);
        require(
            cached.as_ref().map(|value| value.as_str()) == Some("cached-original"),
            "Source capture consulted or refreshed the ordinary keychain cache",
        )?;
        require(
            NativeDeviceLease::try_acquire(directory.path(), DeviceLeaseMode::Shared)
                .map_err(|_| "Cannot verify retained profile exclusion")?
                .is_none(),
            "Snapshot Close released the exclusive profile capability",
        )?;
        drop(source);
        require_capability_released(directory.path()).await?;
        exercised
    }
    .await;

    cleanup_entry(&identity, physical, result)
}

fn isolated_child(exact_test: &str) -> Result<bool, String> {
    match std::env::var_os(CHILD) {
        None => {
            let executable =
                std::env::current_exe().map_err(|_| "Cannot locate native test executable")?;
            let output = std::process::Command::new(executable)
                .args([
                    exact_test,
                    "--ignored",
                    "--exact",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env(CHILD, "1")
                .stdin(std::process::Stdio::null())
                .output()
                .map_err(|_| "Cannot start isolated native source test")?;
            eprint!("{}", String::from_utf8_lossy(&output.stderr));
            require(
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"),
                "Isolated actual native source acceptance failed",
            )?;
            Ok(false)
        }
        Some(value) if value == "1" => Ok(true),
        Some(_) => Err("Unexpected native source child marker".into()),
    }
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_file_pages_preserve_split_utf8_and_release_snapshot() -> Result<(), String> {
    if isolated_child(TEST)? {
        actual_case().await
    } else {
        Ok(())
    }
}

async fn credential_case() -> Result<(), String> {
    let (identity, physical) = unique_entry()?;
    let result = async {
        let entry = Entry::new(SERVICE, &identity).map_err(|_| "Cannot create actual source owner")?;
        let vault = Arc::new(KeychainVault::from_entry(entry, format!("desktop-keyring-test-v1:{identity}")));
        // Linux's protected-entry quota is smaller than the protocol page bound. This actual OS
        // fixture uses the same reader with a smaller page to exercise its continuation wire.
        let (directory, source) =
            NativeProfileSource::isolated_fixture_with_page_bytes(vault.clone(), 18)
            .map_err(|_| "Cannot create exclusively held isolated source fixture")?;
        vault.set_value("bittery_device_key", "cached-original")
            .map_err(|_| "Cannot warm isolated ordinary keychain owner")?;
        let account = "acct_legacy_α:7";
        let secret_ref = format!("bittery_account_{account}_secret_key");
        let session_ref = format!("bittery_account_{account}_session_data");
        let jwt_ref = format!("bittery_account_{account}_jwt_token");
        let vault_keys_ref = format!("bittery_account_{account}_vault_keys");
        let private_key_ref = format!("bittery_account_{account}_encrypted_private_key");
        let empty_ref = "bittery_account_acct_empty_secret_key";
        let device = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
        let secret = "  A3-original-é-🔑\n";
        let session = "{\n  \"sessionId\" : \"sess-α\",\n  \"nested\" : \"{\\\"kept\\\":\\\"雪\\\"}\",\n  \"space\" : \"  untouched\\t\"\n}\n";
        let original = Zeroizing::new(serde_json::to_string_pretty(&json!({
            "bittery_device_key": device, (secret_ref.clone()): secret,
            (session_ref): session, (jwt_ref): null, (vault_keys_ref): ["opaque"],
            (private_key_ref): {"opaque": true}, (empty_ref): "",
            "unrelated_legacy": "retained"
        })).map_err(|_| "Cannot encode original credential fixture")?);
        physical.set_password(&original).map_err(|_| "Cannot seed exact physical credential fixture")?;
        let before = Zeroizing::new(physical.get_password().map_err(|_| "Cannot read original physical credential fixture")?);
        require(before.as_bytes() == original.as_bytes(), "Actual OS entry did not retain original credential bytes")?;
        let cached_absent = vault.get_value(&secret_ref).map_err(|_| "Cannot verify original ordinary cache")?
            .map(Zeroizing::new);
        require(cached_absent.is_none(), "Ordinary cache must predate actual Account credential references")?;

        let exercised: Result<(), String> = async {
            let (begun, binary) = invoke(&source, json!({
                "type": "beginSourceSnapshot", "format": "desktopLegacyV1"
            })).await?;
            require(binary.is_none(), "Begin must not return binary")?;
            let ProfileAdmissionResponse::SourceSnapshot { snapshot } = begun else {
                return Err("Begin did not return a snapshot".into());
            };
            require(snapshot.families == vec![
                ProfileSourceFamilyInventory { family: ProfileSourceFamily::DesktopStore, presence: ProfileSourcePresence::Missing, file_identity: None },
                ProfileSourceFamilyInventory { family: ProfileSourceFamily::DesktopSyncStore, presence: ProfileSourcePresence::Missing, file_identity: None },
                ProfileSourceFamilyInventory { family: ProfileSourceFamily::DesktopCredentials, presence: ProfileSourcePresence::Present, file_identity: None },
            ], "Begin did not distinguish actual protected source from absent files")?;
            let cases = [
                (ProfileSourceSelector::GlobalCredential { field: ProfileGlobalCredentialField::DeviceKey },
                    ProfileSourceObservation::StoredString { encoding: ProfileSourceStringEncoding::Utf8, length: device.len() as u64 }, Some(device.as_bytes())),
                (ProfileSourceSelector::AccountCredential { account_id: account.into(), field: ProfileAccountCredentialField::SecretKey },
                    ProfileSourceObservation::StoredString { encoding: ProfileSourceStringEncoding::Utf8, length: secret.len() as u64 }, Some(secret.as_bytes())),
                (ProfileSourceSelector::AccountCredential { account_id: account.into(), field: ProfileAccountCredentialField::SessionData },
                    ProfileSourceObservation::StoredString { encoding: ProfileSourceStringEncoding::Utf8, length: session.len() as u64 }, Some(session.as_bytes())),
                (ProfileSourceSelector::AccountCredential { account_id: account.into(), field: ProfileAccountCredentialField::JwtToken },
                    ProfileSourceObservation::PresentUnsupported { value_kind: bittery_client_core::ProfileSourceValueKind::Null }, None),
                (ProfileSourceSelector::AccountCredential { account_id: account.into(), field: ProfileAccountCredentialField::VaultKeys },
                    ProfileSourceObservation::PresentUnsupported { value_kind: bittery_client_core::ProfileSourceValueKind::Array }, None),
                (ProfileSourceSelector::AccountCredential { account_id: account.into(), field: ProfileAccountCredentialField::EncryptedPrivateKey },
                    ProfileSourceObservation::PresentUnsupported { value_kind: bittery_client_core::ProfileSourceValueKind::Object }, None),
                (ProfileSourceSelector::AccountCredential { account_id: "acct_missing".into(), field: ProfileAccountCredentialField::SecretKey },
                    ProfileSourceObservation::Missing {}, None),
                (ProfileSourceSelector::AccountCredential { account_id: "acct_empty".into(), field: ProfileAccountCredentialField::SecretKey },
                    ProfileSourceObservation::StoredString { encoding: ProfileSourceStringEncoding::Utf8, length: 0 }, Some(b"".as_slice())),
            ];
            let mut secret_cursor = None;
            for (selector, expected_observation, expected_bytes) in cases {
                let mut cursor: Option<String> = None;
                let mut collected = Zeroizing::new(Vec::new());
                let mut previous = None;
                loop {
                    let (response, binary) = invoke(&source, json!({
                        "type": "readSourcePage", "snapshotHandle": snapshot.snapshot_handle,
                        "family": "desktopCredentials", "selector": selector, "cursor": cursor
                    })).await?;
                    let ProfileAdmissionResponse::SourcePage(page) = response else {
                        return Err("Credential Read did not return a source page".into());
                    };
                    page.validate_for(&snapshot.snapshot_handle, ProfileSourceFamily::DesktopCredentials,
                        &selector, collected.len() as u64, previous.as_ref(),
                        binary.as_ref().map(|bytes| bytes.as_slice()))
                        .map_err(|_| "Credential page failed shared scope/length validation")?;
                    require(page.observation == expected_observation,
                        "Credential observation did not preserve physical value presence and kind")?;
                    if let Some(binary) = binary {
                        collected.extend_from_slice(&binary);
                    }
                    previous = Some(page.observation);
                    match page.continuation {
                        ProfileSourceContinuation::More { cursor: next } => {
                            if selector == (ProfileSourceSelector::AccountCredential {
                                account_id: account.into(),
                                field: ProfileAccountCredentialField::SecretKey,
                            }) && secret_cursor.is_none() {
                                secret_cursor = Some(next.clone());
                            }
                            require(cursor.as_ref() != Some(&next),
                                "Credential cursor did not advance")?;
                            cursor = Some(next);
                        }
                        ProfileSourceContinuation::End {} => break,
                    }
                }
                require(match expected_bytes {
                    Some(expected) => collected.as_slice() == expected,
                    None => collected.is_empty(),
                }, "Credential selector did not preserve exact string bytes or unsupported-value emptiness")?;
            }

            let secret_selector = ProfileSourceSelector::AccountCredential {
                account_id: account.into(), field: ProfileAccountCredentialField::SecretKey,
            };
            let initial_request = json!({
                "type": "readSourcePage", "snapshotHandle": snapshot.snapshot_handle,
                "family": "desktopCredentials", "selector": secret_selector, "cursor": null
            });
            let first = invoke(&source, initial_request.clone()).await?;
            let repeated = invoke(&source, initial_request).await?;
            require(first == repeated, "Repeated credential request did not replay the same page")?;
            let cursor = secret_cursor.ok_or("Paged credential did not expose a cursor")?;
            require(invoke(&source, json!({
                "type": "readSourcePage", "snapshotHandle": snapshot.snapshot_handle,
                "family": "desktopCredentials",
                "selector": {"type": "accountCredential", "accountId": account, "field": "sessionData"},
                "cursor": cursor
            })).await.is_err(), "Credential cursor was accepted for another selector")?;
            Ok(())
        }.await;

        let (closed, binary) = invoke(&source, json!({
            "type": "closeSourceSnapshot", "selector": {"type": "currentCapability"}
        })).await?;
        require(closed == ProfileAdmissionResponse::SourceSnapshotClosed {} && binary.is_none(),
            "Close did not acknowledge protected snapshot release")?;
        let after = Zeroizing::new(physical.get_password().map_err(|_| "Cannot verify physical credential preservation")?);
        require(after.as_bytes() == before.as_bytes(), "Credential selectors changed original physical entry bytes")?;
        let cached = vault.get_value("bittery_device_key").map_err(|_| "Cannot verify ordinary global cache")?
            .map(Zeroizing::new);
        require(cached.as_ref().map(|value| value.as_str()) == Some("cached-original"),
            "Credential selectors refreshed the ordinary global cache")?;
        let cached_absent = vault.get_value(&secret_ref).map_err(|_| "Cannot verify ordinary Account cache")?
            .map(Zeroizing::new);
        require(cached_absent.is_none(), "Credential selectors populated the ordinary Account cache")?;
        require(!directory.path().join("store.json").try_exists().map_err(|_| "Cannot verify absent source store")?
            && !directory.path().join("sync-store.json").try_exists().map_err(|_| "Cannot verify absent source Sync store")?,
            "Credential capture created an absent source file")?;
        require(NativeDeviceLease::try_acquire(directory.path(), DeviceLeaseMode::Shared)
            .map_err(|_| "Cannot verify retained profile exclusion")?.is_none(),
            "Snapshot Close released the exclusive profile capability")?;
        drop(source);
        require_capability_released(directory.path()).await?;
        exercised
    }.await;
    cleanup_entry(&identity, physical, result)
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_credential_selectors_preserve_original_strings_and_missing_references(
) -> Result<(), String> {
    if isolated_child(CREDENTIAL_TEST)? {
        credential_case().await
    } else {
        Ok(())
    }
}

async fn malformed_credential_case(raw: &str) -> Result<(), String> {
    let (identity, physical) = unique_entry()?;
    let result = async {
        let entry =
            Entry::new(SERVICE, &identity).map_err(|_| "Cannot create actual source owner")?;
        let vault = Arc::new(KeychainVault::from_entry(
            entry,
            format!("desktop-keyring-test-v1:{identity}"),
        ));
        vault
            .set_value("bittery_device_key", "cached-original")
            .map_err(|_| "Cannot warm malformed-map cache")?;
        let original = Zeroizing::new(raw.to_owned());
        physical
            .set_password(&original)
            .map_err(|_| "Cannot seed malformed physical credential fixture")?;
        let (directory, source) = NativeProfileSource::isolated_fixture(vault.clone())
            .map_err(|_| "Cannot create malformed source fixture")?;

        let (begun, binary) = invoke(
            &source,
            json!({"type": "beginSourceSnapshot", "format": "desktopLegacyV1"}),
        )
        .await?;
        require(binary.is_none(), "Malformed-map Begin returned binary")?;
        let ProfileAdmissionResponse::SourceSnapshot { snapshot } = begun else {
            return Err("Malformed-map Begin did not return a snapshot".into());
        };
        require(
            invoke(
                &source,
                json!({
                    "type": "readSourcePage", "snapshotHandle": snapshot.snapshot_handle,
                    "family": "desktopCredentials",
                    "selector": {"type": "globalCredential", "field": "deviceKey"},
                    "cursor": null
                }),
            )
            .await
            .is_err(),
            "Malformed or duplicate protected map was accepted",
        )?;
        let (closed, binary) = invoke(
            &source,
            json!({
                "type": "closeSourceSnapshot", "selector": {"type": "currentCapability"}
            }),
        )
        .await?;
        require(
            closed == ProfileAdmissionResponse::SourceSnapshotClosed {} && binary.is_none(),
            "Malformed-map snapshot did not close",
        )?;
        let retained = Zeroizing::new(
            physical
                .get_password()
                .map_err(|_| "Cannot verify malformed protected map")?,
        );
        require(
            retained.as_bytes() == original.as_bytes(),
            "Malformed-map refusal changed physical bytes",
        )?;
        let cached = vault
            .get_value("bittery_device_key")
            .map_err(|_| "Cannot verify malformed-map cache")?
            .map(Zeroizing::new);
        require(
            cached.as_ref().map(|value| value.as_str()) == Some("cached-original"),
            "Malformed-map capture refreshed the ordinary cache",
        )?;
        drop(source);
        require_capability_released(directory.path()).await
    }
    .await;
    cleanup_entry(&identity, physical, result)
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_malformed_credential_maps_are_refused_and_preserved() -> Result<(), String> {
    if isolated_child(MALFORMED_CREDENTIAL_TEST)? {
        for raw in [
            r#"["not", "a", "map"]"#,
            r#"{"bittery_device_key":"first","bittery_device_key":"second"}"#,
            r#"{"bittery_device_key":"unterminated}"#,
            r#"{"bittery_device_key":"valid","unselected":"\ud800"}"#,
            r#"{"bittery_device_key":"valid","unselected":{"nested":["\ud800"]}}"#,
            r#"{"bittery_device_key":{"nested":["\ud800"]}}"#,
        ] {
            malformed_credential_case(raw).await?;
        }
    }
    Ok(())
}

async fn verification_case() -> Result<(), String> {
    let (identity, physical) = unique_entry()?;
    let result = async {
        let entry =
            Entry::new(SERVICE, &identity).map_err(|_| "Cannot create verification owner")?;
        let vault = Arc::new(KeychainVault::from_entry(
            entry,
            format!("desktop-keyring-test-v1:{identity}"),
        ));
        let (directory, source) = NativeProfileSource::isolated_fixture(vault.clone())
            .map_err(|_| "Cannot create verification source fixture")?;
        let store = b"exact store bytes for manifest verification\n";
        let sync_store = b"exact sync bytes for manifest verification\n";
        let device_key = "physical-device-key";
        let store_path = directory.path().join("store.json");
        std::fs::write(&store_path, store).map_err(|_| "Cannot seed verification store")?;
        std::fs::write(directory.path().join("sync-store.json"), sync_store)
            .map_err(|_| "Cannot seed verification Sync store")?;
        physical
            .set_password(&Zeroizing::new(
                json!({
                    "bittery_device_key": device_key,
                    "unrelated_core_state": "before"
                })
                .to_string(),
            ))
            .map_err(|_| "Cannot seed verification credentials")?;

        let exercised: Result<(), String> = async {
            let (begun, binary) = invoke(
                &source,
                json!({"type": "beginSourceSnapshot", "format": "desktopLegacyV1"}),
            )
            .await?;
            require(binary.is_none(), "Verification Begin returned binary")?;
            let ProfileAdmissionResponse::SourceSnapshot { snapshot } = begun else {
                return Err("Verification Begin returned the wrong response".into());
            };
            let (header, entries) = manifest(&snapshot, store, sync_store, device_key)?;
            let mut foreign_lineage = header.clone();
            foreign_lineage.recorded_capture_id = bittery_crypto_core::generate_uuid();
            require(
                invoke(
                    &source,
                    serde_json::to_value(ProfileAdmissionRequest::VerifySourceSnapshot {
                        step: ProfileSourceVerifyStep::Start {
                            verification_attempt_id: "foreign-lineage".to_owned(),
                            snapshot_handle: snapshot.snapshot_handle.clone(),
                            header: foreign_lineage,
                        },
                    })
                    .map_err(|_| "Cannot encode foreign-lineage Verify Start")?,
                )
                .await
                .is_err(),
                "Fresh Begin accepted an arbitrary recorded capture lineage",
            )?;

            require(
                verify_manifest(&source, "exact", &snapshot, &header, &entries).await?
                    == ProfileSourceVerificationResult::Unchanged {
                        snapshot_handle: snapshot.snapshot_handle.clone(),
                    },
                "Exact physical source manifest did not verify",
            )?;

            physical
                .set_password(&Zeroizing::new(
                    json!({
                        "bittery_device_key": device_key,
                        "unrelated_core_state": "changed by Core"
                    })
                    .to_string(),
                ))
                .map_err(|_| "Cannot update unrelated protected state")?;
            require(
                verify_manifest(&source, "unrelated", &snapshot, &header, &entries).await?
                    == ProfileSourceVerificationResult::Unchanged {
                        snapshot_handle: snapshot.snapshot_handle.clone(),
                    },
                "Unrelated protected-map write invalidated selected source evidence",
            )?;

            physical
                .set_password(&Zeroizing::new(
                    json!({
                        "bittery_device_key": "changed-device-key",
                        "unrelated_core_state": "changed by Core"
                    })
                    .to_string(),
                ))
                .map_err(|_| "Cannot change selected credential")?;
            require(
                verify_manifest(&source, "credential-changed", &snapshot, &header, &entries)
                    .await?
                    == ProfileSourceVerificationResult::Changed {},
                "Selected credential change was not detected",
            )?;

            physical
                .set_password(&Zeroizing::new(
                    json!({
                        "bittery_device_key": device_key,
                        "unrelated_core_state": "changed by Core"
                    })
                    .to_string(),
                ))
                .map_err(|_| "Cannot restore selected credential")?;
            let displaced = directory.path().join("store.displaced");
            std::fs::rename(&store_path, &displaced)
                .map_err(|_| "Cannot displace original store object")?;
            std::fs::write(&store_path, store)
                .map_err(|_| "Cannot replace store with same bytes")?;
            require(
                verify_manifest(
                    &source,
                    "same-bytes-new-object",
                    &snapshot,
                    &header,
                    &entries,
                )
                .await?
                    == ProfileSourceVerificationResult::Changed {},
                "Same-byte source file replacement did not change stable object identity",
            )?;
            Ok(())
        }
        .await;

        let close = invoke(
            &source,
            json!({
                "type": "closeSourceSnapshot",
                "selector": {"type": "currentCapability"}
            }),
        )
        .await;
        let closed = match close {
            Ok((response, binary)) => require(
                response == ProfileAdmissionResponse::SourceSnapshotClosed {} && binary.is_none(),
                "Verification snapshot did not close",
            ),
            Err(error) => Err(error),
        };
        drop(source);
        require_capability_released(directory.path()).await?;
        exercised.and(closed)
    }
    .await;
    cleanup_entry(&identity, physical, result)
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_manifest_verification_detects_only_selected_physical_changes() -> Result<(), String>
{
    if isolated_child(VERIFICATION_TEST)? {
        verification_case().await
    } else {
        Ok(())
    }
}

async fn profile_identity_case() -> Result<(), String> {
    let (identity, physical) = unique_entry()?;
    let result = async {
        let entry =
            Entry::new(SERVICE, &identity).map_err(|_| "Cannot create profile-identity owner")?;
        let vault = Arc::new(KeychainVault::from_entry(
            entry,
            format!("desktop-keyring-test-v1:{identity}"),
        ));
        let (directory, source) = NativeProfileSource::isolated_fixture(vault)
            .map_err(|_| "Cannot create profile-identity fixture")?;
        let store = b"same retained store object\n";
        let sync_store = b"same retained Sync object\n";
        let device_key = "profile-identity-device";
        let store_path = directory.path().join("store.json");
        let sync_path = directory.path().join("sync-store.json");
        std::fs::write(&store_path, store).map_err(|_| "Cannot seed identity store")?;
        std::fs::write(&sync_path, sync_store).map_err(|_| "Cannot seed identity Sync store")?;
        let protected = Zeroizing::new(json!({"bittery_device_key": device_key}).to_string());
        physical
            .set_password(&protected)
            .map_err(|_| "Cannot seed identity credentials")?;

        let (begun, _) = invoke(
            &source,
            json!({"type": "beginSourceSnapshot", "format": "desktopLegacyV1"}),
        )
        .await?;
        let ProfileAdmissionResponse::SourceSnapshot { snapshot } = begun else {
            return Err("Profile-identity Begin returned the wrong response".into());
        };
        let (header, entries) = manifest(&snapshot, store, sync_store, device_key)?;
        let displaced = directory.path().with_file_name(format!(
            "bittery91-source-displaced-{}",
            bittery_crypto_core::generate_uuid()
        ));
        std::fs::rename(directory.path(), &displaced)
            .map_err(|_| "Cannot displace original profile directory object")?;
        let mut replacement =
            ProfileDirectoryReplacement::new(directory.path().to_path_buf(), displaced.clone());
        std::fs::create_dir(directory.path())
            .map_err(|_| "Cannot create replacement profile directory object")?;
        std::fs::rename(displaced.join("store.json"), &store_path)
            .map_err(|_| "Cannot retain store object in replacement directory")?;
        std::fs::rename(displaced.join("sync-store.json"), &sync_path)
            .map_err(|_| "Cannot retain Sync object in replacement directory")?;

        let checked = async {
            require(
                verify_manifest(
                    &source,
                    "replaced-profile-directory",
                    &snapshot,
                    &header,
                    &entries,
                )
                .await?
                    == ProfileSourceVerificationResult::Changed {},
                "Replacement profile directory passed with retained file objects",
            )
        }
        .await;
        let restored = replacement.restore();
        checked.and(restored)?;

        let (closed, binary) = invoke(
            &source,
            json!({
                "type": "closeSourceSnapshot",
                "selector": {"type": "currentCapability"}
            }),
        )
        .await?;
        require(
            closed == ProfileAdmissionResponse::SourceSnapshotClosed {} && binary.is_none(),
            "Profile-identity fixture did not close",
        )?;
        require(
            std::fs::read(&store_path).map_err(|_| "Cannot verify restored store")? == store
                && std::fs::read(&sync_path).map_err(|_| "Cannot verify restored Sync store")?
                    == sync_store,
            "Profile directory replacement changed retained file bytes",
        )?;
        drop(source);
        require_capability_released(directory.path()).await
    }
    .await;
    cleanup_entry(&identity, physical, result)
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_profile_directory_replacement_is_changed_with_same_file_objects(
) -> Result<(), String> {
    if isolated_child(PROFILE_IDENTITY_TEST)? {
        profile_identity_case().await
    } else {
        Ok(())
    }
}

async fn reopen_case() -> Result<(), String> {
    let (identity, physical) = unique_entry()?;
    let result = async {
        let entry = Entry::new(SERVICE, &identity).map_err(|_| "Cannot create reopen owner")?;
        let vault = Arc::new(KeychainVault::from_entry(
            entry,
            format!("desktop-keyring-test-v1:{identity}"),
        ));
        let (directory, mut source) = NativeProfileSource::isolated_fixture(vault.clone())
            .map_err(|_| "Cannot create reopen source fixture")?;
        let store = b"store bytes retained across source owner loss\n";
        let sync_store = b"sync bytes retained across source owner loss\n";
        let device_key = "reopened-device-key";
        std::fs::write(directory.path().join("store.json"), store)
            .map_err(|_| "Cannot seed reopen store")?;
        std::fs::write(directory.path().join("sync-store.json"), sync_store)
            .map_err(|_| "Cannot seed reopen Sync store")?;
        let protected = Zeroizing::new(
            json!({
                "bittery_device_key": device_key,
                "unrelated": {"retained": true}
            })
            .to_string(),
        );
        physical
            .set_password(&protected)
            .map_err(|_| "Cannot seed reopen credentials")?;

        let exercised: Result<(), String> = async {
            let (begun, _) = invoke(
                &source,
                json!({"type": "beginSourceSnapshot", "format": "desktopLegacyV1"}),
            )
            .await?;
            let ProfileAdmissionResponse::SourceSnapshot { snapshot } = begun else {
                return Err("Reopen fixture Begin returned the wrong response".into());
            };
            // The combined manifest cannot fit in one source-control message, while every Entry
            // call and the native rolling state remain bounded. All Account references are missing.
            let (header, entries) =
                manifest_with_missing_accounts(&snapshot, store, sync_store, device_key, 200)?;
            require(
                serde_json::to_vec(&entries)
                    .map_err(|_| "Cannot measure large source manifest")?
                    .len()
                    > PROFILE_SOURCE_CONTROL_BYTES,
                "Large source manifest fixture still fits in one control message",
            )?;
            let mut wrong_count = header.clone();
            wrong_count.entry_count += 1;
            require(
                invoke(
                    &source,
                    serde_json::to_value(ProfileAdmissionRequest::VerifySourceSnapshot {
                        step: ProfileSourceVerifyStep::Start {
                            verification_attempt_id: "wrong-count".to_owned(),
                            snapshot_handle: snapshot.snapshot_handle.clone(),
                            header: wrong_count,
                        },
                    })
                    .map_err(|_| "Cannot encode wrong-count Verify Start")?,
                )
                .await
                .is_err(),
                "Native source accepted a noncanonical Desktop manifest count",
            )?;
            let (abandoned, _) = invoke(
                &source,
                serde_json::to_value(ProfileAdmissionRequest::VerifySourceSnapshot {
                    step: ProfileSourceVerifyStep::Start {
                        verification_attempt_id: "abandoned-owner".to_owned(),
                        snapshot_handle: snapshot.snapshot_handle.clone(),
                        header: header.clone(),
                    },
                })
                .map_err(|_| "Cannot encode abandoned Verify Start")?,
            )
            .await?;
            let ProfileAdmissionResponse::SourceSnapshotVerification {
                result:
                    ProfileSourceVerificationResult::Started {
                        verification_cursor: abandoned_cursor,
                        next_index: 0,
                    },
            } = abandoned
            else {
                return Err("Abandoned Verify Start returned an invalid receipt".into());
            };
            require(
                invoke(
                    &source,
                    serde_json::to_value(ProfileAdmissionRequest::VerifySourceSnapshot {
                        step: ProfileSourceVerifyStep::Entry {
                            verification_cursor: abandoned_cursor.clone(),
                            index: 0,
                            expected_entry: entries[1].clone(),
                        },
                    })
                    .map_err(|_| "Cannot encode out-of-order Verify Entry")?,
                )
                .await
                .is_err(),
                "Native source accepted a manifest entry outside canonical order",
            )?;
            let (closed, binary) = invoke(
                &source,
                json!({
                    "type": "closeSourceSnapshot",
                    "selector": {"type": "exact", "handle": snapshot.snapshot_handle}
                }),
            )
            .await?;
            require(
                closed == ProfileAdmissionResponse::SourceSnapshotClosed {} && binary.is_none(),
                "Original source owner did not close before Reopen",
            )?;
            drop(source);
            source =
                NativeProfileSource::isolated_existing_fixture(directory.path(), vault.clone())
                    .map_err(|_| "Fresh source owner could not reacquire the isolated profile")?;
            require(
                invoke(
                    &source,
                    serde_json::to_value(ProfileAdmissionRequest::VerifySourceSnapshot {
                        step: ProfileSourceVerifyStep::Entry {
                            verification_cursor: abandoned_cursor,
                            index: 0,
                            expected_entry: entries[0].clone(),
                        },
                    })
                    .map_err(|_| "Cannot encode stale-owner Verify Entry")?,
                )
                .await
                .is_err(),
                "Fresh native owner accepted a prior process verification cursor",
            )?;

            let start_request =
                serde_json::to_value(ProfileAdmissionRequest::ReopenSourceSnapshot {
                    step: ProfileSourceReopenStep::Start {
                        verification_attempt_id: "owner-loss-reopen".to_owned(),
                        header: header.clone(),
                    },
                })
                .map_err(|_| "Cannot encode Reopen Start")?;
            let started = invoke(&source, start_request.clone()).await?;
            let repeated_start = invoke(&source, start_request).await?;
            require(
                started == repeated_start && started.1.is_none(),
                "Lost Reopen Start did not replay its original receipt",
            )?;
            let ProfileAdmissionResponse::SourceSnapshotVerification { result } = started.0 else {
                return Err("Reopen Start returned the wrong response".into());
            };
            let mut cursor = match result {
                ProfileSourceVerificationResult::Started {
                    verification_cursor,
                    next_index: 0,
                } => verification_cursor,
                _ => return Err("Reopen Start returned an invalid receipt".into()),
            };
            require(
                invoke(
                    &source,
                    json!({
                        "type": "readSourcePage",
                        "snapshotHandle": snapshot.snapshot_handle,
                        "family": "desktopStore",
                        "selector": {"type": "wholeFile"},
                        "cursor": null
                    }),
                )
                .await
                .is_err(),
                "Provisional Reopen allowed source reads before Finish",
            )?;

            let mut first_request = None;
            for (index, expected_entry) in entries.iter().enumerate() {
                let request = serde_json::to_value(ProfileAdmissionRequest::ReopenSourceSnapshot {
                    step: ProfileSourceReopenStep::Entry {
                        verification_cursor: cursor.clone(),
                        index: index as u64,
                        expected_entry: expected_entry.clone(),
                    },
                })
                .map_err(|_| "Cannot encode Reopen Entry")?;
                let response = if index == 0 {
                    // Delivery is discarded after the native worker commits the step. Retrying the
                    // identical step must replay the sole retained Entry receipt.
                    let lost = invoke(&source, request.clone()).await?;
                    first_request = Some(request.clone());
                    let replayed = invoke(&source, request).await?;
                    require(lost == replayed, "Lost Reopen Entry did not replay")?;
                    replayed
                } else {
                    invoke(&source, request).await?
                };
                require(response.1.is_none(), "Reopen Entry returned binary")?;
                let ProfileAdmissionResponse::SourceSnapshotVerification { result } = response.0
                else {
                    return Err("Reopen Entry returned the wrong response".into());
                };
                cursor = match result {
                    ProfileSourceVerificationResult::Matched {
                        verification_cursor,
                        next_index,
                    } if next_index == index as u64 + 1 => verification_cursor,
                    _ => return Err("Reopen Entry did not advance exactly once".into()),
                };
                if index == 1 {
                    require(
                        invoke(
                            &source,
                            first_request
                                .clone()
                                .ok_or("First Reopen Entry request was not retained")?,
                        )
                        .await
                        .is_err(),
                        "Reopen retained more than the immediately previous Entry receipt",
                    )?;
                }
            }

            let finish_request =
                serde_json::to_value(ProfileAdmissionRequest::ReopenSourceSnapshot {
                    step: ProfileSourceReopenStep::Finish {
                        verification_cursor: cursor,
                    },
                })
                .map_err(|_| "Cannot encode Reopen Finish")?;
            let finished = invoke(&source, finish_request.clone()).await?;
            let replayed_finish = invoke(&source, finish_request).await?;
            require(
                finished == replayed_finish && finished.1.is_none(),
                "Lost Reopen Finish did not replay the published snapshot",
            )?;
            let ProfileAdmissionResponse::SourceSnapshotVerification {
                result: ProfileSourceVerificationResult::Reopened { snapshot: reopened },
            } = finished.0
            else {
                return Err("Reopen Finish did not publish a snapshot".into());
            };
            require(
                reopened.profile_identity == snapshot.profile_identity
                    && reopened.capture_id != snapshot.capture_id
                    && reopened.snapshot_handle != snapshot.snapshot_handle,
                "Reopen did not preserve profile identity with fresh capture identity",
            )?;
            require(
                verify_manifest(
                    &source,
                    "verify-reopened-lineage",
                    &reopened,
                    &header,
                    &entries,
                )
                .await?
                    == ProfileSourceVerificationResult::Unchanged {
                        snapshot_handle: reopened.snapshot_handle.clone(),
                    },
                "Reopened snapshot did not authorize Verify against recorded source lineage",
            )?;
            let (page, binary) = invoke(
                &source,
                json!({
                    "type": "readSourcePage",
                    "snapshotHandle": reopened.snapshot_handle,
                    "family": "desktopStore",
                    "selector": {"type": "wholeFile"},
                    "cursor": null
                }),
            )
            .await?;
            let ProfileAdmissionResponse::SourcePage(page) = page else {
                return Err("Reopened snapshot did not serve source bytes".into());
            };
            require(
                page.observation
                    == ProfileSourceObservation::FileBytes {
                        length: store.len() as u64,
                    }
                    && binary.as_ref().map(|value| value.as_slice()) == Some(store.as_slice()),
                "Reopened snapshot did not retain freshly verified file bytes",
            )?;
            let (closed, binary) = invoke(
                &source,
                json!({
                    "type": "closeSourceSnapshot",
                    "selector": {"type": "currentCapability"}
                }),
            )
            .await?;
            require(
                closed == ProfileAdmissionResponse::SourceSnapshotClosed {} && binary.is_none(),
                "Reopened source did not close",
            )?;
            drop(source);
            Ok(())
        }
        .await;

        let retained = Zeroizing::new(
            physical
                .get_password()
                .map_err(|_| "Cannot verify reopened protected bytes")?,
        );
        require(
            retained.as_bytes() == protected.as_bytes(),
            "Reopen changed physical protected bytes",
        )?;
        require_capability_released(directory.path()).await?;
        exercised
    }
    .await;
    cleanup_entry(&identity, physical, result)
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_reopen_streams_large_manifest_and_replays_only_completed_steps(
) -> Result<(), String> {
    if isolated_child(REOPEN_TEST)? {
        reopen_case().await
    } else {
        Ok(())
    }
}

async fn cleanup_case() -> Result<(), String> {
    let (identity, physical) = unique_entry()?;
    let result = async {
        let entry = Entry::new(SERVICE, &identity).map_err(|_| "Cannot create cleanup owner")?;
        let vault = Arc::new(KeychainVault::from_entry(entry, format!("desktop-keyring-test-v1:{identity}")));
        let (directory, source) = NativeProfileSource::isolated_fixture(vault.clone())
            .map_err(|_| "Cannot create cleanup fixture")?;
        let store = b"captured cleanup store bytes\n";
        let sync_store = b"captured cleanup Sync bytes\n";
        let device_key = "captured-cleanup-device-key";
        let store_path = directory.path().join("store.json");
        let sync_path = directory.path().join("sync-store.json");
        std::fs::write(&store_path, store).map_err(|_| "Cannot seed cleanup store")?;
        std::fs::write(&sync_path, sync_store).map_err(|_| "Cannot seed cleanup Sync store")?;
        let original_credentials = Zeroizing::new(format!(
            r#"{{"bittery_device_key":"{device_key}","foreign":{{"nested":[true,{{"x":"y"}}]}},"raw_array":[1, 2, 3],"other":"keep"}}"#
        ));
        physical
            .set_password(&original_credentials)
            .map_err(|_| "Cannot seed cleanup credentials")?;

        let (begun, _) = invoke(
            &source,
            json!({"type": "beginSourceSnapshot", "format": "desktopLegacyV1"}),
        )
        .await?;
        let ProfileAdmissionResponse::SourceSnapshot { snapshot } = begun else {
            return Err("Cleanup Begin returned the wrong response".into());
        };
        let (header, entries) =
            manifest_with_missing_accounts(&snapshot, store, sync_store, device_key, 200)?;
        require(
            serde_json::to_vec(&entries)
                .map_err(|_| "Cannot size cleanup manifest")?
                .len()
                > PROFILE_SOURCE_CONTROL_BYTES,
            "Cleanup manifest still fits in one control",
        )?;
        invoke(
            &source,
            json!({"type":"closeSourceSnapshot","selector":{"type":"exact","handle":snapshot.snapshot_handle}}),
        )
        .await?;

        // Cleanup Reopen validates the committed expected manifest, not current target equality.
        // One unreadable/missing-at-capture credential must not starve an independent file delete.
        let malformed = Zeroizing::new(format!(
            r#"{{"bittery_device_key":"{device_key}","foreign":{{"nested":["\ud800"]}},"bittery_account_account-0000-{}_secret_key":{{"now":"present"}}}}"#,
            "x".repeat(96)
        ));
        physical
            .set_password(&malformed)
            .map_err(|_| "Cannot install malformed cleanup credentials")?;
        let admission_id = "committed-actual-cleanup";
        let cleanup =
            reopen_cleanup_manifest(&source, "cleanup-first", admission_id, &header, &entries)
                .await?;
        require(
            invoke(
                &source,
                json!({"type":"readSourcePage","snapshotHandle":cleanup.snapshot_handle,
                    "family":"desktopStore","selector":{"type":"wholeFile"},"cursor":null}),
            )
            .await
            .is_err(),
            "Cleanup-only snapshot authorized a source read",
        )?;

        // Discard the first successful deletion receipt. An exact retry proves physical absence.
        require(
            delete_captured(&source, &cleanup, 0, &entries[0]).await?
                == ProfileSourceDeleteResult::Deleted {},
            "Exact captured file was not deleted",
        )?;
        require(
            delete_captured(&source, &cleanup, 0, &entries[0]).await?
                == ProfileSourceDeleteResult::AlreadyAbsent {},
            "Lost file deletion acknowledgement did not reconcile as absence",
        )?;

        let displaced_sync = directory.path().join("sync-store.captured");
        std::fs::rename(&sync_path, &displaced_sync)
            .map_err(|_| "Cannot displace captured Sync file")?;
        let foreign_sync = sync_store;
        std::fs::write(&sync_path, foreign_sync)
            .map_err(|_| "Cannot install foreign Sync replacement")?;
        require(
            delete_captured(&source, &cleanup, 1, &entries[1]).await?
                == ProfileSourceDeleteResult::Changed {},
            "Foreign file replacement was not classified Changed",
        )?;
        require(
            std::fs::read(&sync_path).map_err(|_| "Cannot read foreign Sync replacement")?
                == foreign_sync,
            "Changed file replacement was deleted",
        )?;

        require(
            delete_captured(&source, &cleanup, 2, &entries[2]).await?
                == ProfileSourceDeleteResult::Unavailable {},
            "Malformed unrelated credential value did not make cleanup unavailable",
        )?;
        require(
            physical
                .get_password()
                .map_err(|_| "Cannot verify malformed cleanup credentials")?
                .as_bytes()
                == malformed.as_bytes(),
            "Unavailable credential cleanup changed malformed physical bytes",
        )?;

        physical
            .set_password(&original_credentials)
            .map_err(|_| "Cannot restore cleanup credentials")?;
        require(
            delete_captured(&source, &cleanup, 2, &entries[2]).await?
                == ProfileSourceDeleteResult::Deleted {},
            "Exact captured credential was not deleted",
        )?;
        let expected_retained =
            r#"{"foreign":{"nested":[true,{"x":"y"}]},"raw_array":[1, 2, 3],"other":"keep"}"#;
        require(
            physical
                .get_password()
                .map_err(|_| "Cannot inspect cleaned credentials")?
                == expected_retained,
            "Credential cleanup did not preserve unrelated raw values",
        )?;
        invoke(
            &source,
            json!({"type":"closeSourceSnapshot","selector":{"type":"exact","handle":cleanup.snapshot_handle}}),
        )
        .await?;
        drop(source);

        // A fresh native owner has no deletion receipt. Streaming the original expected manifest
        // still yields a cleanup-only handle, and exact physical absence is sufficient proof.
        let reopened_source = NativeProfileSource::isolated_existing_fixture(
            directory.path(),
            vault.clone(),
        )
        .map_err(|_| "Cannot reacquire cleanup owner")?;
        let reopened = reopen_cleanup_manifest(
            &reopened_source,
            "cleanup-owner-loss",
            admission_id,
            &header,
            &entries,
        )
        .await?;
        require(
            delete_captured(&reopened_source, &reopened, 0, &entries[0]).await?
                == ProfileSourceDeleteResult::AlreadyAbsent {}
                && delete_captured(&reopened_source, &reopened, 2, &entries[2]).await?
                    == ProfileSourceDeleteResult::AlreadyAbsent {},
            "Fresh owner could not reconcile completed cleanup without receipts",
        )?;
        require(
            delete_captured(&reopened_source, &reopened, 1, &entries[1]).await?
                == ProfileSourceDeleteResult::Changed {}
                && std::fs::read(&sync_path)
                    .map_err(|_| "Cannot recheck foreign Sync replacement")?
                    == foreign_sync,
            "Fresh owner did not preserve a changed source target",
        )?;
        invoke(
            &reopened_source,
            json!({"type":"closeSourceSnapshot","selector":{"type":"currentCapability"}}),
        )
        .await?;
        drop(reopened_source);
        drop(vault);
        require_capability_released(directory.path()).await
    }
    .await;
    cleanup_entry(&identity, physical, result)
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_cleanup_reopens_exact_manifest_and_deletes_only_matching_source(
) -> Result<(), String> {
    if isolated_child(CLEANUP_TEST)? {
        cleanup_case().await
    } else {
        Ok(())
    }
}

async fn cancelled_cleanup_case() -> Result<(), String> {
    let (identity, physical) = unique_entry()?;
    let result = async {
        let entry = Entry::new(SERVICE, &identity)
            .map_err(|_| "Cannot create cleanup cancellation owner")?;
        let vault = Arc::new(KeychainVault::from_entry(entry, format!("desktop-keyring-test-v1:{identity}")));
        let barrier = TestPageBarrier::new();
        let release = ReleasePageBarrier(barrier.clone());
        let (directory, source) =
            NativeProfileSource::isolated_fixture_with_page_barrier(vault, barrier.clone())
                .map_err(|_| "Cannot create cleanup cancellation fixture")?;
        let store = b"cleanup delete held with an actual source reader\n";
        let sync_store = b"cleanup cancellation Sync remains unchanged\n";
        let device_key = "cleanup-cancellation-device";
        let store_path = directory.path().join("store.json");
        std::fs::write(&store_path, store)
            .map_err(|_| "Cannot seed cleanup cancellation store")?;
        std::fs::write(directory.path().join("sync-store.json"), sync_store)
            .map_err(|_| "Cannot seed cleanup cancellation Sync store")?;
        let protected = Zeroizing::new(
            json!({"bittery_device_key":device_key,"unrelated":"retained"}).to_string(),
        );
        physical
            .set_password(&protected)
            .map_err(|_| "Cannot seed cleanup cancellation credentials")?;
        let (begun, _) = invoke(
            &source,
            json!({"type":"beginSourceSnapshot","format":"desktopLegacyV1"}),
        )
        .await?;
        let ProfileAdmissionResponse::SourceSnapshot { snapshot } = begun else {
            return Err("Cleanup cancellation Begin returned the wrong response".into());
        };
        let (header, entries) = manifest(&snapshot, store, sync_store, device_key)?;
        invoke(
            &source,
            json!({"type":"closeSourceSnapshot","selector":{"type":"exact","handle":snapshot.snapshot_handle}}),
        )
        .await?;
        let cleanup = reopen_cleanup_manifest(
            &source,
            "cleanup-cancelled-delete",
            "cleanup-cancelled-admission",
            &header,
            &entries,
        )
        .await?;

        let delete_source = source.clone();
        let delete_request = serde_json::to_string(&ProfileAdmissionRequest::DeleteCapturedSource {
            snapshot_handle: cleanup.snapshot_handle.clone(),
            admission_id: cleanup.admission_id.clone(),
            index: 0,
            expected_entry: entries[0].clone(),
        })
        .map_err(|_| "Cannot encode cancelled cleanup deletion")?;
        let delivery = tokio::spawn(async move {
            delete_source
                .invoke(Zeroizing::new(delete_request))
                .await
        });
        barrier.wait_for_page().await;
        let changed_store = b"changed while exact cleanup deletion was blocked\n";
        std::fs::write(&store_path, changed_store)
            .map_err(|_| "Cannot change blocked cleanup source")?;
        delivery.abort();
        require(
            delivery.await.is_err_and(|error| error.is_cancelled()),
            "Issued cleanup deletion delivery was not cancelled",
        )?;

        let close_source = source.clone();
        let close_handle = cleanup.snapshot_handle;
        let close = tokio::spawn(async move {
            close_source
                .invoke(Zeroizing::new(
                    json!({"type":"closeSourceSnapshot","selector":{"type":"exact","handle":close_handle}}).to_string(),
                ))
                .await
        });
        barrier.wait_for_close_fence().await;
        require(
            !close.is_finished()
                && has_open_source_handle(&store_path)?
                && std::fs::read(&store_path)
                    .map_err(|_| "Cannot inspect held cleanup source")?
                    == changed_store,
            "Close did not retain and drain the detached cleanup reader",
        )?;
        require(
            NativeDeviceLease::try_acquire(directory.path(), DeviceLeaseMode::Shared)
                .map_err(|_| "Cannot verify cleanup cancellation exclusion")?
                .is_none(),
            "Detached cleanup deletion released profile exclusion",
        )?;
        barrier.release();
        let (control, binary) = tokio::time::timeout(std::time::Duration::from_secs(2), close)
            .await
            .map_err(|_| "Close did not drain cleanup deletion")?
            .map_err(|_| "Cleanup Close task was cancelled")?
            .map_err(|_| "Cleanup Close refused after drain")?;
        require(
            serde_json::from_str::<ProfileAdmissionResponse>(&control)
                .map_err(|_| "Cleanup Close returned invalid control")?
                == ProfileAdmissionResponse::SourceSnapshotClosed {}
                && binary.is_none(),
            "Cleanup Close did not acknowledge the drained deletion",
        )?;
        require(
            std::fs::read(&store_path)
                .map_err(|_| "Changed cleanup source was deleted")?
                == changed_store,
            "Detached cleanup deletion did not preserve changed source bytes",
        )?;
        require(
            !has_open_or_deleted_source_handle(&store_path)?,
            "Cleanup Close retained the changed source reader",
        )?;
        require(
            physical
                .get_password()
                .map_err(|_| "Cannot verify cleanup cancellation credentials")?
                .as_bytes()
                == protected.as_bytes(),
            "File cleanup cancellation changed credential bytes",
        )?;
        drop(release);
        drop(source);
        require_capability_released(directory.path()).await
    }
    .await;
    cleanup_entry(&identity, physical, result)
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain and /proc; isolated exact-test child only"]
async fn cancelled_actual_cleanup_delete_is_drained_before_close_acknowledges() -> Result<(), String>
{
    if isolated_child(CANCELLED_CLEANUP_TEST)? {
        cancelled_cleanup_case().await
    } else {
        Ok(())
    }
}

async fn reset_case() -> Result<(), String> {
    let (identity, physical) = unique_entry()?;
    let result = async {
        let entry = Entry::new(SERVICE, &identity).map_err(|_| "Cannot create reset owner")?;
        let vault = Arc::new(KeychainVault::from_entry(entry, format!("desktop-keyring-test-v1:{identity}")));
        let barrier = TestPageBarrier::new();
        let release = ReleasePageBarrier(barrier.clone());
        let (directory, source) =
            NativeProfileSource::isolated_fixture_with_page_barrier(vault.clone(), barrier.clone())
                .map_err(|_| "Cannot create reset fixture")?;
        let store = b"legacy store reset does not decode this payload\n";
        let sync_store = b"legacy Sync reset binds only its file object\n";
        let store_path = directory.path().join("store.json");
        let sync_path = directory.path().join("sync-store.json");
        std::fs::write(&store_path, store).map_err(|_| "Cannot seed reset store")?;
        std::fs::write(&sync_path, sync_store).map_err(|_| "Cannot seed reset Sync store")?;
        let original_credentials = Zeroizing::new(
            r#"{"bittery_device_key":"device","bittery_account__secret_key":{"orphan":true},"bittery_account_orphan_session_data":"session","bittery_account_orphan_encrypted_private_key":[1,2],"bittery_account_orphan_secret_key_extra":"near-miss","bittery:runtime:secret":"core","foreign":{"raw":[true,null]}}"#.to_owned(),
        );
        physical
            .set_password(&original_credentials)
            .map_err(|_| "Cannot seed reset credentials")?;

        let wipe_id = "actual-reset-wipe";
        let first = prepare_reset(&source, wipe_id, None).await?;
        require(
            first == prepare_reset(&source, wipe_id, None).await?,
            "Lost reset preparation did not replay",
        )?;
        let ProfileResetPreparedResult::Prepared { snapshot } = first else {
            return Err("Initial reset scope was not prepared".into());
        };
        require(
            snapshot.scope.profile_identity
                == source.capability.profile_identity
                && snapshot.scope.families.len() == 3
                && matches!(
                    snapshot.scope.families[0].file,
                    ProfileResetFileBinding::Present { .. }
                )
                && matches!(
                    snapshot.scope.families[1].file,
                    ProfileResetFileBinding::Present { .. }
                )
                && matches!(
                    snapshot.scope.families[2].file,
                    ProfileResetFileBinding::NotFile {}
                ),
            "Reset scope did not bind the fixed Desktop namespaces",
        )?;

        let delete_source = source.clone();
        let reset_handle = snapshot.reset_handle.clone();
        let request = serde_json::to_string(&ProfileAdmissionRequest::ResetLegacySourceFamily {
            reset_handle: reset_handle.clone(),
            wipe_id: wipe_id.to_owned(),
            family: ProfileSourceFamily::DesktopStore,
        })
        .map_err(|_| "Cannot encode detached file reset")?;
        let delivery =
            tokio::spawn(async move { delete_source.invoke(Zeroizing::new(request)).await });
        barrier.wait_for_page().await;
        delivery.abort();
        require(
            delivery.await.is_err_and(|error| error.is_cancelled()),
            "Issued reset deletion delivery was not cancelled",
        )?;
        let close_source = source.clone();
        let close = tokio::spawn(async move {
            close_source
                .invoke(Zeroizing::new(
                    json!({"type":"closeSourceSnapshot","selector":{"type":"exact","handle":reset_handle}}).to_string(),
                ))
                .await
        });
        barrier.wait_for_close_fence().await;
        require(
            !close.is_finished()
                && has_open_source_handle(&store_path)?
                && std::fs::read(&store_path).map_err(|_| "Cannot inspect held reset store")?
                    == store,
            "Reset Close did not retain the detached file reader",
        )?;
        barrier.release();
        let (control, binary) = tokio::time::timeout(std::time::Duration::from_secs(2), close)
            .await
            .map_err(|_| "Reset Close did not drain file deletion")?
            .map_err(|_| "Reset Close task was cancelled")?
            .map_err(|_| "Reset Close refused after drain")?;
        require(
            serde_json::from_str::<ProfileAdmissionResponse>(&control)
                .map_err(|_| "Reset Close returned invalid control")?
                == ProfileAdmissionResponse::SourceSnapshotClosed {}
                && binary.is_none()
                && !store_path
                    .try_exists()
                    .map_err(|_| "Cannot prove reset file absence")?
                && !has_open_or_deleted_source_handle(&store_path)?,
            "Reset Close acknowledged before deletion and reader release",
        )?;
        drop(release);
        drop(source);

        let (foreign_identity, foreign_physical) = unique_entry()?;
        let foreign_result = async {
            let foreign_entry = Entry::new(SERVICE, &foreign_identity)
                .map_err(|_| "Cannot create foreign reset credential owner")?;
            let foreign_vault = Arc::new(KeychainVault::from_entry(
                foreign_entry,
                format!("desktop-keyring-test-v1:{foreign_identity}"),
            ));
            let foreign_bytes = Zeroizing::new(
                r#"{"bittery_device_key":"foreign-must-survive","unrelated":"foreign"}"#
                    .to_owned(),
            );
            foreign_physical
                .set_password(&foreign_bytes)
                .map_err(|_| "Cannot seed foreign reset credentials")?;
            let foreign_source = NativeProfileSource::isolated_existing_fixture(
                directory.path(),
                foreign_vault,
            )
            .map_err(|_| "Cannot acquire foreign reset credential owner")?;
            require(
                prepare_reset(&foreign_source, wipe_id, Some(snapshot.scope.clone())).await?
                    == ProfileResetPreparedResult::Changed {},
                "Durable reset scope reopened onto a foreign credential namespace",
            )?;
            invoke(
                &foreign_source,
                json!({"type":"closeSourceSnapshot","selector":{"type":"currentCapability"}}),
            )
            .await?;
            drop(foreign_source);
            require(
                foreign_physical
                    .get_password()
                    .map_err(|_| "Cannot inspect foreign reset credentials")?
                    .as_bytes()
                    == foreign_bytes.as_bytes(),
                "Foreign credential namespace was changed",
            )
        }
        .await;
        cleanup_entry(&foreign_identity, foreign_physical, foreign_result)?;

        let reopened = NativeProfileSource::isolated_existing_fixture(
            directory.path(),
            vault.clone(),
        )
        .map_err(|_| "Cannot reacquire reset owner")?;
        let retry = prepare_reset(&reopened, wipe_id, Some(snapshot.scope.clone())).await?;
        let ProfileResetPreparedResult::Prepared {
            snapshot: retry_snapshot,
        } = retry
        else {
            return Err("Durable reset scope did not reopen after lost deletion receipt".into());
        };
        require(
            retry_snapshot.reset_handle != snapshot.reset_handle
                && retry_snapshot.scope == snapshot.scope
                && reset_family(
                    &reopened,
                    &retry_snapshot,
                    ProfileSourceFamily::DesktopStore,
                )
                .await?
                    == ProfileResetResult::AlreadyAbsent {},
            "Fresh reset owner did not reconcile the deleted file",
        )?;

        let malformed = Zeroizing::new(
            r#"{"bittery_device_key":"device","foreign":{"nested":["\ud800"]}}"#.to_owned(),
        );
        physical
            .set_password(&malformed)
            .map_err(|_| "Cannot install malformed reset credentials")?;
        require(
            reset_family(
                &reopened,
                &retry_snapshot,
                ProfileSourceFamily::DesktopCredentials,
            )
            .await?
                == ProfileResetResult::Unavailable {}
                && physical
                    .get_password()
                    .map_err(|_| "Cannot inspect malformed reset credentials")?
                    .as_bytes()
                    == malformed.as_bytes(),
            "Malformed credential reset was not refused without mutation",
        )?;
        physical
            .set_password(&original_credentials)
            .map_err(|_| "Cannot restore reset credentials")?;
        require(
            reset_family(
                &reopened,
                &retry_snapshot,
                ProfileSourceFamily::DesktopCredentials,
            )
            .await?
                == ProfileResetResult::Reset {}
                && reset_family(
                    &reopened,
                    &retry_snapshot,
                    ProfileSourceFamily::DesktopCredentials,
                )
                .await?
                    == ProfileResetResult::AlreadyAbsent {},
            "Credential reset did not delete and prove all legacy references",
        )?;
        let expected_retained = r#"{"bittery_account_orphan_secret_key_extra":"near-miss","bittery:runtime:secret":"core","foreign":{"raw":[true,null]}}"#;
        require(
            physical
                .get_password()
                .map_err(|_| "Cannot inspect retained reset credentials")?
                == expected_retained,
            "Credential reset did not preserve Core, near-miss and unrelated entries",
        )?;

        let displaced_sync = directory.path().join("sync-store.original");
        std::fs::rename(&sync_path, &displaced_sync)
            .map_err(|_| "Cannot displace reset Sync object")?;
        std::fs::write(&sync_path, sync_store)
            .map_err(|_| "Cannot install same-byte reset Sync replacement")?;
        require(
            reset_family(
                &reopened,
                &retry_snapshot,
                ProfileSourceFamily::DesktopSyncStore,
            )
            .await?
                == ProfileResetResult::Changed {}
                && std::fs::read(&sync_path)
                    .map_err(|_| "Cannot inspect reset Sync replacement")?
                    == sync_store,
            "Reset deleted a foreign same-byte file replacement",
        )?;
        invoke(
            &reopened,
            json!({"type":"closeSourceSnapshot","selector":{"type":"currentCapability"}}),
        )
        .await?;
        drop(reopened);
        drop(vault);
        require_capability_released(directory.path()).await
    }
    .await;
    cleanup_entry(&identity, physical, result)
}

async fn reset_absent_replacement_case() -> Result<(), String> {
    let (identity, physical) = unique_entry()?;
    let result = async {
        let entry =
            Entry::new(SERVICE, &identity).map_err(|_| "Cannot create absent reset owner")?;
        let vault = Arc::new(KeychainVault::from_entry(
            entry,
            format!("desktop-keyring-test-v1:{identity}"),
        ));
        let (directory, source) = NativeProfileSource::isolated_fixture(vault.clone())
            .map_err(|_| "Cannot create absent reset fixture")?;
        let wipe_id = "actual-reset-absent-replacement";
        let ProfileResetPreparedResult::Prepared { snapshot } =
            prepare_reset(&source, wipe_id, None).await?
        else {
            return Err("Absent reset scope was not prepared".into());
        };
        require(
            matches!(
                snapshot.scope.families[0].file,
                ProfileResetFileBinding::Absent {}
            ) && matches!(
                snapshot.scope.families[1].file,
                ProfileResetFileBinding::Absent {}
            ),
            "Absent reset fixture recorded a present file",
        )?;
        invoke(
            &source,
            json!({"type":"closeSourceSnapshot","selector":{"type":"currentCapability"}}),
        )
        .await?;
        drop(source);

        let replacement = b"new file in an originally absent reset namespace\n";
        let store_path = directory.path().join("store.json");
        std::fs::write(&store_path, replacement)
            .map_err(|_| "Cannot create absent-scope replacement")?;
        let reopened = NativeProfileSource::isolated_existing_fixture(directory.path(), vault)
            .map_err(|_| "Cannot reacquire absent reset owner")?;
        require(
            prepare_reset(&reopened, wipe_id, Some(snapshot.scope)).await?
                == ProfileResetPreparedResult::Changed {}
                && std::fs::read(&store_path)
                    .map_err(|_| "Cannot inspect absent-scope replacement")?
                    == replacement,
            "Originally absent namespace did not preserve a new foreign file",
        )?;
        invoke(
            &reopened,
            json!({"type":"closeSourceSnapshot","selector":{"type":"currentCapability"}}),
        )
        .await?;
        drop(reopened);
        require_capability_released(directory.path()).await
    }
    .await;
    cleanup_entry(&identity, physical, result)
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain and /proc; isolated exact-test child only"]
async fn actual_profile_reset_uses_durable_scope_and_preserves_foreign_data() -> Result<(), String>
{
    if isolated_child(RESET_TEST)? {
        reset_case().await?;
        reset_absent_replacement_case().await
    } else {
        Ok(())
    }
}

async fn runtime_wipe_case() -> Result<(), String> {
    let (identity, physical) = unique_entry()?;
    let result = async {
        let entry = Entry::new(SERVICE, &identity)
            .map_err(|_| "Cannot create end-to-end reset owner")?;
        let vault = Arc::new(KeychainVault::from_entry(
            entry,
            format!("desktop-keyring-test-v1:{identity}"),
        ));
        let (directory, source) = NativeProfileSource::isolated_fixture(vault.clone())
            .map_err(|_| "Cannot create end-to-end reset fixture")?;
        let store_path = directory.path().join("store.json");
        let sync_path = directory.path().join("sync-store.json");
        std::fs::write(&store_path, b"malformed old store is still reset\n")
            .map_err(|_| "Cannot seed end-to-end reset store")?;
        std::fs::write(&sync_path, b"old Sync bytes are reset without decoding\n")
            .map_err(|_| "Cannot seed end-to-end reset Sync store")?;
        let protected = Zeroizing::new(
            r#"{"bittery_device_key":"wipe-device","bittery_account__secret_key":{"old":true},"bittery_account_orphan_session_data":"old-session","bittery_account_orphan_jwt_token":"old-token","bittery_account_orphan_vault_keys":[{"old":true}],"bittery_account_orphan_encrypted_private_key":"old-private","bittery_account_orphan_secret_key_extra":"near-miss","foreign":"preserved"}"#.to_owned(),
        );
        physical
            .set_password(&protected)
            .map_err(|_| "Cannot seed end-to-end reset credentials")?;
        let platform = Arc::new(
            NativePlatformStorage::with_test_vault(
                directory.path().join("platform.sqlite"),
                vault.clone(),
            )
            .map_err(|_| "Cannot create end-to-end reset platform storage")?,
        );
        let runtime =
            admission_runtime(directory.path(), platform.clone(), Some(source.clone())).await?;
        let response = runtime
            .request(RuntimeRequest::Wipe, RequestCancellation::new())
            .await
            .map_err(|_| "Actual Runtime Wipe request failed")?;
        require(
            matches!(
                response,
                RuntimeResponse::Teardown {
                    status: TeardownStatus::Complete,
                    ..
                }
            ),
            "Actual Runtime Wipe did not complete",
        )?;
        require(
            !store_path
                .try_exists()
                .map_err(|_| "Cannot prove wiped store absence")?
                && !sync_path
                    .try_exists()
                    .map_err(|_| "Cannot prove wiped Sync absence")?,
            "Actual Runtime Wipe retained a legacy source file",
        )?;
        for key in [
            "bittery_device_key",
            "bittery_account__secret_key",
            "bittery_account_orphan_session_data",
            "bittery_account_orphan_jwt_token",
            "bittery_account_orphan_vault_keys",
            "bittery_account_orphan_encrypted_private_key",
        ] {
            require(
                vault
                    .get_value(key)
                    .map_err(|_| "Cannot inspect wiped legacy credential")?
                    .is_none(),
                "Actual Runtime Wipe retained a legacy credential",
            )?;
        }
        require(
            vault
                .get_value("bittery_account_orphan_secret_key_extra")
                .map_err(|_| "Cannot inspect reset near-miss")?
                .as_deref()
                == Some("near-miss")
                && vault
                    .get_value("foreign")
                    .map_err(|_| "Cannot inspect reset unrelated value")?
                    .as_deref()
                    == Some("preserved"),
            "Actual Runtime Wipe changed unrelated protected values",
        )?;
        let catalog = platform_value(
            &platform,
            PlatformStorageArea::DevicePlain,
            "bittery:runtime:platform-storage:device-catalog".into(),
        )
        .await?
        .ok_or("Actual Runtime Wipe did not retain its durable journal")?;
        let catalog: serde_json::Value = serde_json::from_str(&catalog)
            .map_err(|_| "Actual Runtime Wipe journal is malformed")?;
        require(
            catalog["profileAdmission"]["phase"] == "wiped"
                && catalog["accounts"] == json!([]),
            "Actual Runtime Wipe did not publish a Wiped empty catalog",
        )?;
        runtime.close().await;
        drop(runtime);
        drop(source);

        let reopened = admission_runtime(directory.path(), platform.clone(), None).await?;
        reopened
            .open()
            .await
            .map_err(|_| "Wiped actual Runtime did not reopen without its legacy source")?;
        reopened.close().await;
        drop(reopened);
        drop(platform);
        drop(vault);
        require_capability_released(directory.path()).await
    }
    .await;
    cleanup_entry(&identity, physical, result)
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_runtime_wipe_resets_native_legacy_sources() -> Result<(), String> {
    if isolated_child(RESET_WIPE_TEST)? {
        runtime_wipe_case().await
    } else {
        Ok(())
    }
}

async fn provisional_close_case() -> Result<(), String> {
    let (identity, physical) = unique_entry()?;
    let result = async {
        let entry =
            Entry::new(SERVICE, &identity).map_err(|_| "Cannot create provisional owner")?;
        let vault = Arc::new(KeychainVault::from_entry(
            entry,
            format!("desktop-keyring-test-v1:{identity}"),
        ));
        let (directory, source) = NativeProfileSource::isolated_fixture(vault)
            .map_err(|_| "Cannot create provisional Close fixture")?;
        let store = b"provisional reopen file reader\n";
        let sync_store = b"provisional reopen Sync reader\n";
        let device_key = "provisional-device";
        let store_path = directory.path().join("store.json");
        std::fs::write(&store_path, store).map_err(|_| "Cannot seed provisional store")?;
        std::fs::write(directory.path().join("sync-store.json"), sync_store)
            .map_err(|_| "Cannot seed provisional Sync store")?;
        let protected = Zeroizing::new(json!({"bittery_device_key": device_key}).to_string());
        physical
            .set_password(&protected)
            .map_err(|_| "Cannot seed provisional credentials")?;

        let (begun, _) = invoke(
            &source,
            json!({"type": "beginSourceSnapshot", "format": "desktopLegacyV1"}),
        )
        .await?;
        let ProfileAdmissionResponse::SourceSnapshot { snapshot } = begun else {
            return Err("Provisional fixture Begin returned the wrong response".into());
        };
        let (header, entries) = manifest(&snapshot, store, sync_store, device_key)?;
        invoke(
            &source,
            json!({
                "type": "closeSourceSnapshot",
                "selector": {"type": "exact", "handle": snapshot.snapshot_handle}
            }),
        )
        .await?;
        let (started, _) = invoke(
            &source,
            serde_json::to_value(ProfileAdmissionRequest::ReopenSourceSnapshot {
                step: ProfileSourceReopenStep::Start {
                    verification_attempt_id: "provisional-close".to_owned(),
                    header,
                },
            })
            .map_err(|_| "Cannot encode provisional Reopen Start")?,
        )
        .await?;
        let ProfileAdmissionResponse::SourceSnapshotVerification {
            result:
                ProfileSourceVerificationResult::Started {
                    verification_cursor,
                    next_index: 0,
                },
        } = started
        else {
            return Err("Provisional Reopen Start returned an invalid receipt".into());
        };
        let (matched, _) = invoke(
            &source,
            serde_json::to_value(ProfileAdmissionRequest::ReopenSourceSnapshot {
                step: ProfileSourceReopenStep::Entry {
                    verification_cursor,
                    index: 0,
                    expected_entry: entries[0].clone(),
                },
            })
            .map_err(|_| "Cannot encode provisional Reopen Entry")?,
        )
        .await?;
        require(
            matches!(
                matched,
                ProfileAdmissionResponse::SourceSnapshotVerification {
                    result: ProfileSourceVerificationResult::Matched { next_index: 1, .. }
                }
            ) && has_open_source_handle(&store_path)?,
            "Matched Reopen Entry did not retain its provisional actual reader",
        )?;
        let (closed, binary) = invoke(
            &source,
            json!({
                "type": "closeSourceSnapshot",
                "selector": {"type": "currentCapability"}
            }),
        )
        .await?;
        require(
            closed == ProfileAdmissionResponse::SourceSnapshotClosed {} && binary.is_none(),
            "Provisional Reopen Close did not acknowledge",
        )?;
        require_source_handle_closed(&store_path).await?;
        require(
            std::fs::read(&store_path).map_err(|_| "Cannot verify provisional store")? == store,
            "Provisional Close changed source bytes",
        )?;
        drop(source);
        require_capability_released(directory.path()).await
    }
    .await;
    cleanup_entry(&identity, physical, result)
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain and /proc; isolated exact-test child only"]
async fn close_releases_provisional_reopen_readers() -> Result<(), String> {
    if isolated_child(PROVISIONAL_CLOSE_TEST)? {
        provisional_close_case().await
    } else {
        Ok(())
    }
}

async fn populated_admission_case() -> Result<(), String> {
    let (identity, physical) = unique_entry()?;
    let result = async {
        let entry =
            Entry::new(SERVICE, &identity).map_err(|_| "Cannot create populated source owner")?;
        let vault = Arc::new(KeychainVault::from_entry(
            entry,
            format!("desktop-keyring-test-v1:{identity}"),
        ));
        let (directory, source) = NativeProfileSource::isolated_fixture(vault.clone())
            .map_err(|_| "Cannot create populated source fixture")?;
        let account_id = bittery_crypto_core::generate_uuid();
        let user_id = bittery_crypto_core::generate_uuid();
        let email = format!("admission-{account_id}@example.test");
        let server_url = "https://admission.example.test";
        let secret_key = bittery_crypto_core::generate_secret_key();
        let device_key = std::array::from_fn::<_, 32, _>(|index| index as u8);
        let master_unlock_key = bittery_crypto_core::derive_keys(
            "actual legacy fixture password",
            &secret_key,
            &email,
            &bittery_crypto_core::current_kdf_profile(),
        )
        .map_err(|_| "Cannot derive actual source password material")?
        .master_unlock_key;
        let encoded_master_unlock =
            base64::engine::general_purpose::STANDARD.encode(master_unlock_key);
        let encrypted_master_unlock =
            bittery_crypto_core::encrypt(&encoded_master_unlock, &device_key)
                .map_err(|_| "Cannot wrap actual master unlock bytes")?;
        require(
            bittery_crypto_core::decrypt(&encrypted_master_unlock, &device_key)
                .map_err(|_| "Cannot unwrap actual source master key")?
                == encoded_master_unlock,
            "Actual source master key crypto did not round trip",
        )?;
        let added_at = 1_700_000_000_000_u64;
        let metadata = json!({
            "accountId": account_id,
            "email": email,
            "userId": user_id,
            "name": "Actual legacy admission",
            "serverUrl": server_url,
            "secretKeyHint": bittery_crypto_core::get_secret_key_hint(&secret_key),
            "addedAt": added_at,
            "lastActiveAt": added_at,
            "biometricEnabled": false,
            "insecureTransportConfirmed": false,
            "teamAvatarUrl": null
        });
        let store = serde_json::to_vec_pretty(&json!({
            "bittery_accounts_list": json!({"version":2,"accounts":[metadata]}).to_string(),
            "bittery_active_account": account_id,
            "bittery_master_password_reentry_period_ms": "-1",
            format!("bittery_account_{account_id}_auto_lock_timeout"): "0",
            format!("bittery_account_{account_id}_biometric_enabled"): "false",
            format!("bittery_account_{account_id}_server_url"): server_url,
            format!("bittery_account_{account_id}_pinned_kdf_params"): json!({
                "schemaVersion":1,"algorithm":"pbkdf2-sha256","iterations":600000
            }).to_string()
        }))
        .map_err(|_| "Cannot encode actual legacy store")?;
        let secret_ref = format!("bittery_account_{account_id}_secret_key");
        let session_ref = format!("bittery_account_{account_id}_session_data");
        let device_key_string = base64::engine::general_purpose::STANDARD.encode(device_key);
        let session_data = json!({
            "encryptedMasterUnlockKey": encrypted_master_unlock,
            "email": email,
            "userId": user_id,
            "createdAt": added_at,
            "expiresAt": 1_209_600_000_u64
        })
        .to_string();
        let original_protected = Zeroizing::new(
            json!({
                "bittery_device_key": device_key_string,
                (secret_ref.clone()): secret_key,
                (session_ref.clone()): session_data,
                "unrelated_actual_entry": "preserved"
            })
            .to_string(),
        );
        physical
            .set_password(&original_protected)
            .map_err(|_| "Cannot seed populated actual protected map")?;
        let store_path = directory.path().join("store.json");
        std::fs::write(&store_path, &store).map_err(|_| "Cannot seed populated store")?;
        let platform = Arc::new(
            NativePlatformStorage::with_test_vault(
                directory.path().join("platform.sqlite"),
                vault.clone(),
            )
            .map_err(|_| "Cannot create populated actual platform storage")?,
        );

        let runtime =
            admission_runtime(directory.path(), platform.clone(), Some(source.clone())).await?;
        runtime
            .open()
            .await
            .map_err(|error| format!("Actual populated admission failed: {}", error.message))?;
        require_locked(&runtime, &account_id)?;
        let catalog = platform_value(
            &platform,
            PlatformStorageArea::DevicePlain,
            "bittery:runtime:platform-storage:device-catalog".into(),
        )
        .await?
        .ok_or("Committed actual catalog is missing")?;
        let catalog: serde_json::Value =
            serde_json::from_str(&catalog).map_err(|_| "Committed actual catalog is malformed")?;
        require(
            catalog["profileAdmission"]["phase"] == "complete"
                && catalog["accounts"][0]["accountId"] == account_id
                && catalog["accounts"][0]["activeIncarnation"].is_string(),
            "Actual admission did not complete the Account catalog and source cleanup",
        )?;
        let incarnation = catalog["accounts"][0]["activeIncarnation"]
            .as_str()
            .ok_or("Committed actual incarnation is missing")?;
        let base = format!(
            "bittery:runtime:platform-storage:account:{}:{account_id}:incarnation:{}:{incarnation}",
            account_id.len(),
            incarnation.len()
        );
        let quick_unlock = vault
            .get_value(&format!("{base}:quick-unlock"))
            .map_err(|_| "Cannot read staged actual QuickUnlock")?
            .map(Zeroizing::new)
            .ok_or("Actual QuickUnlock was not staged")?;
        let quick_unlock: serde_json::Value =
            serde_json::from_str(&quick_unlock).map_err(|_| "Actual QuickUnlock is malformed")?;
        let staged_encrypted: bittery_crypto_core::EncryptedData =
            serde_json::from_value(quick_unlock["encryptedMasterUnlockKey"].clone())
                .map_err(|_| "Actual staged encrypted master key is malformed")?;
        require(
            bittery_crypto_core::decrypt(&staged_encrypted, &device_key)
                .map_err(|_| "Actual staged master key cannot decrypt")?
                == encoded_master_unlock
                && quick_unlock["secretKey"] == secret_key,
            "Actual QuickUnlock changed real cryptographic source material",
        )?;
        let session_evidence = vault
            .get_value(&format!("{base}:legacy-session-evidence"))
            .map_err(|_| "Cannot read staged actual legacy Session evidence")?
            .map(Zeroizing::new)
            .ok_or("Metadata-only legacy Session evidence was not staged")?;
        let session_evidence: serde_json::Value = serde_json::from_str(&session_evidence)
            .map_err(|_| "Actual legacy Session evidence is malformed")?;
        require(
            session_evidence["accountId"] == account_id
                && session_evidence["incarnation"] == incarnation
                && session_evidence["createdAtMs"] == added_at
                && session_evidence["expiresAt"] == 1_209_600_000_u64
                && session_evidence["token"].is_null()
                && session_evidence["vaultKeys"].is_null()
                && session_evidence["encryptedPrivateKey"].is_null(),
            "Actual admission did not retain metadata-only nonauthorizing Session evidence",
        )?;
        require(
            vault
                .get_value(&secret_ref)
                .map_err(|_| "Cannot verify cleaned legacy secret")?
                .is_none()
                && vault
                    .get_value(&session_ref)
                    .map_err(|_| "Cannot verify cleaned legacy session")?
                    .is_none()
                && vault
                    .get_value("bittery_device_key")
                    .map_err(|_| "Cannot verify cleaned legacy DeviceKey")?
                    .is_none()
                && vault
                    .get_value("unrelated_actual_entry")
                    .map_err(|_| "Cannot verify unrelated protected entry")?
                    .as_deref()
                    == Some("preserved")
                && !store_path
                    .try_exists()
                    .map_err(|_| "Cannot verify cleaned legacy store")?,
            "Completed admission did not clean exact legacy source while preserving unrelated data",
        )?;
        runtime.close().await;
        drop(runtime);

        let reopened = admission_runtime(directory.path(), platform.clone(), None).await?;
        reopened
            .open()
            .await
            .map_err(|_| "Committed actual Runtime did not reopen without a source")?;
        require_locked(&reopened, &account_id)?;
        let preserved_metadata = platform_value(
            &platform,
            PlatformStorageArea::DevicePlain,
            format!("{base}:metadata"),
        )
        .await?
        .ok_or("Reopened actual metadata is missing")?;
        let preserved_metadata: serde_json::Value = serde_json::from_str(&preserved_metadata)
            .map_err(|_| "Reopened actual metadata is malformed")?;
        let preserved_kdf: bittery_crypto_core::KdfProfile =
            serde_json::from_value(preserved_metadata["pinnedKdfProfile"].clone())
                .map_err(|_| "Reopened actual KDF is malformed")?;
        let derived = bittery_crypto_core::derive_keys(
            "actual legacy fixture password",
            quick_unlock["secretKey"]
                .as_str()
                .ok_or("Preserved Secret Key is missing")?,
            preserved_metadata["email"]
                .as_str()
                .ok_or("Preserved email is missing")?,
            &preserved_kdf,
        )
        .map_err(|_| "Preserved password Quick Unlock prerequisites cannot derive keys")?;
        require(
            base64::engine::general_purpose::STANDARD.encode(derived.master_unlock_key)
                == bittery_crypto_core::decrypt(&staged_encrypted, &device_key)
                    .map_err(|_| "Reopened wrapped master key cannot decrypt")?,
            "Preserved password Quick Unlock prerequisites derive a different master key",
        )?;
        reopened.close().await;
        drop(reopened);
        require(
            [
                "platform.sqlite",
                "replica.sqlite",
                "attachments.sqlite",
                "vault-images.sqlite",
            ]
            .into_iter()
            .all(|name| directory.path().join(name).is_file()),
            "Actual admission did not use every native SQLite destination",
        )?;
        require(
            !store_path
                .try_exists()
                .map_err(|_| "Cannot recheck cleaned legacy store")?,
            "Completed admission recreated its cleaned legacy store",
        )?;
        drop(platform);
        drop(source);
        drop(vault);
        require_capability_released(directory.path()).await
    }
    .await;
    cleanup_entry(&identity, physical, result)
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_populated_profile_commits_locked_with_real_crypto_and_storage() -> Result<(), String>
{
    if isolated_child(POPULATED_ADMISSION_TEST)? {
        populated_admission_case().await
    } else {
        Ok(())
    }
}

struct CrashAdmissionFixture {
    account_id: String,
    user_id: String,
    email: String,
    store: Vec<u8>,
    protected: std::collections::HashMap<String, Zeroizing<String>>,
}

struct WipeCrashFixture {
    store: Vec<u8>,
    sync_store: Vec<u8>,
    store_near_miss: Vec<u8>,
    sync_store_near_miss: Vec<u8>,
    host_file: Vec<u8>,
    protected: std::collections::HashMap<String, Zeroizing<String>>,
}

#[derive(Clone, Copy)]
enum WipeCrashSourceState {
    AllPresent,
    StoreAbsent,
    LegacyFilesAbsent,
    LegacyAndHostCleanupComplete,
    AllAbsent,
}

fn seed_wipe_crash_fixture(directory: &Path, physical: &Entry) -> Result<WipeCrashFixture, String> {
    let store = b"{ malformed legacy DevicePlain store remains untouched before Wipe\n".to_vec();
    let sync_store = b"unparsed legacy Sync bytes remain untouched before Wipe\n".to_vec();
    let store_near_miss = b"neighboring store source must survive Wipe\n".to_vec();
    let sync_store_near_miss = b"neighboring Sync source must survive Wipe\n".to_vec();
    let host_file = b"owned host file remains until Wipe resumes\n".to_vec();
    std::fs::write(directory.join("store.json"), &store)
        .map_err(|_| "Cannot seed Wipe crash legacy DevicePlain file")?;
    std::fs::write(directory.join("sync-store.json"), &sync_store)
        .map_err(|_| "Cannot seed Wipe crash legacy Sync file")?;
    std::fs::write(directory.join("store.json.near-miss"), &store_near_miss)
        .map_err(|_| "Cannot seed Wipe crash neighboring Store file")?;
    std::fs::write(
        directory.join("sync-store.json.near-miss"),
        &sync_store_near_miss,
    )
    .map_err(|_| "Cannot seed Wipe crash neighboring Sync file")?;
    let host_directory = directory.join("host-files");
    std::fs::create_dir(&host_directory)
        .map_err(|_| "Cannot create actual NativeFiles Wipe fixture")?;
    std::fs::write(host_directory.join("owned-fixture.bin"), &host_file)
        .map_err(|_| "Cannot seed actual NativeFiles Wipe fixture")?;

    let mut protected = std::collections::HashMap::new();
    protected.insert(
        "bittery_device_key".into(),
        Zeroizing::new("legacy-device".into()),
    );
    protected.insert(
        "bittery_account_orphan_session_data".into(),
        Zeroizing::new("legacy-session".into()),
    );
    protected.insert(
        "bittery_account_orphan_secret_key".into(),
        Zeroizing::new("legacy-secret-key".into()),
    );
    protected.insert(
        "bittery_account_orphan_jwt_token".into(),
        Zeroizing::new("legacy-token".into()),
    );
    protected.insert(
        "bittery_account_orphan_vault_keys".into(),
        Zeroizing::new("legacy-vault-keys".into()),
    );
    protected.insert(
        "bittery_account_orphan_encrypted_private_key".into(),
        Zeroizing::new("legacy-private-key".into()),
    );
    protected.insert(
        "bittery_account_orphan_secret_key_extra".into(),
        Zeroizing::new("near-miss".into()),
    );
    protected.insert("foreign".into(), Zeroizing::new("preserved".into()));
    let protected_json = Zeroizing::new(
        serde_json::to_string(&protected).map_err(|_| "Cannot encode Wipe crash credentials")?,
    );
    physical
        .set_password(protected_json.as_str())
        .map_err(|_| "Cannot seed Wipe crash protected credentials")?;

    Ok(WipeCrashFixture {
        store,
        sync_store,
        store_near_miss,
        sync_store_near_miss,
        host_file,
        protected,
    })
}

fn expected_wipe_crash_scope(
    directory: &Path,
    vault: &KeychainVault,
) -> Result<ProfileLegacyResetScope, String> {
    let (device, inode) = crash_file_identity(directory)?;
    let profile_identity = format!("desktop-v1:{device}:{inode}");
    let family_profile_identity = profile_identity.clone();
    let file_scope = move |family, name: &str| -> Result<ProfileResetFamilyScope, String> {
        let (device, inode) = crash_file_identity(&directory.join(name))?;
        Ok(ProfileResetFamilyScope {
            family,
            namespace_identity: format!("desktop-reset-file-v1:{family_profile_identity}:{name}"),
            selector_plan_version: 1,
            file: ProfileResetFileBinding::Present {
                file_identity: format!("linux-v1:{device}:{inode}"),
            },
        })
    };
    let scope = ProfileLegacyResetScope {
        version: 1,
        format: LegacyProfileFormat::DesktopLegacyV1,
        profile_identity,
        families: vec![
            file_scope(ProfileSourceFamily::DesktopStore, "store.json")?,
            file_scope(ProfileSourceFamily::DesktopSyncStore, "sync-store.json")?,
            ProfileResetFamilyScope {
                family: ProfileSourceFamily::DesktopCredentials,
                namespace_identity: vault.namespace_identity().to_owned(),
                selector_plan_version: 1,
                file: ProfileResetFileBinding::NotFile {},
            },
        ],
    };
    scope
        .validate()
        .map_err(|_| "Expected Wipe reset scope is invalid")?;
    Ok(scope)
}

fn require_wipe_crash_path_absent(path: &Path, message: &'static str) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Err(message.into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(message.into()),
    }
}

fn require_wipe_crash_source_state(
    directory: &Path,
    fixture: &WipeCrashFixture,
    expected: WipeCrashSourceState,
) -> Result<(), String> {
    let store_path = directory.join("store.json");
    let sync_store_path = directory.join("sync-store.json");
    let host_path = directory.join("host-files").join("owned-fixture.bin");
    require(
        std::fs::read(directory.join("store.json.near-miss"))
            .map_err(|_| "Cannot read retained Wipe neighboring Store file")?
            == fixture.store_near_miss
            && std::fs::read(directory.join("sync-store.json.near-miss"))
                .map_err(|_| "Cannot read retained Wipe neighboring Sync file")?
                == fixture.sync_store_near_miss,
        "Wipe removed or changed a neighboring legacy source file",
    )?;
    match expected {
        WipeCrashSourceState::AllPresent => {
            require(
                std::fs::read(&store_path).map_err(|_| "Cannot read Wipe crash store")?
                    == fixture.store
                    && std::fs::read(&sync_store_path)
                        .map_err(|_| "Cannot read Wipe crash Sync store")?
                        == fixture.sync_store,
                "Wipe changed a captured legacy source before a destructive step",
            )?;
            require(
                std::fs::read(&host_path).map_err(|_| "Cannot read Wipe host fixture")?
                    == fixture.host_file,
                "Wipe changed the owned NativeFiles fixture before host cleanup",
            )
        }
        WipeCrashSourceState::StoreAbsent => {
            require_wipe_crash_path_absent(
                &store_path,
                "Wipe Store cut left a filesystem entry at the removed Store path",
            )?;
            require(
                std::fs::read(&sync_store_path)
                    .map_err(|_| "Cannot read retained Wipe crash Sync store")?
                    == fixture.sync_store
                    && std::fs::read(&host_path)
                        .map_err(|_| "Cannot read retained Wipe host fixture")?
                        == fixture.host_file,
                "Wipe Store cut changed another legacy source or the owned host file",
            )
        }
        WipeCrashSourceState::LegacyFilesAbsent => {
            require_wipe_crash_path_absent(
                &store_path,
                "Wipe family cut left a filesystem entry at the removed Store path",
            )?;
            require_wipe_crash_path_absent(
                &sync_store_path,
                "Wipe family cut left a filesystem entry at the removed Sync Store path",
            )?;
            require(
                std::fs::read(&host_path).map_err(|_| "Cannot read retained Wipe host fixture")?
                    == fixture.host_file,
                "Wipe legacy-family cut changed the owned host file before Runtime cleanup",
            )
        }
        WipeCrashSourceState::LegacyAndHostCleanupComplete => {
            require_wipe_crash_path_absent(
                &store_path,
                "Wipe Runtime cut retained the removed Store path",
            )?;
            require_wipe_crash_path_absent(
                &sync_store_path,
                "Wipe Runtime cut retained the removed Sync Store path",
            )?;
            require_wipe_crash_path_absent(
                &host_path,
                "Wipe Runtime cut retained the seeded NativeFiles file",
            )?;
            require_wipe_crash_path_absent(
                &directory.join("host-files"),
                "Wipe Runtime cut retained the NativeFiles owner directory",
            )
        }
        WipeCrashSourceState::AllAbsent => {
            require_wipe_crash_path_absent(
                &store_path,
                "Resumed Wipe retained a filesystem entry at the Store path",
            )?;
            require_wipe_crash_path_absent(
                &sync_store_path,
                "Resumed Wipe retained a filesystem entry at the Sync Store path",
            )?;
            require_wipe_crash_path_absent(
                &directory.join("host-files"),
                "Resumed Wipe retained a filesystem entry at the NativeFiles directory",
            )
        }
    }
}

#[test]
fn wipe_store_absence_check_rejects_dangling_symlink() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().expect("create small Wipe absence fixture");
    let store_path = directory.path().join("store.json");
    let sync_store = b"retained Sync fixture".to_vec();
    let host_file = b"retained host fixture".to_vec();
    let store_near_miss = b"retained neighboring Store fixture".to_vec();
    let sync_store_near_miss = b"retained neighboring Sync fixture".to_vec();
    let host_path = directory.path().join("host-files");
    std::fs::create_dir(&host_path).expect("create retained host directory");
    std::fs::write(directory.path().join("sync-store.json"), &sync_store)
        .expect("write retained Sync fixture");
    std::fs::write(
        directory.path().join("store.json.near-miss"),
        &store_near_miss,
    )
    .expect("write neighboring Store fixture");
    std::fs::write(
        directory.path().join("sync-store.json.near-miss"),
        &sync_store_near_miss,
    )
    .expect("write neighboring Sync fixture");
    std::fs::write(host_path.join("owned-fixture.bin"), &host_file)
        .expect("write retained host fixture");
    symlink("missing-store-target", &store_path).expect("create dangling Store symlink");

    let fixture = WipeCrashFixture {
        store: Vec::new(),
        sync_store,
        store_near_miss,
        sync_store_near_miss,
        host_file,
        protected: std::collections::HashMap::new(),
    };
    assert!(require_wipe_crash_source_state(
        directory.path(),
        &fixture,
        WipeCrashSourceState::StoreAbsent,
    )
    .is_err());

    std::fs::remove_file(&store_path).expect("remove dangling Store symlink");
    require_wipe_crash_source_state(
        directory.path(),
        &fixture,
        WipeCrashSourceState::StoreAbsent,
    )
    .expect("accept a Store path with no filesystem entry");
}

fn require_wipe_crash_keychain_state(
    physical: &Entry,
    fixture: &WipeCrashFixture,
    legacy_credentials_removed: bool,
    runtime_secret_present: bool,
) -> Result<(), String> {
    let actual = read_crash_fixture_keychain(physical)?;
    require(
        fixture
            .protected
            .get("bittery_account_orphan_secret_key")
            .is_some_and(|value| value.as_str() == "legacy-secret-key"),
        "Wipe crash fixture did not seed the exact orphan SecretKey selector",
    )?;
    let removed_legacy = [
        "bittery_device_key",
        "bittery_account_orphan_session_data",
        "bittery_account_orphan_secret_key",
        "bittery_account_orphan_jwt_token",
        "bittery_account_orphan_vault_keys",
        "bittery_account_orphan_encrypted_private_key",
    ];
    for (key, value) in &fixture.protected {
        let should_remain = !legacy_credentials_removed
            || key == "bittery_account_orphan_secret_key_extra"
            || key == "foreign"
            || !removed_legacy.contains(&key.as_str());
        if should_remain {
            require(
                actual.get(key).map(|actual| actual.as_str()) == Some(value.as_str()),
                "Wipe changed a retained protected or foreign value",
            )?;
        } else {
            require(
                !actual.contains_key(key),
                "Resumed Wipe retained an owned legacy credential",
            )?;
        }
    }
    require(
        actual.get(CRASH_DEVICE_KEY).map(|value| value.as_str())
            == runtime_secret_present.then_some("owned-runtime-device-secret"),
        "Wipe changed the owned Runtime DeviceSecret at the wrong boundary",
    )?;
    require(
        actual
            .get(WIPE_CRASH_FOREIGN_PLATFORM_KEY)
            .map(|value| value.as_str())
            == Some("foreign-runtime-secret"),
        "Wipe removed the unrelated DeviceSecret value",
    )?;
    let actual_keys: std::collections::BTreeSet<_> = actual.keys().map(String::as_str).collect();
    let mut expected_keys: std::collections::BTreeSet<_> =
        fixture.protected.keys().map(String::as_str).collect();
    if legacy_credentials_removed {
        expected_keys.retain(|key| !removed_legacy.contains(key));
    }
    if runtime_secret_present {
        expected_keys.insert(CRASH_DEVICE_KEY);
    }
    expected_keys.insert(WIPE_CRASH_FOREIGN_PLATFORM_KEY);
    expected_keys.insert(WIPE_CRASH_NEAR_MISS_PLATFORM_KEY);
    require(
        actual_keys == expected_keys,
        "Wipe changed the exact protected credential key set outside its scope",
    )?;
    require(
        actual
            .get(WIPE_CRASH_NEAR_MISS_PLATFORM_KEY)
            .is_some_and(|value| value.as_str() == "near-miss-runtime-secret"),
        "Wipe changed the neighboring protected Runtime namespace value",
    )
}

fn seed_crash_admission_fixture(
    directory: &Path,
    physical: &Entry,
) -> Result<CrashAdmissionFixture, String> {
    let account_id = bittery_crypto_core::generate_uuid();
    let user_id = bittery_crypto_core::generate_uuid();
    let email = format!("crash-{account_id}@example.test");
    let server_url = "https://crash-admission.example.test";
    let secret_key = Zeroizing::new(bittery_crypto_core::generate_secret_key());
    let device_key = std::array::from_fn::<_, 32, _>(|index| 0x40 | index as u8);
    let master_unlock_key = bittery_crypto_core::derive_keys(
        "actual crash fixture password",
        &secret_key,
        &email,
        &bittery_crypto_core::current_kdf_profile(),
    )
    .map_err(|_| "Cannot derive crash fixture password material")?
    .master_unlock_key;
    let encoded_master_unlock = base64::engine::general_purpose::STANDARD.encode(master_unlock_key);
    let encrypted_master_unlock = bittery_crypto_core::encrypt(&encoded_master_unlock, &device_key)
        .map_err(|_| "Cannot wrap crash fixture master key")?;
    let added_at = 1_700_000_000_000_u64;
    let metadata = json!({
        "accountId": account_id,
        "email": email,
        "userId": user_id,
        "name": "Physical crash admission",
        "serverUrl": server_url,
        "secretKeyHint": bittery_crypto_core::get_secret_key_hint(&secret_key),
        "addedAt": added_at,
        "lastActiveAt": added_at,
        "biometricEnabled": false,
        "insecureTransportConfirmed": false,
        "teamAvatarUrl": null
    });
    let store = serde_json::to_vec_pretty(&json!({
        "bittery_accounts_list": json!({"version":2,"accounts":[metadata]}).to_string(),
        "bittery_active_account": account_id,
        "bittery_master_password_reentry_period_ms": "-1",
        format!("bittery_account_{account_id}_auto_lock_timeout"): "0",
        format!("bittery_account_{account_id}_biometric_enabled"): "false",
        format!("bittery_account_{account_id}_server_url"): server_url,
        format!("bittery_account_{account_id}_pinned_kdf_params"): json!({
            "schemaVersion":1,"algorithm":"pbkdf2-sha256","iterations":600000
        }).to_string()
    }))
    .map_err(|_| "Cannot encode crash fixture store")?;
    let secret_ref = format!("bittery_account_{account_id}_secret_key");
    let session_ref = format!("bittery_account_{account_id}_session_data");
    let device_key_string = base64::engine::general_purpose::STANDARD.encode(device_key);
    let session_data = Zeroizing::new(
        json!({
            "encryptedMasterUnlockKey": encrypted_master_unlock,
            "email": email,
            "userId": user_id,
            "createdAt": added_at,
            "expiresAt": 1_209_600_000_u64
        })
        .to_string(),
    );
    let mut protected = std::collections::HashMap::new();
    protected.insert(
        "bittery_device_key".into(),
        Zeroizing::new(device_key_string),
    );
    protected.insert(secret_ref, secret_key);
    protected.insert(session_ref, Zeroizing::new(session_data.to_string()));
    protected.insert(
        "unrelated_crash_fixture_entry".into(),
        Zeroizing::new("preserved".into()),
    );
    let protected_json = Zeroizing::new(
        serde_json::to_string(&protected).map_err(|_| "Cannot encode crash fixture keychain")?,
    );
    physical
        .set_password(protected_json.as_str())
        .map_err(|_| "Cannot seed crash fixture keychain")?;
    std::fs::write(directory.join("store.json"), &store)
        .map_err(|_| "Cannot seed crash fixture store file")?;

    Ok(CrashAdmissionFixture {
        account_id,
        user_id,
        email,
        store,
        protected,
    })
}

fn read_crash_fixture_keychain(
    physical: &Entry,
) -> Result<std::collections::HashMap<String, Zeroizing<String>>, String> {
    let raw = Zeroizing::new(
        physical
            .get_password()
            .map_err(|_| "Cannot read crash fixture keychain")?,
    );
    serde_json::from_str(raw.as_str())
        .map_err(|_| "Crash fixture keychain map is malformed".to_owned())
}

fn crash_account_document_key(account_id: &str, incarnation: &str, document: &str) -> String {
    format!(
        "{CRASH_PLATFORM_PREFIX}account:{}:{account_id}:incarnation:{}:{incarnation}:{document}",
        account_id.len(),
        incarnation.len()
    )
}

fn crash_device_plain_document_key(account_id: &str, incarnation: &str, document: &str) -> String {
    match document {
        "local-security" => CRASH_LOCAL_SECURITY_KEY.to_owned(),
        "metadata" => crash_account_document_key(account_id, incarnation, "metadata"),
        "account-local-security" => crash_account_scoped_document_key(account_id, "local-security"),
        _ => unreachable!("Crash cut spec lists a known DevicePlain document"),
    }
}

fn read_crash_device_plain_records(
    directory: &Path,
) -> Result<std::collections::BTreeMap<String, Zeroizing<String>>, String> {
    let connection = rusqlite::Connection::open(directory.join("platform.sqlite"))
        .map_err(|_| "Cannot open crash fixture DevicePlain database")?;
    let mut statement = connection
        .prepare(
            "SELECT key, value FROM platform_records WHERE substr(CAST(key AS BLOB), 1, length(CAST(?1 AS BLOB))) = CAST(?1 AS BLOB)",
        )
        .map_err(|_| "Cannot query crash fixture DevicePlain records")?;
    let rows = statement
        .query_map([CRASH_PLATFORM_PREFIX], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| "Cannot read crash fixture DevicePlain records")?;
    let mut records = std::collections::BTreeMap::new();
    for row in rows {
        let (key, value) = row.map_err(|_| "Cannot read a crash fixture DevicePlain record")?;
        records.insert(key, Zeroizing::new(value));
    }
    Ok(records)
}

fn read_crash_device_plain_value(
    directory: &Path,
    key: &str,
) -> Result<Option<Zeroizing<String>>, String> {
    use rusqlite::OptionalExtension;

    let connection = rusqlite::Connection::open(directory.join("platform.sqlite"))
        .map_err(|_| "Cannot open crash fixture DevicePlain database")?;
    let value = connection
        .query_row(
            "SELECT value FROM platform_records WHERE key = ?1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| "Cannot read crash fixture DevicePlain value")?;
    Ok(value.map(Zeroizing::new))
}

fn require_wipe_crash_device_plain_state(
    directory: &Path,
    journal: &str,
    runtime_plain_present: bool,
) -> Result<(), String> {
    let records = read_crash_device_plain_records(directory)?;
    let expected_count = if runtime_plain_present { 2 } else { 1 };
    require(
        records.len() == expected_count
            && records
                .get(CRASH_DEVICE_CATALOG_KEY)
                .is_some_and(|value| value.as_str() == journal)
            && records
                .get(WIPE_CRASH_RUNTIME_PLAIN_KEY)
                .map(|value| value.as_str())
                == runtime_plain_present.then_some("owned-runtime-plain"),
        "Wipe changed the direct SQLite Runtime namespace state",
    )?;
    require(
        read_crash_device_plain_value(directory, "foreign:runtime-plain-fixture")?
            .as_ref()
            .map(|value| value.as_str())
            == Some("foreign-runtime-plain")
            && read_crash_device_plain_value(directory, WIPE_CRASH_NEAR_MISS_PLATFORM_KEY)?
                .as_ref()
                .map(|value| value.as_str())
                == Some("near-miss-runtime-plain"),
        "Wipe changed a direct SQLite foreign or neighboring namespace value",
    )
}

fn require_crash_device_plain_documents(
    records: &std::collections::BTreeMap<String, Zeroizing<String>>,
    cut: CrashWriteCut,
    fixture: &CrashAdmissionFixture,
    incarnation: &str,
    journal: &str,
) -> Result<(), String> {
    let mut expected = std::collections::BTreeSet::from([CRASH_DEVICE_CATALOG_KEY.to_owned()]);
    for document in cut.completed_plain_documents() {
        expected.insert(crash_device_plain_document_key(
            &fixture.account_id,
            incarnation,
            document,
        ));
    }
    let actual: std::collections::BTreeSet<String> = records.keys().cloned().collect();
    require(
        actual == expected,
        "Physical crash cut has an unexpected Core DevicePlain document set",
    )?;
    require(
        records
            .get(CRASH_DEVICE_CATALOG_KEY)
            .is_some_and(|value| value.as_str() == journal),
        "Physical crash cut changed the exact durable admission journal bytes",
    )?;

    if cut.completed_plain_documents().contains(&"local-security") {
        let raw = records
            .get(CRASH_LOCAL_SECURITY_KEY)
            .ok_or("Physical crash cut lost global local-security settings")?;
        let document: serde_json::Value = serde_json::from_str(raw.as_str())
            .map_err(|_| "Physical crash local-security document is malformed")?;
        require(
            document["version"] == 1 && document["masterPasswordReentryPeriodMs"] == -1,
            "Physical crash local-security settings do not match the legacy fixture",
        )?;
    }

    if cut.completed_plain_documents().contains(&"metadata") {
        let key = crash_device_plain_document_key(&fixture.account_id, incarnation, "metadata");
        let raw = records
            .get(&key)
            .ok_or("Physical crash cut lost its Account metadata document")?;
        let document: serde_json::Value = serde_json::from_str(raw.as_str())
            .map_err(|_| "Physical crash Account metadata document is malformed")?;
        require(
            document["accountId"] == fixture.account_id
                && document["incarnation"] == incarnation
                && document["email"] == fixture.email
                && document["userId"] == fixture.user_id
                && document["name"] == "Physical crash admission",
            "Physical crash Account metadata lost its source identity or profile fields",
        )?;
    }

    if cut
        .completed_plain_documents()
        .contains(&"account-local-security")
    {
        let key = crash_device_plain_document_key(
            &fixture.account_id,
            incarnation,
            "account-local-security",
        );
        let raw = records
            .get(&key)
            .ok_or("Physical crash cut lost Account local-security settings")?;
        let document: serde_json::Value = serde_json::from_str(raw.as_str())
            .map_err(|_| "Physical crash Account local-security document is malformed")?;
        require(
            document["version"] == 1 && document["inactivityTimeoutMs"] == 0,
            "Physical crash Account local-security settings do not match the legacy fixture",
        )?;
    }
    Ok(())
}

fn require_same_crash_device_plain_records(
    before: &std::collections::BTreeMap<String, Zeroizing<String>>,
    after: &std::collections::BTreeMap<String, Zeroizing<String>>,
) -> Result<(), String> {
    require(
        before.len() == after.len()
            && before.iter().all(|(key, value)| {
                after
                    .get(key)
                    .is_some_and(|actual| actual.as_str() == value.as_str())
            }),
        "Abrupt process exit changed the exact DevicePlain records written before the cut",
    )
}

fn require_same_crash_platform_secrets(
    before: &std::collections::HashMap<String, Zeroizing<String>>,
    after: &std::collections::HashMap<String, Zeroizing<String>>,
) -> Result<(), String> {
    let before_core: std::collections::BTreeSet<String> = before
        .keys()
        .filter(|key| key.starts_with(CRASH_PLATFORM_PREFIX))
        .cloned()
        .collect();
    let after_core: std::collections::BTreeSet<String> = after
        .keys()
        .filter(|key| key.starts_with(CRASH_PLATFORM_PREFIX))
        .cloned()
        .collect();
    require(
        before_core == after_core
            && before_core.iter().all(|key| {
                before
                    .get(key)
                    .zip(after.get(key))
                    .is_some_and(|(expected, actual)| actual.as_str() == expected.as_str())
            }),
        "Abrupt process exit changed the exact DeviceSecret documents written before the cut",
    )
}

fn require_crash_platform_secrets(
    keychain: &std::collections::HashMap<String, Zeroizing<String>>,
    cut: CrashWriteCut,
    account_id: &str,
    incarnation: &str,
) -> Result<(), String> {
    let mut expected = std::collections::BTreeSet::from([CRASH_DEVICE_KEY.to_owned()]);
    for document in cut.completed_secret_documents() {
        expected.insert(crash_account_document_key(
            account_id,
            incarnation,
            document,
        ));
    }
    let actual: std::collections::BTreeSet<String> = keychain
        .keys()
        .filter(|key| key.starts_with(CRASH_PLATFORM_PREFIX))
        .cloned()
        .collect();
    require(
        actual == expected,
        "Physical crash cut has an unexpected Core DeviceSecret document set",
    )?;
    require(
        keychain
            .get(CRASH_DEVICE_KEY)
            .is_some_and(|value| !value.is_empty()),
        "Physical crash cut lost its committed DeviceKey",
    )?;

    if cut.completed_secret_documents().contains(&"quick-unlock") {
        let key = crash_account_document_key(account_id, incarnation, "quick-unlock");
        let raw = keychain
            .get(&key)
            .ok_or("Physical crash cut lost its QuickUnlock document")?;
        let document: serde_json::Value = serde_json::from_str(raw.as_str())
            .map_err(|_| "Physical crash QuickUnlock document is malformed")?;
        require(
            document["accountId"] == account_id
                && document["incarnation"] == incarnation
                && document["encryptedMasterUnlockKey"].is_object()
                && document["secretKey"]
                    .as_str()
                    .is_some_and(|value| !value.is_empty())
                && document["biometricEnabled"] == false,
            "Physical crash QuickUnlock document lost its account binding or wrapped credentials",
        )?;
    }

    if cut
        .completed_secret_documents()
        .contains(&"legacy-session-evidence")
    {
        let key = crash_account_document_key(account_id, incarnation, "legacy-session-evidence");
        let raw = keychain
            .get(&key)
            .ok_or("Physical crash cut lost its legacy Session evidence document")?;
        let document: serde_json::Value = serde_json::from_str(raw.as_str())
            .map_err(|_| "Physical crash legacy Session evidence is malformed")?;
        require(
            document["accountId"] == account_id
                && document["incarnation"] == incarnation
                && document["token"].is_null()
                && document["vaultKeys"].is_null()
                && document["encryptedPrivateKey"].is_null(),
            "Physical crash legacy Session evidence is not the expected metadata-only fixture",
        )?;
    }
    Ok(())
}

fn crash_file_identity(path: &Path) -> Result<(u64, u64), String> {
    use std::os::unix::fs::MetadataExt;

    let metadata = std::fs::metadata(path).map_err(|_| "Cannot inspect crash fixture identity")?;
    Ok((metadata.dev(), metadata.ino()))
}

fn require_no_replica_head(directory: &Path, account_id: &str) -> Result<(), String> {
    let connection = rusqlite::Connection::open(directory.join("replica.sqlite"))
        .map_err(|_| "Cannot inspect crash fixture Replica")?;
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM replica_heads WHERE account_id = ?1",
            [account_id],
            |row| row.get(0),
        )
        .map_err(|_| "Cannot inspect crash fixture Replica head")?;
    require(
        count == 0,
        "Crash cut partially published an Account Replica",
    )
}

struct CrashReplicaEvidence {
    heads: Vec<(String, String, String, String, String, Option<String>)>,
    rows: Vec<(String, i64, String, Zeroizing<String>)>,
}

fn read_crash_replica_evidence(directory: &Path) -> Result<CrashReplicaEvidence, String> {
    let connection = rusqlite::Connection::open(directory.join("replica.sqlite"))
        .map_err(|_| "Cannot inspect crash fixture Replica")?;
    let mut heads_statement = connection
        .prepare(
            "SELECT account_id, user_id, incarnation, replica_revision, lock_epoch, failure_json \
             FROM replica_heads ORDER BY account_id",
        )
        .map_err(|_| "Cannot query physical crash Replica heads")?;
    let heads = heads_statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })
        .map_err(|_| "Cannot read physical crash Replica heads")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Cannot decode physical crash Replica head")?;

    let mut rows_statement = connection
        .prepare(
            "SELECT account_id, store, record_id, payload_json \
             FROM replica_rows ORDER BY account_id, store, record_id",
        )
        .map_err(|_| "Cannot query physical crash Replica rows")?;
    let rows = rows_statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                Zeroizing::new(row.get(3)?),
            ))
        })
        .map_err(|_| "Cannot read physical crash Replica rows")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Cannot decode physical crash Replica row")?;
    Ok(CrashReplicaEvidence { heads, rows })
}

fn require_crash_replica_install(
    evidence: &CrashReplicaEvidence,
    fixture: &CrashAdmissionFixture,
    incarnation: &str,
) -> Result<(), String> {
    require(
        evidence.heads
            == [(
                fixture.account_id.clone(),
                fixture.user_id.clone(),
                incarnation.to_owned(),
                "0".into(),
                "0".into(),
                None,
            )],
        "Committed physical crash Replica does not have the reserved locked revision-0 head",
    )?;
    require(
        evidence.rows.is_empty(),
        "Physical crash fixture unexpectedly contains imported Replica rows",
    )
}

fn require_same_crash_replica_evidence(
    before: &CrashReplicaEvidence,
    after: &CrashReplicaEvidence,
) -> Result<(), String> {
    require(
        before.heads == after.heads
            && before.rows.len() == after.rows.len()
            && before.rows.iter().zip(&after.rows).all(
                |(
                    (account, store, record, payload),
                    (after_account, after_store, after_record, after_payload),
                )| {
                    account == after_account
                        && store == after_store
                        && record == after_record
                        && payload.as_str() == after_payload.as_str()
                },
            ),
        "Abrupt process exit changed the exact logical Replica head or row bytes",
    )
}

struct PhysicalCrashChild(Option<std::process::Child>);

impl PhysicalCrashChild {
    fn kill_and_wait(&mut self) -> Result<std::process::ExitStatus, String> {
        let child = self
            .0
            .as_mut()
            .ok_or("Physical crash child was already reaped")?;
        child
            .kill()
            .map_err(|_| "Cannot kill exact held physical crash child")?;
        let status = child
            .wait()
            .map_err(|_| "Cannot reap exact held physical crash child")?;
        self.0 = None;
        Ok(status)
    }
}

impl Drop for PhysicalCrashChild {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

struct PhysicalCrashEntry {
    identity: String,
    physical: Entry,
    cleaned: bool,
}

impl PhysicalCrashEntry {
    fn finish(mut self, result: Result<(), String>) -> Result<(), String> {
        let _ = self.physical.delete_credential();
        let cleanup = match self.physical.get_password() {
            Err(keyring::Error::NoEntry) => {
                self.cleaned = true;
                Ok(())
            }
            Ok(value) => {
                drop(Zeroizing::new(value));
                Err(format!(
                    "Physical crash fixture credential cleanup failed for {}",
                    self.identity
                ))
            }
            Err(_) => Err(format!(
                "Physical crash fixture cleanup unproved for {}",
                self.identity
            )),
        };
        match (result, cleanup) {
            (Err(error), Err(cleanup)) => Err(format!("{error}; also {cleanup}")),
            (Err(error), Ok(())) => Err(error),
            (Ok(()), Err(error)) => Err(error),
            (Ok(()), Ok(())) => Ok(()),
        }
    }
}

impl Drop for PhysicalCrashEntry {
    fn drop(&mut self) {
        if !self.cleaned {
            let _ = self.physical.delete_credential();
        }
    }
}

fn wait_for_physical_crash_marker(
    child: &mut PhysicalCrashChild,
    marker: &Path,
) -> Result<(), String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        if marker
            .try_exists()
            .map_err(|_| "Cannot inspect physical crash write marker")?
        {
            return Ok(());
        }
        if child
            .0
            .as_mut()
            .ok_or("Physical crash child was already reaped")?
            .try_wait()
            .map_err(|_| "Cannot inspect physical crash child")?
            .is_some()
        {
            return Err("Physical crash child exited before the selected OS write".into());
        }
        if std::time::Instant::now() >= deadline {
            return Err("Physical crash child missed its bounded write marker".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

async fn physical_wipe_crash_child_case(
    directory: PathBuf,
    identity: String,
    marker: PathBuf,
    cut: CrashWriteCut,
) -> Result<(), String> {
    require(cut.is_wipe(), "Wipe child received a non-Wipe cut")?;
    let entry = Entry::new(SERVICE, &identity).map_err(|_| "Cannot select Wipe child keychain")?;
    let vault = Arc::new(crate::keychain::KeychainVault::from_entry(
        entry,
        format!("desktop-keyring-test-v1:{identity}"),
    ));
    let source = NativeProfileSource::isolated_existing_fixture(&directory, vault.clone())
        .map_err(|_| "Cannot create Wipe child native source capability")?;
    let platform = Arc::new(
        NativePlatformStorage::with_test_vault(directory.join("platform.sqlite"), vault.clone())
            .map_err(|_| "Cannot create Wipe child native platform storage")?,
    );
    let expected_wipe_scope = if cut.tracks_initial_wipe_identity() {
        Some(expected_wipe_crash_scope(&directory, &vault)?)
    } else {
        None
    };
    let runtime = if cut == CrashWriteCut::WipePopulatedReplicaDeletion {
        let replica: Arc<dyn SerializedReplicaExecutor> = Arc::new(HoldAfterPopulatedReplicaWipe {
            inner: Arc::new(
                SqliteReplica::open(directory.join("replica.sqlite"))
                    .map_err(|_| "Cannot open populated Wipe Replica")?,
            ),
            marker,
        });
        admission_runtime_with_replica_executor(
            &directory,
            replica,
            platform,
            Some(source),
            Arc::new(AdmissionNoNetwork),
        )
        .await?
    } else if cut.is_source_reset() {
        let source_executor: Arc<dyn SerializedProfileAdmissionExecutor> =
            Arc::new(ObserveWipeReset {
                inner: source,
                cut: Some(cut),
                marker: Some(marker),
                replay_absence: None,
                replay_absence_observed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                retry_scope: None,
                retry_wipe_id: None,
                retry_reset_handle: Arc::new(std::sync::Mutex::new(None)),
                retry_families_observed: Arc::new(std::sync::Mutex::new(Vec::new())),
            });
        admission_runtime_with_source_executor(&directory, platform, source_executor).await?
    } else {
        let executor: Arc<dyn SerializedPlatformStorageExecutor> =
            Arc::new(HoldAfterSelectedPlatformWrite {
                inner: platform,
                marker,
                cut,
                account_id: String::new(),
                expected_wipe_scope,
                initial_wipe_id: std::sync::Mutex::new(None),
            });
        admission_runtime_with_executor(
            &directory,
            executor,
            Some(source),
            Arc::new(AdmissionNoNetwork),
        )
        .await?
    };
    runtime.install_teardown_host_cleanup(Arc::new(
        NativeFiles::open(directory.join("host-files"))
            .map_err(|_| "Cannot install actual NativeFiles Wipe owner")?,
    ));
    let _ = runtime
        .request(RuntimeRequest::Wipe, RequestCancellation::new())
        .await
        .map_err(|_| "Child Runtime Wipe failed before the selected Reset write")?;
    Err("Child Runtime returned before the selected Wiping write acknowledgement".into())
}

fn require_wipe_crash_catalog(
    value: &str,
    expected_scope: &ProfileLegacyResetScope,
    expected_wipe_id: Option<&str>,
    expected_phase: bittery_client_core::ProfileAdmissionResetPhase,
    expected_revision: u64,
    expected_remaining: &[ProfileSourceFamily],
) -> Result<String, String> {
    let catalog: serde_json::Value =
        serde_json::from_str(value).map_err(|_| "Wipe crash catalog is malformed")?;
    let view = wipe_reset_catalog_view(&catalog).ok_or("Wipe reset record is invalid")?;
    let original_store = expected_scope
        .families
        .iter()
        .find(|family| family.family == ProfileSourceFamily::DesktopStore)
        .ok_or("Pre-cut Wipe scope has no DesktopStore descriptor")?;
    require(
        matches!(original_store.file, ProfileResetFileBinding::Present { .. })
            && view.phase == expected_phase
            && view.revision == expected_revision
            && &view.scope == expected_scope
            && view.remaining.as_slice() == expected_remaining,
        "Wipe catalog changed its exact phase, revision, durable scope, or receipts",
    )?;
    require(
        expected_wipe_id.is_none_or(|expected| expected == view.wipe_id),
        "Resumed Wipe changed the original wipe identity",
    )?;
    Ok(view.wipe_id)
}

fn require_wipe_source_reset_marker(contents: &[u8], cut: CrashWriteCut) -> Result<String, String> {
    let contents =
        std::str::from_utf8(contents).map_err(|_| "Wipe source marker is not valid UTF-8")?;
    let details = contents
        .strip_prefix(
            std::str::from_utf8(cut.marker_contents())
                .map_err(|_| "Wipe source cut marker prefix is not valid UTF-8")?,
        )
        .ok_or("Wipe source marker has the wrong successful-reset prefix")?;
    let mut lines = details.lines();
    let _reset_handle = lines
        .next()
        .and_then(|line| line.strip_prefix("resetHandle="))
        .filter(|value| !value.is_empty())
        .ok_or("Wipe source marker has no exact reset handle")?;
    let wipe_id = lines
        .next()
        .and_then(|line| line.strip_prefix("wipeId="))
        .filter(|value| !value.is_empty())
        .ok_or("Wipe source marker has no exact wipe ID")?;
    let family = match cut.spec().target {
        CrashCutTarget::SourceReset(CrashSourceResetSelector::Store) => "desktopStore",
        CrashCutTarget::SourceReset(CrashSourceResetSelector::SyncStore) => "desktopSyncStore",
        CrashCutTarget::SourceReset(CrashSourceResetSelector::Credentials) => "desktopCredentials",
        _ => return Err("Wipe source marker belongs to a non-family cut".into()),
    };
    require(
        lines.next() == Some(format!("family={family}").as_str())
            && lines.next() == Some("result=reset")
            && lines.next().is_none(),
        "Wipe source marker changed its exact handle, closed family or result",
    )?;
    Ok(wipe_id.to_owned())
}

fn require_wipe_catalog_marker(contents: &[u8], cut: CrashWriteCut) -> Result<String, String> {
    let contents =
        std::str::from_utf8(contents).map_err(|_| "Wipe terminal marker is not valid UTF-8")?;
    let details = contents
        .strip_prefix(
            std::str::from_utf8(cut.marker_contents())
                .map_err(|_| "Wipe terminal marker prefix is not valid UTF-8")?,
        )
        .ok_or("Wipe terminal marker has the wrong Wiped catalog prefix")?;
    let mut lines = details.lines();
    let wipe_id = lines
        .next()
        .and_then(|line| line.strip_prefix("wipeId="))
        .filter(|value| !value.is_empty())
        .ok_or("Wipe catalog marker has no original wipe ID")?;
    require(
        lines.next().is_none(),
        "Wipe catalog marker contains unexpected fields",
    )?;
    Ok(wipe_id.to_owned())
}

async fn require_wipe_crash_platform_values(
    platform: &NativePlatformStorage,
    runtime_plain_present: bool,
    runtime_secret_present: bool,
) -> Result<(), String> {
    let runtime_plain = platform_value(
        platform,
        PlatformStorageArea::DevicePlain,
        WIPE_CRASH_RUNTIME_PLAIN_KEY.into(),
    )
    .await?;
    let runtime_secret = platform_value(
        platform,
        PlatformStorageArea::DeviceSecret,
        CRASH_DEVICE_KEY.into(),
    )
    .await?;
    let foreign_plain = platform_value(
        platform,
        PlatformStorageArea::DevicePlain,
        "foreign:runtime-plain-fixture".into(),
    )
    .await?;
    let foreign_secret = platform_value(
        platform,
        PlatformStorageArea::DeviceSecret,
        WIPE_CRASH_FOREIGN_PLATFORM_KEY.into(),
    )
    .await?;
    let near_miss_plain = platform_value(
        platform,
        PlatformStorageArea::DevicePlain,
        WIPE_CRASH_NEAR_MISS_PLATFORM_KEY.into(),
    )
    .await?;
    let near_miss_secret = platform_value(
        platform,
        PlatformStorageArea::DeviceSecret,
        WIPE_CRASH_NEAR_MISS_PLATFORM_KEY.into(),
    )
    .await?;
    require(
        runtime_plain.as_ref().map(|value| value.as_str())
            == runtime_plain_present.then_some("owned-runtime-plain")
            && runtime_secret.as_ref().map(|value| value.as_str())
                == runtime_secret_present.then_some("owned-runtime-device-secret")
            && foreign_plain.as_ref().map(|value| value.as_str()) == Some("foreign-runtime-plain")
            && foreign_secret.as_ref().map(|value| value.as_str())
                == Some("foreign-runtime-secret")
            && near_miss_plain.as_ref().map(|value| value.as_str())
                == Some("near-miss-runtime-plain")
            && near_miss_secret.as_ref().map(|value| value.as_str())
                == Some("near-miss-runtime-secret"),
        "Wipe changed Runtime or unrelated platform values at the wrong boundary",
    )
}

async fn physical_wipe_crash_parent_case(cut: CrashWriteCut) -> Result<(), String> {
    require(cut.is_wipe(), "Wipe parent received a non-Wipe cut")?;
    let (identity, physical) = unique_entry()?;
    let fixture_owner = PhysicalCrashEntry {
        identity: identity.clone(),
        physical,
        cleaned: false,
    };
    let result = async {
        let entry =
            Entry::new(SERVICE, &identity).map_err(|_| "Cannot create Wipe source owner")?;
        let vault = Arc::new(crate::keychain::KeychainVault::from_entry(
            entry,
            format!("desktop-keyring-test-v1:{identity}"),
        ));
        let (directory, source) = NativeProfileSource::isolated_fixture(vault.clone())
            .map_err(|_| "Cannot create physical Wipe source fixture")?;
        let populated_account_id = if cut == CrashWriteCut::WipePopulatedReplicaDeletion {
            let seeded = admit_populated_cache_source(
                directory.path(),
                source.clone(),
                vault.clone(),
                &fixture_owner.physical,
            )
            .await?;
            let rows = actual_replica_rows(directory.path(), &seeded.account_id).await?;
            let item = row_payload(&rows, "authorityItems")?;
            let retained_vault = row_payload(&rows, "authorityVaults")?;
            require(
                item["encryptedData"]
                    .as_str()
                    .is_some_and(|value| !value.is_empty())
                    && retained_vault["encryptedVaultKey"]
                        .as_str()
                        .is_some_and(|value| !value.is_empty()),
                "Populated Wipe fixture did not admit encrypted Item and Vault authority",
            )?;
            let evidence = read_crash_replica_evidence(directory.path())?;
            require(
                evidence.heads.len() == 1
                    && evidence.heads[0].0 == seeded.account_id
                    && evidence.rows.iter().all(|row| row.0 == seeded.account_id)
                    && evidence.rows.len() >= 2,
                "Populated Wipe fixture has no genuine Account head and nonempty rows",
            )?;
            Some(seeded.account_id)
        } else {
            None
        };
        let fixture = seed_wipe_crash_fixture(directory.path(), &fixture_owner.physical)?;
        let (vault, source) = if populated_account_id.is_some() {
            drop(source);
            drop(vault);
            let entry = Entry::new(SERVICE, &identity)
                .map_err(|_| "Cannot reopen populated Wipe keychain owner")?;
            let vault = Arc::new(crate::keychain::KeychainVault::from_entry(
                entry,
                format!("desktop-keyring-test-v1:{identity}"),
            ));
            let source =
                NativeProfileSource::isolated_existing_fixture(directory.path(), vault.clone())
                    .map_err(|_| "Cannot reopen populated Wipe source owner")?;
            (vault, source)
        } else {
            (vault, source)
        };
        let expected_scope = expected_wipe_crash_scope(directory.path(), &vault)?;
        let platform = Arc::new(
            NativePlatformStorage::with_test_vault(
                directory.path().join("platform.sqlite"),
                vault.clone(),
            )
            .map_err(|_| "Cannot create physical Wipe platform storage")?,
        );
        if populated_account_id.is_none() {
            set_crash_platform_value(
                &platform,
                PlatformStorageArea::DevicePlain,
                CRASH_DEVICE_CATALOG_KEY,
                WIPE_CRASH_MALFORMED_CATALOG,
            )
            .await?;
        }
        let initial_catalog = platform_value(
            &platform,
            PlatformStorageArea::DevicePlain,
            CRASH_DEVICE_CATALOG_KEY.into(),
        )
        .await?
        .ok_or("Cannot verify initial DeviceCatalog evidence")?;
        require(
            if populated_account_id.is_some() {
                serde_json::from_str::<serde_json::Value>(initial_catalog.as_str())
                    .ok()
                    .is_some_and(|catalog| {
                        catalog["accounts"]
                            .as_array()
                            .is_some_and(|accounts| accounts.len() == 1)
                    })
            } else {
                initial_catalog.as_str() == WIPE_CRASH_MALFORMED_CATALOG
                    && serde_json::from_str::<serde_json::Value>(initial_catalog.as_str()).is_err()
            },
            "Wipe crash fixture did not retain its selected initial catalog",
        )?;
        set_crash_platform_value(
            &platform,
            PlatformStorageArea::DevicePlain,
            WIPE_CRASH_RUNTIME_PLAIN_KEY,
            "owned-runtime-plain",
        )
        .await?;
        set_crash_platform_value(
            &platform,
            PlatformStorageArea::DevicePlain,
            "foreign:runtime-plain-fixture",
            "foreign-runtime-plain",
        )
        .await?;
        set_crash_platform_value(
            &platform,
            PlatformStorageArea::DevicePlain,
            WIPE_CRASH_NEAR_MISS_PLATFORM_KEY,
            "near-miss-runtime-plain",
        )
        .await?;
        set_crash_platform_value(
            &platform,
            PlatformStorageArea::DeviceSecret,
            CRASH_DEVICE_KEY,
            "owned-runtime-device-secret",
        )
        .await?;
        set_crash_platform_value(
            &platform,
            PlatformStorageArea::DeviceSecret,
            WIPE_CRASH_FOREIGN_PLATFORM_KEY,
            "foreign-runtime-secret",
        )
        .await?;
        set_crash_platform_value(
            &platform,
            PlatformStorageArea::DeviceSecret,
            WIPE_CRASH_NEAR_MISS_PLATFORM_KEY,
            "near-miss-runtime-secret",
        )
        .await?;
        require_wipe_crash_source_state(
            directory.path(),
            &fixture,
            WipeCrashSourceState::AllPresent,
        )?;
        require_wipe_crash_keychain_state(&fixture_owner.physical, &fixture, false, true)?;
        require_wipe_crash_platform_values(&platform, true, true).await?;
        if populated_account_id.is_none() {
            require_wipe_crash_device_plain_state(
                directory.path(),
                initial_catalog.as_str(),
                true,
            )?;
        }
        drop(source);
        drop(platform);
        drop(vault);

        if let Some(account_id) = populated_account_id.as_ref() {
            let before = read_crash_replica_evidence(directory.path())?;
            require(
                before.heads.len() == 1
                    && before.heads[0].0 == *account_id
                    && before.rows.len() >= 2
                    && before.rows.iter().all(|row| row.0 == *account_id),
                "Pre-child Wipe Replica lost its admitted populated head or rows",
            )?;
        }

        let marker = directory.path().join(cut.marker_file());
        let executable =
            std::env::current_exe().map_err(|_| "Cannot locate physical Wipe test executable")?;
        let child = std::process::Command::new(executable)
            .args([
                cut.test_name(),
                "--ignored",
                "--exact",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(CRASH_CHILD, "1")
            .env(CRASH_DIRECTORY, directory.path())
            .env(CRASH_IDENTITY, &identity)
            .env(CRASH_MARKER, &marker)
            .env(CRASH_CUT, cut.environment_value())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .map_err(|_| "Cannot start exact physical Wipe crash child")?;
        let mut child = PhysicalCrashChild(Some(child));
        wait_for_physical_crash_marker(&mut child, &marker)?;
        let marker_contents =
            std::fs::read(&marker).map_err(|_| "Cannot read physical Wipe marker")?;
        let marker_wipe_id = if cut.is_source_reset() {
            Some(require_wipe_source_reset_marker(&marker_contents, cut)?)
        } else if cut.tracks_initial_wipe_identity() {
            Some(require_wipe_catalog_marker(&marker_contents, cut)?)
        } else {
            require(
                marker_contents == cut.marker_contents(),
                "Wipe marker does not identify the selected successful native write",
            )?;
            None
        };
        if populated_account_id.is_some() {
            let deleted = read_crash_replica_evidence(directory.path())?;
            require(
                deleted.heads.is_empty() && deleted.rows.is_empty(),
                "Committed populated Replica Wipe left a head or row before Core acknowledgement",
            )?;
        }
        let source_state_at_cut = match cut {
            CrashWriteCut::WipeResetIntent => WipeCrashSourceState::AllPresent,
            CrashWriteCut::WipeStoreDeletion | CrashWriteCut::WipeStoreReceipt => {
                WipeCrashSourceState::StoreAbsent
            }
            CrashWriteCut::WipeSyncStoreDeletion
            | CrashWriteCut::WipeSyncStoreReceipt
            | CrashWriteCut::WipeCredentialsDeletion
            | CrashWriteCut::WipeCredentialsReceipt => WipeCrashSourceState::LegacyFilesAbsent,
            CrashWriteCut::WipeDevicePlainPrefixDeletion
            | CrashWriteCut::WipeDeviceSecretPrefixDeletion
            | CrashWriteCut::WipePopulatedReplicaDeletion
            | CrashWriteCut::WipeWipedCatalogWrite => {
                WipeCrashSourceState::LegacyAndHostCleanupComplete
            }
            _ => return Err("Wipe parent selected an unrepresented physical cut".into()),
        };
        require_wipe_crash_source_state(directory.path(), &fixture, source_state_at_cut)?;
        let legacy_credentials_removed = matches!(
            cut,
            CrashWriteCut::WipeCredentialsDeletion
                | CrashWriteCut::WipeCredentialsReceipt
                | CrashWriteCut::WipeDevicePlainPrefixDeletion
                | CrashWriteCut::WipeDeviceSecretPrefixDeletion
                | CrashWriteCut::WipePopulatedReplicaDeletion
                | CrashWriteCut::WipeWipedCatalogWrite
        );
        let runtime_plain_present = !matches!(
            cut,
            CrashWriteCut::WipeDevicePlainPrefixDeletion
                | CrashWriteCut::WipeDeviceSecretPrefixDeletion
                | CrashWriteCut::WipePopulatedReplicaDeletion
                | CrashWriteCut::WipeWipedCatalogWrite
        );
        let runtime_secret_present = !matches!(
            cut,
            CrashWriteCut::WipeDeviceSecretPrefixDeletion
                | CrashWriteCut::WipePopulatedReplicaDeletion
                | CrashWriteCut::WipeWipedCatalogWrite
        );
        require_wipe_crash_keychain_state(
            &fixture_owner.physical,
            &fixture,
            legacy_credentials_removed,
            runtime_secret_present,
        )?;

        let checkpoint_entry = Entry::new(SERVICE, &identity)
            .map_err(|_| "Cannot reopen Wipe checkpoint keychain entry")?;
        let checkpoint_vault = Arc::new(crate::keychain::KeychainVault::from_entry(
            checkpoint_entry,
            format!("desktop-keyring-test-v1:{identity}"),
        ));
        if cut == CrashWriteCut::WipeResetIntent {
            require(
                expected_wipe_crash_scope(directory.path(), &checkpoint_vault)? == expected_scope,
                "Held initial Wipe intent changed its physical directory or file identities",
            )?;
        }
        let checkpoint_platform = Arc::new(
            NativePlatformStorage::with_test_vault(
                directory.path().join("platform.sqlite"),
                checkpoint_vault.clone(),
            )
            .map_err(|_| "Cannot open physical Wipe checkpoint database")?,
        );
        let cut_journal = platform_value(
            &checkpoint_platform,
            PlatformStorageArea::DevicePlain,
            CRASH_DEVICE_CATALOG_KEY.into(),
        )
        .await?
        .ok_or("Successful Wipe cut has no durable Reset catalog")?;
        let expected_revision = match cut {
            CrashWriteCut::WipeResetIntent | CrashWriteCut::WipeStoreDeletion => 0,
            CrashWriteCut::WipeStoreReceipt | CrashWriteCut::WipeSyncStoreDeletion => 1,
            CrashWriteCut::WipeSyncStoreReceipt | CrashWriteCut::WipeCredentialsDeletion => 2,
            CrashWriteCut::WipeCredentialsReceipt => 3,
            CrashWriteCut::WipeDevicePlainPrefixDeletion
            | CrashWriteCut::WipeDeviceSecretPrefixDeletion
            | CrashWriteCut::WipePopulatedReplicaDeletion => 3,
            CrashWriteCut::WipeWipedCatalogWrite => 4,
            _ => return Err("Wipe parent selected an unrepresented receipt revision".into()),
        };
        let expected_remaining: &[ProfileSourceFamily] = match cut {
            CrashWriteCut::WipeResetIntent | CrashWriteCut::WipeStoreDeletion => &[
                ProfileSourceFamily::DesktopStore,
                ProfileSourceFamily::DesktopSyncStore,
                ProfileSourceFamily::DesktopCredentials,
            ],
            CrashWriteCut::WipeStoreReceipt | CrashWriteCut::WipeSyncStoreDeletion => &[
                ProfileSourceFamily::DesktopSyncStore,
                ProfileSourceFamily::DesktopCredentials,
            ],
            CrashWriteCut::WipeSyncStoreReceipt | CrashWriteCut::WipeCredentialsDeletion => {
                &[ProfileSourceFamily::DesktopCredentials]
            }
            CrashWriteCut::WipeCredentialsReceipt => &[],
            CrashWriteCut::WipeDevicePlainPrefixDeletion
            | CrashWriteCut::WipeDeviceSecretPrefixDeletion
            | CrashWriteCut::WipePopulatedReplicaDeletion
            | CrashWriteCut::WipeWipedCatalogWrite => &[],
            _ => return Err("Wipe parent selected an unrepresented remaining-family set".into()),
        };
        if let CrashCutTarget::PlatformWrite {
            key: CrashKeySelector::CatalogWrite(expected_phase),
            ..
        } = cut.spec().target
        {
            require(
                matches_catalog_write_phase(cut_journal.as_str(), expected_phase, ""),
                "Wipe cut did not match the selected exact Reset catalog Set",
            )?;
        }
        let wipe_id = require_wipe_crash_catalog(
            cut_journal.as_str(),
            &expected_scope,
            marker_wipe_id.as_deref(),
            if cut.is_terminal_wiped_write() {
                bittery_client_core::ProfileAdmissionResetPhase::Wiped
            } else {
                bittery_client_core::ProfileAdmissionResetPhase::Wiping
            },
            expected_revision,
            expected_remaining,
        )?;
        require_wipe_crash_platform_values(
            &checkpoint_platform,
            runtime_plain_present,
            runtime_secret_present,
        )
        .await?;
        require_wipe_crash_device_plain_state(
            directory.path(),
            cut_journal.as_str(),
            runtime_plain_present,
        )?;
        drop(checkpoint_platform);
        drop(checkpoint_vault);

        let status = child.kill_and_wait()?;
        use std::os::unix::process::ExitStatusExt;
        require(
            status.signal() == Some(9),
            "Physical Wipe child was not terminated at the held acknowledgement",
        )?;
        require_capability_released(directory.path()).await?;

        let reopened_entry = Entry::new(SERVICE, &identity)
            .map_err(|_| "Cannot reopen post-crash Wipe keychain entry")?;
        let reopened_vault = Arc::new(crate::keychain::KeychainVault::from_entry(
            reopened_entry,
            format!("desktop-keyring-test-v1:{identity}"),
        ));
        if cut == CrashWriteCut::WipeResetIntent {
            require(
                expected_wipe_crash_scope(directory.path(), &reopened_vault)? == expected_scope,
                "Initial Wipe intent lost its physical directory or file identities after SIGKILL",
            )?;
        }
        let reopened_platform = Arc::new(
            NativePlatformStorage::with_test_vault(
                directory.path().join("platform.sqlite"),
                reopened_vault.clone(),
            )
            .map_err(|_| "Cannot reopen post-crash Wipe database")?,
        );
        let after_crash_journal = platform_value(
            &reopened_platform,
            PlatformStorageArea::DevicePlain,
            CRASH_DEVICE_CATALOG_KEY.into(),
        )
        .await?
        .ok_or("Post-crash Wipe reopen lost its Reset journal")?;
        require(
            after_crash_journal.as_str() == cut_journal.as_str(),
            "Abrupt exit changed the exact durable Wipe journal or captured sources",
        )?;
        require_wipe_crash_catalog(
            after_crash_journal.as_str(),
            &expected_scope,
            Some(&wipe_id),
            if cut.is_terminal_wiped_write() {
                bittery_client_core::ProfileAdmissionResetPhase::Wiped
            } else {
                bittery_client_core::ProfileAdmissionResetPhase::Wiping
            },
            expected_revision,
            expected_remaining,
        )?;
        require_wipe_crash_source_state(directory.path(), &fixture, source_state_at_cut)?;
        require_wipe_crash_keychain_state(
            &fixture_owner.physical,
            &fixture,
            legacy_credentials_removed,
            runtime_secret_present,
        )?;
        require_wipe_crash_platform_values(
            &reopened_platform,
            runtime_plain_present,
            runtime_secret_present,
        )
        .await?;
        require_wipe_crash_device_plain_state(
            directory.path(),
            after_crash_journal.as_str(),
            runtime_plain_present,
        )?;
        if populated_account_id.is_some() {
            let deleted = read_crash_replica_evidence(directory.path())?;
            require(
                deleted.heads.is_empty() && deleted.rows.is_empty(),
                "Fresh owners reopened populated Replica rows after the killed Wipe child",
            )?;
        }

        if cut.is_terminal_wiped_write() {
            let source = NativeProfileSource::isolated_existing_fixture(
                directory.path(),
                reopened_vault.clone(),
            )
            .map_err(|_| "Cannot acquire a fresh source provider for normal Wiped open")?;
            let source_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let source_executor: Arc<dyn SerializedProfileAdmissionExecutor> =
                Arc::new(CountProfileAdmissionRequests {
                    inner: source,
                    calls: source_calls.clone(),
                });
            let runtime = admission_runtime_with_source_executor(
                directory.path(),
                reopened_platform.clone(),
                source_executor,
            )
            .await?;
            runtime
                .open()
                .await
                .map_err(|_| "Normal open failed after terminal Wiped catalog write")?;
            require(
                source_calls.load(std::sync::atomic::Ordering::SeqCst) == 0,
                "Normal Wiped open requested legacy profile capture or import",
            )?;
            let opened_catalog = platform_value(
                &reopened_platform,
                PlatformStorageArea::DevicePlain,
                CRASH_DEVICE_CATALOG_KEY.into(),
            )
            .await?
            .ok_or("Normal Wiped open removed its terminal tombstone")?;
            require(
                opened_catalog.as_str() == cut_journal.as_str(),
                "Normal Wiped open changed the exact terminal tombstone",
            )?;
            require_wipe_crash_catalog(
                opened_catalog.as_str(),
                &expected_scope,
                Some(&wipe_id),
                bittery_client_core::ProfileAdmissionResetPhase::Wiped,
                4,
                &[],
            )?;
            require_wipe_crash_source_state(
                directory.path(),
                &fixture,
                WipeCrashSourceState::LegacyAndHostCleanupComplete,
            )?;
            require_wipe_crash_keychain_state(&fixture_owner.physical, &fixture, true, false)?;
            require_wipe_crash_platform_values(&reopened_platform, false, false).await?;
            require_wipe_crash_device_plain_state(
                directory.path(),
                opened_catalog.as_str(),
                false,
            )?;
            runtime.close().await;
            drop(runtime);
            drop(reopened_platform);
            drop(reopened_vault);
            return require_capability_released(directory.path()).await;
        }

        let source = NativeProfileSource::isolated_existing_fixture(
            directory.path(),
            reopened_vault.clone(),
        )
        .map_err(|_| "Cannot acquire a fresh native source provider after Wipe crash")?;
        let replay_absence = match cut {
            CrashWriteCut::WipeStoreDeletion | CrashWriteCut::WipeStoreReceipt => {
                Some((wipe_id.clone(), ProfileSourceFamily::DesktopStore))
            }
            CrashWriteCut::WipeSyncStoreDeletion | CrashWriteCut::WipeSyncStoreReceipt => {
                Some((wipe_id.clone(), ProfileSourceFamily::DesktopSyncStore))
            }
            CrashWriteCut::WipeCredentialsDeletion | CrashWriteCut::WipeCredentialsReceipt => {
                Some((wipe_id.clone(), ProfileSourceFamily::DesktopCredentials))
            }
            CrashWriteCut::WipeResetIntent => None,
            CrashWriteCut::WipeDevicePlainPrefixDeletion
            | CrashWriteCut::WipeDeviceSecretPrefixDeletion
            | CrashWriteCut::WipePopulatedReplicaDeletion => None,
            CrashWriteCut::WipeWipedCatalogWrite => None,
            _ => return Err("Wipe recovery selected an unrepresented source family".into()),
        };
        let replay_absence_observed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let retry_scope = matches!(
            cut,
            CrashWriteCut::WipeDevicePlainPrefixDeletion
                | CrashWriteCut::WipeDeviceSecretPrefixDeletion
                | CrashWriteCut::WipePopulatedReplicaDeletion
        )
        .then(|| expected_scope.clone());
        let retry_reset_handle = Arc::new(std::sync::Mutex::new(None));
        let retry_families_observed = Arc::new(std::sync::Mutex::new(Vec::new()));
        let runtime = if replay_absence.is_some() || retry_scope.is_some() {
            let source_executor: Arc<dyn SerializedProfileAdmissionExecutor> =
                Arc::new(ObserveWipeReset {
                    inner: source.clone(),
                    cut: None,
                    marker: None,
                    replay_absence: replay_absence.clone(),
                    replay_absence_observed: replay_absence_observed.clone(),
                    retry_scope: retry_scope.clone(),
                    retry_wipe_id: retry_scope.as_ref().map(|_| wipe_id.clone()),
                    retry_reset_handle: retry_reset_handle.clone(),
                    retry_families_observed: retry_families_observed.clone(),
                });
            admission_runtime_with_source_executor(
                directory.path(),
                reopened_platform.clone(),
                source_executor,
            )
            .await?
        } else {
            admission_runtime_with_executor(
                directory.path(),
                reopened_platform.clone(),
                Some(source.clone()),
                Arc::new(AdmissionNoNetwork),
            )
            .await?
        };
        runtime.install_teardown_host_cleanup(Arc::new(
            NativeFiles::open(directory.path().join("host-files"))
                .map_err(|_| "Cannot install resumed NativeFiles Wipe owner")?,
        ));
        let response = runtime
            .request(RuntimeRequest::Wipe, RequestCancellation::new())
            .await
            .map_err(|_| "Fresh Runtime Wipe retry failed")?;
        require(
            matches!(
                response,
                RuntimeResponse::Teardown {
                    status: TeardownStatus::Complete,
                    ..
                }
            ),
            "Fresh Runtime Wipe retry did not complete",
        )?;
        if replay_absence.is_some() {
            require(
                replay_absence_observed.load(std::sync::atomic::Ordering::SeqCst),
                "Fresh Wipe retry did not replay the selected family as AlreadyAbsent",
            )?;
        }
        if let Some(scope) = retry_scope.as_ref() {
            let acquired_handle = retry_reset_handle
                .lock()
                .map_err(|_| "Fresh reset handle lock was poisoned")?
                .clone();
            let observed_families = retry_families_observed
                .lock()
                .map_err(|_| "Fresh family observation lock was poisoned")?;
            require(
                acquired_handle
                    .as_ref()
                    .is_some_and(|handle| !handle.is_empty())
                    && observed_families.len() == scope.families.len()
                    && scope
                        .families
                        .iter()
                        .all(|expected| observed_families.contains(&expected.family)),
                "Fresh Wipe retry did not prove every exact-scope family AlreadyAbsent once",
            )?;
        }
        let wiped_journal = platform_value(
            &reopened_platform,
            PlatformStorageArea::DevicePlain,
            CRASH_DEVICE_CATALOG_KEY.into(),
        )
        .await?
        .ok_or("Completed Wipe lost its durable Reset catalog")?;
        require_wipe_crash_catalog(
            wiped_journal.as_str(),
            &expected_scope,
            Some(&wipe_id),
            bittery_client_core::ProfileAdmissionResetPhase::Wiped,
            4,
            &[],
        )?;
        require_wipe_crash_source_state(
            directory.path(),
            &fixture,
            WipeCrashSourceState::AllAbsent,
        )?;
        require_wipe_crash_keychain_state(&fixture_owner.physical, &fixture, true, false)?;
        require_wipe_crash_platform_values(&reopened_platform, false, false).await?;
        require_wipe_crash_device_plain_state(directory.path(), wiped_journal.as_str(), false)?;
        runtime.close().await;
        drop(runtime);
        drop(source);
        if populated_account_id.is_some() {
            let deleted = read_crash_replica_evidence(directory.path())?;
            require(
                deleted.heads.is_empty() && deleted.rows.is_empty(),
                "Completed same-Wipe retry restored a deleted Replica head or row",
            )?;
            let source_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let ordinary_source = NativeProfileSource::isolated_existing_fixture(
                directory.path(),
                reopened_vault.clone(),
            )
            .map_err(|_| "Cannot acquire source provider after populated Wipe retry")?;
            let ordinary_source: Arc<dyn SerializedProfileAdmissionExecutor> =
                Arc::new(CountProfileAdmissionRequests {
                    inner: ordinary_source,
                    calls: source_calls.clone(),
                });
            let ordinary_runtime = admission_runtime_with_source_executor(
                directory.path(),
                reopened_platform.clone(),
                ordinary_source,
            )
            .await?;
            ordinary_runtime
                .open()
                .await
                .map_err(|_| "Normal open failed after populated Wipe recovery")?;
            require(
                source_calls.load(std::sync::atomic::Ordering::SeqCst) == 0,
                "Normal open recaptured a legacy source after populated Wipe recovery",
            )?;
            let ordinary_catalog = platform_value(
                &reopened_platform,
                PlatformStorageArea::DevicePlain,
                CRASH_DEVICE_CATALOG_KEY.into(),
            )
            .await?
            .ok_or("Normal open lost the recovered Wiped catalog")?;
            require(
                ordinary_catalog.as_str() == wiped_journal.as_str(),
                "Normal open changed the recovered Wiped catalog",
            )?;
            let after_open = read_crash_replica_evidence(directory.path())?;
            require(
                after_open.heads.is_empty() && after_open.rows.is_empty(),
                "Normal open reimported a deleted populated Replica",
            )?;
            ordinary_runtime.close().await;
            drop(ordinary_runtime);
        }
        drop(reopened_platform);
        drop(reopened_vault);
        require_capability_released(directory.path()).await
    }
    .await;
    fixture_owner.finish(result)
}

async fn physical_crash_child_case(expected_cut: CrashWriteCut) -> Result<(), String> {
    let directory = std::path::PathBuf::from(
        std::env::var_os(CRASH_DIRECTORY).ok_or("Crash child has no profile directory")?,
    );
    let identity = std::env::var(CRASH_IDENTITY).map_err(|_| "Crash child has no key identity")?;
    let cut = CrashWriteCut::from_environment(
        &std::env::var(CRASH_CUT).map_err(|_| "Crash child has no physical write cut")?,
    )?;
    require(
        cut == expected_cut,
        "Crash child test name and selected cut disagree",
    )?;
    let marker = std::path::PathBuf::from(
        std::env::var_os(CRASH_MARKER).ok_or("Crash child has no write marker")?,
    );
    if cut.is_wipe() {
        return physical_wipe_crash_child_case(directory, identity, marker, cut).await;
    }
    let account_id = std::env::var(CRASH_ACCOUNT_ID)
        .map_err(|_| "Crash child has no fixture Account identity")?;
    let entry = Entry::new(SERVICE, &identity).map_err(|_| "Cannot select child keychain entry")?;
    let vault = Arc::new(crate::keychain::KeychainVault::from_entry(
        entry,
        format!("desktop-keyring-test-v1:{identity}"),
    ));
    let source = NativeProfileSource::isolated_existing_fixture(&directory, vault.clone())
        .map_err(|_| "Cannot create child native source capability")?;
    let platform = Arc::new(
        NativePlatformStorage::with_test_vault(directory.join("platform.sqlite"), vault.clone())
            .map_err(|_| "Cannot create child native platform storage")?,
    );
    let runtime = if cut.is_source_delete() {
        let executor: Arc<dyn SerializedProfileAdmissionExecutor> =
            Arc::new(HoldAfterSelectedSourceDeletion {
                inner: source,
                marker,
                cut,
                account_id,
            });
        admission_runtime_with_source_executor(&directory, platform, executor).await?
    } else if cut.is_replica_install() {
        let replica = Arc::new(
            SqliteReplica::open(directory.join("replica.sqlite"))
                .map_err(|_| "Cannot create child physical crash Replica")?,
        );
        let executor = Arc::new(HoldAfterSelectedReplicaInstall {
            inner: replica,
            marker,
            account_id,
            cut,
        });
        admission_runtime_with_replica_executor(
            &directory,
            executor,
            platform,
            Some(source),
            Arc::new(AdmissionNoNetwork),
        )
        .await?
    } else {
        let executor = Arc::new(HoldAfterSelectedPlatformWrite {
            inner: platform,
            marker,
            cut,
            account_id,
            expected_wipe_scope: None,
            initial_wipe_id: std::sync::Mutex::new(None),
        });
        admission_runtime_with_executor(
            &directory,
            executor,
            Some(source),
            Arc::new(AdmissionNoNetwork),
        )
        .await?
    };
    runtime
        .open()
        .await
        .map_err(|_| "Child Runtime failed before its selected physical cut")?;
    Err("Child Runtime returned before the selected physical-operation acknowledgement".into())
}

async fn physical_crash_parent_case(cut: CrashWriteCut) -> Result<(), String> {
    if cut.is_wipe() {
        return physical_wipe_crash_parent_case(cut).await;
    }
    let directory = tempfile::Builder::new()
        .prefix("bittery91-physical-crash-")
        .tempdir()
        .map_err(|_| "Cannot create physical crash profile directory")?;
    let (identity, physical) = unique_entry()?;
    let fixture_owner = PhysicalCrashEntry {
        identity: identity.clone(),
        physical,
        cleaned: false,
    };
    let result = async {
        let fixture = seed_crash_admission_fixture(directory.path(), &fixture_owner.physical)?;
        let source_directory_identity = crash_file_identity(directory.path())?;
        let store_path = directory.path().join("store.json");
        let source_file_identity = crash_file_identity(&store_path)?;
        let marker = directory.path().join(cut.marker_file());
        let executable =
            std::env::current_exe().map_err(|_| "Cannot locate physical crash test executable")?;
        let child = std::process::Command::new(executable)
            .args([
                cut.test_name(),
                "--ignored",
                "--exact",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(CRASH_CHILD, "1")
            .env(CRASH_DIRECTORY, directory.path())
            .env(CRASH_IDENTITY, &identity)
            .env(CRASH_MARKER, &marker)
            .env(CRASH_ACCOUNT_ID, &fixture.account_id)
            .env(CRASH_CUT, cut.environment_value())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .map_err(|_| "Cannot start exact physical crash child")?;
        let mut child = PhysicalCrashChild(Some(child));
        wait_for_physical_crash_marker(&mut child, &marker)?;
        let marker_contents =
            std::fs::read(&marker).map_err(|_| "Cannot read physical crash marker")?;
        if !cut.is_source_delete() {
            require(
                marker_contents == cut.marker_contents(),
                "Physical crash marker does not identify the selected completed write",
            )?;
        } else {
            require(
                marker_contents.starts_with(cut.marker_contents()),
                "Source deletion marker does not identify the selected cleanup primitive",
            )?;
        }

        let at_cut = read_crash_fixture_keychain(&fixture_owner.physical)?;
        if cut.is_cleanup() {
            require_crash_legacy_source_state(
                directory.path(),
                &fixture_owner.physical,
                &fixture,
                cut,
            )?;
            require(
                crash_file_identity(directory.path())? == source_directory_identity,
                "Cleanup changed the exact legacy profile directory identity",
            )?;
        } else {
            for (key, expected) in &fixture.protected {
                require(
                    at_cut.get(key).map(|value| value.as_str()) == Some(expected.as_str()),
                    "Selected platform write changed an original keychain credential",
                )?;
            }
            require(
                std::fs::read(&store_path).map_err(|_| "Cannot read crash source store")?
                    == fixture.store
                    && crash_file_identity(directory.path())? == source_directory_identity
                    && crash_file_identity(&store_path)? == source_file_identity,
                "Held post-write cut changed the exact legacy source or file identity",
            )?;
        }

        let checkpoint_entry = Entry::new(SERVICE, &identity)
            .map_err(|_| "Cannot reopen checkpoint keychain entry")?;
        let checkpoint_vault = Arc::new(crate::keychain::KeychainVault::from_entry(
            checkpoint_entry,
            format!("desktop-keyring-test-v1:{identity}"),
        ));
        let checkpoint_platform = Arc::new(
            NativePlatformStorage::with_test_vault(
                directory.path().join("platform.sqlite"),
                checkpoint_vault.clone(),
            )
            .map_err(|_| "Cannot open physical crash checkpoint database")?,
        );
        let cut_journal = platform_value(
            &checkpoint_platform,
            PlatformStorageArea::DevicePlain,
            "bittery:runtime:platform-storage:device-catalog".into(),
        )
        .await?
        .ok_or("Held physical crash cut has no durable admission journal")?;
        let journal: serde_json::Value = serde_json::from_str(&cut_journal)
            .map_err(|_| "Held physical crash admission journal is malformed")?;
        let expected_profile_identity = format!(
            "desktop-v1:{}:{}",
            source_directory_identity.0, source_directory_identity.1
        );
        let progress_account = &journal["profileAdmission"]["progress"]["accounts"][0];
        let reserved_account = &journal["accounts"][0];
        require(
            journal["profileAdmission"]["kind"] == "import",
            "Held physical crash journal is not a profile import",
        )?;
        let expected_phase = if matches!(
            cut,
            CrashWriteCut::CommittedCatalog
                | CrashWriteCut::DesktopStoreCleanup
                | CrashWriteCut::ProtectedCredentialCleanup
                | CrashWriteCut::FinalCleanupCheckpoint
        ) {
            "committed"
        } else {
            "preparing"
        };
        require(
            journal["profileAdmission"]["phase"] == expected_phase,
            "Held physical crash journal has the wrong admission phase",
        )?;
        require(
            journal["profileAdmission"]["source"]["profileIdentity"] == expected_profile_identity,
            "Held physical crash journal lost its source identity",
        )?;
        let expected_checkpoint = if matches!(
            cut,
            CrashWriteCut::AccountCheckpoint
                | CrashWriteCut::CommittedCatalog
                | CrashWriteCut::DesktopStoreCleanup
                | CrashWriteCut::ProtectedCredentialCleanup
                | CrashWriteCut::FinalCleanupCheckpoint
        ) {
            "verified"
        } else {
            "unwritten"
        };
        require(
            progress_account["accountId"] == fixture.account_id
                && progress_account["checkpoint"] == expected_checkpoint,
            "Held physical crash journal has the wrong Account checkpoint",
        )?;
        let incarnation = progress_account["incarnation"]
            .as_str()
            .ok_or("Held physical crash journal has no Account incarnation")?;
        let committed_cut = matches!(
            cut,
            CrashWriteCut::CommittedCatalog
                | CrashWriteCut::DesktopStoreCleanup
                | CrashWriteCut::ProtectedCredentialCleanup
                | CrashWriteCut::FinalCleanupCheckpoint
        );
        let catalog_reservation_matches = if committed_cut {
            reserved_account["activeIncarnation"] == progress_account["incarnation"]
                && reserved_account["pendingInstall"].is_null()
                && reserved_account["pendingRetirement"].is_null()
        } else {
            reserved_account["activeIncarnation"].is_null()
                && reserved_account["pendingInstall"]["expectedActiveIncarnation"].is_null()
                && reserved_account["pendingInstall"]["incarnation"]
                    == progress_account["incarnation"]
                && reserved_account["pendingRetirement"].is_null()
        };
        require(
            journal["accounts"]
                .as_array()
                .is_some_and(|accounts| accounts.len() == 1)
                && reserved_account["accountId"] == fixture.account_id
                && catalog_reservation_matches,
            if committed_cut {
                "Held Committed catalog does not publish the exact active incarnation"
            } else {
                "Held physical crash cut lost its matching inactive pending reservation"
            },
        )?;
        let cleanup_identity = if cut.is_cleanup() {
            let identity = require_crash_cleanup_journal(
                &journal,
                cut,
                &fixture,
                &expected_profile_identity,
            )?;
            require(
                identity.incarnation == incarnation,
                "Cleanup crash journal changed the exact Account incarnation",
            )?;
            if cut.is_source_delete() {
                let receipts = crash_cleanup_receipts(&journal, &fixture.account_id)
                    .ok_or("Cleanup marker journal lost captured target identities")?;
                let target = match cut {
                    CrashWriteCut::DesktopStoreCleanup => CrashCleanupEntry::DesktopStore,
                    CrashWriteCut::ProtectedCredentialCleanup => {
                        CrashCleanupEntry::AccountSecretKey
                    }
                    _ => return Err("Unexpected source deletion marker cut".into()),
                };
                let index = receipts
                    .get(&target)
                    .map(|(index, _)| *index)
                    .ok_or("Cleanup marker target is absent from the committed manifest")?;
                require(
                    marker_contents
                        == source_delete_marker_contents(cut, &identity.admission_id, index),
                    "Source deletion marker lost its exact admission and manifest target",
                )?;
            }
            Some(identity)
        } else {
            None
        };
        let at_cut_plain = read_crash_device_plain_records(directory.path())?;
        require_crash_device_plain_documents(
            &at_cut_plain,
            cut,
            &fixture,
            incarnation,
            cut_journal.as_str(),
        )?;
        require_crash_platform_secrets(&at_cut, cut, &fixture.account_id, incarnation)?;
        let at_cut_replica = read_crash_replica_evidence(directory.path())?;
        if cut.has_installed_replica() {
            require_crash_replica_install(&at_cut_replica, &fixture, incarnation)?;
        } else {
            require_no_replica_head(directory.path(), &fixture.account_id)?;
        }
        drop(checkpoint_platform);
        drop(checkpoint_vault);

        let status = child.kill_and_wait()?;
        use std::os::unix::process::ExitStatusExt;
        require(
            status.signal() == Some(9),
            "Physical crash child was not terminated at the held acknowledgement",
        )?;
        require_capability_released(directory.path()).await?;

        let reopened_entry = Entry::new(SERVICE, &identity)
            .map_err(|_| "Cannot reopen post-crash keychain entry")?;
        let reopened_vault = Arc::new(crate::keychain::KeychainVault::from_entry(
            reopened_entry,
            format!("desktop-keyring-test-v1:{identity}"),
        ));
        let reopened_platform = Arc::new(
            NativePlatformStorage::with_test_vault(
                directory.path().join("platform.sqlite"),
                reopened_vault.clone(),
            )
            .map_err(|_| "Cannot reopen post-crash platform database")?,
        );
        let reopened_journal = platform_value(
            &reopened_platform,
            PlatformStorageArea::DevicePlain,
            "bittery:runtime:platform-storage:device-catalog".into(),
        )
        .await?
        .ok_or("Post-crash reopen lost the admission journal")?;
        require(
            reopened_journal.as_str() == cut_journal.as_str(),
            "Post-crash reopen changed the exact durable admission journal before resume",
        )?;
        let after_crash_plain = read_crash_device_plain_records(directory.path())?;
        require_crash_device_plain_documents(
            &after_crash_plain,
            cut,
            &fixture,
            incarnation,
            reopened_journal.as_str(),
        )?;
        require_same_crash_device_plain_records(&at_cut_plain, &after_crash_plain)?;
        let after_crash = read_crash_fixture_keychain(&fixture_owner.physical)?;
        if cut.is_cleanup() {
            require_crash_legacy_source_state(
                directory.path(),
                &fixture_owner.physical,
                &fixture,
                cut,
            )?;
            require(
                crash_file_identity(directory.path())? == source_directory_identity,
                "Post-crash cleanup changed the exact legacy profile directory identity",
            )?;
        } else {
            for (key, expected) in &fixture.protected {
                require(
                    after_crash.get(key).map(|value| value.as_str()) == Some(expected.as_str()),
                    "Post-crash reopen changed a retained legacy credential",
                )?;
            }
        }
        require_crash_platform_secrets(&after_crash, cut, &fixture.account_id, incarnation)?;
        require_same_crash_platform_secrets(&at_cut, &after_crash)?;
        let after_crash_replica = read_crash_replica_evidence(directory.path())?;
        if cut.has_installed_replica() {
            require_crash_replica_install(&after_crash_replica, &fixture, incarnation)?;
        }
        require_same_crash_replica_evidence(&at_cut_replica, &after_crash_replica)?;
        require(
            after_crash
                .get("unrelated_crash_fixture_entry")
                .map(|value| value.as_str())
                == Some("preserved"),
            "Post-crash reopen changed the unrelated protected value",
        )?;
        if !cut.is_cleanup() {
            require(
                std::fs::read(&store_path).map_err(|_| "Cannot recheck crash source store")?
                    == fixture.store
                    && crash_file_identity(directory.path())? == source_directory_identity
                    && crash_file_identity(&store_path)? == source_file_identity,
                "Post-crash reopen changed the exact legacy source or profile identity",
            )?;
        }

        let source = NativeProfileSource::isolated_existing_fixture(
            directory.path(),
            reopened_vault.clone(),
        )
        .map_err(|_| "Cannot reacquire source capability after process crash")?;
        let runtime = if cut.has_installed_replica() {
            let replica = Arc::new(
                SqliteReplica::open(directory.path().join("replica.sqlite"))
                    .map_err(|_| "Cannot reopen Replica behind recovery guard")?,
            );
            let guarded: Arc<dyn SerializedReplicaExecutor> = Arc::new(RefuseReplicaReinstall {
                inner: replica,
                account_id: fixture.account_id.clone(),
            });
            admission_runtime_with_replica_executor(
                directory.path(),
                guarded,
                reopened_platform.clone(),
                Some(source.clone()),
                Arc::new(AdmissionNoNetwork),
            )
            .await?
        } else {
            admission_runtime(
                directory.path(),
                reopened_platform.clone(),
                Some(source.clone()),
            )
            .await?
        };
        runtime
            .open()
            .await
            .map_err(|_| "Native Runtime did not resume the exact staged admission")?;
        require_locked(&runtime, &fixture.account_id)?;
        let resumed_replica = read_crash_replica_evidence(directory.path())?;
        require_crash_replica_install(&resumed_replica, &fixture, incarnation)?;
        if cut.has_installed_replica() {
            require_same_crash_replica_evidence(&at_cut_replica, &resumed_replica)?;
        }
        let complete_journal = platform_value(
            &reopened_platform,
            PlatformStorageArea::DevicePlain,
            CRASH_DEVICE_CATALOG_KEY.into(),
        )
        .await?
        .ok_or("Resumed physical admission lost its catalog")?;
        let complete: serde_json::Value = serde_json::from_str(&complete_journal)
            .map_err(|_| "Resumed physical admission catalog is malformed")?;
        require(
            complete["profileAdmission"]["phase"] == "complete"
                && complete["accounts"][0]["accountId"] == fixture.account_id
                && complete["accounts"][0]["activeIncarnation"] == incarnation,
            "Resumed physical admission did not publish its complete Account catalog",
        )?;
        if let Some(identity) = &cleanup_identity {
            require(
                complete["profileAdmission"]["admissionId"] == identity.admission_id
                    && complete["profileAdmission"]["manifestDigest"]
                        == identity.manifest_digest
                    && complete["profileAdmission"]["source"]["profileIdentity"]
                        == expected_profile_identity
                    && complete["profileAdmission"]["completionId"]
                        .as_str()
                        .is_some_and(|value| !value.is_empty())
                    && complete["profileAdmission"]["progress"].is_null(),
                "Cleanup recovery changed admission identity or failed to compact its exact source journal",
            )?;
        }
        let completed_keychain = read_crash_fixture_keychain(&fixture_owner.physical)?;
        require_crash_platform_secrets(
            &completed_keychain,
            CrashWriteCut::LegacySessionEvidence,
            &fixture.account_id,
            incarnation,
        )?;
        let completed_plain = read_crash_device_plain_records(directory.path())?;
        require_crash_device_plain_documents(
            &completed_plain,
            CrashWriteCut::AccountLocalSecurity,
            &fixture,
            incarnation,
            complete_journal.as_str(),
        )?;
        require(
            !store_path
                .try_exists()
                .map_err(|_| "Cannot inspect cleaned physical source store")?,
            "Resumed physical admission did not clean its exact legacy source",
        )?;
        require(
            completed_keychain
                .get("unrelated_crash_fixture_entry")
                .map(|value| value.as_str())
                == Some("preserved")
                && completed_keychain
                    .keys()
                    .all(|key| !key.starts_with("bittery_account_"))
                && !completed_keychain.contains_key("bittery_device_key"),
            "Resumed physical admission did not remove only its legacy credentials",
        )?;
        runtime.close().await;
        drop(runtime);
        drop(source);
        drop(reopened_platform);
        drop(reopened_vault);
        require_capability_released(directory.path()).await
    }
    .await;
    fixture_owner.finish(result)
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_crash_after_device_secret_write_reopens_and_completes() -> Result<(), String> {
    physical_crash_test_case(CrashWriteCut::DeviceKey).await
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_crash_after_quick_unlock_write_reopens_and_completes() -> Result<(), String> {
    physical_crash_test_case(CrashWriteCut::QuickUnlock).await
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_crash_after_legacy_session_evidence_write_reopens_and_completes(
) -> Result<(), String> {
    physical_crash_test_case(CrashWriteCut::LegacySessionEvidence).await
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_crash_after_global_local_security_write_reopens_and_completes() -> Result<(), String>
{
    physical_crash_test_case(CrashWriteCut::GlobalLocalSecurity).await
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_crash_after_account_metadata_write_reopens_and_completes() -> Result<(), String> {
    physical_crash_test_case(CrashWriteCut::AccountMetadata).await
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_crash_after_account_local_security_write_reopens_and_completes(
) -> Result<(), String> {
    physical_crash_test_case(CrashWriteCut::AccountLocalSecurity).await
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_crash_after_replica_install_reopens_and_completes() -> Result<(), String> {
    physical_crash_test_case(CrashWriteCut::ReplicaInstall).await
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_crash_after_account_checkpoint_catalog_write_reopens_and_completes(
) -> Result<(), String> {
    physical_crash_test_case(CrashWriteCut::AccountCheckpoint).await
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_crash_after_committed_catalog_write_reopens_and_completes() -> Result<(), String> {
    physical_crash_test_case(CrashWriteCut::CommittedCatalog).await
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_crash_after_legacy_device_plain_store_cleanup_reopens_and_completes(
) -> Result<(), String> {
    physical_crash_test_case(CrashWriteCut::DesktopStoreCleanup).await
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_crash_after_protected_credential_cleanup_reopens_and_completes(
) -> Result<(), String> {
    physical_crash_test_case(CrashWriteCut::ProtectedCredentialCleanup).await
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_crash_after_final_cleanup_checkpoint_reopens_and_completes() -> Result<(), String> {
    physical_crash_test_case(CrashWriteCut::FinalCleanupCheckpoint).await
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_crash_after_wipe_reset_intent_reopens_and_completes() -> Result<(), String> {
    physical_crash_test_case(CrashWriteCut::WipeResetIntent).await
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_crash_after_wipe_store_deletion_reopens_and_completes() -> Result<(), String> {
    physical_crash_test_case(CrashWriteCut::WipeStoreDeletion).await
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_crash_after_wipe_store_receipt_reopens_and_completes() -> Result<(), String> {
    physical_crash_test_case(CrashWriteCut::WipeStoreReceipt).await
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_crash_after_wipe_sync_store_deletion_reopens_and_completes() -> Result<(), String> {
    physical_crash_test_case(CrashWriteCut::WipeSyncStoreDeletion).await
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_crash_after_wipe_sync_store_receipt_reopens_and_completes() -> Result<(), String> {
    physical_crash_test_case(CrashWriteCut::WipeSyncStoreReceipt).await
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_crash_after_wipe_credentials_deletion_reopens_and_completes() -> Result<(), String>
{
    physical_crash_test_case(CrashWriteCut::WipeCredentialsDeletion).await
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_crash_after_wipe_credentials_receipt_reopens_and_completes() -> Result<(), String> {
    physical_crash_test_case(CrashWriteCut::WipeCredentialsReceipt).await
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_crash_after_wipe_device_plain_prefix_deletion_reopens_and_completes(
) -> Result<(), String> {
    physical_crash_test_case(CrashWriteCut::WipeDevicePlainPrefixDeletion).await
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_crash_after_wipe_device_secret_prefix_deletion_reopens_and_completes(
) -> Result<(), String> {
    physical_crash_test_case(CrashWriteCut::WipeDeviceSecretPrefixDeletion).await
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_crash_after_wipe_wiped_catalog_write_reopens_and_completes() -> Result<(), String> {
    physical_crash_test_case(CrashWriteCut::WipeWipedCatalogWrite).await
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_crash_after_populated_replica_wipe_reopens_and_completes() -> Result<(), String> {
    physical_crash_test_case(CrashWriteCut::WipePopulatedReplicaDeletion).await
}

async fn physical_crash_test_case(cut: CrashWriteCut) -> Result<(), String> {
    match std::env::var(CRASH_CHILD).as_deref() {
        Ok("1") => physical_crash_child_case(cut).await,
        Ok(_) => Err("Unexpected physical crash child marker".into()),
        Err(std::env::VarError::NotPresent) => physical_crash_parent_case(cut).await,
        Err(_) => Err("Invalid physical crash child marker".into()),
    }
}

struct PopulatedCacheSeed {
    account_id: String,
    generation: &'static str,
    master_unlock_key: [u8; 32],
    vault_key: [u8; 32],
    wrap_context: bittery_crypto_core::VaultKeyWrapContext,
    item_context: bittery_crypto_core::AadContext,
    item_plaintext: String,
    http: Arc<AdmissionSrpNetwork>,
    platform: Arc<NativePlatformStorage>,
}

async fn admit_populated_cache_source(
    directory: &Path,
    source: Arc<NativeProfileSource>,
    vault: Arc<KeychainVault>,
    physical: &Entry,
) -> Result<PopulatedCacheSeed, String> {
    let account_id = bittery_crypto_core::generate_uuid();
    let user_id = bittery_crypto_core::generate_uuid();
    let email = format!("cache-{account_id}@example.test");
    let server_url = "https://cache.example.test";
    let secret_key = bittery_crypto_core::generate_secret_key();
    let device_key = std::array::from_fn::<_, 32, _>(|index| 0x80 | index as u8);
    let kdf_profile = bittery_crypto_core::current_kdf_profile();
    let master_unlock_key = bittery_crypto_core::derive_keys(
        "actual cached fixture password",
        &secret_key,
        &email,
        &kdf_profile,
    )
    .map_err(|_| "Cannot derive actual cached password material")?
    .master_unlock_key;
    let encoded_master_unlock = base64::engine::general_purpose::STANDARD.encode(master_unlock_key);
    let encrypted_master_unlock = bittery_crypto_core::encrypt(&encoded_master_unlock, &device_key)
        .map_err(|_| "Cannot wrap actual cached master key")?;

    let vault_id = "vault:actual-offline";
    let item_id = "item:actual-offline";
    let generation = "actual-generation";
    let vault_key = std::array::from_fn::<_, 32, _>(|index| 0x40 | index as u8);
    let wrap_context = bittery_crypto_core::VaultKeyWrapContext::new(vault_id, &user_id, 1);
    let wrapped_vault_key = bittery_crypto_core::encrypt_vault_key_with_muk(
        &vault_key,
        &master_unlock_key,
        &wrap_context,
    )
    .map_err(|_| "Cannot wrap actual offline Vault key")?;
    let http = Arc::new(AdmissionSrpNetwork::new(
        "actual cached fixture password",
        &secret_key,
        email.clone(),
        user_id.clone(),
        vault_id.into(),
        wrapped_vault_key.clone(),
        kdf_profile.clone(),
    )?);
    let item_context = bittery_crypto_core::AadContext {
        vault_id: vault_id.into(),
        entity_id: item_id.into(),
        entity_type: "item".into(),
        version: 1,
        user_id: user_id.clone(),
    };
    let item_plaintext = json!({
        "title":"Actual offline login",
        "username":"offline@example.test",
        "password":"retained-ciphertext-secret"
    })
    .to_string();
    let encrypted_item =
        bittery_crypto_core::encrypt_with_aad(&item_plaintext, &vault_key, &item_context)
            .map_err(|_| "Cannot encrypt actual offline Item")?;

    let items_prefix = format!("record:item-cache-stage:{account_id}:{generation}:items:");
    let vaults_prefix = format!("record:item-cache-stage:{account_id}:{generation}:vaults:");
    let added_at = 1_700_000_000_000_u64;
    let metadata = json!({
        "accountId": account_id,
        "email": email,
        "userId": user_id,
        "name": "Actual cached admission",
        "serverUrl": server_url,
        "secretKeyHint": bittery_crypto_core::get_secret_key_hint(&secret_key),
        "addedAt": added_at,
        "lastActiveAt": added_at,
        "biometricEnabled": false,
        "insecureTransportConfirmed": false,
        "teamAvatarUrl": null
    });
    let store = serde_json::to_vec_pretty(&json!({
        "bittery_accounts_list": json!({"version":2,"accounts":[metadata]}).to_string(),
        "bittery_active_account": account_id,
        "bittery_master_password_reentry_period_ms": "-1",
        format!("bittery_account_{account_id}_auto_lock_timeout"): "0",
        format!("bittery_account_{account_id}_biometric_enabled"): "false",
        format!("bittery_account_{account_id}_server_url"): server_url,
        format!("bittery_account_{account_id}_pinned_kdf_params"): json!({
            "schemaVersion":1,"algorithm":"pbkdf2-sha256","iterations":600000
        }).to_string(),
        format!("bittery_account_{account_id}_travel_mode_cache"): json!({
            "enabled":false,
            "hiddenVaultIds":[],
            "enabledAt":null,
            "updatedAt":added_at
        }).to_string(),
        format!("record:{account_id}:meta:meta"): json!({
            "v":2,
            "itemsPrimed":true,
            "vaultsPrimed":true,
            "metadata":{
                "lastFullSyncAt":1700000001000_u64,
                "itemCount":1,
                "cacheVersion":1,
                "syncBaseline":{
                    "serverUrl":"https://cache.example.test/",
                    "cursorId":"evt-actual-cache"
                }
            },
            "activeGeneration":generation,
            "nativeView":{
                "v":1,
                "itemsKeyPrefix":items_prefix,
                "vaultsKeyPrefix":vaults_prefix
            }
        }).to_string(),
        format!("{vaults_prefix}{vault_id}"): json!({
            "id":vault_id,
            "name":"Actual Offline Vault",
            "type":"personal",
            "icon":null,
            "imageUrl":null,
            "accountId":account_id,
            "accountEmail":email,
            "serverUrl":"https://CACHE.example.test/"
        }).to_string(),
        format!("{items_prefix}{item_id}"): json!({
            "id":item_id,
            "vaultId":vault_id,
            "category":"login",
            "favorite":false,
            "encryptedData":encrypted_item.ciphertext,
            "encryptionIv":encrypted_item.iv,
            "encryptionAlgorithm":encrypted_item.algorithm,
            "version":7,
            "encryptionVersion":1,
            "encryptedByUserId":user_id,
            "lastModifiedBy":user_id,
            "createdAt":"2026-09-20T00:00:00Z",
            "updatedAt":"2026-09-20T00:01:00Z",
            "deletedAt":null,
            "accountId":account_id,
            "accountEmail":email,
            "serverUrl":"https://cache.example.test/"
        }).to_string()
    }))
    .map_err(|_| "Cannot encode actual cached store")?;
    let source_id = format!(
        "account:{}:server:{}",
        encode_legacy_component(&account_id),
        encode_legacy_component(server_url)
    );
    let sync_prefix = format!("sync_source_{}:", encode_legacy_component(&source_id));
    let sync_store = serde_json::to_vec(&json!({
        "bittery_sync_client_id":"actual-cache-client",
        format!("{sync_prefix}syncBaselineV1"): json!({
            "initialized":true,"cursor":{"id":"evt-actual-cache"}
        }).to_string(),
        format!("{sync_prefix}lastSyncCursor"): json!({"id":"evt-actual-cache"}).to_string()
    }))
    .map_err(|_| "Cannot encode actual cached Sync store")?;
    let device_key_string = base64::engine::general_purpose::STANDARD.encode(device_key);
    let session_data = json!({
        "encryptedMasterUnlockKey":encrypted_master_unlock,
        "email":email,
        "userId":user_id,
        "createdAt":added_at,
        "expiresAt":1_209_600_000_u64
    })
    .to_string();
    let original_protected = Zeroizing::new(
        json!({
            "bittery_device_key":device_key_string,
            format!("bittery_account_{account_id}_secret_key"):secret_key,
            format!("bittery_account_{account_id}_session_data"):session_data,
            format!("bittery_account_{account_id}_jwt_token"):"retained-offline-token",
            format!("bittery_account_{account_id}_vault_keys"):json!([{
                "vaultId":vault_id,
                "encryptedVaultKey":wrapped_vault_key,
                "role":"owner",
                "vaultIcon":null,
                "vaultImageUrl":null,
                "vaultName":"Actual Offline Vault",
                "vaultType":"personal"
            }]).to_string(),
            format!("bittery_account_{account_id}_encrypted_private_key"):
                "retained-private-key",
            "unrelated_actual_cache_entry":"preserved"
        })
        .to_string(),
    );
    physical
        .set_password(&original_protected)
        .map_err(|_| "Cannot seed actual cached protected map")?;
    std::fs::write(directory.join("store.json"), store)
        .map_err(|_| "Cannot seed actual cached store")?;
    std::fs::write(directory.join("sync-store.json"), sync_store)
        .map_err(|_| "Cannot seed actual cached Sync store")?;
    let platform = Arc::new(
        NativePlatformStorage::with_test_vault(directory.join("platform.sqlite"), vault.clone())
            .map_err(|_| "Cannot create actual cached platform storage")?,
    );

    let runtime = admission_runtime_with_http(
        directory,
        platform.clone(),
        Some(source.clone()),
        http.clone(),
    )
    .await?;
    runtime
        .open()
        .await
        .map_err(|error| format!("Actual cached admission failed: {}", error.message))?;
    require_locked(&runtime, &account_id)?;
    require(
        http.call_count() == 0,
        "Actual cached admission used authentication HTTP",
    )?;
    runtime.close().await;
    drop(runtime);

    Ok(PopulatedCacheSeed {
        account_id,
        generation,
        master_unlock_key,
        vault_key,
        wrap_context,
        item_context,
        item_plaintext,
        http,
        platform,
    })
}

async fn populated_cache_case() -> Result<(), String> {
    let (identity, physical) = unique_entry()?;
    let result = async {
        let entry =
            Entry::new(SERVICE, &identity).map_err(|_| "Cannot create cache source owner")?;
        let vault = Arc::new(KeychainVault::from_entry(
            entry,
            format!("desktop-keyring-test-v1:{identity}"),
        ));
        let (directory, source) = NativeProfileSource::isolated_fixture(vault.clone())
            .map_err(|_| "Cannot create actual cache source fixture")?;
        let PopulatedCacheSeed {
            account_id,
            generation,
            master_unlock_key,
            vault_key,
            wrap_context,
            item_context,
            item_plaintext,
            http,
            platform,
        } = admit_populated_cache_source(
            directory.path(),
            source.clone(),
            vault.clone(),
            &physical,
        )
        .await?;
        let item_id = "item:actual-offline";
        let reopened = admission_runtime_with_http(
            directory.path(),
            platform.clone(),
            None,
            http.clone(),
        )
        .await?;
        reopened
            .open()
            .await
            .map_err(|_| "Actual cached Runtime did not reopen offline")?;
        require_locked(&reopened, &account_id)?;
        require(
            http.call_count() == 0,
            "Actual cached locked reopen used authentication HTTP",
        )?;
        let travel_sink = Arc::new(AdmissionSink::default());
        let _travel_observation = reopened
            .observe(
                ObservationRequest::TravelMode {
                    account_id: AccountId::from(account_id.clone()),
                },
                travel_sink.clone(),
            )
            .map_err(|_| "Cannot observe admitted actual Travel policy")?;
        let travel_projection = travel_sink.0.lock().unwrap().last().cloned();
        require(
            matches!(travel_projection,
                Some(RuntimeProjection::TravelMode(value))
                    if value.enforcement == bittery_client_core::TravelModeEnforcement::Ready
                        && !value.last_verified_policy.as_ref().is_some_and(|policy| policy.enabled)
                        && value.last_verified_policy.as_ref().is_some_and(|policy| policy.verified_at_ms.is_none())
            ),
            "Actual disabled Travel policy fabricated a verification receipt",
        )?;

        reopened
            .request(
                RuntimeRequest::QuickUnlock {
                    account_id: AccountId::from(account_id.clone()),
                    master_password: "actual cached fixture password".into(),
                },
                RequestCancellation::new(),
            )
            .await
            .map_err(|error| format!("Actual cached Quick Unlock failed: {:?}", error.code))?;
        require_access(&reopened, &account_id, AccountAccessState::Unlocked)?;
        let unlock_calls = http.call_count();
        require(
            unlock_calls >= 3,
            "Actual cached Quick Unlock did not use the ordinary authentication ceremony",
        )?;
        http.go_offline();
        let sink = Arc::new(AdmissionSink::default());
        let _observation = reopened
            .observe(
                ObservationRequest::Items {
                    account_id: AccountId::from(account_id.clone()),
                },
                sink.clone(),
            )
            .map_err(|_| "Cannot observe actual cached Items after Quick Unlock")?;
        let projection = sink.0.lock().unwrap().last().cloned();
        let Some(RuntimeProjection::Items(items)) = projection else {
            return Err("Actual cached Quick Unlock did not publish Items".into());
        };
        let public_item = items
            .items
            .iter()
            .find(|item| item.item_id == item_id)
            .ok_or("Actual cached public Items omitted retained Item")?;
        require(
            public_item.data.title() == "Actual offline login"
                && public_item.data.password() == Some("retained-ciphertext-secret"),
            "Actual cached public Item plaintext differs",
        )?;
        require(
            public_item.status == bittery_client_core::ItemProjectionStatus::Authoritative,
            "Actual cached public Item is not authoritative",
        )?;
        require(
            http.call_count() == unlock_calls,
            "Actual cached public Items observation used authentication HTTP after offline",
        )?;
        reopened.close().await;
        drop(reopened);

        let rows = actual_replica_rows(directory.path(), &account_id).await?;
        let replica_metadata = row_payload(&rows, "replicaMetadata")?;
        require(
            replica_metadata["state"] == "ready"
                && replica_metadata["activeCursor"]["type"] == "capturedValue"
                && replica_metadata.to_string().contains("evt-actual-cache"),
            "Actual Sync baseline was not retained exactly as a ready captured cursor",
        )?;
        let generation_row = row_payload(&rows, "bootstrapGenerations")?;
        require(
            generation_row["legacyAdmission"]["sourceActiveGeneration"] == generation,
            "Actual cache generation was not retained",
        )?;
        let retained_vault = row_payload(&rows, "authorityVaults")?;
        let retained_item = row_payload(&rows, "authorityItems")?;
        let retained_wrapped = retained_vault["encryptedVaultKey"]
            .as_str()
            .ok_or("Actual retained Vault has no wrapped key")?;
        let reopened_vault_key = bittery_crypto_core::decrypt_vault_key_with_muk(
            retained_wrapped,
            &master_unlock_key,
            &wrap_context,
        )
        .map_err(|_| {
            "Actual retained Vault key does not decrypt through original password material"
        })?;
        require(
            reopened_vault_key == vault_key,
            "Actual retained Vault key changed during admission",
        )?;
        let retained_encrypted = bittery_crypto_core::EncryptedData {
            ciphertext: retained_item["encryptedData"]
                .as_str()
                .ok_or("Actual retained Item has no ciphertext")?
                .into(),
            iv: retained_item["encryptionIv"]
                .as_str()
                .ok_or("Actual retained Item has no IV")?
                .into(),
            algorithm: retained_item["encryptionAlgorithm"]
                .as_str()
                .ok_or("Actual retained Item has no algorithm")?
                .into(),
        };
        require(
            bittery_crypto_core::decrypt_with_aad(
                &retained_encrypted,
                &reopened_vault_key,
                &item_context,
            )
            .map_err(|_| "Actual retained Item ciphertext does not decrypt")?
                == item_plaintext,
            "Actual retained Item plaintext changed during offline admission",
        )?;
        require(
            vault
                .get_value("unrelated_actual_cache_entry")
                .map_err(|_| "Cannot verify unrelated cached protected entry")?
                .as_deref()
                == Some("preserved")
                && !directory.path().join("store.json").exists()
                && !directory.path().join("sync-store.json").exists(),
            "Actual cached admission cleanup changed unrelated data or retained source files",
        )?;
        drop(platform);
        drop(source);
        drop(vault);
        require_capability_released(directory.path()).await
    }
    .await;
    cleanup_entry(&identity, physical, result)
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain; isolated exact-test child only"]
async fn actual_populated_cache_reopens_offline_with_decryptable_ciphertext() -> Result<(), String>
{
    if isolated_child(POPULATED_CACHE_TEST)? {
        populated_cache_case().await
    } else {
        Ok(())
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LostCreateCredentials {
    password: SecretString,
    account_id: String,
    user_id: String,
    vault_id: String,
    item_id: String,
    operation_id: String,
    source_command_id: String,
    attempt_id: String,
    item_title: String,
    original_request_body: Zeroizing<String>,
    original_outcome: Zeroizing<String>,
    store_json: Zeroizing<String>,
    sync_store_json: Zeroizing<String>,
    protected_entry: Zeroizing<String>,
}

fn lost_create_credentials() -> Result<LostCreateCredentials, String> {
    let path = std::env::var_os("BITTERY_NATIVE_CREATE_LOSS_CREDENTIALS")
        .ok_or("Lost-Create acceptance requires a protected credentials file")?;
    let mut file =
        std::fs::File::open(path).map_err(|_| "Cannot open lost-Create acceptance credentials")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if file
            .metadata()
            .map_err(|_| "Cannot inspect lost-Create credential permissions")?
            .permissions()
            .mode()
            & 0o077
            != 0
        {
            return Err("Lost-Create credentials permit group or other access".into());
        }
    }
    let mut bytes = Zeroizing::new(Vec::new());
    std::io::Read::read_to_end(&mut file, &mut bytes)
        .map_err(|_| "Cannot read lost-Create acceptance credentials")?;
    serde_json::from_slice(&bytes).map_err(|_| "Lost-Create credentials are malformed".into())
}

async fn lost_create_case() -> Result<(), String> {
    use base64::Engine as _;

    let credentials = lost_create_credentials()?;
    let (identity, physical) = unique_entry()?;
    let result = async {
        let entry = Entry::new(SERVICE, &identity)
            .map_err(|_| "Cannot create lost-Create source owner")?;
        let vault = Arc::new(KeychainVault::from_entry(
            entry,
            format!("desktop-keyring-test-v1:{identity}"),
        ));
        let (directory, source) = NativeProfileSource::isolated_fixture(vault.clone())
            .map_err(|_| "Cannot create lost-Create source fixture")?;
        let decode = |value: &str, kind: &'static str| {
            base64::engine::general_purpose::STANDARD
                .decode(value)
                .map_err(move |_| format!("Lost-Create {kind} is not base64"))
        };
        let store = Zeroizing::new(decode(&credentials.store_json, "store")?);
        let sync_store = Zeroizing::new(decode(&credentials.sync_store_json, "Sync store")?);
        let protected = Zeroizing::new(decode(
            &credentials.protected_entry,
            "protected entry",
        )?);
        let protected = Zeroizing::new(
            String::from_utf8(protected.to_vec())
                .map_err(|_| "Lost-Create protected entry is not UTF8")?,
        );
        physical
            .set_password(&protected)
            .map_err(|_| "Cannot seed lost-Create protected entry")?;
        std::fs::write(directory.path().join("store.json"), store.as_slice())
            .map_err(|_| "Cannot seed lost-Create store")?;
        std::fs::write(
            directory.path().join("sync-store.json"),
            sync_store.as_slice(),
        )
        .map_err(|_| "Cannot seed lost-Create Sync store")?;
        let platform = Arc::new(
            NativePlatformStorage::with_test_vault(
                directory.path().join("platform.sqlite"),
                vault.clone(),
            )
            .map_err(|_| "Cannot create lost-Create platform storage")?,
        );
        let http = Arc::new(
            GatedNativeHttp::new().map_err(|_| "Cannot create actual native HTTP executor")?,
        );
        let runtime = admission_runtime_with_http(
            directory.path(),
            platform.clone(),
            Some(source.clone()),
            http.clone(),
        )
        .await?;
        let admission_result = async {
            runtime
                .open()
                .await
                .map_err(|error| format!("Lost-Create admission failed: {}", error.message))?;
            require(
                http.calls() == 0,
                "Lost-Create admission used HTTP before publication",
            )?;
            require_locked(&runtime, &credentials.account_id)?;
            let admitted_rows =
                actual_replica_rows(directory.path(), &credentials.account_id).await?;
            let operation = row_payload(&admitted_rows, "operations")?;
            let overlay = row_payload(&admitted_rows, "optimisticItems")?;
            require(
                operation["operationId"] == credentials.operation_id.as_str()
                    && operation["request"]["path"]
                        == format!(
                            "/api/v1/vaults/{}/items/{}",
                            credentials.vault_id, credentials.item_id
                        )
                    && operation["request"]["body"]
                        == json!(credentials.original_request_body.as_bytes())
                    && operation["legacyAdmission"]["sourceCommand"]["id"]
                        == credentials.source_command_id.as_str()
                    && operation["legacyAdmission"]["sourceCommand"]["operationId"]
                        == credentials.operation_id.as_str()
                    && operation["legacyAdmission"]["sourceCommand"]["attemptId"]
                        == credentials.attempt_id.as_str()
                    && overlay["itemId"] == credentials.item_id.as_str()
                    && overlay["operationId"] == credentials.operation_id.as_str()
                    && overlay["encryptedByUserId"] == credentials.user_id.as_str(),
                "Admission changed the captured legacy Create request or lineage",
            )
        }
        .await;
        runtime.close().await;
        drop(runtime);
        admission_result?;

        let reopened = admission_runtime_with_http(
            directory.path(),
            platform.clone(),
            None,
            http.clone(),
        )
        .await?;
        let mut dispatcher = None;
        let reopened_result = async {
            reopened
                .open()
                .await
                .map_err(|_| "Lost-Create Runtime did not reopen without its source")?;
            require_locked(&reopened, &credentials.account_id)?;
            require(
                http.calls() == 0,
                "Lost-Create locked source-free reopen used HTTP",
            )?;
            http.allow();
            reopened
                .request(
                    RuntimeRequest::QuickUnlock {
                        account_id: AccountId::from(credentials.account_id.clone()),
                        master_password: credentials.password.as_ref().to_owned(),
                    },
                    RequestCancellation::new(),
                )
                .await
                .map_err(|error| format!("Lost-Create Quick Unlock failed: {:?}", error.code))?;
            require_access(
                &reopened,
                &credentials.account_id,
                AccountAccessState::Unlocked,
            )?;
            dispatcher = Some(tokio::spawn(reopened.clone().run_operation_dispatch()));
            let final_rows = tokio::time::timeout(std::time::Duration::from_secs(40), async {
            loop {
                if let Ok(rows) = actual_replica_rows(directory.path(), &credentials.account_id).await
                {
                    let has_receipt = rows.iter().any(|row| {
                        row["store"] == "operationReceipts"
                            && row["key"]["recordId"] == credentials.operation_id
                    });
                    let has_pending = rows.iter().any(|row| {
                        row["store"] == "operations" || row["store"] == "optimisticItems"
                    });
                    if has_receipt && !has_pending {
                        break rows;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            })
            .await
            .map_err(|_| "Lost-Create retained outcome did not converge")?;
            let receipt = row_payload(&final_rows, "operationReceipts")?;
            let original_outcome: serde_json::Value =
                serde_json::from_str(&credentials.original_outcome)
                    .map_err(|_| "Buffered original Create outcome is malformed")?;
            require(
            receipt["operationId"] == credentials.operation_id.as_str()
                && receipt["kind"] == "create_item"
                && receipt["target"]["type"] == "item"
                && receipt["target"]["itemId"] == credentials.item_id.as_str()
                && receipt["result"]["type"] == "applied"
                && receipt["result"]["entityId"] == credentials.item_id.as_str()
                && receipt["result"]["version"] == original_outcome["result"]["version"]
                && receipt["legacyLineage"]["sourceCommandId"]
                    == credentials.source_command_id.as_str()
                && receipt["legacyLineage"]["sourceOperationId"]
                    == credentials.operation_id.as_str()
                && receipt["legacyLineage"]["sourceAttemptId"]
                    == credentials.attempt_id.as_str(),
            "Compact receipt differs from the original retained Server result or lineage",
            )?;
            let sink = Arc::new(AdmissionSink::default());
            let observation = reopened
            .observe(
                ObservationRequest::Items {
                    account_id: AccountId::from(credentials.account_id.clone()),
                },
                sink.clone(),
            )
                .map_err(|_| "Cannot observe reconciled lost-Create Item")?;
            let projection = sink.0.lock().unwrap().last().cloned();
            observation.close();
            let Some(RuntimeProjection::Items(items)) = projection else {
                return Err("Lost-Create reconciliation published no Items".into());
            };
            let matching: Vec<_> = items
                .items
                .iter()
                .filter(|item| item.item_id == credentials.item_id)
                .collect();
            require(
                matching.len() == 1
                    && matching[0].status
                        == bittery_client_core::ItemProjectionStatus::Authoritative
                    && matching[0].data.title() == credentials.item_title,
                "Lost-Create reconciliation did not publish one authoritative original Item",
            )
        }
        .await;
        reopened.close().await;
        let dispatcher_result = if let Some(dispatcher) = dispatcher {
            dispatcher
                .await
                .map_err(|_| "Lost-Create dispatcher did not drain")
        } else {
            Ok(())
        };
        drop(reopened);
        reopened_result?;
        dispatcher_result?;
        require(
            vault
                .get_value("unrelated_create_loss_entry")
                .map_err(|_| "Cannot verify unrelated lost-Create credential")?
                .as_deref()
                == Some("preserved")
                && !directory.path().join("store.json").exists()
                && !directory.path().join("sync-store.json").exists(),
            "Lost-Create cleanup changed unrelated data or retained source files",
        )?;
        eprintln!(
            "Actual admitted legacy Create reconciled the original retained Server outcome without reminting identity"
        );
        drop(platform);
        drop(source);
        drop(vault);
        require_capability_released(directory.path()).await
    }
    .await;
    cleanup_entry(&identity, physical, result)
}

#[tokio::test]
#[ignore = "Requires actual Server, isolated Linux OS keychain, and protected source fixture"]
async fn actual_admitted_create_reconciles_retained_server_outcome() -> Result<(), String> {
    if isolated_child(LOST_CREATE_TEST)? {
        lost_create_case().await
    } else {
        Ok(())
    }
}

struct ReleasePageBarrier(Arc<TestPageBarrier>);

impl Drop for ReleasePageBarrier {
    fn drop(&mut self) {
        self.0.release();
    }
}

async fn cancelled_verification_case() -> Result<(), String> {
    let (identity, physical) = unique_entry()?;
    let result = async {
        let entry =
            Entry::new(SERVICE, &identity).map_err(|_| "Cannot create cancellation owner")?;
        let vault = Arc::new(KeychainVault::from_entry(
            entry,
            format!("desktop-keyring-test-v1:{identity}"),
        ));
        let barrier = TestPageBarrier::new();
        let release = ReleasePageBarrier(barrier.clone());
        let (directory, source) =
            NativeProfileSource::isolated_fixture_with_page_barrier(vault, barrier.clone())
                .map_err(|_| "Cannot create verification cancellation fixture")?;
        let store = b"actual verification reader held through cancelled delivery\n";
        let sync_store = b"actual sync source remains unchanged\n";
        let device_key = "cancelled-verification-device";
        let store_path = directory.path().join("store.json");
        std::fs::write(&store_path, store)
            .map_err(|_| "Cannot seed cancellation verification store")?;
        std::fs::write(directory.path().join("sync-store.json"), sync_store)
            .map_err(|_| "Cannot seed cancellation verification Sync store")?;
        let protected = Zeroizing::new(
            json!({"bittery_device_key": device_key, "unrelated": "retained"}).to_string(),
        );
        physical
            .set_password(&protected)
            .map_err(|_| "Cannot seed cancellation verification credentials")?;

        let (begun, _) = invoke(
            &source,
            json!({"type": "beginSourceSnapshot", "format": "desktopLegacyV1"}),
        )
        .await?;
        let ProfileAdmissionResponse::SourceSnapshot { snapshot } = begun else {
            return Err("Verification cancellation Begin returned the wrong response".into());
        };
        let (header, entries) = manifest(&snapshot, store, sync_store, device_key)?;
        let (started, _) = invoke(
            &source,
            serde_json::to_value(ProfileAdmissionRequest::VerifySourceSnapshot {
                step: ProfileSourceVerifyStep::Start {
                    verification_attempt_id: "cancelled-entry".to_owned(),
                    snapshot_handle: snapshot.snapshot_handle.clone(),
                    header,
                },
            })
            .map_err(|_| "Cannot encode cancellation Verify Start")?,
        )
        .await?;
        let ProfileAdmissionResponse::SourceSnapshotVerification {
            result:
                ProfileSourceVerificationResult::Started {
                    verification_cursor,
                    next_index: 0,
                },
        } = started
        else {
            return Err("Cancellation Verify Start returned an invalid receipt".into());
        };

        let entry_source = source.clone();
        let entry_request = serde_json::to_string(&ProfileAdmissionRequest::VerifySourceSnapshot {
            step: ProfileSourceVerifyStep::Entry {
                verification_cursor,
                index: 0,
                expected_entry: entries[0].clone(),
            },
        })
        .map_err(|_| "Cannot encode cancellation Verify Entry")?;
        let delivery =
            tokio::spawn(async move { entry_source.invoke(Zeroizing::new(entry_request)).await });
        barrier.wait_for_page().await;
        delivery.abort();
        require(
            delivery.await.is_err_and(|error| error.is_cancelled()),
            "Issued verification delivery was not cancelled",
        )?;

        let close_source = source.clone();
        let close_handle = snapshot.snapshot_handle;
        let close = tokio::spawn(async move {
            close_source
                .invoke(Zeroizing::new(
                    json!({
                        "type": "closeSourceSnapshot",
                        "selector": {"type": "exact", "handle": close_handle}
                    })
                    .to_string(),
                ))
                .await
        });
        barrier.wait_for_close_fence().await;
        require(
            !close.is_finished() && has_open_source_handle(&store_path)?,
            "Close did not retain the cancelled verification reader",
        )?;
        require(
            std::fs::read(&store_path)
                .map_err(|_| "Cannot verify cancellation verification store")?
                == store,
            "Cancelled verification or pending Close changed file bytes",
        )?;
        let retained = Zeroizing::new(
            physical
                .get_password()
                .map_err(|_| "Cannot verify cancellation protected bytes")?,
        );
        require(
            retained.as_bytes() == protected.as_bytes(),
            "Cancelled verification or pending Close changed protected bytes",
        )?;
        require(
            NativeDeviceLease::try_acquire(directory.path(), DeviceLeaseMode::Shared)
                .map_err(|_| "Cannot verify cancellation exclusion")?
                .is_none(),
            "Cancelled verification released profile exclusion",
        )?;

        barrier.release();
        let (control, binary) = tokio::time::timeout(std::time::Duration::from_secs(2), close)
            .await
            .map_err(|_| "Close did not drain the released verification worker")?
            .map_err(|_| "Close task was cancelled")?
            .map_err(|_| "Close refused after draining verification")?;
        let closed: ProfileAdmissionResponse = serde_json::from_str(&control)
            .map_err(|_| "Close returned invalid control after verification cancellation")?;
        require(
            closed == ProfileAdmissionResponse::SourceSnapshotClosed {} && binary.is_none(),
            "Close did not acknowledge drained verification readers",
        )?;
        require_source_handle_closed(&store_path).await?;
        drop(release);
        drop(source);
        require_capability_released(directory.path()).await
    }
    .await;
    cleanup_entry(&identity, physical, result)
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain and /proc; isolated exact-test child only"]
async fn cancelled_actual_verification_entry_is_drained_before_close_acknowledges(
) -> Result<(), String> {
    if isolated_child(CANCELLED_VERIFICATION_TEST)? {
        cancelled_verification_case().await
    } else {
        Ok(())
    }
}

async fn cancelled_page_case() -> Result<(), String> {
    let (identity, physical) = unique_entry()?;
    let result = async {
        let entry =
            Entry::new(SERVICE, &identity).map_err(|_| "Cannot create actual source owner")?;
        let vault = Arc::new(KeychainVault::from_entry(
            entry,
            format!("desktop-keyring-test-v1:{identity}"),
        ));
        vault
            .set_value("bittery_device_key", "cached-original")
            .map_err(|_| "Cannot warm cancellation fixture cache")?;
        let original_credentials = Zeroizing::new(
            r#"{"bittery_device_key":"physical-original","unrelated":"retained"}"#.to_owned(),
        );
        physical
            .set_password(&original_credentials)
            .map_err(|_| "Cannot seed cancellation fixture credentials")?;

        let barrier = TestPageBarrier::new();
        let release = ReleasePageBarrier(barrier.clone());
        let (directory, source) =
            NativeProfileSource::isolated_fixture_with_page_barrier(vault.clone(), barrier.clone())
                .map_err(|_| "Cannot create cancellation source fixture")?;
        let original_file = b"actual reader bytes retained through cancelled delivery\n";
        let store_path = directory.path().join("store.json");
        std::fs::write(&store_path, original_file)
            .map_err(|_| "Cannot seed cancellation source file")?;

        let (begun, binary) = invoke(
            &source,
            json!({"type": "beginSourceSnapshot", "format": "desktopLegacyV1"}),
        )
        .await?;
        require(binary.is_none(), "Cancellation Begin returned binary")?;
        let ProfileAdmissionResponse::SourceSnapshot { snapshot } = begun else {
            return Err("Cancellation Begin did not return a snapshot".into());
        };
        require(
            has_open_source_handle(&store_path)?,
            "Begin did not retain an actual source file reader",
        )?;

        let page_source = source.clone();
        let page_handle = snapshot.snapshot_handle.clone();
        let page = tokio::spawn(async move {
            page_source
                .invoke(Zeroizing::new(
                    json!({
                        "type": "readSourcePage", "snapshotHandle": page_handle,
                        "family": "desktopStore", "selector": {"type": "wholeFile"},
                        "cursor": null
                    })
                    .to_string(),
                ))
                .await
        });
        barrier.wait_for_page().await;
        page.abort();
        require(
            page.await.is_err_and(|error| error.is_cancelled()),
            "Issued page delivery was not cancelled",
        )?;

        let close_source = source.clone();
        let close_handle = snapshot.snapshot_handle;
        let close = tokio::spawn(async move {
            close_source
                .invoke(Zeroizing::new(
                    json!({
                        "type": "closeSourceSnapshot",
                        "selector": {"type": "exact", "handle": close_handle}
                    })
                    .to_string(),
                ))
                .await
        });
        barrier.wait_for_close_fence().await;
        require(
            !close.is_finished() && has_open_source_handle(&store_path)?,
            "Close did not wait for the cancelled actual page worker",
        )?;
        require(
            std::fs::read(&store_path).map_err(|_| "Cannot verify cancellation source file")?
                == original_file,
            "Cancelled page or pending Close changed source file bytes",
        )?;
        let retained = Zeroizing::new(
            physical
                .get_password()
                .map_err(|_| "Cannot verify cancellation source credentials")?,
        );
        require(
            retained.as_bytes() == original_credentials.as_bytes(),
            "Cancelled page or pending Close changed protected bytes",
        )?;
        require(
            NativeDeviceLease::try_acquire(directory.path(), DeviceLeaseMode::Shared)
                .map_err(|_| "Cannot verify cancellation exclusion")?
                .is_none(),
            "Cancelled page released profile exclusion",
        )?;

        barrier.release();
        let (control, binary) = tokio::time::timeout(std::time::Duration::from_secs(2), close)
            .await
            .map_err(|_| "Close did not drain the released page worker")?
            .map_err(|_| "Close task was cancelled")?
            .map_err(|_| "Close refused after draining the cancelled page")?;
        let closed: ProfileAdmissionResponse = serde_json::from_str(&control)
            .map_err(|_| "Close returned invalid control after cancellation")?;
        require(
            closed == ProfileAdmissionResponse::SourceSnapshotClosed {} && binary.is_none(),
            "Close did not acknowledge drained source readers",
        )?;
        require_source_handle_closed(&store_path).await?;
        require(
            NativeDeviceLease::try_acquire(directory.path(), DeviceLeaseMode::Shared)
                .map_err(|_| "Cannot verify post-close exclusion")?
                .is_none(),
            "Snapshot Close released the exclusive profile capability",
        )?;
        drop(release);
        drop(source);
        require_capability_released(directory.path()).await
    }
    .await;
    cleanup_entry(&identity, physical, result)
}

#[tokio::test]
#[ignore = "Requires actual Linux OS keychain and /proc; isolated exact-test child only"]
async fn cancelled_actual_page_is_drained_before_close_acknowledges() -> Result<(), String> {
    if isolated_child(CANCELLED_PAGE_TEST)? {
        cancelled_page_case().await
    } else {
        Ok(())
    }
}
