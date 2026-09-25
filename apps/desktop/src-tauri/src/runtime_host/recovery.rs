//! Native maintenance and bounded physical recovery execution. Core owns all recovery policy.

use super::{
    device_lease::{DeviceLeaseMode, NativeDeviceLease},
    recovery_files::NativeRecoveryFiles,
};
use async_trait::async_trait;
use bittery_client_core::{
    RecoveryBound, RecoveryControlRequest as Request, RecoveryControlResponse as Reply,
    RecoveryUnavailableReason as Unavailable, RequestCancellation, RuntimeError, RuntimeErrorCode,
    SerializedRecoveryExecutor, SqliteRecoveryStorage,
};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use zeroize::Zeroize;

use bittery_client_core::{
    RECOVERY_CHUNK_BYTES as CHUNK_BYTES, RECOVERY_CONTROL_BYTES as CONTROL_BYTES,
};
type Answer = (Reply, Option<Vec<u8>>);
pub(super) type DeviceLeaseSlot = Arc<Mutex<Option<NativeDeviceLease>>>;

#[derive(Clone)]
pub(super) struct NativeRecovery(Arc<Inner>);
struct Inner {
    directory: PathBuf,
    // Field drop order keeps the final maintenance lease alive through SQLite/stage closure.
    storage: Mutex<Option<(String, SqliteRecoveryStorage)>>,
    gate: DeviceLeaseSlot,
    cancellation: Mutex<Option<(String, RequestCancellation)>>,
    pending: AtomicBool,
    transfer: Arc<NativeRecoveryFiles>,
}
struct Pending(Arc<Inner>);
impl Drop for Pending {
    fn drop(&mut self) {
        self.0.pending.store(false, Ordering::Release);
    }
}

impl NativeRecovery {
    /// The gate initially holds the ordinary owner's shared lease. Core closes that owner before
    /// invoking EnterMaintenance. The transfer delegate receives only the closed file operations.
    pub(super) fn new(
        directory: PathBuf,
        gate: DeviceLeaseSlot,
        transfer: Arc<NativeRecoveryFiles>,
    ) -> Self {
        Self(Arc::new(Inner {
            directory,
            gate,
            storage: Mutex::new(None),
            cancellation: Mutex::new(None),
            pending: AtomicBool::new(false),
            transfer,
        }))
    }
}

#[async_trait]
impl SerializedRecoveryExecutor for NativeRecovery {
    fn cancel(&self, recovery_id: &str) {
        let cancellation = self
            .0
            .cancellation
            .lock()
            .expect("Recovery cancellation lock poisoned");
        if let Some((current, token)) = &*cancellation {
            if current == recovery_id {
                token.cancel();
                self.0.transfer.cancel(recovery_id);
            }
        }
    }
    async fn invoke(
        &self,
        control_json: String,
        mut binary_chunk: Option<Vec<u8>>,
    ) -> Result<(String, Option<Vec<u8>>), RuntimeError> {
        if self
            .0
            .pending
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            if let Some(bytes) = &mut binary_chunk {
                bytes.zeroize();
            }
            return encode(unavailable(Unavailable::Busy));
        }
        let pending = Pending(self.0.clone());
        let reject = |reply: Reply, bytes: &mut Option<Vec<u8>>| {
            if let Some(bytes) = bytes {
                bytes.zeroize();
            }
            encode((reply, None))
        };
        if control_json.len() > CONTROL_BYTES {
            return reject(
                Reply::LimitExceeded {
                    bound: RecoveryBound::ControlBytes,
                },
                &mut binary_chunk,
            );
        }
        let request: Request = match serde_json::from_str(&control_json) {
            Ok(value) => value,
            Err(_) => {
                return reject(
                    Reply::Unavailable {
                        reason: Unavailable::Corrupt,
                    },
                    &mut binary_chunk,
                )
            }
        };
        let has_binary = matches!(
            request,
            Request::StageRowChunk { .. } | Request::SinkWrite { .. }
        ) || matches!(&request, Request::AddArtifactEntry {record,..} if record.has_binary());
        if binary_chunk
            .as_ref()
            .is_some_and(|bytes| bytes.len() > CHUNK_BYTES)
        {
            return reject(
                Reply::LimitExceeded {
                    bound: RecoveryBound::ChunkBytes,
                },
                &mut binary_chunk,
            );
        }
        if has_binary != binary_chunk.is_some() || binary_chunk.as_ref().is_some_and(Vec::is_empty)
        {
            return reject(
                Reply::Unavailable {
                    reason: Unavailable::Corrupt,
                },
                &mut binary_chunk,
            );
        }
        // The task owns admission and any physical IO even if its awaiting caller disappears.
        // Core cancellation remains explicit; cleanup commands are still admitted after cancel.
        let inner = self.0.clone();
        tokio::spawn(async move {
            let _pending = pending;
            let result = inner.run(request, control_json, binary_chunk).await;
            encode(result)
        })
        .await
        .map_err(|_| invariant())?
    }
}

