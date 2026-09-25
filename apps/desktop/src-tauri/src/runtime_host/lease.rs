//! Kernel-held Account file locks implement Core's exclusive preparation capability.

use async_trait::async_trait;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use bittery_client_core::{
    AccountId, AttachmentMoveAccountLease, AttachmentMoveAccountLeasePort, RequestCancellation,
    RuntimeError, RuntimeErrorCode,
};
use std::{
    fs::File,
    path::{Path, PathBuf},
};

pub(super) struct NativeAccountLeases {
    directory: PathBuf,
    closed: RequestCancellation,
}

impl NativeAccountLeases {
    pub(super) fn open(directory: impl AsRef<Path>) -> Result<Self, RuntimeError> {
        let directory = directory.as_ref().to_path_buf();
        std::fs::create_dir_all(&directory).map_err(|_| unavailable())?;
        Ok(Self {
            directory,
            closed: RequestCancellation::new(),
        })
    }

    pub(super) fn close(&self) {
        self.closed.cancel();
    }
}

impl Drop for NativeAccountLeases {
    fn drop(&mut self) {
        self.close();
    }
}

struct NativeLease {
    _file: File,
    closed: RequestCancellation,
}

#[async_trait]
impl AttachmentMoveAccountLease for NativeLease {
    fn is_live(&self) -> bool {
        !self.closed.is_cancelled()
    }
    async fn lost(&self) {
        self.closed.cancelled().await;
    }
}

fn unavailable() -> RuntimeError {
    RuntimeError {
        code: RuntimeErrorCode::StorageUnavailable,
        message: "Native Account lease is unavailable".into(),
        recovery_bound: None,
        team_page_problem: None,
    }
}

#[async_trait]
impl AttachmentMoveAccountLeasePort for NativeAccountLeases {
    async fn acquire(
        &self,
        account_id: &AccountId,
    ) -> Result<Option<Box<dyn AttachmentMoveAccountLease>>, RuntimeError> {
        if self.closed.is_cancelled() {
            return Ok(None);
        }
        if account_id.as_str().is_empty() {
            return Err(unavailable());
        }
        let path = self
            .directory
            .join(URL_SAFE_NO_PAD.encode(account_id.as_str().as_bytes()));
        let closed = self.closed.clone();
        tokio::task::spawn_blocking(move || {
            let mut options = std::fs::OpenOptions::new();
            options.read(true).write(true).create(true).truncate(false);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            // Keep the empty lock inode stable. Unlinking a held lock would let another process
            // lock a replacement inode while the first process still owns the old one.
            let file = options.open(path).map_err(|_| unavailable())?;
            match file.try_lock() {
                Ok(()) if !closed.is_cancelled() => Ok(Some(Box::new(NativeLease {
                    _file: file,
                    closed,
                })
                    as Box<dyn AttachmentMoveAccountLease>)),
                Ok(()) | Err(std::fs::TryLockError::WouldBlock) => Ok(None),
                Err(std::fs::TryLockError::Error(_)) => Err(unavailable()),
            }
        })
        .await
        .map_err(|_| unavailable())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn kernel_lease_excludes_another_process_and_releases_on_drop() {
        let directory = tempfile::tempdir().unwrap();
        let port = NativeAccountLeases::open(directory.path()).unwrap();
        let account = AccountId::from("account-a");
        let first = port.acquire(&account).await.unwrap().unwrap();
        assert!(first.is_live());
        assert!(port.acquire(&account).await.unwrap().is_none());
        assert!(port
            .acquire(&AccountId::from("account-b"))
            .await
            .unwrap()
            .is_some());
        let probe = |available: bool| {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "runtime_host::lease::tests::child_process_probes_kernel_lease",
                    "--ignored",
                    "--exact",
                    "--nocapture",
                ])
                .env("BITTERY_LEASE_TEST_DIRECTORY", directory.path())
                .env(
                    "BITTERY_LEASE_TEST_AVAILABLE",
                    if available { "yes" } else { "no" },
                )
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"));
        };
        probe(false);
        drop(first);
        probe(true);
        let held = port.acquire(&account).await.unwrap().unwrap();
        port.close();
        assert!(!held.is_live());
        tokio::time::timeout(std::time::Duration::from_secs(1), held.lost())
            .await
            .unwrap();
        assert!(port.acquire(&account).await.unwrap().is_none());
    }

    #[tokio::test]
    #[ignore = "Invoked only by the real two-process lease test with its isolated directory"]
    async fn child_process_probes_kernel_lease() {
        let directory = std::env::var_os("BITTERY_LEASE_TEST_DIRECTORY")
            .expect("Parent lease test must supply directory");
        let expected = std::env::var("BITTERY_LEASE_TEST_AVAILABLE").unwrap() == "yes";
        let port = NativeAccountLeases::open(directory).unwrap();
        let lease = port.acquire(&AccountId::from("account-a")).await.unwrap();
        assert_eq!(lease.is_some(), expected);
    }
}
