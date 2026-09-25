# Desktop and Extension production ownership inventory

Type: research
Status: resolved
Blocked by:

## Question

Which production paths still own behavior outside the shared Rust Client Runtime, and what must
migrate before Desktop, then Extension, can pass production acceptance?

## Scope

Inspect actual production callers and the completed Web paths. Historical ticket closure is not
evidence of Desktop or Extension integration. Include all five Item categories, Vault operations,
Attachments, Share links and shared Vaults, Import, travel mode, Account management, recovery,
biometrics, autofill/passkeys, and Desktop–Extension native messaging. Identify shared transitional
callers in every application before scheduling deletion.

## Evidence

Parallel read-only host/Core investigations completed 2026-09-08 against the initial clean worktree:

- [Desktop inventory](../desktop-extension/desktop-inventory.md).
- [Extension inventory](../desktop-extension/extension-inventory.md).
- [Shared Runtime and Web caller inventory](../desktop-extension/runtime-inventory.md).

Both applications still use transitional owners. Core has all five Item categories, durable Vault
creation/Import, Attachments, Share links, and Replica recovery; biometric unlock, Vault update/delete,
Travel mode management, device setup disclosure, and Extension passkey/native transfer capabilities
remain missing. Features with no local UI are recorded explicitly, including Import/account-recovery
destinations on Web. No new Desktop/Extension UI is implied by a shared-library capability.

The native binding is currently headless; it is not a production Desktop integration. Desktop's
native cache decryptor and Extension popup live keys are separate owners that must be removed.
Web credential/rotation/Vault owners and Mobile callers constrain shared deletion.

Safe cache recovery follows already accepted tickets 09/10/42: a migrated cache-clear gesture uses
guarded re-Bootstrap and preserves accepted Operations; blocked repair exposes protected recovery,
never a silent discard. Explicit Remove/Wipe remain the existing destructive gestures.

This research establishes implementation scope, not acceptance. The linked specification and
dependency tickets record the next decision-complete slice; unresolved later contracts stay visible.

## Acceptance

- Every production path has a concrete caller, current behavioral owner, target owner, and acceptance
  obligation; an unsupported host feature is distinguished from a missing Runtime capability.
- Desktop placement is resolved separately in ticket 61, including the ADR 0010 conflict.
- Browser acceptance scope is resolved separately in ticket 62 against accepted ticket 41.
- Decision-complete slices receive a specification and dependency-ordered delivery tickets.
