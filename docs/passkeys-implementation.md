# Passkeys Implementation Plan and Status (Extension-First)

Updated: 2026-02-11

## Scope and Target

This document tracks implementation status against the full passkey plan from `docs/roadmap/passkey-support.md`.

V1 target remains:
- Extension-first WebAuthn interception (`create` + `get`).
- Shared Rust crypto and encrypted item storage.
- No DB schema migration.
- Native browser fallback when no Bittery credential matches.
- End-to-end registration/login success on real WebAuthn test sites.

## Design Defaults (Plan Baseline)

- Attestation format: `fmt: "none"`.
- Algorithm: ES256 (`-7`).
- Fixed Bittery AAGUID.
- Passkeys stored inside encrypted login item JSON (`passkeys[]`).
- Private key format: base64-encoded 32-byte P-256 scalar.
- Matching based on deterministic rpId/domain logic (not fuzzy autofill matching).
- Extension UI via overlay/iframe pattern (not popup-first).

## Phase-by-Phase Status

## Phase 1: Crypto Core and Bindings

Status: **Mostly complete**

Implemented:
- Added Rust passkey module:
  - `packages/crypto/core/crates/bittery-crypto-core/src/passkey.rs`
- Added dependencies in workspace/core Cargo manifests:
  - `p256`, `ecdsa`, `ciborium`
- Exported passkey symbols from core lib.
- Implemented crypto primitives:
  - keypair generation
  - credential ID generation
  - COSE public key encoding
  - authenticator data construction
  - attestation object construction
  - assertion signing
- Added passkey unit tests in Rust module.
- Added WASM exports:
  - `generatePasskeyKeypair`
  - `generatePasskeyCredentialId`
  - `buildPasskeyAttestationObject`
  - `signPasskeyAssertion`
- Added extension WASM wrappers in:
  - `apps/extension/src/lib/wasm-crypto.ts`
- Added FFI functions with `bittery_passkey_*` prefix.
- Added JNI bridge wrappers in `bittery-crypto-ffi`.
- Added Android credential-provider NativeCrypto wrapper methods for future use.

Still pending for full cross-platform parity:
- Desktop/Tauri command surface for passkey helpers.
- Web app wrapper parity (if web app needs these helpers directly in later phases).

## Phase 2: Shared Types and Serialization

Status: **Complete for planned V1**

Implemented:
- Added `Passkey` type in `packages/shared/src/types.ts`.
- Added `passkeys?: Passkey[]` to:
  - `DecryptedItemData`
  - `LoginDisplayData`
- Storage model remains migration-free (encrypted JSON payload only).

## Phase 3: Extension Injection and Bridge

Status: **Complete baseline**

Implemented:
- Added MAIN-world page script at `document_start` to intercept WebAuthn:
  - `apps/extension/src/page-script/passkey.ts`
- Added content bridge:
  - `apps/extension/src/content-script/passkey-bridge.ts`
  - `apps/extension/src/content-script/passkey-bridge-entry.ts`
- Added shared passkey message/types helpers:
  - `apps/extension/src/passkey/types.ts`
  - `apps/extension/src/passkey/base64.ts`
- Added manifest wiring in:
  - `apps/extension/manifest.config.js`
- Implemented request correlation, origin/source checks, and timeout behavior.

## Phase 4: Background Passkey Handlers

Status: **Partially complete**

Implemented:
- Added passkey handlers:
  - `apps/extension/src/background/passkey-handlers.ts`
- Added router integration in:
  - `apps/extension/src/background/message-router.ts`
- Create flow implemented:
  - parse options
  - keypair + credential generation
  - attestation build
  - save to existing login (when confident) or create new login
- Get flow implemented:
  - rpId validation
  - `allowCredentials` filtering
  - signing path + `signCount`/`lastUsedAt` persistence
  - explicit fallback to native when no match
- Feature flag gate added (`feature_passkeys_v1_enabled`).
- Lock/session checks integrated with existing extension unlock behavior.

Still pending to satisfy V1 UX requirements:
- Multi-match get flow must show picker UI (currently first match is auto-selected).
- Ambiguous create flow must prompt for save target (currently falls back to first writable vault/new item).
- Strong cancellation semantics end-to-end (current cancel path is minimal).

## Phase 5: Extension UI (Picker and Save Target)

Status: **Not started**

Pending:
- New passkey picker iframe entry + HTML + web-accessible resource wiring.
- Overlay launcher using existing overlay-utils model.
- Save-target prompt for create:
  - auto-attach when exactly one confident match
  - prompt when ambiguous (existing login vs create new)
- Minimal payload and ranking display (site/account/vault/last-used).

## Phase 6: Observability, Flagging, and Rollout

Status: **Partially complete**

Implemented:
- Feature flag gate exists in background handlers.

Pending:
- Structured telemetry/log events:
  - create intercepted
  - get intercepted
  - native fallback reason
  - signing errors
  - attach/create decision path
- Rollout workflow:
  - internal dogfood
  - staged beta
  - production enablement

## V1 Completion Checklist (Extension)

Remaining to declare extension V1 complete:
- Passkey picker UI for multi-match `get`.
- Save-target prompt for ambiguous `create`.
- Background flow wiring to use those UI decisions.
- Observability events + rollout policy.
- Unit tests for message routing/matching/update/fallback paths.
- E2E verification on real WebAuthn test sites:
  - registration
  - login
  - multi-match selection
  - native fallback when no Bittery match
  - locked-state handling

## Post-V1 / Deferred Work (Full Plan)

These are part of the full plan but intentionally deferred beyond extension V1:

- Android credential provider public-key credential flows.
- Desktop Tauri passkey crypto commands + desktop-bridge passkey delegation.
- Web/desktop/mobile passkey management UI (view/manage passkeys on item detail pages).
- Passkeys.directory integration:
  - site support lookup
  - “passkey supported” indicators/prompts
  - dashboard metrics
- iOS credential provider extension implementation.

## Current Validation Snapshot

- Type checks passing:
  - `apps/extension`
  - `packages/shared`
- Rust/WASM build path compiles with passkey module changes in this repo state.
