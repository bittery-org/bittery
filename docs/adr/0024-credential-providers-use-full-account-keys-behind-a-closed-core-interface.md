# Credential Providers use full Account keys behind a closed core interface

Status: accepted

A mobile Credential Provider must fill, create, and update passwords and passkeys immediately while
the main application is not running. Bittery's canonical Item writes require a Vault key and the
Account Signing Key, so an autofill-only key would need a second projection, grant, signature, and
Sync protocol. The Provider therefore opens the complete Account Key Set only inside an independent
constrained Rust core, behind a closed credential capability interface; no key or key handle crosses
a Swift, Kotlin, or UI binding.

## Consequences

Main and Provider hosts keep separate wrapper records and unlocked sessions. They share the canonical
Account Replica through guarded commits and an OS-released shared/exclusive Replica Lease, not through
a mirror or live-key bridge. Before unlock, a separately protected Suggestion Index exposes only the
approved preview fields. After unlock, code execution inside the Provider core compromises the whole
opened Account and is documented as an Acknowledged Compromised Endpoint. A cryptographically narrower
Provider and a persisted cross-process unlock handoff were rejected because their extra protocol and
security state did not justify their narrower or more convenient behavior.

Both hosts remain one enrolled Mobile Device. Each host and Unlock method separately wraps the same
Device credential seed, so the Provider can sign and Sync without raw key transfer or a second visible
Device Grant. Guarded Replica commits reserve disjoint request-counter ranges across the concurrent
hosts; a crash may waste counters but cannot reuse them.
