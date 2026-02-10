# Feature: Passkey Support

## Overview

Add full passkey (WebAuthn) support to Bittery, allowing users to store, create, and authenticate with passkeys. Passkeys are stored as part of existing login items (not separate items). All passkey data is encrypted within the vault blob like any other field.

## Requirements

### Browser Extension (Priority 1)

#### New: Page Script Injection

The current extension has no injected page scripts — all communication is content script to service worker. Passkey support requires a **new page-level script** that runs in the page's `MAIN` world to override `navigator.credentials.create()` and `navigator.credentials.get()`. This is the standard approach used by 1Password, Bitwarden, etc. — there is no official extension API for passkey providers.

**Manifest changes** (`apps/extension/manifest.config.js`):
- Add a second content script entry with `run_at: "document_start"` and `world: "MAIN"` to inject the WebAuthn override before any page script can call the native API
- Alternatively, use the existing `document_end` content script to dynamically inject a `<script>` element from `web_accessible_resources` — but `document_start` + `MAIN` world is more reliable

**Communication chain** (new pattern for this extension):
```
Page script (MAIN world, overrides navigator.credentials)
  ↕ window.postMessage / addEventListener("message")
Content script (ISOLATED world, bridges page ↔ background)
  ↕ chrome.runtime.sendMessage / onMessage
Service worker (handles passkey lookup, creation, signing)
```

The page script should use a unique message type prefix (e.g., `BITTERY_PASSKEY_`) to avoid collisions with other extensions or page scripts.

#### Registration (`navigator.credentials.create()`)

- Intercept the call and extract `publicKey` options (rpId, rpName, user info, challenge, excludeCredentials, etc.)
- Send to service worker to generate ECDSA P-256 keypair via WASM crypto
- Build authenticator data: rpIdHash (SHA-256 of rpId), flags (UP=1, UV=1, AT=1, BE=1, BS=1 = 0x5D), signCount=0, attestedCredentialData (AAGUID + credentialId + COSE public key)
- Build attestation object: CBOR-encoded `{ fmt: "none", attStmt: {}, authData }`
- Use a fixed AAGUID identifying Bittery as the authenticator (generate one UUID and hardcode it)
- Return a valid `PublicKeyCredential` response (with `AuthenticatorAttestationResponse`) back to the page
- Store the passkey data on the matching login item (or prompt user to select/create one)

#### Authentication (`navigator.credentials.get()`)

- Intercept the call and extract `publicKey` options (rpId, challenge, allowCredentials, userVerification)
- Send rpId + allowCredentials to service worker to find matching passkeys in the decrypted vault cache
- If no match found: **pass through to the browser's native handler** — do not show empty UI. This is especially important for conditional mediation (`mediation: "conditional"`) to not break native autofill
- If single match: proceed with signing. If multiple matches: show picker UI
- Sign `authenticatorData || clientDataHash` with the stored private key, output DER-encoded signature
- Increment `signCount` on the credential and persist the update
- Return valid `PublicKeyCredential` (with `AuthenticatorAssertionResponse`) to the page

#### Passkey Matching

- Match by `rpId` against the item's URL (extract the registrable domain)
- For non-discoverable credentials (allowCredentials list provided): also match by `credentialId`
- For discoverable credentials (no allowCredentials): match all passkeys for the rpId
- Use the existing `hostnameMatches()` utility from `apps/extension/src/background/vault-utils.ts` as a starting point, but passkey matching should use exact rpId domain comparison per the WebAuthn spec (not the fuzzy hostname matching used for autofill)

#### Backup State Flags

Set backup eligibility (BE) and backup state (BS) flags to 1 in authenticatorData. Bittery passkeys are synced across devices via vault sync, so they qualify as multi-device credentials.

---

### Crypto Core (Rust)

Extend the existing `bittery-crypto-core` crate — do not create a separate crate. Add a new `passkey.rs` module following the established pattern.

**New workspace dependencies** (add to `packages/crypto/core/Cargo.toml`):
- `p256` — ECDSA P-256 (NIST) keypair generation and signing
- `ecdsa` — ECDSA signature types and DER encoding
- `ciborium` — CBOR encoding/decoding (RFC 8949) for attestation objects and COSE keys

**Already available**: `sha2` (SHA-256 for rpIdHash and clientDataHash), `base64`, `getrandom`

