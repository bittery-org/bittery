# Crypto gets an enforced seam: `CryptoPort` + `VaultCrypto`

## Context

`packages/storage` proved a shape: a dumb, **total** port with zero optional members, a deep
module above it holding all policy, and one conformance suite run against every adapter.
`packages/storage/CONTEXT.md` §2 states the rule — "every method is total, so the compiler
verifies that an adapter satisfies the contract."

Crypto never got it. `ICrypto` (`packages/types/src/index.ts:24`) has 12 members, 3 of them
optional, and unions sync with async. It is not the real seam: five hand-written adapters
sit behind it and 33 app files reach past it into the concrete module for the operations it
doesn't carry. `auth-service.ts:308` probes `typeof crypto.deriveKeyHandles === "function"`
at runtime. `packages/storage`'s own `CryptoProvider` carries 3 required and 7 optional
members, and `AccountStore` caches the master unlock key as `number | Uint8Array` because of
it. Nothing tests any of this.

The algorithms are not the problem — ADR 0001 already puts every primitive in one Rust core
with 142 tests and format vectors. The drift is entirely in the TypeScript binding layer.

Outcome: one total `CryptoPort`, four adapters the compiler verifies, key material that
crosses every seam as an opaque `KeyRef`, the seven account key ceremonies lifted out of web
React components into a shared `VaultCrypto`, and crypto's first cross-adapter tests.

## What the exploration changed about the original candidate

- **Five implementations, not four.** `apps/web/src/lib/worker-crypto.ts` (350) +
  `crypto.worker.ts` (490) is a second web adapter, used only by `use-signup-form.ts` and
  `routes/_auth/recover.tsx`.
- **Rotation and master-key wrapping are already single Rust calls** (`wasmPerformKeyRotation`,
  `invoke("crypto_perform_key_rotation")`), so they belong on the port, not inside
  `VaultCrypto`. What is genuinely TS-side policy is the envelope/wrap-context handling and
  the seven multi-step ceremonies.
- **Most "web-only" operations are already bound in Rust and merely unexported in TS.** Tauri
  has `crypto_re_encrypt_item` / `crypto_encrypt_vault_key_for_member`; the mobile FFI has all
  four `bittery_passkey_*` and `bittery_perform_key_rotation`. The real binding gap is 17
  functions.
- **Envelope policy lives inside the adapters today**: all four import
  `@bittery/shared/vault-key-crypto` and `crypto-context-envelope` directly. That is the
  policy-below-the-seam leak, and it moves above the port.

## Design

```
                apps  (wiring only: createWasmWorkerCryptoPort(), …)
                          |
   VaultCrypto      @bittery/core/services/vault-crypto.ts
   the seven ceremonies · envelope + wrap context · KDF pinning
                          |
   AccountStore / ItemCache          @bittery/storage   (speaks KeyRef)
                          |
   CryptoPort       @bittery/crypto-port   total, async, no optional members
                          |
   wasm-worker   wasm   tauri   expo      pure marshalling, no policy
                          |
   port-conformance · one suite body, four adapters + in-memory fake
```

`CryptoPort` must sit **below** `storage` (AccountStore wraps the MUK under the device key)
while `VaultCrypto` sits **above** it (the ceremonies read and write accounts). They cannot be
one package.

### `KeyRef` is the only currency for key material

Opaque handle, never raw bytes at a seam. Web's `KeyRef` is a WASM key-table handle that never
leaves the worker thread; desktop, mobile and the extension implement it as a boxed
`Uint8Array` whose `destroyKey` zeroizes. This is what makes the port total: the nine
web-only key-handle operations become ordinary port members with a trivial implementation
elsewhere, and `HandleCapableCrypto` / `asHandleCapableCrypto` / `CryptoProvider`'s seven
optional members / `AccountStore`'s handle-twin methods all disappear.

`getMasterUnlockKey(): Promise<KeyRef | null>` — 124 call sites across 34 files. It is a type
change, so the compiler finds every one.

### What is *not* on the port

- `arrayBufferToBase64` / `base64ToArrayBuffer` — pure, already in `@bittery/shared/crypto`.
- `getSecretKeyHint` / `getRecoveryKeyHint` — string splitting, not crypto. Move to shared.
- `validateKdfProfile` — KDF pinning is TS policy (`@bittery/shared/kdf-policy`, used by
  `packages/storage/src/kdf-profile.ts` below core). `VaultCrypto` calls
  `validateKdfProfileOrThrow`. Removing it from the port also removes one FFI gap.

