//! Hardening for the local desktop-app <-> native-messaging-host IPC endpoint.
//!
//! The endpoint carries vault keys, session auth tokens and item snapshots, so
//! "every process running as this OS user" is not an acceptable audience. This
//! module owns three concerns:
//!
//! 1. **Where the endpoint lives and how it is locked down** — a per-user
//!    directory created at mode `0700` on Unix, an explicit security descriptor
//!    on the Windows named pipe.
//! 2. **Who the kernel says is on the other end** — peer uid and pid.
//! 3. **Whether that peer is the executable we expect** — the installed native
//!    messaging host (server side) or the installed desktop app (client side).
//!
//! Both the Tauri app (`lib.rs`, the IPC server) and the `bittery-native-host`
//! binary (`native_host.rs`, the IPC client) compile this module in, so the two
//! sides cannot drift on the endpoint location or on the identity rules.
//!
//! ## Threat model and known limits
//!
//! The peer check in [`verify_peer_process`] is **path based**: it resolves the
//! peer's executable through the OS (`/proc/<pid>/exe`, `proc_pidpath`,
//! `QueryFullProcessImageNameW`) and requires it to be one of our own binaries
//! sitting next to the running executable. That stops the "any local process
//! can just connect" class of attack, which is what this endpoint was
//! previously wide open to.
//!
//! It does **not** stop an attacker who can write to that install location: if
//! they can replace or shadow the native host binary, they can satisfy the
//! path check. Closing that requires verifying the peer's *code signature*
//! (`SecCodeCopyGuestWithAttributes` / `SecStaticCodeCheckValidity` on macOS,
//! `WinVerifyTrust` plus a publisher check on Windows). The verification is
//! deliberately funnelled through [`verify_peer_process`] so that a signature
//! check can be layered in there without touching either call site.
//!
//! The check is also inherently pid based, and pids are recycled. The window
//! between the kernel recording the peer's identity (at `connect`/`accept`) and
//! us resolving its executable is small, but an attacker who can exit a trusted
//! process and win the race to that pid could slip through. Signature
//! verification against the *connection* rather than the pid is the real fix
//! there too.
//!
//! Nothing here defends against an attacker who is already root/SYSTEM, or
//! against one who can debug the desktop process itself.

// Both crate roots (`lib.rs` and the `bittery-native-host` binary) include this
// module, and each uses a different subset of it — plus the Windows helpers are
// compiled on Windows only. Per-item allows would be noise.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

/// Basename of the Unix domain socket inside the per-user runtime directory.
pub const DESKTOP_IPC_SOCKET_NAME: &str = "bittery-desktop-ipc.sock";

/// Fixed, machine-global name of the Windows named pipe.
///
/// Windows named pipes have no per-user namespace, so the name cannot be made
/// unguessable in a useful way. Access is controlled by the security descriptor
/// built in [`desktop_ipc_pipe_sddl`] and by the peer check instead.
#[cfg(windows)]
pub const DESKTOP_IPC_PIPE_NAME: &str = r"\\.\pipe\bittery-desktop-ipc";

/// Basename of the per-user directory holding the Unix socket.
///
/// Keep this short: `sockaddr_un::sun_path` is 104 bytes on macOS, and macOS
/// already spends ~49 of them on the per-user `TMPDIR`. The current layout
/// (`$TMPDIR/bittery-ipc-<uid>/bittery-desktop-ipc.sock`) lands at 89 bytes.
const DESKTOP_IPC_DIR_NAME: &str = "bittery-ipc";

/// Executable basenames the browser's native messaging host may run as.
pub const NATIVE_HOST_EXECUTABLE_NAMES: &[&str] =
    &["bittery-native-host", "bittery-native-host.exe"];

/// Executable basenames the desktop app may run as.
///
/// The cargo binary is `Bittery` (crate name) while the bundled product binary
/// is `bittery` (Tauri `productName`), and Linux filesystems are case
/// sensitive, so both spellings are listed.
pub const DESKTOP_APP_EXECUTABLE_NAMES: &[&str] =
    &["bittery", "Bittery", "bittery.exe", "Bittery.exe"];

/// Which side of the connection we expect the peer to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerRole {
    /// The peer should be the installed native messaging host binary.
    NativeHost,
    /// The peer should be the installed desktop app binary.
    DesktopApp,
}

impl PeerRole {
    pub fn expected_executable_names(self) -> &'static [&'static str] {
        match self {
            PeerRole::NativeHost => NATIVE_HOST_EXECUTABLE_NAMES,
            PeerRole::DesktopApp => DESKTOP_APP_EXECUTABLE_NAMES,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            PeerRole::NativeHost => "native messaging host",
            PeerRole::DesktopApp => "desktop app",
        }
    }
}

/// How hard to fail when the peer cannot be identified at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerPolicy {
    /// Reject unless the peer is positively identified as the expected binary.
    ///
    /// Used by the desktop app, which is the side holding the secrets.
    Required,
    /// Reject only when the peer is positively identified as something else.
    ///
    /// Used by the native host, where the check is defence in depth against a
    /// squatted endpoint: failing closed there would break the extension on
    /// every platform quirk that hides the peer's identity from us.
    BestEffort,
}