impl Inner {
    async fn run(
        self: Arc<Self>,
        request: Request,
        control_json: String,
        mut binary: Option<Vec<u8>>,
    ) -> Answer {
        let id = recovery_id(&request).to_owned();
        let cleanup = matches!(
            request,
            Request::LeaveMaintenance { .. }
                | Request::SourceClose { .. }
                | Request::SinkDiscard { .. }
                | Request::DiscardRepairStage { .. }
        );
        let token = {
            let mut current = self
                .cancellation
                .lock()
                .expect("Recovery cancellation lock poisoned");
            if matches!(request, Request::EnterMaintenance { .. }) && current.is_none() {
                *current = Some((id.clone(), RequestCancellation::new()));
            }
            match current.as_ref() {
                Some((current, token)) if *current == id => token.clone(),
                None if matches!(request, Request::LeaveMaintenance { .. }) => {
                    return (Reply::MaintenanceLeft, None)
                }
                _ => {
                    if let Some(bytes) = &mut binary {
                        bytes.zeroize();
                    }
                    return unavailable(Unavailable::Busy);
                }
            }
        };
        if !cleanup && token.is_cancelled() {
            if let Some(bytes) = &mut binary {
                bytes.zeroize();
            }
            return unavailable(Unavailable::Cancelled);
        }
        let transfer = matches!(
            request,
            Request::SourceRead { .. }
                | Request::SourceRewind { .. }
                | Request::SourceClose { .. }
                | Request::SinkWrite { .. }
                | Request::SinkCommit { .. }
                | Request::SinkDiscard { .. }
        );
        let mut answer = if transfer {
            let active = self
                .storage
                .lock()
                .expect("Recovery storage lock poisoned")
                .as_ref()
                .is_some_and(|(current, _)| *current == id);
            if !active {
                if let Some(bytes) = &mut binary {
                    bytes.zeroize();
                }
                return unavailable(Unavailable::Corrupt);
            }
            match self.transfer.invoke(control_json, binary).await {
                Ok((json, bytes)) => match serde_json::from_str::<Reply>(&json) {
                    Ok(reply) => (reply, bytes),
                    Err(_) => {
                        if let Some(mut bytes) = bytes {
                            bytes.zeroize();
                        }
                        unavailable(Unavailable::Corrupt)
                    }
                },
                Err(error) => error_answer(error),
            }
        } else {
            let binary = binary.map(zeroize::Zeroizing::new);
            let inner = self.clone();
            let physical_token = token.clone();
            match tokio::task::spawn_blocking(move || {
                inner.physical(
                    request,
                    binary.as_deref().map(Vec::as_slice),
                    &physical_token,
                )
            })
            .await
            {
                Ok(value) => value,
                Err(_) => unavailable(Unavailable::StorageUnavailable),
            }
        };
        if !cleanup && token.is_cancelled() && !matches!(answer.0, Reply::Repaired) {
            if let Some(bytes) = &mut answer.1 {
                bytes.zeroize();
            }
            answer = unavailable(Unavailable::Cancelled);
        }
        answer
    }