**New module** (`packages/crypto/core/crates/bittery-crypto-core/src/passkey.rs`):

| Function | Purpose |
|----------|---------|
| `generate_passkey_keypair()` | Generate ECDSA P-256 keypair, return private key bytes + COSE-encoded public key |
| `encode_cose_public_key(x, y)` | COSE Key encoding (RFC 8152): kty=2 (EC2), alg=-7 (ES256), crv=1 (P-256), x, y |
| `build_authenticator_data(rp_id, flags, sign_count, attested_cred_data)` | Construct authenticatorData bytes per WebAuthn spec |
| `build_attestation_object(auth_data)` | CBOR-encode `{ fmt: "none", attStmt: {}, authData }` |
| `sign_assertion(private_key, auth_data, client_data_hash)` | Sign `authData \|\| clientDataHash` with P-256, return DER-encoded signature |
| `generate_credential_id()` | Generate random 32-byte credential ID |

**Binding additions:**
- WASM: Add `#[wasm_bindgen]` functions in `bittery-crypto-wasm/src/lib.rs` (camelCase JS names: `generatePasskeyKeypair`, `buildAttestationObject`, `signPasskeyAssertion`, etc.)
- FFI: Add `#[no_mangle] extern "C"` functions in `bittery-crypto-ffi/src/lib.rs` with `bittery_passkey_` prefix
- Tauri: Direct Rust calls from `bittery-crypto-core` in desktop commands

**Platform wrappers** (thin async wrappers over the WASM/FFI bindings):
- `apps/web/src/lib/wasm-crypto.ts` — add passkey functions
- `apps/extension/src/lib/wasm-crypto.ts` — add passkey functions
- `apps/desktop/src/lib/tauri-crypto.ts` — add passkey Tauri commands
- `apps/mobile/src/lib/crypto/native-crypto.ts` — add passkey FFI wrappers

---

### Vault Schema

**Type changes** (`packages/shared/src/types.ts`):

Add a `Passkey` interface and an optional `passkeys` array to `DecryptedItemData`:

```typescript
export interface Passkey {
  credentialId: string;       // Base64url-encoded
  rpId: string;
  rpName: string;
  userHandle: string;         // Base64url-encoded (from user.id in create options)
  userName: string;           // From user.name
  userDisplayName: string;    // From user.displayName
  privateKey: string;         // Base64-encoded P-256 private key (encrypted within vault blob)
  publicKey: string;          // Base64-encoded COSE public key (needed for attestation responses)
  algorithm: number;          // COSE algorithm identifier (-7 for ES256)
  signCount: number;          // Incremented on each assertion
  transports: string[];       // ["internal", "hybrid"] — transport hints for the RP
  createdAt: string;          // ISO 8601
  lastUsedAt?: string;        // ISO 8601, updated on each assertion
}
```

Add to `DecryptedItemData` (around line 78):
```typescript
passkeys?: Passkey[];
```

Also update `LoginDisplayData` (around line 113) to include `passkeys`.

**Key design decisions:**
- All passkey fields live within the encrypted `encryptedData` blob — no plaintext metadata in the database. The `privateKey` field does not need separate encryption since the entire item is already AES-256-GCM encrypted with the vault key.
- Matching happens client-side against the locally cached and decrypted vault, same as autofill matching today.
- When a passkey is created for a site that already has a login item (matched by URL/rpId), attach it to that existing item. Otherwise, create a new login item.
- A login item can have multiple passkeys (e.g., different user accounts on the same site).

**No database migration needed** — the passkey data is stored inside the encrypted JSON blob. Existing items without passkeys will simply have `passkeys: undefined`.

---

### Desktop (Tauri)

- Add Tauri commands wrapping the passkey crypto functions from `bittery-crypto-core`
- Desktop doesn't need WebAuthn interception (browsers handle their own passkeys) — the desktop app stores/syncs passkey data for the extension and mobile apps
- If the extension is in desktop-bridge mode, passkey crypto operations (keypair gen, signing) can be delegated to the desktop app via native messaging, similar to how vault decryption works today

---

### Android

Android already has a full credential provider implementation at `apps/mobile/modules/credential-provider/`. The existing infrastructure includes:

- `BitteryCredentialProviderService` registered in the manifest with `BIND_CREDENTIAL_PROVIDER_SERVICE` permission (Credential Manager API, API 34+)
- `BitteryAutofillService` for legacy autofill (API 26+)
- `GetCredentialsActivity` with biometric auth + MUK escrow for on-demand decryption
- Room database with `ItemEntity`, `VaultKeyEntity`, `ItemDomainEntity` for domain-based credential matching
- `VaultDecryptor` supporting both MUK-encrypted (personal) and RSA-encrypted (team) vault keys
- `VaultStateManager` singleton shared between React Native and the credential provider service
- `MukEscrowManager` for biometric-only unlock with configurable timeout

Currently only `TYPE_PASSWORD_CREDENTIAL` is declared in `res/xml/credential_provider.xml`. Extending for passkeys requires:

**Capability declaration** (`credential_provider.xml`):
- Add `android.credentials.TYPE_PUBLIC_KEY_CREDENTIAL` capability

**Service changes** (`BitteryCredentialProviderService.kt`):
- Handle `BeginCreatePublicKeyCredentialRequest` in `onBeginCreateCredentialRequest()` — extract the request JSON, return a `CreateEntry` pointing to `GetCredentialsActivity`
- Handle `BeginGetPublicKeyCredentialRequest` in `onBeginGetCredentialRequest()` — query `ItemEntity` for items with passkeys matching the rpId, return `PublicKeyCredentialEntry` items
- Parse the WebAuthn request JSON (challenge, rpId, allowCredentials, userVerification) and pass to the activity

**Activity changes** (`GetCredentialsActivity.kt`):
- Add a passkey creation flow: receive `CreatePublicKeyCredentialRequest`, call Rust crypto FFI via `NativeCrypto` to generate P-256 keypair, build attestation object, store passkey data on the matching `ItemEntity`, return `CreatePublicKeyCredentialResponse`
- Add a passkey assertion flow: receive `GetPublicKeyCredentialRequest`, decrypt the matching item's passkey data, call Rust crypto FFI to sign the assertion, increment signCount, return `GetPublicKeyCredentialResponse`
- Both flows reuse the existing biometric auth + MUK escrow pattern for vault decryption

**Storage changes:**
- `VaultDecryptor.decryptLoginItem()` already parses the full JSON — passkey data will be available as part of `DecryptedItemData.passkeys` once synced
- `ItemDomainEntity` already handles domain matching — passkey rpId matching can use the same domain extraction logic
- No new Room entities needed — passkey data lives inside the encrypted item blob

**Crypto bridge:**
- Add passkey FFI functions to `NativeCrypto.kt` (JNI calls to `bittery_passkey_*` functions from the Rust FFI crate)
- Reuses the same Rust crypto functions across extension (WASM) and mobile (FFI)

The existing credential provider architecture (shared MUK via `VaultStateManager`, biometric escrow, domain matching, on-demand decryption) makes this a natural extension rather than a greenfield implementation.

### iOS

- Deferred — no Apple Developer License available yet
- When available: implement via ASCredentialProviderExtension (requires the Xcode credential provider entitlement)

---

### Passkey Directory Integration (Phase 3)

- Pull data from passkeys.directory (community-maintained database of sites supporting passkeys)
- Show indicator on login items when a site supports passkeys but the user hasn't created one yet
- Dashboard view: "X of your accounts support passkeys, Y already have one"

---

## Implementation Order

1. **Crypto core**: `passkey.rs` module + WASM/FFI bindings (can be developed and tested independently)
2. **Types**: Add `Passkey` interface and update `DecryptedItemData`
3. **Extension page script**: WebAuthn API override + message bridge to content script
4. **Extension service worker**: Passkey message handlers (create, get, match, sign)
5. **Extension UI**: Passkey picker, save-to-item prompt
6. **Android**: Extend existing credential provider with `TYPE_PUBLIC_KEY_CREDENTIAL` (leverages existing infrastructure)
7. **Desktop**: Tauri commands for passkey crypto (if desktop-bridge mode is used)
8. **Web app**: Passkey display/management in item detail views
9. **Passkey directory**: Site support indicators (Phase 2)

## Non-Goals (for now)

- Passkey-based vault unlock (would require WebAuthn PRF extension, platform support still fragmented)
- Hardware security key / FIDO2 token support
- Attestation formats other than "none"
- Cross-origin passkey requests (only same-rpId matching)