/// What the OS told us about the process on the other end of the connection.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PeerIdentity {
    pub pid: Option<u32>,
    pub uid: Option<u32>,
    pub executable: Option<PathBuf>,
}

// ---------------------------------------------------------------------------
// Endpoint location
// ---------------------------------------------------------------------------

/// Pick the directory that holds the IPC socket.
///
/// Pure so it can be unit tested on every platform. `xdg_runtime_dir` is
/// `Some` only on Linux with a usable `$XDG_RUNTIME_DIR`; everywhere else we
/// fall back to a uid-qualified subdirectory of the temp dir, which the caller
/// then creates at mode `0700`.
fn resolve_socket_dir(xdg_runtime_dir: Option<&Path>, temp_dir: &Path, uid: u32) -> PathBuf {
    if let Some(runtime_dir) = xdg_runtime_dir {
        if runtime_dir.is_absolute() {
            return runtime_dir.join(DESKTOP_IPC_DIR_NAME);
        }
    }

    temp_dir.join(format!("{}-{}", DESKTOP_IPC_DIR_NAME, uid))
}

/// `$XDG_RUNTIME_DIR`, but only on Linux and only when it is actually usable.
///
/// The spec guarantees it is a `0700` directory owned by the user, which is
/// exactly what we want; a bogus value is ignored so we fall back to the temp
/// dir rather than failing.
#[cfg(unix)]
fn xdg_runtime_dir() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        let value = std::env::var_os("XDG_RUNTIME_DIR")?;
        let path = PathBuf::from(value);
        if path.is_absolute() && path.is_dir() {
            return Some(path);
        }
        None
    }

    // macOS already gives every user a private `0700` TMPDIR, and other unices
    // do not reliably honour XDG. Both fall back to the uid-qualified temp dir.
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

#[cfg(unix)]
fn current_uid() -> u32 {
    // SAFETY: `geteuid` takes no arguments and cannot fail.
    unsafe { libc::geteuid() }
}

/// Directory the IPC socket lives in. Server and client agree by construction.
#[cfg(unix)]
pub fn desktop_ipc_socket_dir() -> PathBuf {
    resolve_socket_dir(
        xdg_runtime_dir().as_deref(),
        &std::env::temp_dir(),
        current_uid(),
    )
}

/// Primary socket path. This is what the server binds.
#[cfg(unix)]
pub fn desktop_ipc_socket_path() -> PathBuf {
    desktop_ipc_socket_dir().join(DESKTOP_IPC_SOCKET_NAME)
}

/// Paths a client should try, in order.
///
/// `$XDG_RUNTIME_DIR` is set for interactive sessions but is not always
/// inherited by a browser-spawned native messaging host, so the client also
/// tries the temp-dir location rather than silently failing to find a server
/// that is running perfectly well.
#[cfg(unix)]
pub fn desktop_ipc_socket_candidates() -> Vec<PathBuf> {
    let mut candidates = vec![desktop_ipc_socket_path()];
    let fallback = resolve_socket_dir(None, &std::env::temp_dir(), current_uid())
        .join(DESKTOP_IPC_SOCKET_NAME);
    if !candidates.contains(&fallback) {
        candidates.push(fallback);
    }
    candidates
}

#[cfg(windows)]
pub fn desktop_ipc_socket_path() -> PathBuf {
    PathBuf::from(DESKTOP_IPC_PIPE_NAME)
}

#[cfg(windows)]
pub fn desktop_ipc_socket_candidates() -> Vec<PathBuf> {
    vec![desktop_ipc_socket_path()]
}

/// Create (or validate) the per-user socket directory at mode `0700` and return
/// the socket path inside it.
#[cfg(unix)]
pub fn prepare_desktop_ipc_socket_path() -> std::io::Result<PathBuf> {
    let dir = desktop_ipc_socket_dir();
    prepare_socket_dir(&dir)?;
    Ok(dir.join(DESKTOP_IPC_SOCKET_NAME))
}

/// Make `dir` exist, be ours, and be mode `0700`.
///
/// Explicitly `chmod`s rather than relying on the process umask (which would
/// leave `0755` under the default `022`), and refuses a directory that is a
/// symlink or that somebody else owns — otherwise a squatter could pre-create
/// the path on a shared `/tmp` and read the traffic.
#[cfg(unix)]
fn prepare_socket_dir(dir: &Path) -> std::io::Result<()> {
    use std::fs;
    use std::io::{Error, ErrorKind};
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    match fs::create_dir_all(dir) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }

    // `symlink_metadata` does not follow the final component, so a symlink
    // planted at this path fails the `is_dir` check instead of silently
    // redirecting us somewhere world readable.
    let metadata = fs::symlink_metadata(dir)?;
    if !metadata.is_dir() {
        return Err(Error::new(
            ErrorKind::PermissionDenied,
            format!("{} is not a directory", dir.display()),
        ));
    }

    let uid = current_uid();
    if metadata.uid() != uid {
        return Err(Error::new(
            ErrorKind::PermissionDenied,
            format!(
                "{} is owned by uid {} but this process runs as uid {}",
                dir.display(),
                metadata.uid(),
                uid
            ),
        ));
    }

    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;

    let metadata = fs::symlink_metadata(dir)?;
    if metadata.permissions().mode() & 0o777 != 0o700 {
        return Err(Error::new(
            ErrorKind::PermissionDenied,
            format!(
                "{} has mode {:o} after chmod, refusing to use it",
                dir.display(),
                metadata.permissions().mode() & 0o777
            ),
        ));
    }

    Ok(())
}

