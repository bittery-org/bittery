# Linux Desktop application smoke

This harness drives the actual Tauri application and WebKitGTK through external WebDriver. It
checks the existing Login UI, renderer reload with the native PID preserved, process exit, and a
new native process reopening the same isolated profile. It is explicitly a smoke test of the
legacy production composition, not acceptance of Rust Account ownership or authenticated restart.

Prerequisites: Linux, Node 24+, Python 3, `libkeyutils.so.1`, `bwrap` with user namespaces enabled,
`xvfb-run`, `dbus-run-session`, `tauri-driver`, and a WebKitWebDriver matching the installed
WebKitGTK. No new JavaScript test dependency or application plugin is needed.

Build and start the application prerequisites from the repository root:

```sh
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --bin Bittery
pnpm --filter desktop dev:vite
```

With Vite running, use another terminal:

```sh
node apps/desktop/tests/e2e/smoke.mjs
```

Use `--driver /absolute/path/to/tauri-driver`, `--webkit-driver /absolute/path/to/WebKitWebDriver`
and `--application /absolute/path/to/Bittery` to select local tools/binaries. The default application
is the repository's debug binary. This script is not part of ordinary package unit tests or
`pnpm check:ci`; run it explicitly for Desktop evidence.

The script mounts a temporary home without overriding `HOME`, creates separate XDG data/config/cache
and runtime directories, and uses a new user namespace plus a fresh kernel session keyring.
Repository files are read-only inside the application sandbox. Debug native-host registration can
only see the isolated browser profile. No installed browser profile or existing Account is used.
The driver and application run under Xvfb with software rendering; ports are selected locally.

The printed temporary directory retains `evidence.json`, `login.png`, and `driver.log`, including
actual native PIDs and WebDriver capabilities. Cleanup closes the application session and driver
process group. Read the assertion list and limitations before citing a run. Native IPC listener
startup alone does not prove native messaging, and an empty Login screen does not prove Replica
durability. Linux evidence does not cover Touch ID, Windows Hello, or Safari.

On Debian 13 the former `webkit2gtk-driver` package is transitional; the actual binary is in
`webkitgtk-webdriver`. Local tool installation can avoid system changes:

```sh
cargo install tauri-driver --locked --root /tmp/bittery-webdriver-tools
```

The matching Debian package can likewise be downloaded using `apt-get download webkitgtk-webdriver`
and extracted with `dpkg-deb -x` into a temporary directory. Pass its `usr/bin/WebKitWebDriver` path
explicitly. The smoke does not install tools automatically.

Tauri documents [external WebDriver](https://v2.tauri.app/develop/tests/webdriver/) and
[Linux Xvfb setup](https://v2.tauri.app/develop/tests/webdriver/ci/). External Linux WebDriver tests
exercise native WebKit; generic Playwright WebKit or mocked Tauri commands do not replace them.
