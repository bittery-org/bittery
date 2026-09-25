//! OS-selected encrypted recovery files. Core owns archive framing, encryption and repair policy.

use async_trait::async_trait;
use bittery_client_core::{
    AccountId, RecoveryControlRequest as Request, RecoveryControlResponse as Reply,
    RequestCancellation, RuntimeError, RuntimeErrorCode, SerializedRecoveryExecutor,
};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub(super) struct NativeRecoveryFiles {
    files: Arc<Mutex<HashMap<String, RecoveryFile>>>,
    cancellations: Arc<Mutex<HashMap<String, RequestCancellation>>>,
}
struct RecoveryFile {
    account_id: AccountId,
    recovery_id: Option<String>,
    file: File,
    destination: Option<PathBuf>,
}
fn unavailable() -> RuntimeError {
    RuntimeError {
        code: RuntimeErrorCode::StorageUnavailable,
        message: "Native recovery file capability is unavailable".into(),
        recovery_bound: None,
        team_page_problem: None,
    }
}
impl NativeRecoveryFiles {
    #[cfg(test)]
    pub(super) fn cancellation_count(&self) -> usize {
        self.cancellations.lock().unwrap().len()
    }

    /// Called only after the physical recovery owner has drained its serialized work.
    pub(super) fn finish_recovery(&self, recovery_id: &str) -> Result<(), RuntimeError> {
        let mut files = self.files.lock().map_err(|_| unavailable())?;
        files.retain(|_, entry| entry.recovery_id.as_deref() != Some(recovery_id));
        self.cancellations
            .lock()
            .map_err(|_| unavailable())?
            .remove(recovery_id);
        Ok(())
    }

    /// Releases a selected capability when its native caller cancels before Core claims it.
    pub(super) fn release(&self, capability_id: &str) -> Result<(), RuntimeError> {
        self.files
            .lock()
            .map_err(|_| unavailable())?
            .remove(capability_id);
        Ok(())
    }

