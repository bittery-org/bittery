# Bittery Desktop patch

This directory contains the Rust/build/platform inputs from the published
`tauri-plugin-biometry` 0.2.8 crate, under its original [MIT license](LICENSE).
Upstream: [Choochmeque/tauri-plugin-biometry](https://github.com/Choochmeque/tauri-plugin-biometry),
commit `49848154cfb6c34390316f190f9ce0bea23ca811` from the crate's `.cargo_vcs_info.json`.
Published crate SHA-256:
`d1d70628154316603585a1e82e41edac5f8a3946c045fb365c38c9ccc2255122`.
The original package manifest is retained as `Cargo.toml.orig`. JavaScript package/build files
and the upstream package's independent lockfiles are omitted; Desktop's existing Cargo lock owns
resolution. Upstream data-store and cryptographic methods are preserved.

Ticket 67 adds `PromptCancellation`, `authenticate_cancellable`, and `Error::code` for the native
Rust Client Runtime adapter. Existing `authenticate` callers keep their API and behavior. The
signal is independent of Core, Tokio, authentication policy, and key storage. `windows-future` 0.2
is promoted from the existing Windows dependency graph to access its OS completion callback type.

On macOS, cancellation calls `LAContext.invalidate()` and retains the context until the evaluation
callback arrives. Apple documents that invalidation stops pending evaluations with `LAErrorAppCancel`:
[LAContext invalidation](https://developer.apple.com/documentation/localauthentication/lacontext/invalidate()).
On Windows, the patch retains the existing verification operation, requests `Cancel()`, and waits
for its completed callback. Microsoft's [IAsyncInfo cancellation contract](https://learn.microsoft.com/en-us/windows/win32/api/asyncinfo/nf-asyncinfo-iasyncinfo-cancel)
describes a cancellation request; requesting cancellation does not itself prove native completion.
A callback received after cancellation cannot become a successful Runtime unlock.

The plugin polls the cancellation signal while waiting for the native callback; its 10 ms polling
interval is only native notification plumbing. No prompt timeout, retry, unlock grace, password
re-entry rule, or other application policy is added. Linux remains unsupported by the existing
plugin. Mobile APIs are unchanged and do not expose the new Desktop primitive.

The native adapter owns a prompt permit through actual blocking-job completion and requests
cancellation when Core cancels or drops its awaiting future. Unit tests exercise signal/drain and
permit ownership with real threads, without claiming an OS biometric result. Actual macOS and
Windows prompt dismissal, callback completion, lock races, enrollment changes, and Windows Hello
behavior remain hardware acceptance requirements; a Linux test or cross-target check cannot prove
them. In particular, Windows' cancellation request must be observed on the supported Windows app.

Checks on 2026-09-09: three plugin unit tests and four native adapter tests passed. The plugin also
passed Rust checks for `x86_64-pc-windows-gnu` and `aarch64-apple-darwin`. The Apple check used Clang 19
and llvm-ar through `CC_aarch64_apple_darwin` and `AR_aarch64_apple_darwin`; this was a compiler check
on Linux, without running an Apple application. Unchanged legacy macOS keychain methods emit four
upstream deprecation warnings. Windows callback-registration failure waits for terminal operation
status directly after requesting cancellation, avoiding `get()` re-registering a failing callback.
