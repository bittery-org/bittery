//! Physical legacy readers behind Core's trusted profile-source protocol.
//!
//! There is intentionally no production capability constructor. A new cooperating lease alone
//! cannot exclude legacy writers. The sole constructor creates a new isolated test profile.

use super::device_lease::NativeDeviceLease;
use crate::keychain::{FreshSourceDeleteResult, FreshSourceResetResult, KeychainVault};
use async_trait::async_trait;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use bittery_client_core::{
    LegacyProfileFormat, ProfileAccountCredentialField, ProfileAdmissionRequest,
    ProfileAdmissionResponse, ProfileGlobalCredentialField, ProfileLegacyResetScope,
    ProfileResetFamilyScope, ProfileResetFileBinding, ProfileResetPreparedResult,
    ProfileResetResult, ProfileResetSnapshot, ProfileSnapshotCloseSelector,
    ProfileSourceCleanupReopenResult, ProfileSourceCleanupReopenStep, ProfileSourceCleanupSnapshot,
    ProfileSourceContinuation, ProfileSourceDeleteResult, ProfileSourceFamily,
    ProfileSourceFamilyInventory, ProfileSourceManifestDigest, ProfileSourceManifestEntry,
    ProfileSourceManifestHeader, ProfileSourceObservation, ProfileSourcePage,
    ProfileSourcePresence, ProfileSourceReopenStep, ProfileSourceSelector, ProfileSourceSnapshot,
    ProfileSourceStringEncoding, ProfileSourceValueKind, ProfileSourceVerificationResult,
    ProfileSourceVerifyStep, RuntimeError, RuntimeErrorCode, SerializedProfileAdmissionExecutor,
    PROFILE_SOURCE_BINARY_BYTES, PROFILE_SOURCE_CONTROL_BYTES, PROFILE_SOURCE_CURSOR_BYTES,
};
use serde::{
    de::{MapAccess, SeqAccess, Visitor},
    Deserialize, Serialize,
};
use std::{
    collections::HashSet,
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex},
};
use tokio::sync::watch;
use zeroize::Zeroizing;

#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(test)]
use tokio::sync::Notify;

type EncodedSourceResult = Result<(Zeroizing<String>, Option<Zeroizing<Vec<u8>>>), RuntimeError>;

struct ProfileCapability {
    directory: PathBuf,
    profile_identity: String,
    vault: Arc<KeychainVault>,
    _lease: NativeDeviceLease,
}

#[cfg(test)]
struct TestPageBarrier {
    page_completed: AtomicBool,
    page_completed_signal: Notify,
    close_fenced: AtomicBool,
    close_fenced_signal: Notify,
    released: Mutex<bool>,
    release_signal: Condvar,
}