/// Tighten the socket inode itself to `0600`.
///
/// Belt and braces: the `0700` parent directory already blocks everyone else,
/// but Linux checks permissions on the socket inode too and some filesystems do
/// not honour directory traversal the way we would like.
#[cfg(unix)]
pub fn restrict_socket_file(path: &Path) -> std::io::Result<()> {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

// ---------------------------------------------------------------------------
// Peer credentials
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
fn unix_peer_identity(fd: std::os::unix::io::RawFd) -> std::io::Result<PeerIdentity> {
    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;

    // SAFETY: `credentials` is a live, correctly sized `ucred` and `length`
    // describes it; `getsockopt` only writes within those bounds.
    let result = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            std::ptr::addr_of_mut!(credentials).cast(),
            &mut length,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error());
    }

    Ok(PeerIdentity {
        pid: if credentials.pid > 0 {
            Some(credentials.pid as u32)
        } else {
            None
        },
        uid: Some(credentials.uid),
        executable: None,
    })
}

#[cfg(target_os = "macos")]
fn unix_peer_identity(fd: std::os::unix::io::RawFd) -> std::io::Result<PeerIdentity> {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;

    // SAFETY: both out-parameters are live locals of the right type.
    if unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } != 0 {
        return Err(std::io::Error::last_os_error());
    }

    // `LOCAL_PEERPID` is best effort: it is unavailable on some socket states,
    // and `verify_peer_process` decides what a missing pid means.
    let mut pid: libc::pid_t = 0;
    let mut length = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    // SAFETY: `pid` is a live `pid_t` and `length` describes it.
    let result = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            std::ptr::addr_of_mut!(pid).cast(),
            &mut length,
        )
    };

    Ok(PeerIdentity {
        pid: if result == 0 && pid > 0 {
            Some(pid as u32)
        } else {
            None
        },
        uid: Some(uid),
        executable: None,
    })
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn unix_peer_identity(_fd: std::os::unix::io::RawFd) -> std::io::Result<PeerIdentity> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "peer credentials are not implemented for this platform",
    ))
}

/// Decide whether a freshly accepted Unix socket peer may talk to us.
///
/// Rejects any peer whose uid differs from ours, then hands off to
/// [`verify_peer_process`] for the executable check.
#[cfg(unix)]
pub fn authorize_unix_peer(
    fd: std::os::unix::io::RawFd,
    role: PeerRole,
    policy: PeerPolicy,
) -> Result<PeerIdentity, String> {
    let mut identity = unix_peer_identity(fd)
        .map_err(|error| format!("could not read peer credentials: {}", error))?;

    let expected_uid = current_uid();
    match identity.uid {
        Some(uid) if uid == expected_uid => {}
        Some(uid) => {
            return Err(format!(
                "peer runs as uid {} but this process runs as uid {}",
                uid, expected_uid
            ));
        }
        None if policy == PeerPolicy::Required => {
            return Err("peer uid is unavailable".to_string());
        }
        None => {}
    }

    identity.executable = verify_peer_process(identity.pid, role, policy)?;
    Ok(identity)
}

// ---------------------------------------------------------------------------
// Peer executable
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
fn executable_path_for_pid(pid: u32) -> std::io::Result<PathBuf> {
    // A deleted or replaced binary yields a "<path> (deleted)" link target that
    // fails to canonicalize, so we fail closed on that too.
    std::fs::read_link(format!("/proc/{}/exe", pid))
}

#[cfg(target_os = "macos")]
fn executable_path_for_pid(pid: u32) -> std::io::Result<PathBuf> {
    use std::os::unix::ffi::OsStringExt;

    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: `buffer` is a live allocation of exactly `buffer.len()` bytes.
    let written = unsafe {
        libc::proc_pidpath(
            pid as libc::c_int,
            buffer.as_mut_ptr().cast(),
            buffer.len() as u32,
        )
    };
    if written <= 0 {
        return Err(std::io::Error::last_os_error());
    }

    buffer.truncate(written as usize);
    Ok(PathBuf::from(std::ffi::OsString::from_vec(buffer)))
}

#[cfg(windows)]
fn executable_path_for_pid(pid: u32) -> std::io::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // SAFETY: plain FFI call; `OpenProcess` returns NULL on failure.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return Err(std::io::Error::last_os_error());
    }

    // Extended-length paths cap out at 32767 UTF-16 code units.
    let mut buffer = vec![0u16; 32768];
    let mut size = buffer.len() as u32;
    // SAFETY: `handle` is a live process handle and `buffer`/`size` describe a
    // live allocation of `size` UTF-16 code units.
    let ok = unsafe {
        QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buffer.as_mut_ptr(), &mut size)
    };
    // Capture the error before `CloseHandle` can overwrite the thread's last
    // error value.
    let result = if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        buffer.truncate(size as usize);
        Ok(PathBuf::from(std::ffi::OsString::from_wide(&buffer)))
    };
    // SAFETY: `handle` came from `OpenProcess` and is not used again.
    unsafe {
        let _ = CloseHandle(handle);
    }

    result
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn executable_path_for_pid(_pid: u32) -> std::io::Result<PathBuf> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "peer executable lookup is not implemented for this platform",
    ))
}

