# Bittery Security Audit — Phase 1: Cryptographic Implementation Review

Date: 2026-03-05
Scope: Rust Crypto Core and all bridge/client code that directly handles cryptographic operations.

## 1. Summary
The Rust cryptographic primitives are generally solid (AES-256-GCM, RSA-OAEP-SHA256, SRP math checks, KDF policy checks). The highest-risk issues are in integration boundaries: sensitive key material is exported into JS/TS memory, key rotation returns plaintext new vault keys, and vault-key wrapping with MUK is not context-bound. These issues materially weaken the stated zero-knowledge/opaque-handle design.

Severity overview:
- High: 3
- Medium: 2
- Low: 1
- Informational: 1

---

## 2. Findings

### Finding 1 — Sensitive key material is exported into JS/TS memory instead of staying in Rust/WASM handles
- Severity: High
- Location:
  - `packages/crypto/core/crates/bittery-crypto-wasm/src/lib.rs:124-138`
  - `packages/crypto/core/crates/bittery-crypto-wasm/src/lib.rs:141-150`
  - `packages/crypto/core/crates/bittery-crypto-wasm/src/lib.rs:349-364`
  - `apps/web/src/lib/wasm-crypto.ts:167-172`
  - `apps/web/src/lib/wasm-crypto.ts:185-191`
  - `apps/web/src/lib/crypto.worker.ts:114-120`
  - `apps/web/src/lib/crypto.worker.ts:243`
  - `packages/storage/src/adapters/web.ts:47`
  - `packages/storage/src/adapters/web.ts:147-167`
  - `packages/core/src/services/auth-service.ts:219-225`
- Description: Derivation outputs and other sensitive material (auth key, MUK, master key, SRP session key/proof) are returned as base64/strings to JS and then converted to `Uint8Array`, posted through workers, cached in JS memory, and used in TS services. This directly contradicts the stated architecture requirement that MUK never leaves Rust/WASM heap and TS only receives opaque handles.
- Attack scenario:
  1. An attacker gets JS execution in the app context (XSS, malicious extension dependency, injected script, compromised desktop webview content).
  2. The attacker hooks worker messages / crypto wrappers and reads returned `authKey` and `masterUnlockKey` material.
  3. The attacker decrypts wrapped vault keys and decrypts vault contents offline.
- Recommended fix:
  - Replace key-returning APIs with opaque key handles owned by Rust.
  - Expose only operations that consume handle IDs (`decrypt_with_handle`, `encrypt_with_handle`, `wrap_vault_key_with_handle`, etc.).
  - Ensure handle lifecycle has explicit destroy and automatic zeroization.
  - Remove JS caching of raw MUK bytes.

```rust
// Example direction
#[wasm_bindgen]
pub fn derive_keys_handle(password: &str, secret: &str, email: &str) -> Result<u64, JsError> {
    SECRET_STORE.insert_derived_keys(password, secret, email)
}

#[wasm_bindgen]
pub fn decrypt_with_handle(data: JsEncryptedData, key_handle: u64) -> Result<String, JsError> {
    SECRET_STORE.with_key(key_handle, |key| decrypt(&to_core(data), key))
}
```

### Finding 2 — Key rotation returns the plaintext new vault key to the caller
- Severity: High
- Location:
  - `packages/crypto/core/crates/bittery-crypto-core/src/key_rotation.rs:57-65`
  - `packages/crypto/core/crates/bittery-crypto-core/src/key_rotation.rs:191-193`
  - `packages/crypto/core/crates/bittery-crypto-core/src/key_rotation.rs:236-242`
  - `packages/crypto/core/crates/bittery-crypto-wasm/src/lib.rs:739-742`
  - `packages/crypto/core/crates/bittery-crypto-wasm/src/lib.rs:847-849`
  - `packages/crypto/core/crates/bittery-crypto-ffi/src/lib.rs:842-847`
  - `packages/crypto/core/crates/bittery-crypto-ffi/src/lib.rs:1160-1168`
  - `apps/desktop/src-tauri/src/crypto_commands.rs:315-319`
  - `apps/desktop/src-tauri/src/crypto_commands.rs:427-429`
- Description: `perform_key_rotation` includes `new_vault_key_base64` in its return object, and this plaintext key is propagated through WASM/FFI/Tauri APIs into app-layer memory. During rotation, the most sensitive new key is unnecessarily exposed.
- Attack scenario:
  1. User performs member removal / key rotation.
  2. Malicious script/process hooks rotation result in JS/bridge layer.
  3. Attacker exfiltrates `new_vault_key_base64` and decrypts newly re-encrypted data.