### Normalisation, applied everywhere

All-async, one spelling. Kills `generateEncryptionKey(): string` (mobile) vs
`Promise<Uint8Array>`, `validateSecretKey` sync-on-three/async-on-desktop,
`generateRSAKeyPair` vs `generateRsaKeyPair`, and web's eight `X`/`XAsync` twins.

### `port-conformance` asserts the mapping, not the algorithms

No backend loads in `bun:test` (WASM is `--target web`, mobile is an Expo native module,
desktop is Tauri IPC, `@bittery/crypto-napi` exports only two server-side SRP functions). So
each adapter runs the one suite body over a **doubled backend**, exactly as
`packages/storage/src/adapters/tauri-test-doubles.ts` does. It pins what the TS layer owns and
the Rust tests cannot see: argument marshalling, base64 boundaries, `KeyRef` lifetime (destroy
zeroizes; use-after-destroy throws), error translation, and that a missing key throws rather
than returning `null`. Storage's two rules carry over verbatim — **no platform import, no
branching on `name`**. Ciphertext interop stays where it already is: the Rust vectors.

## Implementation

One PR. The stages below are commit boundaries within it, not separate PRs.

### 1 · Rust bindings (17 functions, all thin wrappers over tested core functions)

| binding | add |
| --- | --- |
| `crates/bittery-crypto-ffi` | `derive_master_key`, `derive_keys_from_master_key`, `encrypt_master_key`, `decrypt_master_key`, `generate_recovery_key`, `validate_recovery_key`, `generate_uuid` (7) |
| `apps/desktop/src-tauri` crypto commands | the same six recovery functions + `passkey_generate_keypair`, `passkey_generate_credential_id`, `passkey_build_attestation_object`, `passkey_sign_assertion` (10) |

Plus the Swift/Kotlin/TS glue in `packages/crypto/expo-module` for the FFI seven, and command
registration in the Tauri `lib.rs`. Mobile and desktop need a native rebuild.

This is what makes account recovery implementable on desktop and mobile at all — today the
binding simply isn't there.

### 2 · `@bittery/crypto-port` at `packages/crypto/port`

Mirrors `packages/storage`'s layout:

- `src/crypto-port.ts` — `KeyRef`, `CryptoPort` (~35 members: key lifecycle, derivation,
  symmetric encrypt/decrypt, `wrapKey`/`unwrapKey`, RSA, `encryptVaultKeyForMember` /
  `encryptVaultKeyWithMuk` / `reEncryptItem`, rotation, Secret Key, recovery, SRP, passkey,
  `generateUuid`, and `decryptMany` for batch item decryption).
- `src/adapters/wasm-worker.ts` + `src/wasm.worker.ts` — **web's only adapter**. Because the
  port is total there is nothing to enumerate, so the worker becomes one generic
  `(method, args)` forward, replacing the 490-line hand-written dispatch. `KeyRef` never
  crosses the thread boundary on web — the property key handles exist for is enforced by the
  worker, not by discipline. `decryptMany` keeps item-list decryption to one round trip.
- `src/adapters/wasm.ts` — the extension (main thread, same `@bittery/crypto-wasm` binding).
- `src/adapters/tauri.ts`, `src/adapters/expo.ts`.
- `src/adapters/port-conformance.ts` + one `*-test-doubles.ts` and one `*.test.ts` per adapter.
- `src/testing/in-memory-crypto.ts` — the fake, fifth subject of the suite.

Backends are optional peer deps, as `packages/storage/package.json` already does for
`@tauri-apps/api` and `expo-secure-store`.

Write `port-conformance.ts` and the in-memory fake **first**; port the adapters against it.

### 3 · `packages/storage` speaks `KeyRef`

- Delete `src/crypto-provider.ts`; import `CryptoPort` instead.
- `account-store.ts`: MUK cache becomes `KeyRef` (the `number | Uint8Array` union at line 426
  goes); delete `getMasterUnlockKeyHandle`, `setMasterUnlockKeyHandle`,
  `storeSessionDataWithMasterUnlockKeyHandle`, `decryptStoredMasterUnlockKeyHandle`;
  `destroyHandle` becomes an unconditional `port.destroyKey`.
- Update `CONTEXT.md` §1 ("The plaintext master unlock key is never persisted" — on web it
  now never exists in JS at all) and §2 (a second pair of seams to name).

