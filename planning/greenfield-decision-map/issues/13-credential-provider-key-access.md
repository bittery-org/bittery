# Credential-provider process key access

Type: grilling
Status: resolved
Blocked by: 12

## Question

Mobile ships later, but this decision constrains the engine now, and it is exactly where the previous implementation's security model broke. The frozen Android path calls `crypto.exportKey(masterUnlockKey)` and hands base64 across the seam **today**, in both directions, and inside Kotlin the KeyRef discipline is dropped entirely. Two frozen documents disagree about whether the provider even runs in its own process. See [current-state verification](../research/current-state-verification.md) and [corpus review, Significant #4](../research/corpus-review.md).

`ARCH-ENGINE-002` says these processes "use constrained runtimes and an explicit shared-store locking/protocol design", which names the ciphertext problem and skips the key problem.

Decide:

- How an OS-launched credential-provider process obtains decryption capability: its own OS-gated wrapper with a narrower key, IPC from the main runtime, or something else.
- Whether that key is narrower than the master unlock key: autofill-scoped, per-Vault, or read-only.
- The concurrency and locking protocol over a shared replica when two processes are live.
- The reduced guarantee this creates, written as a requirement rather than left implicit.
- Whether the same shape serves iOS AutoFill and Android Credential Manager, or whether they diverge.

Produces: `ARCH-ENGINE-002` refinement, a key-scope decision, and an ADR.

## Answer

Resolved with the maintainer and promoted to `PRIVACY-017`, `AUTH-045` through `AUTH-048`,
`ITEM-007`, `ARCH-ENGINE-002`, `ARCH-ENGINE-007` through `ARCH-ENGINE-013`, `ARCH-STORE-020`, and
`ARCH-STORE-027` in [`docs/greenfield/target/`](../../../docs/greenfield/target/), the local bytes in
[`cryptographic-format.md`](../../../docs/greenfield/target/cryptographic-format.md), seed scenario
[16](../../../docs/greenfield/scenarios/13-credential-provider-save.yaml), the root glossary, and
accepted ADR
[0024](../../../docs/adr/0024-credential-providers-use-full-account-keys-behind-a-closed-core-interface.md).

### Full keys inside a closed Provider core

iOS AutoFill and Android Credential Manager/Autofill use one semantic design. Each OS-launched
Credential Provider is an independent constrained `ClientRuntime` host even if Android currently
co-locates its service in the application's process. It shares no engine singleton, unlocked session,
live key, or correctness-critical heap state with the main host.

The Provider opens the complete Account Key Set inside its Rust core. Immediate offline password and
passkey creation or update requires both a Vault key and the Account Signing Key; an autofill-only
cryptographic key would need a second projection, recipient-grant, signature, and Sync protocol. That
complexity was rejected. Swift, Kotlin, UI code, and public bindings receive no Account, Vault,
wrapping, or signing key and no generic decryption or key-handle capability. A binding may return only
the User-selected credential response required by the OS flow.

The public Provider interface is closed to locked suggestions; Login search and selection; password
fill; TOTP; passkey assertion and registration; Login/passkey creation and update in a named writable
Vault; and one-time or persistent website/application match confirmation. It has no general Vault or
Item browser, Secure Notes, Attachments, Teams, administration, import/export, or Sentinel.

### Separate wrappers and sessions

Each Account has independently generated main-host and Provider wrapper records. Provider password
quick unlock is the baseline and reuses the existing canonical `PasswordUnlockRecord` with a fresh
Device factor and envelope. Optional Provider platform quick unlock is **system-gated**: iOS uses
User Presence and Device-only Apple protection; Android uses an authentication-required Keystore
anchor. Verified Secure Enclave, TEE, or StrongBox protection is labeled **hardware-gated**. Android
software Keystore fallback remains only **system-gated**. A missing or invalid platform anchor falls
back to master-password quick unlock and requires that route plus fresh consent to replace it.

One Provider authorization tries independent wrappers for every locally enabled Account; All Accounts
is the default suggestion scope, with an Account or later Collection filter permitted. Every save
still identifies one Account and writable Vault. Main and Provider sessions do not unlock or renew one
another and there is no persisted Unlock Lease or Account-key handoff. Process termination destroys
that host's keys. Explicit Lock, OS session lock, suspend, learned revocation, removal, recovery, and
sign-out advance shared lock state that invalidates both hosts.

Main and Provider hosts are one enrolled Mobile Device with one visible Device Grant, public
credential key, status, and revocation stream. Each host and authorization method stores a separate
context `0x04` wrapping of the same private Ed25519 Device-credential seed, which only Rust opens.
Concurrent hosts reserve disjoint request-counter ranges through guarded Replica commits. This lets
the Provider authenticate its own best-effort Sync without a raw key bridge or a second visible
Provider Device.

### Locked suggestions and the honest reduced guarantee

Before Account unlock, the Provider may read one separately protected Suggestion Index containing
only Item title, username, website/application match, and User-chosen local Account label. It contains
no password, TOTP seed, passkey private material, Vault or Server name, other Item field, Attachment,
Team data, count, or activity. [Search and autofill index](20-search-and-autofill-index.md) owns the
exact encryption, match keys, rebuild, and invalidation under this closed bound.

The reduced guarantee is explicit. Anyone who can read the unlocked Device store or control the
Provider process may learn the approved preview. Once the Provider core is unlocked, control of that
core compromises every Account opened in its session, including valid reads and Item writes. This is
an Acknowledged Compromised Endpoint. A narrow command API is not described as read-only or
autofill-scoped cryptographic protection.

### One Replica, guarded concurrency, and durable saves

Main and Provider hosts use the same canonical Account Replica, local operation overlay, guarded
commits, and Sync state. There is no Provider mirror. Ordinary snapshots, commits, and Sync hold an
OS-released shared Replica Lease; their database transactions and guarded commit sequences establish
the serial order. Migration, repair, store replacement, Account removal, and Device wipe require the
same per-Account lease exclusively. Contention returns retryable busy, and process death releases the
lease without a cleanup message.

A Provider create or update succeeds after the Replica's declared Durability barrier accepts the
complete local operation. The Provider attempts Sync within its remaining OS execution budget. If it
is offline, interrupted, or terminated, any later main or Provider host resumes that exact pending
operation. It never acknowledges an in-memory credential mirror as a saved Bittery Item.