/// Directories that may legitimately hold a Bittery executable.
///
/// Derived from the running executable's own location, which covers the three
/// layouts we ship: everything side by side in `target/<profile>` during
/// development, `Contents/MacOS` + `Contents/Resources` inside a macOS app
/// bundle, and a single install directory on Windows and Linux.
pub fn trusted_executable_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    let Ok(current) = std::env::current_exe() else {
        return dirs;
    };
    let current = std::fs::canonicalize(&current).unwrap_or(current);
    let Some(dir) = current.parent() else {
        return dirs;
    };

    push_canonical(&mut dirs, dir);
    // macOS app bundle: the two halves of the bundle can see each other.
    push_canonical(&mut dirs, &dir.join("..").join("Resources"));
    push_canonical(&mut dirs, &dir.join("..").join("MacOS"));

    dirs
}

fn push_canonical(dirs: &mut Vec<PathBuf>, candidate: &Path) {
    if let Ok(path) = std::fs::canonicalize(candidate) {
        if !dirs.contains(&path) {
            dirs.push(path);
        }
    }
}

/// Case sensitivity of executable names follows the platform's filesystem.
fn executable_names_match(expected: &str, actual: &str) -> bool {
    if cfg!(target_os = "linux") {
        expected == actual
    } else {
        expected.eq_ignore_ascii_case(actual)
    }
}

/// Pure trust decision: is `peer_executable` one of `allowed_names` sitting
/// directly inside one of `trusted_dirs`?
///
/// Both `peer_executable` and `trusted_dirs` are expected to be canonicalized
/// by the caller so that symlinks and `/var` vs `/private/var` cannot be used
/// to smuggle a mismatch past the comparison.
pub fn executable_is_trusted(
    peer_executable: &Path,
    allowed_names: &[&str],
    trusted_dirs: &[PathBuf],
) -> bool {
    let Some(name) = peer_executable.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if !allowed_names
        .iter()
        .any(|allowed| executable_names_match(allowed, name))
    {
        return false;
    }

    let Some(parent) = peer_executable.parent() else {
        return false;
    };

    trusted_dirs.iter().any(|dir| dir == parent)
}

/// Resolve the peer's executable and check it against the expected role.
///
/// This is the single choke point for peer identity. Layering real code
/// signature verification on top means adding it here — see the module docs for
/// why the current path-only check is not sufficient against an attacker with
/// write access to the install directory.
pub fn verify_peer_process(
    pid: Option<u32>,
    role: PeerRole,
    policy: PeerPolicy,
) -> Result<Option<PathBuf>, String> {
    let Some(pid) = pid else {
        return match policy {
            PeerPolicy::Required => Err("peer pid is unavailable".to_string()),
            PeerPolicy::BestEffort => Ok(None),
        };
    };

    let executable = match executable_path_for_pid(pid) {
        Ok(path) => path,
        Err(error) => {
            return match policy {
                PeerPolicy::Required => Err(format!(
                    "could not resolve the executable of peer pid {}: {}",
                    pid, error
                )),
                PeerPolicy::BestEffort => Ok(None),
            };
        }
    };

    let canonical = std::fs::canonicalize(&executable).unwrap_or(executable);
    let trusted_dirs = trusted_executable_dirs();

    if executable_is_trusted(&canonical, role.expected_executable_names(), &trusted_dirs) {
        return Ok(Some(canonical));
    }

    // A positively identified mismatch is rejected under both policies.
    Err(format!(
        "peer pid {} runs {} which is not the installed {} (expected one of {:?} in {:?})",
        pid,
        canonical.display(),
        role.label(),
        role.expected_executable_names(),
        trusted_dirs,
    ))
}

// ---------------------------------------------------------------------------
// Windows named pipe security
// ---------------------------------------------------------------------------

/// `ERROR_ACCESS_DENIED`. Spelled out so the constant is available to the pure,
/// cross-platform error mapper below.
pub const ERROR_ACCESS_DENIED_CODE: i32 = 5;

/// Access rights granted to the pipe's clients.
///
/// Enumerated one bit at a time on purpose. `FILE_GENERIC_WRITE` (the SDDL `FW`
/// alias) folds in `FILE_APPEND_DATA`, which shares its value `0x0004` with
/// `FILE_CREATE_PIPE_INSTANCE` — granting it would let any client create extra
/// instances of our pipe and impersonate the server for the next connection.
///
/// | bit          | right                   |
/// |--------------|-------------------------|
/// | `0x00000001` | `FILE_READ_DATA`        |
/// | `0x00000002` | `FILE_WRITE_DATA`       |
/// | `0x00000008` | `FILE_READ_EA`          |
/// | `0x00000010` | `FILE_WRITE_EA`         |
/// | `0x00000080` | `FILE_READ_ATTRIBUTES`  |
/// | `0x00000100` | `FILE_WRITE_ATTRIBUTES` |
/// | `0x00020000` | `READ_CONTROL`          |
/// | `0x00100000` | `SYNCHRONIZE`           |
///
/// Deliberately absent: `FILE_CREATE_PIPE_INSTANCE`, `FILE_EXECUTE`, `DELETE`,
/// `WRITE_DAC`, `WRITE_OWNER`.
pub const DESKTOP_IPC_PIPE_CLIENT_ACCESS: u32 = 0x0012_019B;