#[cfg(test)]
impl TestPageBarrier {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            page_completed: AtomicBool::new(false),
            page_completed_signal: Notify::new(),
            close_fenced: AtomicBool::new(false),
            close_fenced_signal: Notify::new(),
            released: Mutex::new(false),
            release_signal: Condvar::new(),
        })
    }

    fn page_completed_and_wait(&self) {
        self.page_completed.store(true, Ordering::Release);
        self.page_completed_signal.notify_waiters();
        let mut released = self
            .released
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while !*released {
            released = self
                .release_signal
                .wait(released)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    fn mark_close_fenced(&self) {
        self.close_fenced.store(true, Ordering::Release);
        self.close_fenced_signal.notify_waiters();
    }

    async fn wait_for_page(&self) {
        loop {
            let notified = self.page_completed_signal.notified();
            if self.page_completed.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }

    async fn wait_for_close_fence(&self) {
        loop {
            let notified = self.close_fenced_signal.notified();
            if self.close_fenced.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }

    fn release(&self) {
        *self
            .released
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = true;
        self.release_signal.notify_all();
    }
}

#[derive(Clone)]
struct SourceFile {
    file: Arc<File>,
    length: u64,
    file_identity: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageCursor {
    version: u8,
    handle: String,
    family: ProfileSourceFamily,
    selector: ProfileSourceSelector,
    offset: u64,
}

impl PageCursor {
    fn encode(self) -> Result<String, RuntimeError> {
        let bytes = serde_json::to_vec(&self).map_err(|_| unavailable())?;
        let encoded = URL_SAFE_NO_PAD.encode(bytes);
        if encoded.len() > PROFILE_SOURCE_CURSOR_BYTES {
            return Err(unavailable());
        }
        Ok(encoded)
    }

    fn offset(
        cursor: Option<&str>,
        handle: &str,
        family: ProfileSourceFamily,
        selector: &ProfileSourceSelector,
    ) -> Result<u64, RuntimeError> {
        let Some(cursor) = cursor else { return Ok(0) };
        if cursor.is_empty() || cursor.len() > PROFILE_SOURCE_CURSOR_BYTES {
            return Err(unavailable());
        }
        let bytes = URL_SAFE_NO_PAD.decode(cursor).map_err(|_| unavailable())?;
        struct CursorObject;
        impl<'de> serde::de::Visitor<'de> for CursorObject {
            type Value = PageCursor;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a closed source cursor object")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                map: A,
            ) -> Result<Self::Value, A::Error> {
                PageCursor::deserialize(serde::de::value::MapAccessDeserializer::new(map))
            }
        }
        let mut decoder = serde_json::Deserializer::from_slice(&bytes);
        let decoded = serde::Deserializer::deserialize_map(&mut decoder, CursorObject)
            .map_err(|_| unavailable())?;
        decoder.end().map_err(|_| unavailable())?;
        if decoded.version != 1
            || decoded.handle != handle
            || decoded.family != family
            || &decoded.selector != selector
            || decoded.offset == 0
        {
            return Err(unavailable());
        }
        Ok(decoded.offset)
    }
}

struct Capture {
    snapshot: ProfileSourceSnapshot,
    store: Option<SourceFile>,
    sync_store: Option<SourceFile>,
    credentials: Option<Arc<Zeroizing<String>>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum VerificationMode {
    Reopen,
    Verify,
}

enum ProfileIdentityStatus {
    Match,
    Changed,
    Unavailable,
}

#[derive(Default)]
struct ProvisionalCapture {
    store: Option<Option<SourceFile>>,
    sync_store: Option<Option<SourceFile>>,
    credentials: Option<Option<Arc<Zeroizing<String>>>>,
}

type ReopenParts = (
    Option<SourceFile>,
    Option<SourceFile>,
    Option<Arc<Zeroizing<String>>>,
);

struct VerificationReceipt {
    cursor: String,
    index: u64,
    expected_entry: ProfileSourceManifestEntry,
    result: ProfileSourceVerificationResult,
}

struct VerificationState {
    mode: VerificationMode,
    attempt_id: String,
    header: ProfileSourceManifestHeader,
    started: ProfileSourceVerificationResult,
    cursor: String,
    digest: Option<ProfileSourceManifestDigest>,
    next_index: u64,
    previous_entry: Option<VerificationReceipt>,
    terminal_result: Option<ProfileSourceVerificationResult>,
    finish_cursor: Option<String>,
    provisional: ProvisionalCapture,
}

struct CleanupVerificationReceipt {
    cursor: String,
    index: u64,
    expected_entry: ProfileSourceManifestEntry,
    result: ProfileSourceCleanupReopenResult,
}

struct CleanupState {
    attempt_id: String,
    admission_id: String,
    header: ProfileSourceManifestHeader,
    started: ProfileSourceCleanupReopenResult,
    cursor: String,
    digest: Option<ProfileSourceManifestDigest>,
    next_index: u64,
    expected_entries: Vec<ProfileSourceManifestEntry>,
    previous_entry: Option<CleanupVerificationReceipt>,
    terminal_result: Option<ProfileSourceCleanupReopenResult>,
    finish_cursor: Option<String>,
}

struct ResetState {
    wipe_id: String,
    format: LegacyProfileFormat,
    expected_scope: Option<ProfileLegacyResetScope>,
    preparing: bool,
    result: Option<ProfileResetPreparedResult>,
}

struct SlotState {
    capture: Option<Result<Capture, RuntimeError>>,
    creating_capture: bool,
    authorized_recorded_capture_id: Option<String>,
    verification: Option<VerificationState>,
    cleanup: Option<CleanupState>,
    reset: Option<ResetState>,
    issued: usize,
    closing: bool,
    closed: bool,
}

struct Slot {
    capability: Arc<ProfileCapability>,
    handle: String,
    capture_id: String,
    state: Mutex<SlotState>,
    drained: Condvar,
    changed: watch::Sender<()>,
}

/// Every issued blocking job owns its slot and thus the exclusive capability. Its completion is
/// published into the slot, not merely returned to a cancellable invocation's JoinHandle.
struct IssuedJob(Arc<Slot>);

impl Drop for IssuedJob {
    fn drop(&mut self) {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.issued -= 1;
        if state.issued == 0 && state.creating_capture && state.capture.is_none() {
            state.capture = Some(Err(unavailable()));
            state.creating_capture = false;
        }
        if state.issued == 0 {
            if let Some(reset) = state.reset.as_mut() {
                if reset.preparing && reset.result.is_none() {
                    reset.result = Some(ProfileResetPreparedResult::Unavailable {});
                    reset.preparing = false;
                }
            }
        }
        drop(state);
        self.0.drained.notify_all();
        self.0.changed.send_replace(());
    }
}

pub(super) struct NativeProfileSource {
    capability: Arc<ProfileCapability>,
    slot: Mutex<Option<Arc<Slot>>>,
    page_bytes: usize,
    #[cfg(test)]
    page_barrier: Option<Arc<TestPageBarrier>>,
}

impl NativeProfileSource {
    #[cfg(all(test, target_os = "linux"))]
    fn isolated_fixture(
        vault: Arc<KeychainVault>,
    ) -> Result<(tempfile::TempDir, Arc<Self>), RuntimeError> {
        Self::isolated_fixture_config(vault, PROFILE_SOURCE_BINARY_BYTES, None)
    }

    #[cfg(all(test, target_os = "linux"))]
    fn isolated_fixture_with_page_bytes(
        vault: Arc<KeychainVault>,
        page_bytes: usize,
    ) -> Result<(tempfile::TempDir, Arc<Self>), RuntimeError> {
        Self::isolated_fixture_config(vault, page_bytes, None)
    }

    #[cfg(all(test, target_os = "linux"))]
    fn isolated_fixture_with_page_barrier(
        vault: Arc<KeychainVault>,
        barrier: Arc<TestPageBarrier>,
    ) -> Result<(tempfile::TempDir, Arc<Self>), RuntimeError> {
        Self::isolated_fixture_config(vault, PROFILE_SOURCE_BINARY_BYTES, Some(barrier))
    }

    #[cfg(all(test, target_os = "linux"))]
    fn isolated_existing_fixture(
        directory: &Path,
        vault: Arc<KeychainVault>,
    ) -> Result<Arc<Self>, RuntimeError> {
        use super::device_lease::DeviceLeaseMode;
        use std::os::unix::fs::MetadataExt;
        let lease = NativeDeviceLease::try_acquire(directory, DeviceLeaseMode::Exclusive)?
            .ok_or_else(unavailable)?;
        let metadata = std::fs::metadata(directory).map_err(|_| unavailable())?;
        Ok(Arc::new(Self {
            capability: Arc::new(ProfileCapability {
                directory: directory.to_path_buf(),
                profile_identity: format!("desktop-v1:{}:{}", metadata.dev(), metadata.ino()),
                vault,
                _lease: lease,
            }),
            slot: Mutex::new(None),
            page_bytes: PROFILE_SOURCE_BINARY_BYTES,
            page_barrier: None,
        }))
    }

    #[cfg(all(test, target_os = "linux"))]
    fn isolated_fixture_config(
        vault: Arc<KeychainVault>,
        page_bytes: usize,
        page_barrier: Option<Arc<TestPageBarrier>>,
    ) -> Result<(tempfile::TempDir, Arc<Self>), RuntimeError> {
        use super::device_lease::DeviceLeaseMode;
        use std::os::unix::fs::MetadataExt;
        if page_bytes == 0 || page_bytes > PROFILE_SOURCE_BINARY_BYTES {
            return Err(unavailable());
        }
        let directory = tempfile::Builder::new()
            .prefix("bittery91-source-")
            .tempdir()
            .map_err(|_| unavailable())?;
        let lease = NativeDeviceLease::try_acquire(directory.path(), DeviceLeaseMode::Exclusive)?
            .ok_or_else(unavailable)?;
        let metadata = std::fs::metadata(directory.path()).map_err(|_| unavailable())?;
        let capability = Arc::new(ProfileCapability {
            directory: directory.path().to_path_buf(),
            profile_identity: format!("desktop-v1:{}:{}", metadata.dev(), metadata.ino()),
            vault,
            _lease: lease,
        });
        Ok((
            directory,
            Arc::new(Self {
                capability,
                slot: Mutex::new(None),
                page_bytes,
                page_barrier,
            }),
        ))
    }

    async fn begin(
        &self,
        format: LegacyProfileFormat,
    ) -> Result<ProfileSourceSnapshot, RuntimeError> {
        if format != LegacyProfileFormat::DesktopLegacyV1 {
            return Err(unavailable());
        }
        let slot = {
            let mut current = self.slot.lock().map_err(|_| unavailable())?;
            let existing = current
                .as_ref()
                .map(|slot| {
                    let state = slot.state.lock().map_err(|_| unavailable())?;
                    if state.closed {
                        Ok(None)
                    } else if state.closing
                        || (state.capture.is_none()
                            && (state.verification.is_some()
                                || state.cleanup.is_some()
                                || state.reset.is_some()))
                    {
                        Err(unavailable())
                    } else {
                        Ok(Some(slot.clone()))
                    }
                })
                .transpose()?
                .flatten();
            if let Some(slot) = existing {
                slot
            } else {
                let (changed, _) = watch::channel(());
                let slot = Arc::new(Slot {
                    capability: self.capability.clone(),
                    handle: bittery_crypto_core::generate_uuid(),
                    capture_id: bittery_crypto_core::generate_uuid(),
                    state: Mutex::new(SlotState {
                        capture: None,
                        creating_capture: true,
                        authorized_recorded_capture_id: None,
                        verification: None,
                        cleanup: None,
                        reset: None,
                        issued: 1,
                        closing: false,
                        closed: false,
                    }),
                    drained: Condvar::new(),
                    changed,
                });
                *current = Some(slot.clone());
                let issued = IssuedJob(slot.clone());
                tokio::task::spawn_blocking(move || {
                    let captured = issued.0.capture();
                    let mut state = issued
                        .0
                        .state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    state.capture = Some(captured);
                    state.creating_capture = false;
                    drop(state);
                    drop(issued);
                });
                slot
            }
        };
        let mut changed = slot.changed.subscribe();
        loop {
            {
                let state = slot.state.lock().map_err(|_| unavailable())?;
                if state.closing || state.closed {
                    return Err(unavailable());
                }
                if let Some(captured) = &state.capture {
                    return captured
                        .as_ref()
                        .map(|capture| capture.snapshot.clone())
                        .map_err(Clone::clone);
                }
            }
            changed.changed().await.map_err(|_| unavailable())?;
        }
    }

    async fn read(
        &self,
        handle: String,
        family: ProfileSourceFamily,
        selector: ProfileSourceSelector,
        cursor: Option<String>,
    ) -> EncodedSourceResult {
        selector.validate_for(family)?;
        let offset = PageCursor::offset(cursor.as_deref(), &handle, family, &selector)?;
        let (issued, source) = {
            let current = self.slot.lock().map_err(|_| unavailable())?;
            let slot = current.as_ref().ok_or_else(unavailable)?;
            if slot.handle != handle {
                return Err(unavailable());
            }
            let mut state = slot.state.lock().map_err(|_| unavailable())?;
            if state.closing || state.closed {
                return Err(unavailable());
            }
            let capture = state
                .capture
                .as_ref()
                .ok_or_else(unavailable)?
                .as_ref()
                .map_err(Clone::clone)?;
            let source = match (&selector, family) {
                (ProfileSourceSelector::WholeFile {}, ProfileSourceFamily::DesktopStore) => {
                    ReadSource::File(capture.store.clone())
                }
                (ProfileSourceSelector::WholeFile {}, ProfileSourceFamily::DesktopSyncStore) => {
                    ReadSource::File(capture.sync_store.clone())
                }
                (
                    ProfileSourceSelector::GlobalCredential { .. }
                    | ProfileSourceSelector::AccountCredential { .. },
                    ProfileSourceFamily::DesktopCredentials,
                ) => ReadSource::Credentials(capture.credentials.clone()),
                _ => return Err(unavailable()),
            };
            if cursor.is_some()
                && matches!(&source, ReadSource::File(file) if file.as_ref().is_none_or(|file| offset >= file.length))
            {
                return Err(unavailable());
            }
            // Reserve before submitting to the blocking pool. Close must drain queued jobs too.
            state.issued = state.issued.checked_add(1).ok_or_else(unavailable)?;
            (IssuedJob(slot.clone()), source)
        };
        let page_bytes = self.page_bytes;
        #[cfg(test)]
        let page_barrier = self.page_barrier.clone();
        tokio::task::spawn_blocking(move || {
            let _issued = issued;
            let response = match source {
                ReadSource::File(file) => {
                    read_file_page(file, handle, family, selector, offset, page_bytes)
                }
                ReadSource::Credentials(credentials) => {
                    read_credential_page(credentials, handle, family, selector, offset, page_bytes)
                }
            };
            #[cfg(test)]
            if let Some(barrier) = page_barrier {
                barrier.page_completed_and_wait();
            }
            response
        })
        .await
        .map_err(|_| unavailable())?
    }

    fn start_verify(
        &self,
        verification_attempt_id: String,
        snapshot_handle: String,
        header: ProfileSourceManifestHeader,
    ) -> Result<ProfileSourceVerificationResult, RuntimeError> {
        validate_desktop_header(&header, &self.capability.profile_identity)?;
        let current = self.slot.lock().map_err(|_| unavailable())?;
        let slot = current.as_ref().ok_or_else(unavailable)?;
        if slot.handle != snapshot_handle {
            return Err(unavailable());
        }
        let mut state = slot.state.lock().map_err(|_| unavailable())?;
        if state.closing || state.closed || state.creating_capture {
            return Err(unavailable());
        }
        let capture = state
            .capture
            .as_ref()
            .ok_or_else(unavailable)?
            .as_ref()
            .map_err(Clone::clone)?;
        if capture.snapshot.capture_id != header.recorded_capture_id
            && state.authorized_recorded_capture_id.as_deref()
                != Some(header.recorded_capture_id.as_str())
        {
            return Err(unavailable());
        }
        if let Some(verification) = &state.verification {
            if verification.mode == VerificationMode::Verify
                && verification.attempt_id == verification_attempt_id
                && verification.header == header
            {
                return Ok(verification
                    .terminal_result
                    .clone()
                    .unwrap_or_else(|| verification.started.clone()));
            }
            if verification.terminal_result.is_none()
                || verification.header != header
                || state.issued != 0
            {
                return Err(unavailable());
            }
        }
        let mut verification =
            new_verification(VerificationMode::Verify, verification_attempt_id, header)?;
        let result = verification_identity_result(&self.capability)
            .unwrap_or_else(|| verification.started.clone());
        if !matches!(result, ProfileSourceVerificationResult::Started { .. }) {
            verification.terminal_result = Some(result.clone());
        }
        state.verification = Some(verification);
        Ok(result)
    }

    fn start_reopen(
        &self,
        verification_attempt_id: String,
        header: ProfileSourceManifestHeader,
    ) -> Result<ProfileSourceVerificationResult, RuntimeError> {
        validate_desktop_header(&header, &self.capability.profile_identity)?;
        let mut current = self.slot.lock().map_err(|_| unavailable())?;
        if let Some(slot) = current.as_ref() {
            let state = slot.state.lock().map_err(|_| unavailable())?;
            if !state.closed {
                let verification = state.verification.as_ref().ok_or_else(unavailable)?;
                if verification.mode == VerificationMode::Reopen
                    && verification.attempt_id == verification_attempt_id
                    && verification.header == header
                {
                    return Ok(verification
                        .terminal_result
                        .clone()
                        .unwrap_or_else(|| verification.started.clone()));
                }
                return Err(unavailable());
            }
        }
        let mut verification =
            new_verification(VerificationMode::Reopen, verification_attempt_id, header)?;
        let result = verification_identity_result(&self.capability)
            .unwrap_or_else(|| verification.started.clone());
        if !matches!(result, ProfileSourceVerificationResult::Started { .. }) {
            verification.terminal_result = Some(result.clone());
        }
        let (changed, _) = watch::channel(());
        let slot = Arc::new(Slot {
            capability: self.capability.clone(),
            handle: bittery_crypto_core::generate_uuid(),
            capture_id: bittery_crypto_core::generate_uuid(),
            state: Mutex::new(SlotState {
                capture: None,
                creating_capture: false,
                authorized_recorded_capture_id: None,
                verification: Some(verification),
                cleanup: None,
                reset: None,
                issued: 0,
                closing: false,
                closed: false,
            }),
            drained: Condvar::new(),
            changed,
        });
        *current = Some(slot);
        Ok(result)
    }

    async fn verification_entry(
        &self,
        mode: VerificationMode,
        verification_cursor: String,
        index: u64,
        expected_entry: ProfileSourceManifestEntry,
    ) -> Result<ProfileSourceVerificationResult, RuntimeError> {
        let issued = {
            let current = self.slot.lock().map_err(|_| unavailable())?;
            let slot = current.as_ref().ok_or_else(unavailable)?;
            let mut state = slot.state.lock().map_err(|_| unavailable())?;
            if state.closing || state.closed {
                return Err(unavailable());
            }
            let verification = state.verification.as_ref().ok_or_else(unavailable)?;
            if verification.mode != mode {
                return Err(unavailable());
            }
            if let Some(receipt) = &verification.previous_entry {
                if receipt.cursor == verification_cursor
                    && receipt.index == index
                    && receipt.expected_entry == expected_entry
                {
                    return Ok(receipt.result.clone());
                }
            }
            if verification.terminal_result.is_some()
                || verification.cursor != verification_cursor
                || verification.next_index != index
                || index >= verification.header.entry_count
                || !entry_is_canonical(
                    index,
                    &expected_entry,
                    verification
                        .previous_entry
                        .as_ref()
                        .map(|receipt| &receipt.expected_entry),
                )
            {
                return Err(unavailable());
            }
            state.issued = state.issued.checked_add(1).ok_or_else(unavailable)?;
            IssuedJob(slot.clone())
        };
        #[cfg(test)]
        let page_barrier = self.page_barrier.clone();
        tokio::task::spawn_blocking(move || {
            let slot = issued.0.clone();
            let observed = observe_entry(&slot.capability, &expected_entry);
            #[cfg(test)]
            if let Some(barrier) = page_barrier {
                barrier.page_completed_and_wait();
            }
            let result = apply_observed_entry(
                &slot,
                mode,
                verification_cursor,
                index,
                expected_entry,
                observed,
            );
            drop(issued);
            result
        })
        .await
        .map_err(|_| unavailable())?
    }

    fn finish_verification(
        &self,
        mode: VerificationMode,
        verification_cursor: String,
    ) -> Result<ProfileSourceVerificationResult, RuntimeError> {
        let current = self.slot.lock().map_err(|_| unavailable())?;
        let slot = current.as_ref().ok_or_else(unavailable)?;
        let mut state = slot.state.lock().map_err(|_| unavailable())?;
        if state.closing || state.closed || state.issued != 0 {
            return Err(unavailable());
        }
        let reopen_parts = {
            let verification = state.verification.as_mut().ok_or_else(unavailable)?;
            if verification.mode != mode {
                return Err(unavailable());
            }
            if verification.finish_cursor.as_deref() == Some(&verification_cursor) {
                return verification.terminal_result.clone().ok_or_else(unavailable);
            }
            if verification.terminal_result.is_some()
                || verification.cursor != verification_cursor
                || verification.next_index != verification.header.entry_count
            {
                return Err(unavailable());
            }
            if let Some(result) = verification_identity_result(&slot.capability) {
                verification.finish_cursor = Some(verification_cursor);
                verification.terminal_result = Some(result.clone());
                return Ok(result);
            }
            let digest = verification.digest.take().ok_or_else(unavailable)?;
            if !verification.header.verify_digest(digest)? {
                let result = ProfileSourceVerificationResult::Changed {};
                verification.finish_cursor = Some(verification_cursor);
                verification.terminal_result = Some(result.clone());
                return Ok(result);
            }
            match mode {
                VerificationMode::Verify => None,
                VerificationMode::Reopen => Some(take_reopen_parts(verification)?),
            }
        };
        let result = if let Some((store, sync_store, credentials)) = reopen_parts {
            let capture = capture_from_parts(slot, store, sync_store, credentials);
            let snapshot = capture.snapshot.clone();
            let recorded_capture_id = state
                .verification
                .as_ref()
                .ok_or_else(unavailable)?
                .header
                .recorded_capture_id
                .clone();
            state.capture = Some(Ok(capture));
            state.authorized_recorded_capture_id = Some(recorded_capture_id);
            ProfileSourceVerificationResult::Reopened { snapshot }
        } else {
            ProfileSourceVerificationResult::Unchanged {
                snapshot_handle: slot.handle.clone(),
            }
        };
        let verification = state.verification.as_mut().ok_or_else(unavailable)?;
        verification.finish_cursor = Some(verification_cursor);
        verification.terminal_result = Some(result.clone());
        Ok(result)
    }

    fn start_cleanup_reopen(
        &self,
        verification_attempt_id: String,
        admission_id: String,
        header: ProfileSourceManifestHeader,
    ) -> Result<ProfileSourceCleanupReopenResult, RuntimeError> {
        validate_desktop_header(&header, &self.capability.profile_identity)?;
        let mut current = self.slot.lock().map_err(|_| unavailable())?;
        if let Some(slot) = current.as_ref() {
            let state = slot.state.lock().map_err(|_| unavailable())?;
            if !state.closed {
                let cleanup = state.cleanup.as_ref().ok_or_else(unavailable)?;
                if cleanup.attempt_id == verification_attempt_id
                    && cleanup.admission_id == admission_id
                    && cleanup.header == header
                {
                    return Ok(cleanup
                        .terminal_result
                        .clone()
                        .unwrap_or_else(|| cleanup.started.clone()));
                }
                return Err(unavailable());
            }
        }
        let cursor = bittery_crypto_core::generate_uuid();
        let started = ProfileSourceCleanupReopenResult::Started {
            verification_cursor: cursor.clone(),
            next_index: 0,
        };
        let mut cleanup = CleanupState {
            attempt_id: verification_attempt_id,
            admission_id,
            digest: Some(header.digest()?),
            header,
            started: started.clone(),
            cursor,
            next_index: 0,
            expected_entries: Vec::new(),
            previous_entry: None,
            terminal_result: None,
            finish_cursor: None,
        };
        let result = if matches!(
            current_profile_identity(&self.capability),
            ProfileIdentityStatus::Match
        ) {
            started
        } else {
            let result = ProfileSourceCleanupReopenResult::Unavailable {};
            cleanup.terminal_result = Some(result.clone());
            cleanup.started = result.clone();
            result
        };
        let (changed, _) = watch::channel(());
        let slot = Arc::new(Slot {
            capability: self.capability.clone(),
            handle: bittery_crypto_core::generate_uuid(),
            capture_id: bittery_crypto_core::generate_uuid(),
            state: Mutex::new(SlotState {
                capture: None,
                creating_capture: false,
                authorized_recorded_capture_id: None,
                verification: None,
                cleanup: Some(cleanup),
                reset: None,
                issued: 0,
                closing: false,
                closed: false,
            }),
            drained: Condvar::new(),
            changed,
        });
        *current = Some(slot);
        Ok(result)
    }

    async fn cleanup_reopen_entry(
        &self,
        verification_cursor: String,
        index: u64,
        expected_entry: ProfileSourceManifestEntry,
    ) -> Result<ProfileSourceCleanupReopenResult, RuntimeError> {
        let issued = {
            let current = self.slot.lock().map_err(|_| unavailable())?;
            let slot = current.as_ref().ok_or_else(unavailable)?;
            let mut state = slot.state.lock().map_err(|_| unavailable())?;
            if state.closing || state.closed {
                return Err(unavailable());
            }
            let cleanup = state.cleanup.as_ref().ok_or_else(unavailable)?;
            if let Some(receipt) = &cleanup.previous_entry {
                if receipt.cursor == verification_cursor
                    && receipt.index == index
                    && receipt.expected_entry == expected_entry
                {
                    return Ok(receipt.result.clone());
                }
            }
            if cleanup.terminal_result.is_some()
                || cleanup.cursor != verification_cursor
                || cleanup.next_index != index
                || index >= cleanup.header.entry_count
                || !entry_is_canonical(index, &expected_entry, cleanup.expected_entries.last())
            {
                return Err(unavailable());
            }
            state.issued = state.issued.checked_add(1).ok_or_else(unavailable)?;
            IssuedJob(slot.clone())
        };
        tokio::task::spawn_blocking(move || {
            let slot = issued.0.clone();
            // This pass authorizes Core's exact committed manifest; each present cleanup target is
            // compared again by DeleteCapturedSource. Physical changes and unreadable unrelated
            // targets must not prevent independent cleanup.
            let accepted = matches!(
                current_profile_identity(&slot.capability),
                ProfileIdentityStatus::Match
            );
            let result = apply_cleanup_reopen_entry(
                &slot,
                verification_cursor,
                index,
                expected_entry,
                accepted,
            );
            drop(issued);
            result
        })
        .await
        .map_err(|_| unavailable())?
    }

    fn finish_cleanup_reopen(
        &self,
        verification_cursor: String,
    ) -> Result<ProfileSourceCleanupReopenResult, RuntimeError> {
        let current = self.slot.lock().map_err(|_| unavailable())?;
        let slot = current.as_ref().ok_or_else(unavailable)?;
        let mut state = slot.state.lock().map_err(|_| unavailable())?;
        if state.closing || state.closed || state.issued != 0 {
            return Err(unavailable());
        }
        let cleanup = state.cleanup.as_mut().ok_or_else(unavailable)?;
        if cleanup.finish_cursor.as_deref() == Some(&verification_cursor) {
            return cleanup.terminal_result.clone().ok_or_else(unavailable);
        }
        if cleanup.terminal_result.is_some()
            || cleanup.cursor != verification_cursor
            || cleanup.next_index != cleanup.header.entry_count
            || !matches!(
                current_profile_identity(&slot.capability),
                ProfileIdentityStatus::Match
            )
        {
            return Err(unavailable());
        }
        let digest = cleanup.digest.take().ok_or_else(unavailable)?;
        let result = if cleanup.header.verify_digest(digest)? {
            ProfileSourceCleanupReopenResult::Reopened {
                snapshot: ProfileSourceCleanupSnapshot {
                    format: LegacyProfileFormat::DesktopLegacyV1,
                    snapshot_handle: slot.handle.clone(),
                    profile_identity: slot.capability.profile_identity.clone(),
                    capture_id: slot.capture_id.clone(),
                    admission_id: cleanup.admission_id.clone(),
                },
            }
        } else {
            ProfileSourceCleanupReopenResult::Unavailable {}
        };
        cleanup.finish_cursor = Some(verification_cursor);
        cleanup.terminal_result = Some(result.clone());
        Ok(result)
    }

    async fn delete_captured_source(
        &self,
        snapshot_handle: String,
        admission_id: String,
        index: u64,
        expected_entry: ProfileSourceManifestEntry,
    ) -> Result<ProfileSourceDeleteResult, RuntimeError> {
        let issued = {
            let current = self.slot.lock().map_err(|_| unavailable())?;
            let slot = current.as_ref().ok_or_else(unavailable)?;
            if slot.handle != snapshot_handle {
                return Err(unavailable());
            }
            let mut state = slot.state.lock().map_err(|_| unavailable())?;
            if state.closing || state.closed || state.issued != 0 {
                return Err(unavailable());
            }
            let cleanup = state.cleanup.as_ref().ok_or_else(unavailable)?;
            let Some(ProfileSourceCleanupReopenResult::Reopened { snapshot }) =
                cleanup.terminal_result.as_ref()
            else {
                return Err(unavailable());
            };
            if snapshot.snapshot_handle != snapshot_handle
                || snapshot.admission_id != admission_id
                || cleanup.admission_id != admission_id
                || usize::try_from(index)
                    .ok()
                    .and_then(|index| cleanup.expected_entries.get(index))
                    != Some(&expected_entry)
                || matches!(
                    expected_entry.observation,
                    ProfileSourceObservation::Missing {}
                )
            {
                return Err(unavailable());
            }
            state.issued = 1;
            IssuedJob(slot.clone())
        };
        #[cfg(test)]
        let page_barrier = self.page_barrier.clone();
        tokio::task::spawn_blocking(move || {
            let result = delete_source_entry(
                &issued.0.capability,
                &expected_entry,
                #[cfg(test)]
                page_barrier.as_deref(),
            );
            drop(issued);
            result
        })
        .await
        .map_err(|_| unavailable())?
    }

    async fn prepare_reset(
        &self,
        wipe_id: String,
        format: LegacyProfileFormat,
        expected_scope: Option<ProfileLegacyResetScope>,
    ) -> Result<ProfileResetPreparedResult, RuntimeError> {
        if format != LegacyProfileFormat::DesktopLegacyV1 {
            return Err(unavailable());
        }
        let slot = {
            let mut current = self.slot.lock().map_err(|_| unavailable())?;
            let existing = current
                .as_ref()
                .map(|slot| {
                    let state = slot.state.lock().map_err(|_| unavailable())?;
                    if state.closed {
                        Ok(None)
                    } else {
                        let reset = state.reset.as_ref().ok_or_else(unavailable)?;
                        if reset.wipe_id == wipe_id
                            && reset.format == format
                            && reset.expected_scope == expected_scope
                        {
                            Ok(Some(slot.clone()))
                        } else {
                            Err(unavailable())
                        }
                    }
                })
                .transpose()?
                .flatten();
            if let Some(slot) = existing {
                slot
            } else {
                let (changed, _) = watch::channel(());
                let slot = Arc::new(Slot {
                    capability: self.capability.clone(),
                    handle: bittery_crypto_core::generate_uuid(),
                    capture_id: bittery_crypto_core::generate_uuid(),
                    state: Mutex::new(SlotState {
                        capture: None,
                        creating_capture: false,
                        authorized_recorded_capture_id: None,
                        verification: None,
                        cleanup: None,
                        reset: Some(ResetState {
                            wipe_id: wipe_id.clone(),
                            format,
                            expected_scope: expected_scope.clone(),
                            preparing: true,
                            result: None,
                        }),
                        issued: 1,
                        closing: false,
                        closed: false,
                    }),
                    drained: Condvar::new(),
                    changed,
                });
                *current = Some(slot.clone());
                let issued = IssuedJob(slot.clone());
                tokio::task::spawn_blocking(move || {
                    let result = prepare_reset_result(&issued.0, &wipe_id, expected_scope.as_ref());
                    let mut state = issued
                        .0
                        .state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if let Some(reset) = state.reset.as_mut() {
                        reset.result = Some(result);
                        reset.preparing = false;
                    }
                    drop(state);
                    drop(issued);
                });
                slot
            }
        };
        let mut changed = slot.changed.subscribe();
        loop {
            {
                let state = slot.state.lock().map_err(|_| unavailable())?;
                if state.closing || state.closed {
                    return Err(unavailable());
                }
                let reset = state.reset.as_ref().ok_or_else(unavailable)?;
                if let Some(result) = &reset.result {
                    return Ok(result.clone());
                }
            }
            changed.changed().await.map_err(|_| unavailable())?;
        }
    }

    async fn reset_family(
        &self,
        reset_handle: String,
        wipe_id: String,
        family: ProfileSourceFamily,
    ) -> Result<ProfileResetResult, RuntimeError> {
        let (issued, scope) = {
            let current = self.slot.lock().map_err(|_| unavailable())?;
            let slot = current.as_ref().ok_or_else(unavailable)?;
            if slot.handle != reset_handle {
                return Err(unavailable());
            }
            let mut state = slot.state.lock().map_err(|_| unavailable())?;
            if state.closing || state.closed || state.issued != 0 {
                return Err(unavailable());
            }
            let reset = state.reset.as_ref().ok_or_else(unavailable)?;
            let Some(ProfileResetPreparedResult::Prepared { snapshot }) = reset.result.as_ref()
            else {
                return Err(unavailable());
            };
            if snapshot.reset_handle != reset_handle
                || snapshot.wipe_id != wipe_id
                || reset.wipe_id != wipe_id
            {
                return Err(unavailable());
            }
            let scope = snapshot
                .scope
                .families
                .iter()
                .find(|scope| scope.family == family)
                .cloned()
                .ok_or_else(unavailable)?;
            state.issued = 1;
            (IssuedJob(slot.clone()), scope)
        };
        #[cfg(test)]
        let page_barrier = self.page_barrier.clone();
        tokio::task::spawn_blocking(move || {
            let result = reset_source_family(
                &issued.0.capability,
                &scope,
                #[cfg(test)]
                page_barrier.as_deref(),
            );
            drop(issued);
            result
        })
        .await
        .map_err(|_| unavailable())?
    }

    async fn close(&self, selector: ProfileSnapshotCloseSelector) -> Result<(), RuntimeError> {
        let slot = {
            let current = self.slot.lock().map_err(|_| unavailable())?;
            let Some(slot) = current.as_ref() else {
                return match selector {
                    ProfileSnapshotCloseSelector::CurrentCapability {} => Ok(()),
                    ProfileSnapshotCloseSelector::Exact { .. } => Err(unavailable()),
                };
            };
            if let ProfileSnapshotCloseSelector::Exact { handle } = &selector {
                if handle != &slot.handle {
                    return Err(unavailable());
                }
            }
            let mut state = slot.state.lock().map_err(|_| unavailable())?;
            if !state.closing && !state.closed {
                // Install the fence before awaiting or issuing drain work. The drain job itself
                // survives cancellation of this invocation and retains the profile capability.
                state.closing = true;
                #[cfg(test)]
                if let Some(barrier) = &self.page_barrier {
                    barrier.mark_close_fenced();
                }
                let retained = slot.clone();
                tokio::task::spawn_blocking(move || {
                    let mut state = retained
                        .state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    while state.issued != 0 {
                        state = retained
                            .drained
                            .wait(state)
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                    }
                    state.capture.take();
                    state.verification.take();
                    state.cleanup.take();
                    state.reset.take();
                    state.authorized_recorded_capture_id.take();
                    state.closed = true;
                    drop(state);
                    retained.changed.send_replace(());
                });
            }
            slot.clone()
        };
        let mut changed = slot.changed.subscribe();
        loop {
            if slot.state.lock().map_err(|_| unavailable())?.closed {
                return Ok(());
            }
            changed.changed().await.map_err(|_| unavailable())?;
        }
    }
}

enum ReadSource {
    File(Option<SourceFile>),
    Credentials(Option<Arc<Zeroizing<String>>>),
}

enum ObservedRetention {
    File(Option<SourceFile>),
    Credentials(Option<Arc<Zeroizing<String>>>),
}

enum ObservedEntry {
    Matched(ObservedRetention),
    Changed,
    Unavailable,
}

fn current_profile_identity(capability: &ProfileCapability) -> ProfileIdentityStatus {
    let metadata = match std::fs::metadata(&capability.directory) {
        Ok(metadata) => metadata,
        Err(_) => return ProfileIdentityStatus::Unavailable,
    };
    if !metadata.is_dir() {
        return ProfileIdentityStatus::Changed;
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::MetadataExt;
        let current = format!("desktop-v1:{}:{}", metadata.dev(), metadata.ino());
        if current == capability.profile_identity {
            ProfileIdentityStatus::Match
        } else {
            ProfileIdentityStatus::Changed
        }
    }
    #[cfg(not(target_os = "linux"))]
    ProfileIdentityStatus::Unavailable
}

fn verification_identity_result(
    capability: &ProfileCapability,
) -> Option<ProfileSourceVerificationResult> {
    match current_profile_identity(capability) {
        ProfileIdentityStatus::Match => None,
        ProfileIdentityStatus::Changed => Some(ProfileSourceVerificationResult::Changed {}),
        ProfileIdentityStatus::Unavailable => Some(ProfileSourceVerificationResult::Unavailable {}),
    }
}

fn validate_desktop_header(
    header: &ProfileSourceManifestHeader,
    profile_identity: &str,
) -> Result<(), RuntimeError> {
    header.validate()?;
    if header.format != LegacyProfileFormat::DesktopLegacyV1
        || header.profile_identity != profile_identity
        || header.entry_count < 3
        || !(header.entry_count - 3).is_multiple_of(5)
    {
        return Err(unavailable());
    }
    Ok(())
}

fn new_verification(
    mode: VerificationMode,
    attempt_id: String,
    header: ProfileSourceManifestHeader,
) -> Result<VerificationState, RuntimeError> {
    let digest = header.digest()?;
    let cursor = bittery_crypto_core::generate_uuid();
    let started = ProfileSourceVerificationResult::Started {
        verification_cursor: cursor.clone(),
        next_index: 0,
    };
    Ok(VerificationState {
        mode,
        attempt_id,
        header,
        started,
        cursor,
        digest: Some(digest),
        next_index: 0,
        previous_entry: None,
        terminal_result: None,
        finish_cursor: None,
        provisional: ProvisionalCapture::default(),
    })
}

fn entry_is_canonical(
    index: u64,
    entry: &ProfileSourceManifestEntry,
    previous: Option<&ProfileSourceManifestEntry>,
) -> bool {
    if entry.version != 1 {
        return false;
    }
    match index {
        0 => {
            entry.family == ProfileSourceFamily::DesktopStore
                && entry.selector == ProfileSourceSelector::WholeFile {}
        }
        1 => {
            entry.family == ProfileSourceFamily::DesktopSyncStore
                && entry.selector == ProfileSourceSelector::WholeFile {}
        }
        2 => {
            entry.family == ProfileSourceFamily::DesktopCredentials
                && entry.selector
                    == ProfileSourceSelector::GlobalCredential {
                        field: ProfileGlobalCredentialField::DeviceKey,
                    }
        }
        _ => {
            if entry.family != ProfileSourceFamily::DesktopCredentials {
                return false;
            }
            let ProfileSourceSelector::AccountCredential { account_id, field } = &entry.selector
            else {
                return false;
            };
            let position = (index - 3) % 5;
            let expected_field = match position {
                0 => ProfileAccountCredentialField::SecretKey,
                1 => ProfileAccountCredentialField::SessionData,
                2 => ProfileAccountCredentialField::JwtToken,
                3 => ProfileAccountCredentialField::VaultKeys,
                _ => ProfileAccountCredentialField::EncryptedPrivateKey,
            };
            if *field != expected_field {
                return false;
            }
            let Some(ProfileSourceManifestEntry {
                selector:
                    ProfileSourceSelector::AccountCredential {
                        account_id: previous_account,
                        ..
                    },
                ..
            }) = previous
            else {
                return position == 0 && index == 3;
            };
            if position == 0 {
                previous_account.as_str().as_bytes() < account_id.as_str().as_bytes()
            } else {
                previous_account == account_id
            }
        }
    }
}

fn observe_entry(
    capability: &ProfileCapability,
    expected: &ProfileSourceManifestEntry,
) -> ObservedEntry {
    match current_profile_identity(capability) {
        ProfileIdentityStatus::Match => {}
        ProfileIdentityStatus::Changed => return ObservedEntry::Changed,
        ProfileIdentityStatus::Unavailable => return ObservedEntry::Unavailable,
    }
    match expected.family {
        ProfileSourceFamily::DesktopStore | ProfileSourceFamily::DesktopSyncStore => {
            observe_file_entry(capability, expected)
        }
        ProfileSourceFamily::DesktopCredentials => observe_credential_entry(capability, expected),
        _ => ObservedEntry::Unavailable,
    }
}

fn observe_file_entry(
    capability: &ProfileCapability,
    expected: &ProfileSourceManifestEntry,
) -> ObservedEntry {
    let path = match expected.family {
        ProfileSourceFamily::DesktopStore => capability.directory.join("store.json"),
        ProfileSourceFamily::DesktopSyncStore => capability.directory.join("sync-store.json"),
        _ => return ObservedEntry::Unavailable,
    };
    let file = match open_source_file(&path) {
        Ok(file) => file,
        Err(_) => return ObservedEntry::Unavailable,
    };
    let Some(file) = file else {
        return match ProfileSourceManifestEntry::from_evidence(
            LegacyProfileFormat::DesktopLegacyV1,
            expected.family,
            expected.selector.clone(),
            ProfileSourceObservation::Missing {},
            None,
            &[],
        ) {
            Ok(observed) if observed == *expected => {
                ObservedEntry::Matched(ObservedRetention::File(None))
            }
            _ => ObservedEntry::Changed,
        };
    };
    if expected.file_identity.as_deref() != Some(&file.file_identity)
        || expected.observation
            != (ProfileSourceObservation::FileBytes {
                length: file.length,
            })
    {
        return ObservedEntry::Changed;
    }
    let mut digest = match expected.evidence_digest(LegacyProfileFormat::DesktopLegacyV1) {
        Ok(digest) => digest,
        Err(_) => return ObservedEntry::Unavailable,
    };
    let mut offset = 0_u64;
    while offset < file.length {
        let length = (file.length - offset).min(PROFILE_SOURCE_BINARY_BYTES as u64) as usize;
        let mut bytes = Zeroizing::new(vec![0; length]);
        if read_exact_at(&file.file, &mut bytes, offset).is_err() || digest.update(&bytes).is_err()
        {
            return ObservedEntry::Unavailable;
        }
        offset += length as u64;
    }
    let mut extra = [0_u8; 1];
    match read_once_at(&file.file, &mut extra, file.length) {
        Ok(0) => {}
        Ok(_) => return ObservedEntry::Changed,
        Err(_) => return ObservedEntry::Unavailable,
    }
    match digest.finish() {
        Ok(actual) if actual == expected.evidence_sha256 => {
            ObservedEntry::Matched(ObservedRetention::File(Some(file)))
        }
        Ok(_) => ObservedEntry::Changed,
        Err(_) => ObservedEntry::Unavailable,
    }
}

fn observe_credential_entry(
    capability: &ProfileCapability,
    expected: &ProfileSourceManifestEntry,
) -> ObservedEntry {
    let raw = match capability.vault.read_fresh_source() {
        Ok(raw) => raw.map(Arc::new),
        Err(_) => return ObservedEntry::Unavailable,
    };
    let selected =
        match extract_credential(raw.as_ref().map(|value| value.as_str()), &expected.selector) {
            Ok(selected) => selected,
            Err(_) => return ObservedEntry::Unavailable,
        };
    let observed = match selected {
        None => ProfileSourceManifestEntry::from_evidence(
            LegacyProfileFormat::DesktopLegacyV1,
            ProfileSourceFamily::DesktopCredentials,
            expected.selector.clone(),
            ProfileSourceObservation::Missing {},
            None,
            &[],
        ),
        Some(CredentialValue::StoredString(value)) => ProfileSourceManifestEntry::from_evidence(
            LegacyProfileFormat::DesktopLegacyV1,
            ProfileSourceFamily::DesktopCredentials,
            expected.selector.clone(),
            ProfileSourceObservation::StoredString {
                encoding: ProfileSourceStringEncoding::Utf8,
                length: value.len() as u64,
            },
            None,
            value.as_bytes(),
        ),
        Some(CredentialValue::PresentUnsupported(_)) => return ObservedEntry::Changed,
    };
    match observed {
        Ok(observed) if observed == *expected => {
            ObservedEntry::Matched(ObservedRetention::Credentials(raw))
        }
        Ok(_) => ObservedEntry::Changed,
        Err(_) => ObservedEntry::Unavailable,
    }
}

fn apply_observed_entry(
    slot: &Slot,
    mode: VerificationMode,
    cursor: String,
    index: u64,
    expected_entry: ProfileSourceManifestEntry,
    observed: ObservedEntry,
) -> Result<ProfileSourceVerificationResult, RuntimeError> {
    let mut state = slot.state.lock().map_err(|_| unavailable())?;
    let verification = state.verification.as_mut().ok_or_else(unavailable)?;
    if verification.mode != mode {
        return Err(unavailable());
    }
    if let Some(receipt) = &verification.previous_entry {
        if receipt.cursor == cursor
            && receipt.index == index
            && receipt.expected_entry == expected_entry
        {
            return Ok(receipt.result.clone());
        }
    }
    if verification.terminal_result.is_some()
        || verification.cursor != cursor
        || verification.next_index != index
    {
        return Err(unavailable());
    }
    let result = match observed {
        ObservedEntry::Matched(retention) => {
            verification
                .digest
                .as_mut()
                .ok_or_else(unavailable)?
                .append(&expected_entry)?;
            if mode == VerificationMode::Reopen {
                match (expected_entry.family, retention) {
                    (ProfileSourceFamily::DesktopStore, ObservedRetention::File(file)) => {
                        verification.provisional.store = Some(file);
                    }
                    (ProfileSourceFamily::DesktopSyncStore, ObservedRetention::File(file)) => {
                        verification.provisional.sync_store = Some(file);
                    }
                    (
                        ProfileSourceFamily::DesktopCredentials,
                        ObservedRetention::Credentials(credentials),
                    ) => {
                        verification.provisional.credentials = Some(credentials);
                    }
                    _ => return Err(unavailable()),
                }
            }
            verification.next_index += 1;
            verification.cursor = bittery_crypto_core::generate_uuid();
            ProfileSourceVerificationResult::Matched {
                verification_cursor: verification.cursor.clone(),
                next_index: verification.next_index,
            }
        }
        ObservedEntry::Changed => {
            let result = ProfileSourceVerificationResult::Changed {};
            verification.terminal_result = Some(result.clone());
            result
        }
        ObservedEntry::Unavailable => {
            let result = ProfileSourceVerificationResult::Unavailable {};
            verification.terminal_result = Some(result.clone());
            result
        }
    };
    verification.previous_entry = Some(VerificationReceipt {
        cursor,
        index,
        expected_entry,
        result: result.clone(),
    });
    Ok(result)
}

fn apply_cleanup_reopen_entry(
    slot: &Slot,
    cursor: String,
    index: u64,
    expected_entry: ProfileSourceManifestEntry,
    accepted: bool,
) -> Result<ProfileSourceCleanupReopenResult, RuntimeError> {
    let mut state = slot.state.lock().map_err(|_| unavailable())?;
    let cleanup = state.cleanup.as_mut().ok_or_else(unavailable)?;
    if let Some(receipt) = &cleanup.previous_entry {
        if receipt.cursor == cursor
            && receipt.index == index
            && receipt.expected_entry == expected_entry
        {
            return Ok(receipt.result.clone());
        }
    }
    if cleanup.terminal_result.is_some() || cleanup.cursor != cursor || cleanup.next_index != index
    {
        return Err(unavailable());
    }
    let result = if accepted {
        cleanup
            .digest
            .as_mut()
            .ok_or_else(unavailable)?
            .append(&expected_entry)?;
        cleanup.expected_entries.push(expected_entry.clone());
        cleanup.next_index += 1;
        cleanup.cursor = bittery_crypto_core::generate_uuid();
        ProfileSourceCleanupReopenResult::Accepted {
            verification_cursor: cleanup.cursor.clone(),
            next_index: cleanup.next_index,
        }
    } else {
        let result = ProfileSourceCleanupReopenResult::Unavailable {};
        cleanup.terminal_result = Some(result.clone());
        result
    };
    cleanup.previous_entry = Some(CleanupVerificationReceipt {
        cursor,
        index,
        expected_entry,
        result: result.clone(),
    });
    Ok(result)
}

fn delete_source_entry(
    capability: &ProfileCapability,
    expected: &ProfileSourceManifestEntry,
    #[cfg(test)] page_barrier: Option<&TestPageBarrier>,
) -> Result<ProfileSourceDeleteResult, RuntimeError> {
    if !matches!(
        current_profile_identity(capability),
        ProfileIdentityStatus::Match
    ) {
        return Ok(ProfileSourceDeleteResult::Unavailable {});
    }
    let result = match expected.family {
        ProfileSourceFamily::DesktopStore | ProfileSourceFamily::DesktopSyncStore => {
            delete_file_entry(
                capability,
                expected,
                #[cfg(test)]
                page_barrier,
            )
        }
        ProfileSourceFamily::DesktopCredentials => delete_credential_entry(capability, expected),
        _ => Ok(ProfileSourceDeleteResult::Unavailable {}),
    }?;
    if matches!(
        current_profile_identity(capability),
        ProfileIdentityStatus::Match
    ) {
        Ok(result)
    } else {
        Ok(ProfileSourceDeleteResult::Unavailable {})
    }
}

fn source_file_path(
    capability: &ProfileCapability,
    family: ProfileSourceFamily,
) -> Option<PathBuf> {
    match family {
        ProfileSourceFamily::DesktopStore => Some(capability.directory.join("store.json")),
        ProfileSourceFamily::DesktopSyncStore => Some(capability.directory.join("sync-store.json")),
        _ => None,
    }
}

fn delete_file_entry(
    capability: &ProfileCapability,
    expected: &ProfileSourceManifestEntry,
    #[cfg(test)] page_barrier: Option<&TestPageBarrier>,
) -> Result<ProfileSourceDeleteResult, RuntimeError> {
    let path = source_file_path(capability, expected.family).ok_or_else(unavailable)?;
    let observed = observe_file_entry(capability, expected);
    let held_file = match observed {
        ObservedEntry::Matched(ObservedRetention::File(Some(file))) => file,
        ObservedEntry::Matched(_) => return Ok(ProfileSourceDeleteResult::AlreadyAbsent {}),
        ObservedEntry::Changed => {
            return match open_source_file(&path) {
                Ok(None) => Ok(ProfileSourceDeleteResult::AlreadyAbsent {}),
                Ok(Some(_)) => Ok(ProfileSourceDeleteResult::Changed {}),
                Err(_) => Ok(ProfileSourceDeleteResult::Unavailable {}),
            };
        }
        ObservedEntry::Unavailable => return Ok(ProfileSourceDeleteResult::Unavailable {}),
    };
    #[cfg(test)]
    if let Some(barrier) = page_barrier {
        barrier.page_completed_and_wait();
    }
    // Reacquire and completely prove the fixed path immediately before unlink. The first reader
    // above remains useful for Close/drain ownership and tests, but never authorizes deletion after
    // blocking work or a path/content change.
    let file = match observe_file_entry(capability, expected) {
        ObservedEntry::Matched(ObservedRetention::File(Some(file))) => file,
        ObservedEntry::Matched(_) => return Ok(ProfileSourceDeleteResult::AlreadyAbsent {}),
        ObservedEntry::Changed => {
            return match open_source_file(&path) {
                Ok(None) => Ok(ProfileSourceDeleteResult::AlreadyAbsent {}),
                Ok(Some(_)) => Ok(ProfileSourceDeleteResult::Changed {}),
                Err(_) => Ok(ProfileSourceDeleteResult::Unavailable {}),
            };
        }
        ObservedEntry::Unavailable => return Ok(ProfileSourceDeleteResult::Unavailable {}),
    };
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ProfileSourceDeleteResult::AlreadyAbsent {});
        }
        Err(_) => return Ok(ProfileSourceDeleteResult::Unavailable {}),
    }
    drop(held_file);
    drop(file);
    match open_source_file(&path) {
        Ok(None) => Ok(ProfileSourceDeleteResult::Deleted {}),
        Ok(Some(_)) => Ok(ProfileSourceDeleteResult::Unavailable {}),
        Err(_) => Ok(ProfileSourceDeleteResult::Unavailable {}),
    }
}

fn delete_credential_entry(
    capability: &ProfileCapability,
    expected: &ProfileSourceManifestEntry,
) -> Result<ProfileSourceDeleteResult, RuntimeError> {
    if !matches!(
        expected.observation,
        ProfileSourceObservation::StoredString { .. }
    ) {
        return Ok(ProfileSourceDeleteResult::Changed {});
    }
    let key = credential_key(&expected.selector)?;
    let result = match capability
        .vault
        .compare_delete_fresh_source_string(&key, |value| {
            ProfileSourceManifestEntry::from_evidence(
                LegacyProfileFormat::DesktopLegacyV1,
                ProfileSourceFamily::DesktopCredentials,
                expected.selector.clone(),
                ProfileSourceObservation::StoredString {
                    encoding: ProfileSourceStringEncoding::Utf8,
                    length: value.len() as u64,
                },
                None,
                value.as_bytes(),
            )
            .map(|observed| observed == *expected)
            .map_err(|_| "Invalid protected credential evidence".to_owned())
        }) {
        Ok(result) => result,
        Err(_) => return Ok(ProfileSourceDeleteResult::Unavailable {}),
    };
    Ok(match result {
        FreshSourceDeleteResult::Deleted => ProfileSourceDeleteResult::Deleted {},
        FreshSourceDeleteResult::AlreadyAbsent => ProfileSourceDeleteResult::AlreadyAbsent {},
        FreshSourceDeleteResult::Changed => ProfileSourceDeleteResult::Changed {},
    })
}

fn reset_file_namespace(
    capability: &ProfileCapability,
    family: ProfileSourceFamily,
) -> Option<String> {
    let name = match family {
        ProfileSourceFamily::DesktopStore => "store.json",
        ProfileSourceFamily::DesktopSyncStore => "sync-store.json",
        _ => return None,
    };
    Some(format!(
        "desktop-reset-file-v1:{}:{name}",
        capability.profile_identity
    ))
}

fn current_reset_scope(
    capability: &ProfileCapability,
) -> Result<ProfileLegacyResetScope, ProfileResetPreparedResult> {
    match current_profile_identity(capability) {
        ProfileIdentityStatus::Match => {}
        ProfileIdentityStatus::Changed => return Err(ProfileResetPreparedResult::Changed {}),
        ProfileIdentityStatus::Unavailable => {
            return Err(ProfileResetPreparedResult::Unavailable {});
        }
    }
    let mut families = Vec::with_capacity(3);
    for family in [
        ProfileSourceFamily::DesktopStore,
        ProfileSourceFamily::DesktopSyncStore,
    ] {
        let path = source_file_path(capability, family)
            .ok_or(ProfileResetPreparedResult::Unavailable {})?;
        let file =
            open_source_file(&path).map_err(|_| ProfileResetPreparedResult::Unavailable {})?;
        families.push(ProfileResetFamilyScope {
            family,
            namespace_identity: reset_file_namespace(capability, family)
                .ok_or(ProfileResetPreparedResult::Unavailable {})?,
            selector_plan_version: 1,
            file: match file {
                Some(file) => ProfileResetFileBinding::Present {
                    file_identity: file.file_identity,
                },
                None => ProfileResetFileBinding::Absent {},
            },
        });
    }
    families.push(ProfileResetFamilyScope {
        family: ProfileSourceFamily::DesktopCredentials,
        namespace_identity: capability.vault.namespace_identity().to_owned(),
        selector_plan_version: 1,
        file: ProfileResetFileBinding::NotFile {},
    });
    if !matches!(
        current_profile_identity(capability),
        ProfileIdentityStatus::Match
    ) {
        return Err(ProfileResetPreparedResult::Changed {});
    }
    let scope = ProfileLegacyResetScope {
        version: 1,
        format: LegacyProfileFormat::DesktopLegacyV1,
        profile_identity: capability.profile_identity.clone(),
        families,
    };
    scope
        .validate()
        .map_err(|_| ProfileResetPreparedResult::Unavailable {})?;
    Ok(scope)
}

fn expected_reset_scope_matches(
    capability: &ProfileCapability,
    expected: &ProfileLegacyResetScope,
) -> Result<(), ProfileResetPreparedResult> {
    if expected.profile_identity != capability.profile_identity
        || expected.format != LegacyProfileFormat::DesktopLegacyV1
        || expected.families.len() != 3
    {
        return Err(ProfileResetPreparedResult::Changed {});
    }
    match current_profile_identity(capability) {
        ProfileIdentityStatus::Match => {}
        ProfileIdentityStatus::Changed => return Err(ProfileResetPreparedResult::Changed {}),
        ProfileIdentityStatus::Unavailable => {
            return Err(ProfileResetPreparedResult::Unavailable {});
        }
    }
    for family_scope in &expected.families {
        let namespace_matches = match family_scope.family {
            ProfileSourceFamily::DesktopStore | ProfileSourceFamily::DesktopSyncStore => {
                reset_file_namespace(capability, family_scope.family).as_deref()
                    == Some(family_scope.namespace_identity.as_str())
            }
            ProfileSourceFamily::DesktopCredentials => {
                capability.vault.namespace_identity() == family_scope.namespace_identity
            }
            _ => false,
        };
        if !namespace_matches || family_scope.selector_plan_version != 1 {
            return Err(ProfileResetPreparedResult::Changed {});
        }
        if matches!(
            family_scope.family,
            ProfileSourceFamily::DesktopStore | ProfileSourceFamily::DesktopSyncStore
        ) {
            let Some(path) = source_file_path(capability, family_scope.family) else {
                return Err(ProfileResetPreparedResult::Unavailable {});
            };
            let current = match open_source_file(&path) {
                Ok(current) => current,
                Err(_) => return Err(ProfileResetPreparedResult::Unavailable {}),
            };
            match (&family_scope.file, current) {
                (ProfileResetFileBinding::Absent {}, None) => {}
                (ProfileResetFileBinding::Absent {}, Some(_)) => {
                    return Err(ProfileResetPreparedResult::Changed {});
                }
                (ProfileResetFileBinding::Present { .. }, None) => {}
                (ProfileResetFileBinding::Present { file_identity }, Some(current))
                    if *file_identity == current.file_identity => {}
                (ProfileResetFileBinding::Present { .. }, Some(_)) => {
                    return Err(ProfileResetPreparedResult::Changed {});
                }
                _ => return Err(ProfileResetPreparedResult::Unavailable {}),
            }
        } else if !matches!(family_scope.file, ProfileResetFileBinding::NotFile {}) {
            return Err(ProfileResetPreparedResult::Unavailable {});
        }
    }
    match current_profile_identity(capability) {
        ProfileIdentityStatus::Match => {}
        ProfileIdentityStatus::Changed => return Err(ProfileResetPreparedResult::Changed {}),
        ProfileIdentityStatus::Unavailable => {
            return Err(ProfileResetPreparedResult::Unavailable {});
        }
    }
    Ok(())
}

fn prepare_reset_result(
    slot: &Slot,
    wipe_id: &str,
    expected_scope: Option<&ProfileLegacyResetScope>,
) -> ProfileResetPreparedResult {
    let scope = if let Some(expected) = expected_scope {
        match expected_reset_scope_matches(&slot.capability, expected) {
            Ok(()) => expected.clone(),
            Err(result) => return result,
        }
    } else {
        match current_reset_scope(&slot.capability) {
            Ok(scope) => scope,
            Err(result) => return result,
        }
    };
    ProfileResetPreparedResult::Prepared {
        snapshot: ProfileResetSnapshot {
            reset_handle: slot.handle.clone(),
            wipe_id: wipe_id.to_owned(),
            scope,
        },
    }
}

fn reset_source_family(
    capability: &ProfileCapability,
    scope: &ProfileResetFamilyScope,
    #[cfg(test)] page_barrier: Option<&TestPageBarrier>,
) -> Result<ProfileResetResult, RuntimeError> {
    if !matches!(
        current_profile_identity(capability),
        ProfileIdentityStatus::Match
    ) {
        return Ok(ProfileResetResult::Unavailable {});
    }
    let result = match scope.family {
        ProfileSourceFamily::DesktopStore | ProfileSourceFamily::DesktopSyncStore => {
            reset_file_family(
                capability,
                scope,
                #[cfg(test)]
                page_barrier,
            )
        }
        ProfileSourceFamily::DesktopCredentials => {
            if scope.namespace_identity != capability.vault.namespace_identity()
                || !matches!(scope.file, ProfileResetFileBinding::NotFile {})
            {
                Ok(ProfileResetResult::Changed {})
            } else {
                Ok(match capability.vault.reset_legacy_source_credentials() {
                    Ok(FreshSourceResetResult::Reset) => ProfileResetResult::Reset {},
                    Ok(FreshSourceResetResult::AlreadyAbsent) => {
                        ProfileResetResult::AlreadyAbsent {}
                    }
                    Err(_) => ProfileResetResult::Unavailable {},
                })
            }
        }
        _ => Ok(ProfileResetResult::Unavailable {}),
    }?;
    if matches!(
        current_profile_identity(capability),
        ProfileIdentityStatus::Match
    ) {
        Ok(result)
    } else {
        Ok(ProfileResetResult::Unavailable {})
    }
}

fn reset_file_family(
    capability: &ProfileCapability,
    scope: &ProfileResetFamilyScope,
    #[cfg(test)] page_barrier: Option<&TestPageBarrier>,
) -> Result<ProfileResetResult, RuntimeError> {
    if reset_file_namespace(capability, scope.family).as_deref()
        != Some(scope.namespace_identity.as_str())
    {
        return Ok(ProfileResetResult::Changed {});
    }
    let path = source_file_path(capability, scope.family).ok_or_else(unavailable)?;
    let expected_identity = match &scope.file {
        ProfileResetFileBinding::Absent {} => {
            return match open_source_file(&path) {
                Ok(None) => Ok(ProfileResetResult::AlreadyAbsent {}),
                Ok(Some(_)) => Ok(ProfileResetResult::Changed {}),
                Err(_) => Ok(ProfileResetResult::Unavailable {}),
            };
        }
        ProfileResetFileBinding::Present { file_identity } => file_identity,
        ProfileResetFileBinding::NotFile {} => return Ok(ProfileResetResult::Unavailable {}),
    };
    let held = match open_source_file(&path) {
        Ok(None) => return Ok(ProfileResetResult::AlreadyAbsent {}),
        Ok(Some(file)) if file.file_identity == *expected_identity => file,
        Ok(Some(_)) => return Ok(ProfileResetResult::Changed {}),
        Err(_) => return Ok(ProfileResetResult::Unavailable {}),
    };
    #[cfg(test)]
    if let Some(barrier) = page_barrier {
        barrier.page_completed_and_wait();
    }
    let final_file = match open_source_file(&path) {
        Ok(None) => return Ok(ProfileResetResult::AlreadyAbsent {}),
        Ok(Some(file)) if file.file_identity == *expected_identity => file,
        Ok(Some(_)) => return Ok(ProfileResetResult::Changed {}),
        Err(_) => return Ok(ProfileResetResult::Unavailable {}),
    };
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ProfileResetResult::AlreadyAbsent {});
        }
        Err(_) => return Ok(ProfileResetResult::Unavailable {}),
    }
    drop(held);
    drop(final_file);
    match open_source_file(&path) {
        Ok(None) => Ok(ProfileResetResult::Reset {}),
        Ok(Some(_)) | Err(_) => Ok(ProfileResetResult::Unavailable {}),
    }
}