    fn physical(
        &self,
        request: Request,
        binary: Option<&[u8]>,
        cancellation: &RequestCancellation,
    ) -> Answer {
        let mut storage = self.storage.lock().expect("Recovery storage lock poisoned");
        match request {
            Request::EnterMaintenance { recovery_id } => {
                if let Some((current, storage)) = &*storage {
                    return if *current == recovery_id {
                        (
                            Reply::MaintenanceEntered {
                                physical_schemas: storage.physical_schemas(),
                            },
                            None,
                        )
                    } else {
                        unavailable(Unavailable::Busy)
                    };
                }
                let mut gate = self.gate.lock().expect("Device lease lock poisoned");
                drop(gate.take());
                let exclusive = match NativeDeviceLease::try_acquire(
                    &self.directory,
                    DeviceLeaseMode::Exclusive,
                ) {
                    Ok(Some(value)) => value,
                    Ok(None) => return unavailable(Unavailable::Busy),
                    Err(_) => return unavailable(Unavailable::StorageUnavailable),
                };
                let physical = match SqliteRecoveryStorage::open(
                    self.directory.join("replica.sqlite"),
                    self.directory.join("attachments.sqlite"),
                    self.directory.join("vault-images.sqlite"),
                ) {
                    Ok(value) => value,
                    Err(reason) => return unavailable(reason),
                };
                let schemas = physical.physical_schemas();
                *gate = Some(exclusive);
                *storage = Some((recovery_id, physical));
                (
                    Reply::MaintenanceEntered {
                        physical_schemas: schemas,
                    },
                    None,
                )
            }
            Request::LeaveMaintenance { recovery_id } => {
                // Keep cancellation admission fenced through final file and gate release. A
                // concurrent cancel must not recreate the file token after finish_recovery drains it.
                let mut cancellation = self
                    .cancellation
                    .lock()
                    .expect("Recovery cancellation lock poisoned");
                // Drained scoped file cleanup must succeed while the maintenance gate still
                // excludes normal owners. A failure keeps this same scope available for retry.
                if let Err(error) = self.transfer.finish_recovery(&recovery_id) {
                    return error_answer(error);
                }
                drop(storage.take());
                drop(self.gate.lock().expect("Device lease lock poisoned").take());
                cancellation.take();
                (Reply::MaintenanceLeft, None)
            }
            Request::ListAccounts { cursor, .. } => match storage.as_mut() {
                Some((_, storage)) => storage
                    .list_accounts(cursor.as_deref())
                    .unwrap_or_else(error_answer),
                None => unavailable(Unavailable::Corrupt),
            },
            Request::ReadEntry {
                account_id, cursor, ..
            } => match storage.as_mut() {
                Some((_, storage)) => storage
                    .read_entry(&account_id, cursor.as_deref())
                    .unwrap_or_else(error_answer),
                None => unavailable(Unavailable::Corrupt),
            },
            request @ (Request::BeginRepairStage { .. }
            | Request::StageExpectedRow { .. }
            | Request::StageRowStart { .. }
            | Request::StageRowChunk { .. }
            | Request::StageRowEnd { .. }
            | Request::CommitRepair { .. }
            | Request::DiscardRepairStage { .. }) => match storage.as_mut() {
                Some((_, storage)) => storage
                    .execute_repair(&request, binary, cancellation)
                    .map(|reply| (reply, None))
                    .unwrap_or_else(error_answer),
                None => unavailable(Unavailable::Corrupt),
            },
            Request::AddArtifactEntry {
                account_id, record, ..
            } => match storage.as_mut() {
                Some((_, storage)) => storage
                    .add_artifact(&account_id, &record, binary, cancellation)
                    .map(|reply| (reply, None))
                    .unwrap_or_else(error_answer),
                None => unavailable(Unavailable::Corrupt),
            },
            _ => unavailable(Unavailable::Unsupported),
        }
    }
}

fn recovery_id(request: &Request) -> &str {
    match request {
        Request::EnterMaintenance { recovery_id }
        | Request::LeaveMaintenance { recovery_id }
        | Request::ListAccounts { recovery_id, .. }
        | Request::ReadEntry { recovery_id, .. }
        | Request::AddArtifactEntry { recovery_id, .. }
        | Request::BeginRepairStage { recovery_id, .. }
        | Request::StageExpectedRow { recovery_id, .. }
        | Request::StageRowStart { recovery_id, .. }
        | Request::StageRowChunk { recovery_id, .. }
        | Request::StageRowEnd { recovery_id, .. }
        | Request::CommitRepair { recovery_id, .. }
        | Request::DiscardRepairStage { recovery_id, .. }
        | Request::SourceRead { recovery_id, .. }
        | Request::SourceRewind { recovery_id, .. }
        | Request::SourceClose { recovery_id, .. }
        | Request::SinkWrite { recovery_id, .. }
        | Request::SinkCommit { recovery_id, .. }
        | Request::SinkDiscard { recovery_id, .. } => recovery_id,
    }
}
fn unavailable(reason: Unavailable) -> Answer {
    (Reply::Unavailable { reason }, None)
}
fn error_answer(error: RuntimeError) -> Answer {
    if let Some(bound) = error.recovery_bound {
        (Reply::LimitExceeded { bound }, None)
    } else {
        unavailable(if error.code == RuntimeErrorCode::StorageUnavailable {
            Unavailable::StorageUnavailable
        } else {
            Unavailable::Corrupt
        })
    }
}
fn encode(mut answer: Answer) -> Result<(String, Option<Vec<u8>>), RuntimeError> {
    // JSON escaping can expand a valid raw row beyond the control envelope limit. Stop during
    // serialization instead of allocating the expanded String and checking afterwards.
    let mut output = ControlWriter(Vec::new());
    if serde_json::to_writer(&mut output, &answer.0).is_err() {
        if let Some(binary) = &mut answer.1 {
            binary.zeroize();
        }
        return Ok((
            serde_json::to_string(&Reply::LimitExceeded {
                bound: RecoveryBound::ControlBytes,
            })
            .map_err(|_| invariant())?,
            None,
        ));
    }
    Ok((
        String::from_utf8(output.0).map_err(|_| invariant())?,
        answer.1,
    ))
}
struct ControlWriter(Vec<u8>);
impl std::io::Write for ControlWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > CONTROL_BYTES - self.0.len() {
            return Err(std::io::Error::other("Recovery control limit exceeded"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn invariant() -> RuntimeError {
    RuntimeError {
        code: RuntimeErrorCode::InvariantViolation,
        message: "Native recovery execution failed".into(),
        recovery_bound: None,
        team_page_problem: None,
    }
}

#[cfg(test)]
mod tests;
