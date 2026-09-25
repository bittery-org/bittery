//! OS-held shared normal-owner / exclusive maintenance exclusion. Core selects the lifecycle.

use bittery_client_core::{RuntimeError, RuntimeErrorCode};
use std::{fs::File, path::Path};

#[derive(Clone, Copy)]
pub(super) enum DeviceLeaseMode {
    Shared,
    Exclusive,
}

pub(super) struct NativeDeviceLease {
    _file: File,
}

impl NativeDeviceLease {
    pub(super) fn try_acquire(
        directory: impl AsRef<Path>,
        mode: DeviceLeaseMode,
    ) -> Result<Option<Self>, RuntimeError> {
        std::fs::create_dir_all(directory.as_ref()).map_err(|_| unavailable())?;
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        // This inode is shared by normal owners and maintenance and is never removed. Replacing
        // it while another process holds its old inode would defeat device-wide exclusion.
        let file = options
            .open(directory.as_ref().join("device-storage.lock"))
            .map_err(|_| unavailable())?;
        if !file.metadata().map_err(|_| unavailable())?.is_file() {
            return Err(unavailable());
        }
        let acquired = match mode {
            DeviceLeaseMode::Shared => file.try_lock_shared(),
            DeviceLeaseMode::Exclusive => file.try_lock(),
        };
        match acquired {
            Ok(()) => Ok(Some(Self { _file: file })),
            Err(std::fs::TryLockError::WouldBlock) => Ok(None),
            Err(std::fs::TryLockError::Error(_)) => Err(unavailable()),
        }
    }
}

fn unavailable() -> RuntimeError {
    RuntimeError {
        code: RuntimeErrorCode::StorageUnavailable,
        message: "Native device storage lease is unavailable".into(),
        recovery_bound: None,
        team_page_problem: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        process::{Command, Stdio},
        sync::Arc,
    };

    struct ChildGuard(std::process::Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn child(directory: &Path, mode: &str, expected: bool) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "runtime_host::device_lease::tests::child_process_probes_device_lease",
                "--ignored",
                "--exact",
                "--nocapture",
            ])
            .env("BITTERY_DEVICE_LEASE_TEST_DIRECTORY", directory)
            .env("BITTERY_DEVICE_LEASE_TEST_MODE", mode)
            .env(
                "BITTERY_DEVICE_LEASE_TEST_AVAILABLE",
                if expected { "yes" } else { "no" },
            );
        command
    }

    fn probe(directory: &Path, mode: &str, expected: bool) {
        let result = child(directory, mode, expected).output().unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(String::from_utf8_lossy(&result.stdout).contains("1 passed; 0 failed"));
    }

    #[test]
    fn processes_share_normal_access_and_exclude_maintenance_until_final_handle_release() {
        let directory = tempfile::tempdir().unwrap();
        let first = Arc::new(
            NativeDeviceLease::try_acquire(directory.path(), DeviceLeaseMode::Shared)
                .unwrap()
                .unwrap(),
        );
        let retained = first.clone();
        probe(directory.path(), "shared", true);
        probe(directory.path(), "exclusive", false);
        let second = NativeDeviceLease::try_acquire(directory.path(), DeviceLeaseMode::Shared)
            .unwrap()
            .unwrap();
        drop(first);
        drop(retained);
        probe(directory.path(), "exclusive", false);
        drop(second);
        probe(directory.path(), "exclusive", true);
        let exclusive =
            NativeDeviceLease::try_acquire(directory.path(), DeviceLeaseMode::Exclusive)
                .unwrap()
                .unwrap();
        probe(directory.path(), "shared", false);
        probe(directory.path(), "exclusive", false);
        drop(exclusive);
        probe(directory.path(), "shared", true);
    }

    #[test]
    fn process_loss_releases_exclusive_gate_without_unlinking_its_inode() {
        use std::io::{BufRead, BufReader};
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("device-storage.lock");
        std::fs::write(&path, b"stable inode is never truncated").unwrap();
        #[cfg(unix)]
        let inode = {
            use std::os::unix::fs::MetadataExt;
            std::fs::metadata(&path).unwrap().ino()
        };
        let mut process = ChildGuard(
            child(directory.path(), "exclusive", true)
                .env("BITTERY_DEVICE_LEASE_TEST_HOLD", "yes")
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let stdout = process.0.stdout.take().unwrap();
        let (ready, receive_ready) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut output = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                if output.read_line(&mut line).unwrap_or(0) == 0 {
                    return;
                }
                if line.trim() == "DEVICE_LEASE_HELD" {
                    let _ = ready.send(());
                    return;
                }
            }
        });
        receive_ready
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("Child did not acquire its lease");
        reader.join().unwrap();
        assert!(
            NativeDeviceLease::try_acquire(directory.path(), DeviceLeaseMode::Shared)
                .unwrap()
                .is_none()
        );
        process.0.kill().unwrap();
        process.0.wait().unwrap();
        assert!(
            NativeDeviceLease::try_acquire(directory.path(), DeviceLeaseMode::Exclusive)
                .unwrap()
                .is_some()
        );
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"stable inode is never truncated"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(std::fs::metadata(path).unwrap().ino(), inode);
        }
    }

    #[test]
    #[ignore = "Invoked only by isolated cross-process device-lease tests"]
    fn child_process_probes_device_lease() {
        use std::io::Write;
        let directory = std::env::var_os("BITTERY_DEVICE_LEASE_TEST_DIRECTORY").unwrap();
        let mode = match std::env::var("BITTERY_DEVICE_LEASE_TEST_MODE")
            .unwrap()
            .as_str()
        {
            "shared" => DeviceLeaseMode::Shared,
            "exclusive" => DeviceLeaseMode::Exclusive,
            _ => panic!("Invalid test mode"),
        };
        let lease = NativeDeviceLease::try_acquire(directory, mode).unwrap();
        assert_eq!(
            lease.is_some(),
            std::env::var("BITTERY_DEVICE_LEASE_TEST_AVAILABLE").unwrap() == "yes"
        );
        if std::env::var_os("BITTERY_DEVICE_LEASE_TEST_HOLD").is_some() {
            assert!(lease.is_some());
            println!("DEVICE_LEASE_HELD");
            std::io::stdout().flush().unwrap();
            loop {
                std::thread::park();
            }
        }
    }
}