/// Access rights granted to the account running the desktop app.
///
/// The client mask plus `FILE_CREATE_PIPE_INSTANCE` (`0x0004`), which the
/// server needs in order to create the second and later instances of the pipe.
pub const DESKTOP_IPC_PIPE_OWNER_ACCESS: u32 = 0x0012_019F;

/// Build the SDDL string for the named pipe's security descriptor.
///
/// `D:P` marks the DACL protected so no inherited ACE can widen it. Only two
/// ACEs are present: `SY` (LocalSystem) gets full control, and the account
/// running the app gets the enumerated mask above. Everyone else — including
/// `Everyone` and `ANONYMOUS`, which the default NPFS DACL grants read access —
/// is denied by omission.
///
/// Kept free of `#[cfg(windows)]` so the string construction is unit tested on
/// every platform; no CI job compiles this crate for Windows.
pub fn desktop_ipc_pipe_sddl(user_sid: &str) -> String {
    format!(
        "D:P(A;;FA;;;SY)(A;;0x{:x};;;{})",
        DESKTOP_IPC_PIPE_OWNER_ACCESS, user_sid
    )
}

/// Human-readable explanation for a failed `CreateNamedPipe`.
///
/// `ERROR_ACCESS_DENIED` on the *first* instance is the interesting case:
/// `FILE_FLAG_FIRST_PIPE_INSTANCE` fails that way when the name already exists,
/// which means another process got there first and is impersonating us.
///
/// Kept free of `#[cfg(windows)]` so it can be unit tested everywhere.
pub fn describe_pipe_create_error(
    pipe_name: &str,
    raw_os_error: Option<i32>,
    first: bool,
) -> String {
    if first && raw_os_error == Some(ERROR_ACCESS_DENIED_CODE) {
        return format!(
            "the named pipe {} already exists and is owned by another process \
             (a second copy of Bittery, or something impersonating it). \
             Refusing to serve vault data over a pipe we do not control. \
             Browser extension integration is disabled until Bittery is restarted \
             with the pipe free.",
            pipe_name
        );
    }

    match raw_os_error {
        Some(code) => format!(
            "could not create the named pipe {} (os error {})",
            pipe_name, code
        ),
        None => format!("could not create the named pipe {}", pipe_name),
    }
}

/// A `SECURITY_ATTRIBUTES` plus the `LocalAlloc`ated descriptor it points at.
#[cfg(windows)]
pub struct PipeSecurity {
    descriptor: windows_sys::Win32::Security::PSECURITY_DESCRIPTOR,
    attributes: windows_sys::Win32::Security::SECURITY_ATTRIBUTES,
}

#[cfg(windows)]
impl PipeSecurity {
    /// Descriptor granting only the current user and LocalSystem.
    pub fn for_current_user() -> std::io::Result<Self> {
        let sid = current_user_sid_string()?;
        Self::from_sddl(&desktop_ipc_pipe_sddl(&sid))
    }

    fn from_sddl(sddl: &str) -> std::io::Result<Self> {
        use windows_sys::Win32::Security::Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
        };
        use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};

        let wide: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();

        // SAFETY: `wide` is NUL terminated and outlives the call; `descriptor`
        // is a live out-parameter.
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }

        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };

        Ok(Self {
            descriptor,
            attributes,
        })
    }

    /// Pointer to pass as `lpSecurityAttributes`.
    ///
    /// Valid only while `self` is alive and not moved, which is why this takes
    /// `&mut self` and callers use it directly in the `CreateNamedPipe` call.
    pub fn as_ptr(&mut self) -> *mut std::ffi::c_void {
        std::ptr::addr_of_mut!(self.attributes).cast()
    }
}

// SAFETY: the two fields are a `LocalAlloc`ated security descriptor and a plain
// `SECURITY_ATTRIBUTES` value pointing at it. Neither has thread affinity: the
// local heap is process wide, `LocalFree` may be called from any thread, and
// the descriptor is only ever read by the kernel during `CreateNamedPipe`.
//
// The IPC accept loop holds a `PipeSecurity` across `.await` so it can stamp the
// same descriptor onto every pipe instance it creates, and `tauri::async_runtime
// ::spawn` requires the resulting future to be `Send`. Rebuilding the descriptor
// per connection instead would add a syscall and a new failure path to the
// accept hot loop for no safety benefit.
//
// Deliberately not `Sync`: `as_ptr` hands out a `*mut` to `self.attributes`, so
// shared access is not sound. `&mut self` keeps that exclusive.
#[cfg(windows)]
unsafe impl Send for PipeSecurity {}

#[cfg(windows)]
impl Drop for PipeSecurity {
    fn drop(&mut self) {
        if !self.descriptor.is_null() {
            // SAFETY: the descriptor came from
            // `ConvertStringSecurityDescriptorToSecurityDescriptorW`, which
            // documents `LocalFree` as the matching deallocator.
            unsafe {
                let _ = windows_sys::Win32::Foundation::LocalFree(self.descriptor.cast());
            }
            self.descriptor = std::ptr::null_mut();
        }
    }
}