### 4 · `VaultCrypto` in `@bittery/core/services/vault-crypto.ts`

Sibling of `auth-service.ts`, which already takes an injected auth client — the ceremonies
interleave crypto with RPC, so they belong here and not in the Rust core.

Absorbs, from the seven web files that inline them today:
`change-password-dialog`, `change-email-dialog`, `regenerate-secret-key-dialog`,
`setup-recovery-key-dialog`, `regenerate-recovery-key-dialog`, `routes/_auth/recover.tsx`,
`use-signup-form.ts`.

Absorbs, from packages that shouldn't own them: `@bittery/shared/vault-key-crypto` (263 lines
— envelope shape, wrap context, `decryptVaultKey`), `@bittery/shared/crypto-context-envelope`,
and consolidates with the existing `services/encryption-context.ts` and
`services/attachment-crypto.ts`. `@bittery/shared/kdf-policy` **stays** in shared (storage
depends on it) and `VaultCrypto` calls it.

Delete `HandleCapableCrypto` and `asHandleCapableCrypto` from `auth-service.ts`.

### 5 · Apps and types

Delete: `apps/web/src/lib/{wasm-crypto,worker-crypto,crypto.worker}.ts`,
`apps/extension/src/lib/{wasm-crypto,crypto-adapter}.ts`,
`apps/mobile/src/lib/crypto/native-crypto.ts`, `apps/desktop/src/lib/tauri-crypto.ts`
(~3,400 lines).

Each app's `platform-provider.tsx` keeps one `createXCryptoPort()` call. `PlatformProvider`
takes `CryptoPort` + `VaultCrypto`; `usePlatformCrypto()` returns `CryptoPort`. Delete
`ICrypto` and the deprecated `IItemDecrypt` from `packages/types`, and `usePlatformItemDecrypt`
from `platform-context.tsx`.

The 33 files importing the concrete modules move to `usePlatformCrypto()` or `core.vaultCrypto`.
Any user-facing string lifted out of a dialog becomes an `m.*` key in **every**
`packages/i18n/messages/*.json`, then `pnpm i18n:generate`.

### 6 · Docs

- `packages/crypto/port/CONTEXT.md` — the design context, shaped like storage's: what a `KeyRef`
  is and who owns its lifetime, what the port refuses to carry and why, the two conformance
  rules, and the honest statement of what the suite does *not* prove. Cite it from the
  "Language" preamble of the root `CONTEXT.md`, as storage's already is.
- `docs/adr/0009-key-material-crosses-seams-as-an-opaque-keyref.md` — hard to reverse, surprising
  without context, and a real trade-off. Records why `KeyRef` rather than `Uint8Array`, why
  `CryptoPort` sits below `storage` and `VaultCrypto` above it, and why the conformance suite
  tests marshalling rather than ciphertext.
- Root `CONTEXT.md`: sharpen **Master unlock key** — the plaintext form does not exist in JS on
  web. No new glossary entries; `KeyRef` and `CryptoPort` are implementation, not domain.

## Verification

```
cargo test --manifest-path packages/crypto/core/Cargo.toml   # the 17 new bindings
pnpm --filter @bittery/crypto-port test                      # conformance × 4 adapters + fake
pnpm check-types
pnpm test
pnpm biome check --write <changed files>
pnpm i18n:check
```

`pnpm test` is the gate for the 124 migrated MUK call sites — `packages/storage/src/account-store.test.ts`,
`packages/core/src/services/{unlock,auth-service,item-service,share-service,vault-repository-*}.test.ts`,
`packages/core/src/testing/account-store-harness.ts` and the five extension background tests all
exercise them.

End-to-end, per platform, because none of the four backends are covered by the suite:

1. **Web** — signup (Secret Key + Emergency Kit shown), sign out, full sign-in, lock/quick
   unlock, open an item, add a vault member, rotate a key on member removal, set up and then
   use a Recovery Key. Confirms the worker adapter and `decryptMany` on a real item list.
2. **Extension** — service-worker restart then `tryRestoreSession`, autofill, and a passkey
   create + get (the four passkey ops are extension-only today).
3. **Desktop** — quick unlock via OS keychain, then **account recovery**, which is new.
4. **Mobile** — biometric unlock, delta sync, then **account recovery**, also new.

Cross-check that a vault key wrapped on one platform unwraps on another (web ↔ desktop against
the same account) — the envelope moved above the port, so this is the one behaviour the
conformance suite deliberately does not cover.
