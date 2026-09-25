//! Native ciphertext spool ownership. Core decides when cleanup is required.

use async_trait::async_trait;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use bittery_client_core::{
    AccountId, RuntimeError, RuntimeErrorCode, TeardownHostCleanup, TeardownHostCleanupRequest,
    TeardownHostCleanupResponse,
};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

pub(super) struct NativeFiles {
    directory: PathBuf,
    filesystem: Arc<Mutex<()>>,
}

impl NativeFiles {
    pub(super) fn open(directory: impl AsRef<Path>) -> Result<Self, RuntimeError> {
        let directory = directory.as_ref().to_path_buf();
        private_directory(&directory)?;
        Ok(Self {
            directory,
            filesystem: Arc::new(Mutex::new(())),
        })
    }

    fn account_directory(&self, account_id: &AccountId) -> Result<PathBuf, RuntimeError> {
        if account_id.as_str().is_empty() {
            return Err(unavailable());
        }
        Ok(self
            .directory
            .join(URL_SAFE_NO_PAD.encode(account_id.as_str().as_bytes())))
    }

    pub(super) fn allocate_ciphertext_spool(
        &self,
        account_id: &AccountId,
    ) -> Result<std::fs::File, RuntimeError> {
        let directory = self.account_directory(account_id)?;
        let _guard = self.filesystem.lock().map_err(|_| unavailable())?;
        private_directory(&directory)?;
        let file = tempfile::tempfile_in(directory).map_err(|_| unavailable())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|_| unavailable())?;
        }
        Ok(file)
    }
}

/// Publish a Core-completed output atomically at the OS-selected destination. The caller keeps
/// its capability retirement fence until this blocking operation completes.
pub(super) fn commit_staged_file(
    file: &mut std::fs::File,
    destination: &Path,
    before_publish: impl FnOnce() -> std::io::Result<()>,
) -> std::io::Result<()> {
    use std::io::{Seek, SeekFrom};
    let parent = destination
        .parent()
        .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let mut output = tempfile::NamedTempFile::new_in(parent)?;
    file.seek(SeekFrom::Start(0))?;
    std::io::copy(file, &mut output)?;
    output.as_file().sync_all()?;
    before_publish()?;
    output.persist(destination).map_err(|error| error.error)?;
    Ok(())
}

fn unavailable() -> RuntimeError {
    RuntimeError {
        code: RuntimeErrorCode::StorageUnavailable,
        message: "Native ciphertext files are unavailable".into(),
        recovery_bound: None,
        team_page_problem: None,
    }
}

fn private_directory(directory: &Path) -> Result<(), RuntimeError> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(directory).map_err(|_| unavailable())?;
    let metadata = std::fs::symlink_metadata(directory).map_err(|_| unavailable())?;
    if !metadata.is_dir() {
        return Err(unavailable());
    }
    Ok(())
}

#[async_trait]
impl TeardownHostCleanup for NativeFiles {
    async fn invoke(
        &self,
        request: TeardownHostCleanupRequest,
    ) -> Result<TeardownHostCleanupResponse, RuntimeError> {
        let (directory, response) = match request {
            TeardownHostCleanupRequest::DeleteAccount { account_id } => (
                self.account_directory(&account_id)?,
                TeardownHostCleanupResponse::AccountDeleted,
            ),
            TeardownHostCleanupRequest::WipeDevice => (
                self.directory.clone(),
                TeardownHostCleanupResponse::DeviceWiped,
            ),
        };
        let filesystem = self.filesystem.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = filesystem.lock().map_err(|_| unavailable())?;
            match std::fs::remove_dir_all(directory) {
                Ok(()) => Ok(response),
                Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Ok(response),
                Err(_) => Err(unavailable()),
            }
        })
        .await
        .map_err(|_| unavailable())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[tokio::test]
    async fn scoped_cleanup_erases_abandoned_ciphertext_and_preserves_other_accounts_and_core_files(
    ) {
        let root = tempfile::tempdir().unwrap();
        let replica = root.path().join("replica.sqlite");
        std::fs::write(&replica, b"Core-owned persistence").unwrap();
        let files = NativeFiles::open(root.path().join("host-files")).unwrap();
        let a = AccountId::from("account-a");
        let b = AccountId::from("../account-b");
        let first_directory = files.account_directory(&a).unwrap();
        let second_directory = files.account_directory(&b).unwrap();
        private_directory(&first_directory).unwrap();
        private_directory(&second_directory).unwrap();
        let first_path = first_directory.join("abandoned-ciphertext");
        let second_path = second_directory.join("abandoned-ciphertext");
        std::fs::write(&first_path, b"encrypted upload bytes").unwrap();
        std::fs::write(&second_path, b"other Account ciphertext").unwrap();
        assert_eq!(
            files
                .invoke(TeardownHostCleanupRequest::DeleteAccount {
                    account_id: a.clone()
                })
                .await
                .unwrap(),
            TeardownHostCleanupResponse::AccountDeleted
        );
        assert!(!first_path.exists());
        assert!(second_path.starts_with(root.path().join("host-files")));
        assert!(second_path.exists());
        assert!(replica.exists());
        files
            .invoke(TeardownHostCleanupRequest::DeleteAccount { account_id: a })
            .await
            .unwrap();
        files
            .invoke(TeardownHostCleanupRequest::WipeDevice)
            .await
            .unwrap();
        assert!(!second_path.exists());
        assert!(replica.exists());
        assert!(files.allocate_ciphertext_spool(&b).is_ok());
    }

    #[tokio::test]
    async fn cleanup_failure_is_not_success_and_does_not_delete_an_unexpected_file() {
        let root = tempfile::tempdir().unwrap();
        let files = NativeFiles::open(root.path().join("host-files")).unwrap();
        let account = AccountId::from("account");
        let unexpected = files.account_directory(&account).unwrap();
        std::fs::write(&unexpected, b"unexpected data must not be reset").unwrap();
        let error = files
            .invoke(TeardownHostCleanupRequest::DeleteAccount {
                account_id: account,
            })
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::StorageUnavailable);
        assert!(unexpected.exists());
    }

    #[test]
    fn cancelled_publication_preserves_previous_destination_after_staging() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("export");
        std::fs::write(&destination, b"previous export").unwrap();
        let mut staged = tempfile::tempfile_in(directory.path()).unwrap();
        staged.write_all(b"new complete encrypted archive").unwrap();
        let result = commit_staged_file(&mut staged, &destination, || {
            Err(std::io::ErrorKind::Interrupted.into())
        });
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::Interrupted);
        assert_eq!(std::fs::read(&destination).unwrap(), b"previous export");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn spool_has_no_persistent_name_and_is_private() {
        use std::io::{Read, Seek, SeekFrom};
        let root = tempfile::tempdir().unwrap();
        let files = NativeFiles::open(root.path()).unwrap();
        let account = AccountId::from("account");
        let mut spool = files.allocate_ciphertext_spool(&account).unwrap();
        spool.write_all(b"ciphertext").unwrap();
        spool.seek(SeekFrom::Start(0)).unwrap();
        let mut bytes = Vec::new();
        spool.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"ciphertext");
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            let metadata = spool.metadata().unwrap();
            assert_eq!(metadata.permissions().mode() & 0o077, 0);
            assert_eq!(metadata.nlink(), 0);
        }
        drop(spool);
        assert_eq!(
            std::fs::read_dir(files.account_directory(&account).unwrap())
                .unwrap()
                .count(),
            0
        );
    }
}