fn take_reopen_parts(verification: &mut VerificationState) -> Result<ReopenParts, RuntimeError> {
    let store = verification
        .provisional
        .store
        .take()
        .ok_or_else(unavailable)?;
    let sync_store = verification
        .provisional
        .sync_store
        .take()
        .ok_or_else(unavailable)?;
    let credentials = verification
        .provisional
        .credentials
        .take()
        .ok_or_else(unavailable)?;
    Ok((store, sync_store, credentials))
}

impl Slot {
    fn capture(&self) -> Result<Capture, RuntimeError> {
        if !matches!(
            current_profile_identity(&self.capability),
            ProfileIdentityStatus::Match
        ) {
            return Err(unavailable());
        }
        let store = open_source_file(&self.capability.directory.join("store.json"))?;
        let sync_store = open_source_file(&self.capability.directory.join("sync-store.json"))?;
        let credentials = self
            .capability
            .vault
            .read_fresh_source()
            .map_err(|_| unavailable())?;
        if !matches!(
            current_profile_identity(&self.capability),
            ProfileIdentityStatus::Match
        ) {
            return Err(unavailable());
        }
        Ok(capture_from_parts(
            self,
            store,
            sync_store,
            credentials.map(Arc::new),
        ))
    }
}

fn capture_from_parts(
    slot: &Slot,
    store: Option<SourceFile>,
    sync_store: Option<SourceFile>,
    credentials: Option<Arc<Zeroizing<String>>>,
) -> Capture {
    let families = [
        (
            ProfileSourceFamily::DesktopStore,
            store.as_ref().map(|file| file.file_identity.clone()),
            store.is_some(),
        ),
        (
            ProfileSourceFamily::DesktopSyncStore,
            sync_store.as_ref().map(|file| file.file_identity.clone()),
            sync_store.is_some(),
        ),
        (
            ProfileSourceFamily::DesktopCredentials,
            None,
            credentials.is_some(),
        ),
    ]
    .into_iter()
    .map(
        |(family, file_identity, present)| ProfileSourceFamilyInventory {
            family,
            presence: if present {
                ProfileSourcePresence::Present
            } else {
                ProfileSourcePresence::Missing
            },
            file_identity,
        },
    )
    .collect();
    Capture {
        snapshot: ProfileSourceSnapshot {
            format: LegacyProfileFormat::DesktopLegacyV1,
            snapshot_handle: slot.handle.clone(),
            profile_identity: slot.capability.profile_identity.clone(),
            capture_id: slot.capture_id.clone(),
            families,
            session_instance: None,
        },
        store,
        sync_store,
        credentials,
    }
}