- Recommended fix:
  - Do not return plaintext new vault key from rotation APIs.
  - Keep new key internal to Rust and return only member-encrypted vault keys + re-encrypted item blobs.
  - If caller must chain operations, use an opaque temporary handle instead of raw key bytes.

### Finding 3 — Vault-key wrapping with MUK is not context-bound (no vault/user/version AAD)
- Severity: High
- Location:
  - `packages/crypto/core/crates/bittery-crypto-core/src/key_rotation.rs:107-122`
  - `packages/core/src/services/vault-service.ts:159-168`
  - `packages/shared/src/vault-key-crypto.ts:60-66`
  - `packages/shared/src/vault-key-crypto.ts:81-89`
- Description: Vault keys wrapped with MUK are encrypted without AAD/context binding. Decryption of wrapped vault keys also does not validate vault/user/key-version context. This permits ciphertext replay/substitution between records where the same MUK can decrypt.
- Attack scenario:
  1. Malicious blob-store server swaps user’s wrapped vault key for vault A with a wrapped key from vault B.
  2. Client decrypts and accepts it as vault A’s key (no context mismatch is checked at unwrap stage).
  3. New writes for vault A may be encrypted with the swapped key.
  4. Anyone knowing the swapped key can decrypt those new vault-A ciphertexts.
- Recommended fix:
  - Add explicit wrap context and enforce it cryptographically via `encrypt_with_aad` / `decrypt_with_aad`.
  - Include at minimum: `vaultId`, `userId`, `keyVersion`, and a wrap purpose/type.
  - Persist context fields alongside wrapped ciphertext and reject any mismatch.

```rust
let ctx = AadContext {
    vault_id: vault_id.to_string(),
    entity_id: "vault-key-wrap".to_string(),
    entity_type: "vault_key".to_string(),
    version: key_version,
    user_id: user_id.to_string(),
};
let wrapped = encrypt_with_aad(&vault_key_base64, master_unlock_key, &ctx)?;
```

### Finding 4 — Multiple decrypt bridges hardcode algorithm metadata and bypass caller-provided algorithm
- Severity: Medium
- Location:
  - `packages/crypto/core/crates/bittery-crypto-ffi/src/lib.rs:219-223`
  - `packages/crypto/core/crates/bittery-crypto-ffi/src/jni.rs:270-274`
  - `apps/desktop/src-tauri/src/crypto_commands.rs:104-108`
- Description: Bridge layers reconstruct `EncryptedData` with a hardcoded algorithm string (`"AES-GCM-AAD-V1"`) instead of using a provided algorithm field. This masks metadata tampering and weakens downgrade/format validation semantics.
- Attack scenario:
  1. Attacker tampers encrypted blob metadata (e.g., unexpected/legacy algorithm marker).
  2. Bridge overwrites algorithm to expected value before core decrypt.
  3. Caller never sees algorithm mismatch and migration/downgrade checks are bypassed.
- Recommended fix:
  - Pass algorithm through bridge APIs and enforce strict algorithm checks in core without rewriting metadata.
  - Reject missing/unknown algorithm values at bridge boundary.

### Finding 5 — SRP constructors/parsers allow weak hash/group options (SHA-1, 1024/1536-bit groups)
- Severity: Medium
- Location:
  - `packages/crypto/core/crates/bittery-crypto-core/src/srp6a/params.rs:9-14`
  - `packages/crypto/core/crates/bittery-crypto-core/src/srp6a/params.rs:41-47`
  - `packages/crypto/core/crates/bittery-crypto-wasm/src/lib.rs:640-659`
  - `packages/crypto/core/crates/bittery-crypto-ffi/src/lib.rs:575-591`
  - `packages/crypto/core/crates/bittery-crypto-ffi/src/lib.rs:1255-1271`
  - `packages/crypto/expo-module/src/BitteryCrypto.types.ts:46-52`
- Description: Runtime defaults are strong (SHA-256 + 4096), but public APIs still accept weaker SRP configurations. This leaves downgrade surface in compromised/misconfigured clients or future code paths.
- Attack scenario:
  1. A downgraded/modified client initializes SRP with SHA-1 and 1024-bit group.
  2. Authentication proceeds with weaker parameters.
  3. Offline attack cost for intercepted material is reduced versus intended policy.
- Recommended fix:
  - Restrict all public constructors/parsers to approved minimums (prefer fixed SHA-256 + 4096 for this product).
  - Remove weak options from TS types and FFI/WASM parser branches.