/// Closes a Win32 handle when it goes out of scope.
#[cfg(windows)]
struct HandleGuard(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for HandleGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the handle was opened by us and is not used again.
            unsafe {
                let _ = windows_sys::Win32::Foundation::CloseHandle(self.0);
            }
            self.0 = std::ptr::null_mut();
        }
    }
}

/// The current process token's user SID in string form (`S-1-5-21-...`).
#[cfg(windows)]
fn current_user_sid_string() -> std::io::Result<String> {
    use windows_sys::Win32::Foundation::{LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: `token` is a live out-parameter.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let token = HandleGuard(token);

    let mut needed: u32 = 0;
    // The first call is the documented "how big is it" probe and is expected to
    // fail with ERROR_INSUFFICIENT_BUFFER while filling in `needed`.
    // SAFETY: passing a null buffer with length 0 is the documented probe form.
    unsafe {
        let _ = GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut needed);
    }
    if needed == 0 {
        return Err(std::io::Error::last_os_error());
    }

    // `TOKEN_USER` contains a pointer, so the backing buffer must be pointer
    // aligned; a `Vec<u8>` is only guaranteed to be byte aligned.
    let mut buffer = vec![0u64; needed.div_ceil(8) as usize];
    let mut length = needed;
    // SAFETY: `buffer` holds at least `needed` bytes and is suitably aligned.
    let ok = unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }

    // SAFETY: on success the buffer holds a `TOKEN_USER`.
    let token_user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };

    let mut raw: windows_sys::core::PWSTR = std::ptr::null_mut();
    // SAFETY: `token_user.User.Sid` points into `buffer`, which is still alive.
    if unsafe { ConvertSidToStringSidW(token_user.User.Sid, &mut raw) } == 0 {
        return Err(std::io::Error::last_os_error());
    }

    // SAFETY: `raw` is a NUL-terminated wide string owned by us.
    let sid = unsafe { wide_string_to_owned(raw) };
    // SAFETY: `ConvertSidToStringSidW` documents `LocalFree` as the matching
    // deallocator.
    unsafe {
        let _ = LocalFree(raw.cast());
    }

    Ok(sid)
}

/// # Safety
///
/// `ptr` must be a valid, NUL-terminated wide string.
#[cfg(windows)]
unsafe fn wide_string_to_owned(ptr: windows_sys::core::PWSTR) -> String {
    let mut length = 0usize;
    while unsafe { *ptr.add(length) } != 0 {
        length += 1;
    }
    let slice = unsafe { std::slice::from_raw_parts(ptr, length) };
    String::from_utf16_lossy(slice)
}

/// Which end of a named pipe the peer sits on.
#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipeSide {
    /// We are the server; ask for the connected client's pid.
    Client,
    /// We are the client; ask for the server's pid.
    Server,
}