fn open_source_file(path: &Path) -> Result<Option<SourceFile>, RuntimeError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A FIFO must not occupy the blocking pool indefinitely, and a symlink is not a fixed
        // profile source. Only a regular file (or genuine absence) is an admitted reader.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(unavailable()),
    };
    let metadata = file.metadata().map_err(|_| unavailable())?;
    if !metadata.is_file() {
        return Err(unavailable());
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::MetadataExt;
        let file_identity = format!("linux-v1:{}:{}", metadata.dev(), metadata.ino());
        Ok(Some(SourceFile {
            file: Arc::new(file),
            length: metadata.len(),
            file_identity,
        }))
    }
    #[cfg(not(target_os = "linux"))]
    Err(unavailable())
}

fn read_file_page(
    file: Option<SourceFile>,
    handle: String,
    family: ProfileSourceFamily,
    selector: ProfileSourceSelector,
    offset: u64,
    page_bytes: usize,
) -> EncodedSourceResult {
    let (observation, binary, continuation) = match file {
        None => (
            ProfileSourceObservation::Missing {},
            None,
            ProfileSourceContinuation::End {},
        ),
        Some(file) => {
            let remaining = file.length.checked_sub(offset).ok_or_else(unavailable)?;
            let length = remaining.min(page_bytes as u64) as usize;
            let mut bytes = Zeroizing::new(vec![0; length]);
            read_exact_at(&file.file, &mut bytes, offset)?;
            let end = offset.checked_add(length as u64).ok_or_else(unavailable)?;
            let continuation = if end == file.length {
                ProfileSourceContinuation::End {}
            } else {
                ProfileSourceContinuation::More {
                    cursor: PageCursor {
                        version: 1,
                        handle: handle.clone(),
                        family,
                        selector: selector.clone(),
                        offset: end,
                    }
                    .encode()?,
                }
            };
            (
                ProfileSourceObservation::FileBytes {
                    length: file.length,
                },
                Some(bytes),
                continuation,
            )
        }
    };
    let page = ProfileSourcePage {
        snapshot_handle: handle.clone(),
        family,
        selector: selector.clone(),
        observation,
        offset,
        byte_length: binary.as_ref().map_or(0, |bytes| bytes.len() as u64),
        continuation,
    };
    page.validate_for(
        &handle,
        family,
        &selector,
        offset,
        None,
        binary.as_ref().map(|bytes| bytes.as_slice()),
    )?;
    encode_response(ProfileAdmissionResponse::SourcePage(page), binary)
}