### Finding 6 — Quick unlock allows SRP flow without mandatory server proof verification
- Severity: Low
- Location:
  - `packages/api/src/routers/auth.ts:720-742`
  - `packages/core/src/services/auth-service.ts:382-389`
- Description: `quickUnlock` response omits `serverProof`, and client-side code only verifies server proof when present. This weakens SRP’s mutual-authentication property on that path.
- Attack scenario:
  1. A malicious intermediary/client shim for quick unlock returns a response without `serverProof`.
  2. Client accepts session material without running SRP M2 verification.
  3. Client trust in server-authenticated handshake is reduced.
- Recommended fix:
  - Return `serverProof` in quick unlock responses and make verification mandatory (`fail closed` if missing).

### Finding 7 — Informational: Context binding in platform wrappers uses plaintext envelope instead of native AAD API
- Severity: Informational
- Location:
  - `apps/web/src/lib/wasm-crypto.ts:226-231`
  - `apps/web/src/lib/wasm-crypto.ts:258-259`
  - `apps/extension/src/lib/wasm-crypto.ts:250-255`
  - `apps/extension/src/lib/wasm-crypto.ts:282-283`
  - `packages/shared/src/crypto-context-envelope.ts:41-50`
  - `packages/shared/src/crypto-context-envelope.ts:56-84`
- Description: Rust has native AAD APIs (`encryptWithContext`/`decryptWithContext`), but platform wrappers generally call non-AAD encrypt/decrypt and implement context checks in a JSON envelope at app layer. This is a design deviation from the stated AES-GCM-AAD-v1 path.
- Attack scenario:
  1. A future caller forgets to pass context on decrypt.
  2. Envelope verification is skipped for that code path.
  3. Context-binding guarantees depend on caller discipline rather than cryptographic API contract.
- Recommended fix:
  - Make context-bearing operations use native AAD APIs by default, and reserve envelope mode only for legacy migration reads.

---

## 3. Positive Findings
- AES-GCM nonce generation uses CSPRNG (`OsRng`) with 96-bit IV per encryption operation: `packages/crypto/core/crates/bittery-crypto-core/src/encryption.rs:124-129`.
- Decrypt verifies algorithm and GCM tag before plaintext processing; plaintext conversion happens only after successful authenticated decrypt: `packages/crypto/core/crates/bittery-crypto-core/src/encryption.rs:191-196`, `216-233`.
- Core AAD context format includes required fields and deterministic serialization with NUL-byte validation: `packages/crypto/core/crates/bittery-crypto-core/src/encryption.rs:30-61`, `65-73`.
- Core tests confirm AAD mismatch causes decryption failure: `packages/crypto/core/crates/bittery-crypto-core/src/encryption.rs:341-357`.
- KDF policy baseline and pinning checks are implemented in Rust and TS (schema/algorithm/min iterations/salt format + pin consistency): `packages/crypto/core/crates/bittery-crypto-core/src/kdf_policy.rs:33-65`, `70-103`; `packages/shared/src/kdf-policy.ts:21-56`.
- Client auth service validates/pins KDF params before finishing login: `packages/core/src/services/auth-service.ts:172-183`, `186-201`, `232`, `362`.
- Secret key generation uses `OsRng`; output alphabet size is 32 symbols (`mod 32` introduces no modulo bias): `packages/crypto/core/crates/bittery-crypto-core/src/secret_key.rs:5`, `8`, `33-40`.
- SRP uses constant-time proof equality and checks invalid public ephemerals (`A % N == 0`, `B % N == 0`): `packages/crypto/core/crates/bittery-crypto-core/src/srp6a/bigint.rs:188-205`; `client.rs:157-160`; `server.rs:100-103`, `127-130`.
- RSA implementation uses 4096-bit keys and OAEP-SHA256: `packages/crypto/core/crates/bittery-crypto-core/src/rsa.rs:17`, `67-71`, `89-93`.

---

## 4. Open Questions
1. Is the “MUK never leaves Rust/WASM heap; TS gets opaque handles only” requirement mandatory for all platforms (web/desktop/mobile), or only a target state?
2. Should wrapped vault keys be formally versioned and context-bound (`vaultId`, `userId`, `keyVersion`) as a protocol requirement?
3. Is envelope-based context binding intended as temporary compatibility mode, and is there a migration plan to native AAD-only item encryption?
4. Is quick unlock expected to provide full SRP mutual authentication (`serverProof`) going forward, or is one-way verification intentionally accepted?
5. For password/secret-key change flows, is there a server-side guarantee that all vault keys are re-encrypted (not a client-provided subset)?