    pub(super) fn grant_sink(
        &self,
        account_id: AccountId,
        file: File,
        destination: PathBuf,
    ) -> Result<String, RuntimeError> {
        if !destination.is_absolute() || destination.file_name().is_none() {
            return Err(unavailable());
        }
        self.grant(account_id, file, Some(destination))
    }
    pub(super) fn grant_source(
        &self,
        account_id: AccountId,
        file: File,
    ) -> Result<String, RuntimeError> {
        let metadata = file.metadata().map_err(|_| unavailable())?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err(unavailable());
        }
        if metadata.len() > bittery_client_core::RECOVERY_MAX_FILE_BYTES {
            return Err(RuntimeError {
                code: RuntimeErrorCode::SizeRejected,
                message: "Recovery exceeds its implementation resource bound".into(),
                recovery_bound: Some(bittery_client_core::RecoveryBound::ArchiveBytes),
                team_page_problem: None,
            });
        }
        self.grant(account_id, file, None)
    }
    fn grant(
        &self,
        account_id: AccountId,
        mut file: File,
        destination: Option<PathBuf>,
    ) -> Result<String, RuntimeError> {
        if account_id.as_str().is_empty() {
            return Err(unavailable());
        }
        let mut files = self.files.lock().map_err(|_| unavailable())?;
        if files.len() >= 128 {
            return Err(unavailable());
        }
        if destination.is_some() {
            file.set_len(0).map_err(|_| unavailable())?;
        }
        file.seek(SeekFrom::Start(0)).map_err(|_| unavailable())?;
        let id = bittery_crypto_core::generate_uuid();
        files.insert(
            id.clone(),
            RecoveryFile {
                account_id,
                recovery_id: None,
                file,
                destination,
            },
        );
        Ok(id)
    }
}
#[async_trait]
impl SerializedRecoveryExecutor for NativeRecoveryFiles {
    fn cancel(&self, recovery_id: &str) {
        self.cancellations
            .lock()
            .expect("Recovery cancellation registry poisoned")
            .entry(recovery_id.into())
            .or_default()
            .cancel();
    }
    async fn invoke(
        &self,
        control_json: String,
        binary_chunk: Option<Vec<u8>>,
    ) -> Result<(String, Option<Vec<u8>>), RuntimeError> {
        if control_json.len() > bittery_client_core::RECOVERY_CONTROL_BYTES {
            return Err(unavailable());
        }
        let request: Request = serde_json::from_str(&control_json).map_err(|_| unavailable())?;
        if matches!(request, Request::SinkWrite { .. }) {
            if !binary_chunk.as_ref().is_some_and(|bytes| {
                !bytes.is_empty() && bytes.len() <= bittery_client_core::RECOVERY_CHUNK_BYTES
            }) {
                return Err(unavailable());
            }
        } else if binary_chunk.is_some() {
            return Err(unavailable());
        }
        let files = self.files.clone();
        let cancellations = self.cancellations.clone();
        let (reply, bytes) = tokio::task::spawn_blocking(move || {
            let mut files = files.lock().map_err(|_| unavailable())?;
            let (recovery_id, account_id, capability_id) = match &request {
                Request::SourceRead {
                    recovery_id,
                    account_id,
                    capability_id,
                    ..
                }
                | Request::SourceRewind {
                    recovery_id,
                    account_id,
                    capability_id,
                }
                | Request::SourceClose {
                    recovery_id,
                    account_id,
                    capability_id,
                }
                | Request::SinkWrite {
                    recovery_id,
                    account_id,
                    capability_id,
                }
                | Request::SinkCommit {
                    recovery_id,
                    account_id,
                    capability_id,
                }
                | Request::SinkDiscard {
                    recovery_id,
                    account_id,
                    capability_id,
                } => (recovery_id, account_id, capability_id),
                _ => return Err(unavailable()),
            };
            let cancellation = cancellations
                .lock()
                .map_err(|_| unavailable())?
                .entry(recovery_id.clone())
                .or_default()
                .clone();
            if !matches!(
                request,
                Request::SourceClose { .. } | Request::SinkDiscard { .. }
            ) && cancellation.is_cancelled()
            {
                return Err(RuntimeError {
                    code: RuntimeErrorCode::Cancelled,
                    message: "Recovery file transfer was cancelled".into(),
                    recovery_bound: None,
                    team_page_problem: None,
                });
            }
            if matches!(request, Request::SourceClose { .. }) && !files.contains_key(capability_id)
            {
                return Ok((Reply::SourceClosed, None));
            }
            if matches!(request, Request::SinkDiscard { .. }) && !files.contains_key(capability_id)
            {
                return Ok((Reply::SinkDiscarded, None));
            }
            let entry = files.get_mut(capability_id).ok_or_else(unavailable)?;
            if entry.account_id.as_str() != account_id
                || entry
                    .recovery_id
                    .as_ref()
                    .is_some_and(|id| id != recovery_id)
            {
                return Err(unavailable());
            }
            let source = matches!(
                request,
                Request::SourceRead { .. }
                    | Request::SourceRewind { .. }
                    | Request::SourceClose { .. }
            );
            if source != entry.destination.is_none() {
                return Err(unavailable());
            }
            entry.recovery_id = Some(recovery_id.clone());
            match request {
                Request::SourceRead { max_bytes, .. } => {
                    if max_bytes == 0
                        || max_bytes as usize > bittery_client_core::RECOVERY_CHUNK_BYTES
                    {
                        return Err(unavailable());
                    }
                    let mut bytes = vec![0; max_bytes as usize];
                    let count = entry.file.read(&mut bytes).map_err(|_| unavailable())?;
                    bytes.truncate(count);
                    if cancellation.is_cancelled() {
                        use zeroize::Zeroize;
                        bytes.zeroize();
                        return Err(RuntimeError {
                            code: RuntimeErrorCode::Cancelled,
                            message: "Recovery file transfer was cancelled".into(),
                            recovery_bound: None,
                            team_page_problem: None,
                        });
                    }
                    if count == 0 {
                        Ok((Reply::SourceEnded, None))
                    } else {
                        Ok((Reply::SourceChunk, Some(bytes)))
                    }
                }
                Request::SourceRewind { .. } => {
                    entry
                        .file
                        .seek(SeekFrom::Start(0))
                        .map_err(|_| unavailable())?;
                    Ok((Reply::SourceRewound, None))
                }
                Request::SourceClose { capability_id, .. } => {
                    files.remove(&capability_id);
                    Ok((Reply::SourceClosed, None))
                }
                Request::SinkWrite { .. } => {
                    entry
                        .file
                        .write_all(binary_chunk.as_ref().ok_or_else(unavailable)?)
                        .map_err(|_| unavailable())?;
                    Ok((Reply::SinkWritten, None))
                }
                Request::SinkCommit { capability_id, .. } => {
                    super::files::commit_staged_file(
                        &mut entry.file,
                        entry.destination.as_ref().ok_or_else(unavailable)?,
                        || {
                            if cancellation.is_cancelled() {
                                Err(std::io::ErrorKind::Interrupted.into())
                            } else {
                                Ok(())
                            }
                        },
                    )
                    .map_err(|_| unavailable())?;
                    files.remove(&capability_id);
                    Ok((Reply::SinkCommitted, None))
                }
                Request::SinkDiscard { capability_id, .. } => {
                    files.remove(&capability_id);
                    Ok((Reply::SinkDiscarded, None))
                }
                _ => Err(unavailable()),
            }
        })
        .await
        .map_err(|_| unavailable())??;
        Ok((
            serde_json::to_string(&reply).map_err(|_| unavailable())?,
            bytes,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn call(
        files: &NativeRecoveryFiles,
        request: Request,
    ) -> Result<(Reply, Option<Vec<u8>>), RuntimeError> {
        let (reply, bytes) = files
            .invoke(serde_json::to_string(&request).unwrap(), None)
            .await?;
        Ok((serde_json::from_str(&reply).unwrap(), bytes))
    }
    #[test]
    fn source_admission_rejects_empty_and_oversized_archives_without_reading() {
        let files = NativeRecoveryFiles::default();
        let file = tempfile::tempfile().unwrap();
        assert!(files
            .grant_source(AccountId::from("account"), file)
            .is_err());
        let file = tempfile::tempfile().unwrap();
        file.set_len(bittery_client_core::RECOVERY_MAX_FILE_BYTES + 1)
            .unwrap();
        let error = files
            .grant_source(AccountId::from("account"), file)
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::SizeRejected);
        assert_eq!(
            error.recovery_bound,
            Some(bittery_client_core::RecoveryBound::ArchiveBytes)
        );
    }

    #[tokio::test]
    async fn encrypted_export_is_atomic_and_discard_preserves_existing_destination() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("export.btrrec");
        std::fs::write(&destination, b"previous export").unwrap();
        let files = NativeRecoveryFiles::default();
        for commit in [false, true] {
            let id = files
                .grant_sink(
                    AccountId::from("account"),
                    tempfile::tempfile_in(directory.path()).unwrap(),
                    destination.clone(),
                )
                .unwrap();
            files
                .invoke(
                    serde_json::to_string(&Request::SinkWrite {
                        recovery_id: "recovery".into(),
                        account_id: "account".into(),
                        capability_id: id.clone(),
                    })
                    .unwrap(),
                    Some(b"complete encrypted archive".to_vec()),
                )
                .await
                .unwrap();
            assert_eq!(std::fs::read(&destination).unwrap(), b"previous export");
            let request = if commit {
                Request::SinkCommit {
                    recovery_id: "recovery".into(),
                    account_id: "account".into(),
                    capability_id: id,
                }
            } else {
                Request::SinkDiscard {
                    recovery_id: "recovery".into(),
                    account_id: "account".into(),
                    capability_id: id,
                }
            };
            call(&files, request).await.unwrap();
            assert_eq!(
                std::fs::read(&destination).unwrap(),
                if commit {
                    &b"complete encrypted archive"[..]
                } else {
                    &b"previous export"[..]
                }
            );
        }
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn cancellation_and_scope_changes_cannot_reuse_a_selected_archive() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("selected");
        std::fs::write(&path, b"archive").unwrap();
        let files = NativeRecoveryFiles::default();
        let id = files
            .grant_source(AccountId::from("account"), File::open(path).unwrap())
            .unwrap();
        let read = |account: &str, recovery: &str| Request::SourceRead {
            recovery_id: recovery.into(),
            account_id: account.into(),
            capability_id: id.clone(),
            max_bytes: 1,
        };
        assert!(call(&files, read("other", "recovery")).await.is_err());
        call(&files, read("account", "recovery")).await.unwrap();
        assert!(call(&files, read("account", "other-recovery"))
            .await
            .is_err());
        files.cancel("recovery");
        assert!(call(&files, read("account", "recovery")).await.is_err());
        call(
            &files,
            Request::SourceClose {
                recovery_id: "recovery".into(),
                account_id: "account".into(),
                capability_id: id.clone(),
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn selected_archive_reads_bounded_bytes_rewinds_and_closes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("selected.btrrec");
        std::fs::write(&path, b"encrypted archive bytes").unwrap();
        let files = NativeRecoveryFiles::default();
        let id = files
            .grant_source(AccountId::from("account"), File::open(path).unwrap())
            .unwrap();
        let read = || Request::SourceRead {
            recovery_id: "recovery".into(),
            account_id: "account".into(),
            capability_id: id.clone(),
            max_bytes: 3,
        };
        let (reply, bytes) = call(&files, read()).await.unwrap();
        assert!(matches!(reply, Reply::SourceChunk));
        assert_eq!(bytes.unwrap(), b"enc");
        call(
            &files,
            Request::SourceRewind {
                recovery_id: "recovery".into(),
                account_id: "account".into(),
                capability_id: id.clone(),
            },
        )
        .await
        .unwrap();
        let mut bytes = Vec::new();
        loop {
            let (reply, chunk) = call(&files, read()).await.unwrap();
            match reply {
                Reply::SourceChunk => {
                    let chunk = chunk.unwrap();
                    assert!(chunk.len() <= 3);
                    bytes.extend(chunk);
                }
                Reply::SourceEnded => {
                    assert!(chunk.is_none());
                    break;
                }
                _ => panic!("Expected bounded source chunk or end"),
            }
        }
        assert_eq!(bytes, b"encrypted archive bytes");
        call(
            &files,
            Request::SourceClose {
                recovery_id: "recovery".into(),
                account_id: "account".into(),
                capability_id: id.clone(),
            },
        )
        .await
        .unwrap();
        assert!(call(&files, read()).await.is_err());
    }
}