struct DiscardedCredentialValue;

impl<'de> Deserialize<'de> for DiscardedCredentialValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct DiscardedCredentialVisitor;

        impl<'de> Visitor<'de> for DiscardedCredentialVisitor {
            type Value = DiscardedCredentialValue;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a structurally valid protected map value")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                drop(Zeroizing::new(value.to_owned()));
                Ok(DiscardedCredentialValue)
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                drop(Zeroizing::new(value));
                Ok(DiscardedCredentialValue)
            }

            fn visit_none<E>(self) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(DiscardedCredentialValue)
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(DiscardedCredentialValue)
            }

            fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(DiscardedCredentialValue)
            }

            fn visit_i64<E>(self, _: i64) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(DiscardedCredentialValue)
            }

            fn visit_u64<E>(self, _: u64) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(DiscardedCredentialValue)
            }

            fn visit_f64<E>(self, _: f64) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(DiscardedCredentialValue)
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                while sequence
                    .next_element::<DiscardedCredentialValue>()?
                    .is_some()
                {}
                Ok(DiscardedCredentialValue)
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                while let Some(key) = map.next_key::<String>()? {
                    drop(Zeroizing::new(key));
                    map.next_value::<DiscardedCredentialValue>()?;
                }
                Ok(DiscardedCredentialValue)
            }
        }

        deserializer.deserialize_any(DiscardedCredentialVisitor)
    }
}

