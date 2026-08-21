# Open questions

These topics require new bounded grilling sessions. Research conclusions are inputs, not decisions.

## Product and releases

- Exact first-release feature set versus long-term product.
- Import/export portability and whether any current format is retained conceptually.
- Detailed administrative governance, quotas, and retention.
- Detailed Share-link policy and anonymous recipient experience.
- Supported OS/browser version matrix.
- Accessibility and localization release requirements.

## Cryptographic formats

- Recovery two-factor construction, atomic authorization order, and any derivation labels it proves
  necessary.
- Device enrollment protocol and Device Unlock Wrapper construction.
- Vault-key rotation lifecycle and the operational threshold below the AES-256-GCM-SIV usage ceiling.

## Local security

- Exact Device Unlock Wrapper interface and per-platform policies.
- Browser quick unlock baseline and optional WebAuthn PRF investigation.
- iOS App Group/Keychain access-group and multi-process database strategy.
- Android app/credential-provider process choice and locking.
- Windows Hello and Linux Secret Service capability levels.
- Configurable online revalidation defaults and behavior.

## Replica and Sync

- Replica schema and transactional adapter interface.
- Operation format and state machine.
- Cursor, bootstrap, rejection, conflict, and indeterminate semantics.
- Locked-state ciphertext synchronization policy.
- Revision-history retention and tombstone compaction.
- Multi-Account/Collection index and search behavior.

## Server

- Complete vertical domain interfaces and permitted cross-domain calls.
- SQLx version freeze and dependency-upgrade policy details.
- Simple deployment Postgres operations and supported object storage adapters.
- Backup format, encryption, restore validation, and Server identity recovery.
- Public OpenAPI compatibility and capability negotiation.

## Platform design

- Tauri local runtime protocol and capability allowlist.
- Effect v4 host structure after stable release; exact beta migration strategy during development.
- Extension background lifetime and desktop integration protocol.
- Native AutoFill/Credential Manager projections and unlock experience.
- Performance budgets and representative Vault sizes/devices.