/// Decide whether a connected named pipe peer may talk to us.
///
/// There is no uid to check: the pipe's security descriptor already restricts
/// the audience to this user and LocalSystem, so the process identity check is
/// what separates our own binaries from every other program the user runs.
#[cfg(windows)]
pub fn authorize_pipe_peer(
    handle: std::os::windows::io::RawHandle,
    side: PipeSide,
    role: PeerRole,
    policy: PeerPolicy,
) -> Result<PeerIdentity, String> {
    use windows_sys::Win32::System::Pipes::{
        GetNamedPipeClientProcessId, GetNamedPipeServerProcessId,
    };

    let mut pid: u32 = 0;
    // SAFETY: `handle` is a live named pipe handle and `pid` is a live
    // out-parameter.
    let ok = unsafe {
        match side {
            PipeSide::Client => GetNamedPipeClientProcessId(handle.cast(), &mut pid),
            PipeSide::Server => GetNamedPipeServerProcessId(handle.cast(), &mut pid),
        }
    };

    let pid = if ok == 0 || pid == 0 {
        if policy == PeerPolicy::Required {
            return Err(format!(
                "could not read the peer process id: {}",
                std::io::Error::last_os_error()
            ));
        }
        None
    } else {
        Some(pid)
    };

    let executable = verify_peer_process(pid, role, policy)?;
    Ok(PeerIdentity {
        pid,
        uid: None,
        executable,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_dir_prefers_an_absolute_xdg_runtime_dir() {
        let dir = resolve_socket_dir(Some(Path::new("/run/user/1000")), Path::new("/tmp"), 1000);

        assert_eq!(dir, PathBuf::from("/run/user/1000/bittery-ipc"));
    }

    #[test]
    fn socket_dir_falls_back_to_a_uid_qualified_temp_dir() {
        let dir = resolve_socket_dir(None, Path::new("/tmp"), 1000);

        assert_eq!(dir, PathBuf::from("/tmp/bittery-ipc-1000"));
    }

    #[test]
    fn socket_dir_ignores_a_relative_xdg_runtime_dir() {
        // A relative $XDG_RUNTIME_DIR would resolve against the process cwd,
        // which an attacker may control.
        let dir = resolve_socket_dir(Some(Path::new("relative/run")), Path::new("/tmp"), 7);

        assert_eq!(dir, PathBuf::from("/tmp/bittery-ipc-7"));
    }

    #[test]
    fn socket_dir_separates_users_on_a_shared_temp_dir() {
        let alice = resolve_socket_dir(None, Path::new("/tmp"), 1000);
        let bob = resolve_socket_dir(None, Path::new("/tmp"), 1001);

        assert_ne!(alice, bob);
    }

    #[test]
    fn trusted_executable_is_accepted_from_a_trusted_directory() {
        let dirs = vec![PathBuf::from("/opt/bittery")];

        assert!(executable_is_trusted(
            Path::new("/opt/bittery/bittery-native-host"),
            NATIVE_HOST_EXECUTABLE_NAMES,
            &dirs,
        ));
    }

    #[test]
    fn executable_in_an_untrusted_directory_is_rejected() {
        let dirs = vec![PathBuf::from("/opt/bittery")];

        assert!(!executable_is_trusted(
            Path::new("/tmp/evil/bittery-native-host"),
            NATIVE_HOST_EXECUTABLE_NAMES,
            &dirs,
        ));
    }

    #[test]
    fn executable_with_an_unexpected_name_is_rejected() {
        let dirs = vec![PathBuf::from("/opt/bittery")];

        assert!(!executable_is_trusted(
            Path::new("/opt/bittery/curl"),
            NATIVE_HOST_EXECUTABLE_NAMES,
            &dirs,
        ));
    }

    #[test]
    fn executable_nested_below_a_trusted_directory_is_rejected() {
        // Only direct children count; a writable subdirectory must not inherit
        // the trust of its parent.
        let dirs = vec![PathBuf::from("/opt/bittery")];

        assert!(!executable_is_trusted(
            Path::new("/opt/bittery/nested/bittery-native-host"),
            NATIVE_HOST_EXECUTABLE_NAMES,
            &dirs,
        ));
    }

    #[test]
    fn roles_expect_different_executables() {
        let dirs = vec![PathBuf::from("/opt/bittery")];

        assert!(!executable_is_trusted(
            Path::new("/opt/bittery/bittery-native-host"),
            PeerRole::DesktopApp.expected_executable_names(),
            &dirs,
        ));
        assert!(executable_is_trusted(
            Path::new("/opt/bittery/bittery"),
            PeerRole::DesktopApp.expected_executable_names(),
            &dirs,
        ));
    }

    #[test]
    fn sddl_grants_only_system_and_the_named_user() {
        let sddl = desktop_ipc_pipe_sddl("S-1-5-21-1-2-3-1001");

        assert_eq!(sddl, "D:P(A;;FA;;;SY)(A;;0x12019f;;;S-1-5-21-1-2-3-1001)");
    }

    #[test]
    fn sddl_dacl_is_protected() {
        let sddl = desktop_ipc_pipe_sddl("S-1-5-21-1-2-3-1001");

        assert!(sddl.starts_with("D:P"), "DACL must be protected: {}", sddl);
    }

    #[test]
    fn sddl_never_grants_world_or_anonymous_access() {
        let sddl = desktop_ipc_pipe_sddl("S-1-5-21-1-2-3-1001");

        // WD = Everyone, AN = ANONYMOUS, BU = Users, IU = INTERACTIVE.
        for alias in [";WD)", ";AN)", ";BU)", ";IU)"] {
            assert!(
                !sddl.contains(alias),
                "{} must not appear in {}",
                alias,
                sddl
            );
        }
    }

    #[test]
    fn client_access_mask_excludes_create_pipe_instance() {
        const FILE_CREATE_PIPE_INSTANCE: u32 = 0x0004;

        assert_eq!(
            DESKTOP_IPC_PIPE_CLIENT_ACCESS & FILE_CREATE_PIPE_INSTANCE,
            0
        );
    }

    #[test]
    fn access_masks_exclude_generic_and_ownership_rights() {
        const GENERIC_ALL: u32 = 0x1000_0000;
        const GENERIC_EXECUTE: u32 = 0x2000_0000;
        const GENERIC_WRITE: u32 = 0x4000_0000;
        const GENERIC_READ: u32 = 0x8000_0000;
        const DELETE: u32 = 0x0001_0000;
        const WRITE_DAC: u32 = 0x0004_0000;
        const WRITE_OWNER: u32 = 0x0008_0000;

        let forbidden = GENERIC_ALL
            | GENERIC_EXECUTE
            | GENERIC_WRITE
            | GENERIC_READ
            | DELETE
            | WRITE_DAC
            | WRITE_OWNER;

        assert_eq!(DESKTOP_IPC_PIPE_CLIENT_ACCESS & forbidden, 0);
        assert_eq!(DESKTOP_IPC_PIPE_OWNER_ACCESS & forbidden, 0);
    }

    #[test]
    fn owner_access_mask_is_the_client_mask_plus_create_pipe_instance() {
        const FILE_CREATE_PIPE_INSTANCE: u32 = 0x0004;

        assert_eq!(
            DESKTOP_IPC_PIPE_OWNER_ACCESS,
            DESKTOP_IPC_PIPE_CLIENT_ACCESS | FILE_CREATE_PIPE_INSTANCE
        );
    }

    #[test]
    fn access_denied_on_the_first_instance_reads_as_a_squatted_pipe() {
        let message = describe_pipe_create_error(
            r"\\.\pipe\bittery-desktop-ipc",
            Some(ERROR_ACCESS_DENIED_CODE),
            true,
        );

        assert!(message.contains("already exists"), "{}", message);
        assert!(message.contains("another process"), "{}", message);
    }

    #[test]
    fn access_denied_on_a_later_instance_is_a_plain_failure() {
        let message = describe_pipe_create_error(
            r"\\.\pipe\bittery-desktop-ipc",
            Some(ERROR_ACCESS_DENIED_CODE),
            false,
        );

        assert!(!message.contains("already exists"), "{}", message);
        assert!(message.contains("os error 5"), "{}", message);
    }

    #[test]
    fn unknown_pipe_errors_still_produce_a_message() {
        let message = describe_pipe_create_error(r"\\.\pipe\x", None, true);

        assert!(message.contains(r"\\.\pipe\x"), "{}", message);
    }

    #[test]
    fn missing_pid_is_fatal_only_under_the_required_policy() {
        assert!(verify_peer_process(None, PeerRole::NativeHost, PeerPolicy::Required).is_err());
        assert_eq!(
            verify_peer_process(None, PeerRole::NativeHost, PeerPolicy::BestEffort),
            Ok(None)
        );
    }

    #[test]
    fn an_unresolvable_pid_is_fatal_only_under_the_required_policy() {
        // pid 0 is never a real peer, so the lookup is guaranteed to fail.
        let unresolvable = Some(0);

        assert!(
            verify_peer_process(unresolvable, PeerRole::NativeHost, PeerPolicy::Required).is_err()
        );
        assert_eq!(
            verify_peer_process(unresolvable, PeerRole::NativeHost, PeerPolicy::BestEffort),
            Ok(None)
        );
    }

    #[test]
    fn a_foreign_process_is_rejected_under_both_policies() {
        // The test binary itself is a real, resolvable process that is neither
        // the desktop app nor the native host.
        let own_pid = std::process::id();

        assert!(
            verify_peer_process(Some(own_pid), PeerRole::NativeHost, PeerPolicy::Required).is_err()
        );
        assert!(
            verify_peer_process(Some(own_pid), PeerRole::NativeHost, PeerPolicy::BestEffort)
                .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn socket_path_lives_inside_the_socket_dir() {
        let dir = desktop_ipc_socket_dir();
        let path = desktop_ipc_socket_path();

        assert_eq!(path.parent(), Some(dir.as_path()));
        assert_eq!(path.file_name().unwrap(), DESKTOP_IPC_SOCKET_NAME);
    }

    #[cfg(unix)]
    #[test]
    fn socket_candidates_start_with_the_primary_path_and_are_unique() {
        let candidates = desktop_ipc_socket_candidates();

        assert_eq!(candidates.first(), Some(&desktop_ipc_socket_path()));
        for (index, candidate) in candidates.iter().enumerate() {
            assert!(
                !candidates[index + 1..].contains(candidate),
                "duplicate candidate {}",
                candidate.display()
            );
        }
    }

    /// Scratch directory that removes itself, so the filesystem-touching tests
    /// below do not depend on the ambient environment.
    #[cfg(unix)]
    struct Scratch(PathBuf);

    #[cfg(unix)]
    impl Scratch {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "bittery-ipc-test-{}-{}-{:?}",
                label,
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("scratch dir should be creatable");
            Self(path)
        }

        fn join(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    #[cfg(unix)]
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;

        std::fs::symlink_metadata(path)
            .expect("path should exist")
            .permissions()
            .mode()
            & 0o777
    }

    #[cfg(unix)]
    #[test]
    fn prepared_socket_dir_is_created_private() {
        let scratch = Scratch::new("create");
        let dir = scratch.join("socket-dir");

        prepare_socket_dir(&dir).expect("socket dir should be preparable");

        assert_eq!(mode_of(&dir), 0o700, "mode was {:o}", mode_of(&dir));
    }

    #[cfg(unix)]
    #[test]
    fn prepared_socket_dir_tightens_a_permissive_existing_dir() {
        use std::os::unix::fs::PermissionsExt;

        let scratch = Scratch::new("tighten");
        let dir = scratch.join("socket-dir");
        std::fs::create_dir(&dir).expect("dir should be creatable");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777))
            .expect("dir should be chmod-able");

        prepare_socket_dir(&dir).expect("socket dir should be preparable");

        assert_eq!(mode_of(&dir), 0o700, "mode was {:o}", mode_of(&dir));
    }

    #[cfg(unix)]
    #[test]
    fn prepared_socket_dir_rejects_a_symlink() {
        let scratch = Scratch::new("symlink");
        let target = scratch.join("elsewhere");
        std::fs::create_dir(&target).expect("target should be creatable");
        let link = scratch.join("socket-dir");
        std::os::unix::fs::symlink(&target, &link).expect("symlink should be creatable");

        let error = prepare_socket_dir(&link).expect_err("a symlinked socket dir must be refused");

        assert!(
            error.to_string().contains("not a directory"),
            "unexpected error: {}",
            error
        );
    }
}