enum CredentialValue {
    StoredString(Zeroizing<String>),
    PresentUnsupported(ProfileSourceValueKind),
}

impl<'de> Deserialize<'de> for CredentialValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct CredentialValueVisitor;

        impl<'de> Visitor<'de> for CredentialValueVisitor {
            type Value = CredentialValue;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("any protected credential map value")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(CredentialValue::StoredString(Zeroizing::new(
                    value.to_owned(),
                )))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(CredentialValue::StoredString(Zeroizing::new(value)))
            }

            fn visit_none<E>(self) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(CredentialValue::PresentUnsupported(
                    ProfileSourceValueKind::Null,
                ))
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                self.visit_none()
            }

            fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(CredentialValue::PresentUnsupported(
                    ProfileSourceValueKind::Boolean,
                ))
            }

            fn visit_i64<E>(self, _: i64) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(CredentialValue::PresentUnsupported(
                    ProfileSourceValueKind::Number,
                ))
            }

            fn visit_u64<E>(self, _: u64) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(CredentialValue::PresentUnsupported(
                    ProfileSourceValueKind::Number,
                ))
            }

            fn visit_f64<E>(self, _: f64) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(CredentialValue::PresentUnsupported(
                    ProfileSourceValueKind::Number,
                ))
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                while sequence
                    .next_element::<DiscardedCredentialValue>()?
                    .is_some()
                {}
                Ok(CredentialValue::PresentUnsupported(
                    ProfileSourceValueKind::Array,
                ))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                while let Some(key) = map.next_key::<String>()? {
                    drop(Zeroizing::new(key));
                    map.next_value::<DiscardedCredentialValue>()?;
                }
                Ok(CredentialValue::PresentUnsupported(
                    ProfileSourceValueKind::Object,
                ))
            }
        }

        deserializer.deserialize_any(CredentialValueVisitor)
    }
}

struct SelectedCredential<'a> {
    key: &'a str,
}

impl<'de> Visitor<'de> for SelectedCredential<'_> {
    type Value = Option<CredentialValue>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a protected credential map with unique string keys")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut selected = None;
        let mut seen = HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !seen.insert(key.clone()) {
                return Err(serde::de::Error::custom("duplicate protected map key"));
            }
            if key == self.key {
                selected = Some(map.next_value::<CredentialValue>()?);
            } else {
                map.next_value::<DiscardedCredentialValue>()?;
            }
        }
        Ok(selected)
    }
}

fn credential_key(selector: &ProfileSourceSelector) -> Result<String, RuntimeError> {
    let key = match selector {
        ProfileSourceSelector::GlobalCredential {
            field: ProfileGlobalCredentialField::DeviceKey,
        } => "bittery_device_key".to_owned(),
        ProfileSourceSelector::AccountCredential { account_id, field } => {
            let field = match field {
                ProfileAccountCredentialField::SecretKey => "secret_key",
                ProfileAccountCredentialField::SessionData => "session_data",
                ProfileAccountCredentialField::JwtToken => "jwt_token",
                ProfileAccountCredentialField::VaultKeys => "vault_keys",
                ProfileAccountCredentialField::EncryptedPrivateKey => "encrypted_private_key",
            };
            format!("bittery_account_{}_{field}", account_id.as_str())
        }
        ProfileSourceSelector::WholeFile {} => return Err(unavailable()),
    };
    Ok(key)
}

fn extract_credential(
    raw: Option<&str>,
    selector: &ProfileSourceSelector,
) -> Result<Option<CredentialValue>, RuntimeError> {
    let Some(raw) = raw else { return Ok(None) };
    let key = credential_key(selector)?;
    let mut decoder = serde_json::Deserializer::from_str(raw);
    let selected =
        serde::Deserializer::deserialize_map(&mut decoder, SelectedCredential { key: &key })
            .map_err(|_| unavailable())?;
    decoder.end().map_err(|_| unavailable())?;
    Ok(selected)
}

fn read_credential_page(
    credentials: Option<Arc<Zeroizing<String>>>,
    handle: String,
    family: ProfileSourceFamily,
    selector: ProfileSourceSelector,
    offset: u64,
    page_bytes: usize,
) -> EncodedSourceResult {
    let selected = extract_credential(credentials.as_ref().map(|value| value.as_str()), &selector)?;
    let (observation, binary, continuation) = match selected {
        None => {
            if offset != 0 {
                return Err(unavailable());
            }
            (
                ProfileSourceObservation::Missing {},
                None,
                ProfileSourceContinuation::End {},
            )
        }
        Some(CredentialValue::PresentUnsupported(value_kind)) => {
            if offset != 0 {
                return Err(unavailable());
            }
            (
                ProfileSourceObservation::PresentUnsupported { value_kind },
                None,
                ProfileSourceContinuation::End {},
            )
        }
        Some(CredentialValue::StoredString(value)) => {
            let total = value.len() as u64;
            if offset > total || (offset == total && offset != 0) {
                return Err(unavailable());
            }
            let remaining = total.checked_sub(offset).ok_or_else(unavailable)?;
            let length = remaining.min(page_bytes as u64) as usize;
            let start = usize::try_from(offset).map_err(|_| unavailable())?;
            let end = start.checked_add(length).ok_or_else(unavailable)?;
            let bytes = Zeroizing::new(value.as_bytes()[start..end].to_vec());
            let continuation = if end == value.len() {
                ProfileSourceContinuation::End {}
            } else {
                ProfileSourceContinuation::More {
                    cursor: PageCursor {
                        version: 1,
                        handle: handle.clone(),
                        family,
                        selector: selector.clone(),
                        offset: end as u64,
                    }
                    .encode()?,
                }
            };
            (
                ProfileSourceObservation::StoredString {
                    encoding: ProfileSourceStringEncoding::Utf8,
                    length: total,
                },
                Some(bytes),
                continuation,
            )
        }
    };
    let page = ProfileSourcePage {
        snapshot_handle: handle.clone(),
        family,
        selector: selector.clone(),
        observation,
        offset,
        byte_length: binary.as_ref().map_or(0, |bytes| bytes.len() as u64),
        continuation,
    };
    page.validate_for(
        &handle,
        family,
        &selector,
        offset,
        None,
        binary.as_ref().map(|bytes| bytes.as_slice()),
    )?;
    encode_response(ProfileAdmissionResponse::SourcePage(page), binary)
}

fn read_exact_at(file: &File, bytes: &mut [u8], mut offset: u64) -> Result<(), RuntimeError> {
    let mut remaining = bytes;
    while !remaining.is_empty() {
        // Positional I/O has no shared seek cursor, including concurrent/repeated pages.
        #[cfg(unix)]
        let read = {
            use std::os::unix::fs::FileExt;
            file.read_at(remaining, offset)
        };
        #[cfg(windows)]
        let read = {
            use std::os::windows::fs::FileExt;
            file.seek_read(remaining, offset)
        };
        #[cfg(not(any(unix, windows)))]
        let read: std::io::Result<usize> = Err(std::io::ErrorKind::Unsupported.into());
        match read {
            Ok(0) => return Err(unavailable()),
            Ok(length) => {
                offset = offset.checked_add(length as u64).ok_or_else(unavailable)?;
                remaining = &mut remaining[length..];
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(unavailable()),
        }
    }
    Ok(())
}

fn read_once_at(file: &File, bytes: &mut [u8], offset: u64) -> std::io::Result<usize> {
    loop {
        #[cfg(unix)]
        let read = {
            use std::os::unix::fs::FileExt;
            file.read_at(bytes, offset)
        };
        #[cfg(windows)]
        let read = {
            use std::os::windows::fs::FileExt;
            file.seek_read(bytes, offset)
        };
        #[cfg(not(any(unix, windows)))]
        let read: std::io::Result<usize> = Err(std::io::ErrorKind::Unsupported.into());
        match read {
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            result => return result,
        }
    }
}

fn encode_response(
    response: ProfileAdmissionResponse,
    binary: Option<Zeroizing<Vec<u8>>>,
) -> EncodedSourceResult {
    if binary
        .as_ref()
        .is_some_and(|bytes| bytes.len() > PROFILE_SOURCE_BINARY_BYTES)
    {
        return Err(unavailable());
    }
    let encoded = Zeroizing::new(serde_json::to_string(&response).map_err(|_| unavailable())?);
    if encoded.len() > PROFILE_SOURCE_CONTROL_BYTES {
        return Err(unavailable());
    }
    Ok((encoded, binary))
}

fn unavailable() -> RuntimeError {
    RuntimeError {
        code: RuntimeErrorCode::StorageUnavailable,
        message: "Native profile source is unavailable".into(),
        recovery_bound: None,
        team_page_problem: None,
    }
}

#[async_trait]
impl SerializedProfileAdmissionExecutor for NativeProfileSource {
    async fn invoke(&self, request_json: Zeroizing<String>) -> EncodedSourceResult {
        if request_json.len() > PROFILE_SOURCE_CONTROL_BYTES {
            return Err(unavailable());
        }
        let request: ProfileAdmissionRequest =
            serde_json::from_str(&request_json).map_err(|_| unavailable())?;
        request.validate()?;
        let response = match request {
            ProfileAdmissionRequest::BeginSourceSnapshot { format } => {
                ProfileAdmissionResponse::SourceSnapshot {
                    snapshot: self.begin(format).await?,
                }
            }
            ProfileAdmissionRequest::CloseSourceSnapshot { selector } => {
                self.close(selector).await?;
                ProfileAdmissionResponse::SourceSnapshotClosed {}
            }
            ProfileAdmissionRequest::ReadSourcePage {
                snapshot_handle,
                family,
                selector,
                cursor,
            } => {
                return self.read(snapshot_handle, family, selector, cursor).await;
            }
            ProfileAdmissionRequest::ReopenSourceSnapshot { step } => {
                let result = match step {
                    ProfileSourceReopenStep::Start {
                        verification_attempt_id,
                        header,
                    } => self.start_reopen(verification_attempt_id, header)?,
                    ProfileSourceReopenStep::Entry {
                        verification_cursor,
                        index,
                        expected_entry,
                    } => {
                        self.verification_entry(
                            VerificationMode::Reopen,
                            verification_cursor,
                            index,
                            expected_entry,
                        )
                        .await?
                    }
                    ProfileSourceReopenStep::Finish {
                        verification_cursor,
                    } => self.finish_verification(VerificationMode::Reopen, verification_cursor)?,
                };
                ProfileAdmissionResponse::SourceSnapshotVerification { result }
            }
            ProfileAdmissionRequest::VerifySourceSnapshot { step } => {
                let result = match step {
                    ProfileSourceVerifyStep::Start {
                        verification_attempt_id,
                        snapshot_handle,
                        header,
                    } => self.start_verify(verification_attempt_id, snapshot_handle, header)?,
                    ProfileSourceVerifyStep::Entry {
                        verification_cursor,
                        index,
                        expected_entry,
                    } => {
                        self.verification_entry(
                            VerificationMode::Verify,
                            verification_cursor,
                            index,
                            expected_entry,
                        )
                        .await?
                    }
                    ProfileSourceVerifyStep::Finish {
                        verification_cursor,
                    } => self.finish_verification(VerificationMode::Verify, verification_cursor)?,
                };
                ProfileAdmissionResponse::SourceSnapshotVerification { result }
            }
            ProfileAdmissionRequest::ReopenSourceForCleanup { step } => {
                let result = match step {
                    ProfileSourceCleanupReopenStep::Start {
                        verification_attempt_id,
                        admission_id,
                        header,
                    } => {
                        self.start_cleanup_reopen(verification_attempt_id, admission_id, header)?
                    }
                    ProfileSourceCleanupReopenStep::Entry {
                        verification_cursor,
                        index,
                        expected_entry,
                    } => {
                        self.cleanup_reopen_entry(verification_cursor, index, expected_entry)
                            .await?
                    }
                    ProfileSourceCleanupReopenStep::Finish {
                        verification_cursor,
                    } => self.finish_cleanup_reopen(verification_cursor)?,
                };
                ProfileAdmissionResponse::SourceCleanupReopen { result }
            }
            ProfileAdmissionRequest::DeleteCapturedSource {
                snapshot_handle,
                admission_id,
                index,
                expected_entry,
            } => {
                let result = self
                    .delete_captured_source(
                        snapshot_handle.clone(),
                        admission_id.clone(),
                        index,
                        expected_entry,
                    )
                    .await?;
                ProfileAdmissionResponse::SourceCleanupResult {
                    snapshot_handle,
                    admission_id,
                    index,
                    result,
                }
            }
            ProfileAdmissionRequest::PrepareLegacyProfileReset {
                wipe_id,
                format,
                expected_scope,
            } => ProfileAdmissionResponse::ProfileResetPrepared {
                result: self.prepare_reset(wipe_id, format, expected_scope).await?,
            },
            ProfileAdmissionRequest::ResetLegacySourceFamily {
                reset_handle,
                wipe_id,
                family,
            } => {
                let result = self
                    .reset_family(reset_handle.clone(), wipe_id.clone(), family)
                    .await?;
                ProfileAdmissionResponse::ProfileResetFamilyResult {
                    reset_handle,
                    wipe_id,
                    family,
                    result,
                }
            }
        };
        encode_response(response, None)
    }
}

#[cfg(all(test, target_os = "linux"))]
#[path = "profile_source_tests.rs"]
mod tests;
