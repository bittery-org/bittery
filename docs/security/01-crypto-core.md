# Plan 01: Crypto Core

**Scope:** `packages/crypto/core/crates/bittery-crypto-core/src/`
**Findings:** 8 (2 Critical, 3 High, 2 Medium, 1 Low)
**Status:** ✅ Completed on 2026-02-07

## Completion Notes

- All findings in this plan were implemented.
- Breaking changes **#10** and **#14** were applied directly (no migration layer), because there are no production users yet.
- Clear local DB and any persisted client crypto state before testing with this version.

All changes in this plan require rebuilding WASM + NAPI + Expo bindings after implementation:
```bash
pnpm run build:crypto-wasm
pnpm run build:crypto-napi
```

---

## #2 — CRITICAL: Non-Constant-Time SRP Proof Comparison

**File:** `srp6a/bigint.rs:166-168`

**Problem:** The `equals()` method uses standard `==` comparison on `BigUint` values. This is timing-dependent — the comparison short-circuits on the first differing byte. An attacker can measure response times to forge SRP session proofs byte-by-byte.

```rust
// CURRENT (timing-dependent)
pub fn equals(&self, other: &SrpInt) -> bool {
    self.value == other.value  // Standard == short-circuits
}
```

Used in:
- `client.rs:216` — Client verifies server proof
- `server.rs:129` — Server verifies client proof (critical path)

**Fix:** Use `subtle::ConstantTimeEq` for constant-time comparison.

```rust
// Add to Cargo.toml
// subtle = "2"

use subtle::ConstantTimeEq;

pub fn equals(&self, other: &SrpInt) -> bool {
    let self_bytes = self.value.to_bytes_be();
    let other_bytes = other.value.to_bytes_be();

    // Pad shorter to equal length
    let max_len = self_bytes.len().max(other_bytes.len());
    let mut a = vec![0u8; max_len];
    let mut b = vec![0u8; max_len];
    a[max_len - self_bytes.len()..].copy_from_slice(&self_bytes);
    b[max_len - other_bytes.len()..].copy_from_slice(&other_bytes);

    a.ct_eq(&b).into()
}
```

**Testing:** Verify SRP login still works end-to-end on all platforms. Write a unit test confirming `equals()` produces correct results for equal and unequal values.

---

## #3 — CRITICAL: Silent Zero on Hex Parse Failure

**File:** `srp6a/bigint.rs:41-54`

**Problem:** `SrpInt::from_hex()` returns zero on parse failure via `unwrap_or_else(BigUint::zero)`. Combined with `unwrap_or_default()` usage in `client.rs:73,229` and `server.rs:147`, invalid crypto parameters silently degrade to zero values. An attacker sending `clientPublicKey = "ZZZZ"` would get a zero value, potentially collapsing the SRP shared secret to a known value.

```rust
// CURRENT — silent fallback to zero
pub fn from_hex(hex: &str) -> Self {
    let cleaned: String = hex.chars().filter(|c| !c.is_whitespace()).collect();
    let value = BigUint::parse_bytes(cleaned.as_bytes(), 16)
        .unwrap_or_else(BigUint::zero);  // Silent zero!
    // ...
}
```

**Fix:** Return `Result` and propagate errors.

```rust
pub fn from_hex(hex: &str) -> Result<Self, CryptoError> {
    let cleaned: String = hex.chars().filter(|c| !c.is_whitespace()).collect();
    let value = BigUint::parse_bytes(cleaned.as_bytes(), 16)
        .ok_or_else(|| CryptoError::InvalidInput("Invalid hex string".into()))?;
    Ok(Self {
        value,
        hex_length: cleaned.len(),
    })
}
```

Update all callers in `client.rs`, `server.rs`, and WASM/NAPI bindings to handle the `Result`. Remove all `unwrap_or_default()` usage for SRP values.

**Testing:** Unit test that `from_hex("ZZZZ")` returns an error. Integration test that invalid SRP parameters return errors rather than proceeding with zero values.

---

## #6 — HIGH: No Memory Zeroization for Cryptographic Keys

**File:** Entire crypto core

**Problem:** Sensitive key material (`master_key`, vault keys, RSA private keys, SRP shared secrets) is never zeroized after use. Memory dumps or cold-boot attacks can recover keys from process memory.

Key locations:
- `key_derivation.rs:61` — `master_key` array on stack
- `encryption.rs:117` — generated encryption keys
- `rsa.rs:44-46` — private key PEM string
- `srp6a/` — shared secrets, session keys

**Fix:** Add the `zeroize` crate and derive `Zeroize`/`ZeroizeOnDrop` on all key structs.

```rust
// Add to Cargo.toml
// zeroize = { version = "1", features = ["derive"] }

use zeroize::{Zeroize, ZeroizeOnDrop};

#[derive(Debug, Clone, Zeroize, ZeroizeOnDrop)]
pub struct DerivedKeys {
    pub auth_key: [u8; KEY_LENGTH],
    pub master_unlock_key: [u8; KEY_LENGTH],
}
```

For stack-allocated arrays like `master_key` in `derive_keys()`:
```rust
let mut master_key = [0u8; KEY_LENGTH];
pbkdf2_hmac::<Sha256>(combined_bytes, salt_bytes, PBKDF2_ITERATIONS, &mut master_key);
// ... use master_key ...
// Zeroize at end of function
master_key.zeroize();
```

Apply to: `DerivedKeys`, `RsaKeyPair`, SRP session structs, intermediate key arrays.

**Testing:** Verify all existing tests pass. Memory zeroization is difficult to unit test but the `zeroize` crate is well-audited.

---

## #9 — HIGH: thread_rng() Instead of OsRng

**Files:**
- `encryption.rs:57` — `rand::thread_rng().fill_bytes(&mut iv)` for AES-256-GCM IVs
- `encryption.rs:117` — `rand::thread_rng().fill_bytes(&mut key)` for key generation
- `secret_key.rs:33` — `rand::thread_rng()` for secret key generation
- `srp6a/bigint.rs:58` — SRP ephemeral value generation

**Problem:** RSA key generation correctly uses `OsRng`, but IVs, encryption keys, secret keys, and SRP ephemeral values use `thread_rng()`. While `thread_rng()` is seeded from the OS, it uses a userspace CSPRNG (ChaCha) which has weaker guarantees in some environments (forked processes, VMs with poor entropy).

**Fix:** Replace all `thread_rng()` with `OsRng` for consistency and defense-in-depth.

```rust
use rand::rngs::OsRng;

// encryption.rs
OsRng.fill_bytes(&mut iv);
OsRng.fill_bytes(&mut key);

// secret_key.rs
let mut rng = OsRng;
rng.fill_bytes(&mut bytes);

// bigint.rs
let mut rng = OsRng;
```

**Testing:** All existing tests pass. Verify generated values are still correctly random (non-repeating).

---

## #10 — HIGH: Non-Standard Key Derivation Concatenation

**File:** `key_derivation.rs:47-79`

**Problem:** Password and secret key are concatenated with a `|` separator: `format!("{}|{}", account_password, secret_key)`. Without length encoding, inputs like `("a|b", "c")` and `("a", "b|c")` produce the same derived key (`"a|b|c"`). Additionally, the email used as PBKDF2 salt is predictable and publicly known.

```rust
// CURRENT — ambiguous concatenation
let combined = format!("{}|{}", account_password, secret_key);
```

**Fix:** Use length-prefixed concatenation to prevent collisions.

```rust
// Length-prefixed concatenation
let password_bytes = account_password.as_bytes();
let secret_bytes = secret_key.as_bytes();
let mut combined = Vec::with_capacity(8 + password_bytes.len() + secret_bytes.len());
combined.extend_from_slice(&(password_bytes.len() as u32).to_be_bytes());
combined.extend_from_slice(password_bytes);
combined.extend_from_slice(&(secret_bytes.len() as u32).to_be_bytes());
combined.extend_from_slice(secret_bytes);
```

**BREAKING CHANGE:** This changes derived keys for all users. Requires:
1. Implement #34 (data versioning) first
2. Support both old and new derivation during migration
3. Re-derive and re-encrypt vault keys on next successful login

**Testing:** New unit tests for collision resistance. Migration tests verifying old keys can still decrypt during transition.

---

## #11 — HIGH: SrpInt Subtraction Silently Returns Zero on Underflow

**File:** `srp6a/bigint.rs:122-134`

**Problem:** If `self < other`, subtraction returns zero instead of performing correct modular arithmetic. This can silently produce zero session keys in SRP calculations.

```rust
// CURRENT — returns zero on underflow
pub fn subtract(&self, other: &SrpInt) -> SrpInt {
    if self.value >= other.value {
        SrpInt::from_biguint(self.value.clone() - other.value.clone())
    } else {
        SrpInt::zero()  // WRONG: should be modular subtraction
    }
}
```

**Fix:** Implement proper modular subtraction using the SRP prime modulus.

```rust
pub fn subtract_mod(&self, other: &SrpInt, modulus: &SrpInt) -> SrpInt {
    if self.value >= other.value {
        SrpInt::from_biguint((self.value.clone() - other.value.clone()) % &modulus.value)
    } else {
        // (self + modulus - other) % modulus
        let result = (self.value.clone() + modulus.value.clone() - other.value.clone()) % &modulus.value;
        SrpInt::from_biguint(result)
    }
}
```

Update all callers to pass the SRP prime `N` as modulus. Review `client.rs` and `server.rs` for all subtraction operations.

**Testing:** Unit test: `SrpInt(3).subtract_mod(SrpInt(5), SrpInt(7))` should equal `SrpInt(5)` (since 3-5 mod 7 = 5). Integration test: SRP login succeeds with edge-case parameters.

---

## #14 — MEDIUM: PBKDF2 100k vs 310k Recommended

**File:** `key_derivation.rs:13`

**Problem:** PBKDF2 iteration count is 100,000. OWASP recommends 310,000+ iterations for PBKDF2-HMAC-SHA256 as of 2024.

```rust
const PBKDF2_ITERATIONS: u32 = 100_000;
```

**Fix:** Increase to at least 310,000.

```rust
const PBKDF2_ITERATIONS: u32 = 310_000;
```

**BREAKING CHANGE:** This changes all derived keys. Same migration strategy as #10:
1. Implement #34 (data versioning) first
2. Store iteration count with user record
3. Re-derive on next login, updating the stored verifier

**Testing:** Benchmark the new iteration count on target hardware. Ensure login time stays under 2-3 seconds on mobile devices. Consider Argon2id as a future alternative.

---

## #17 — MEDIUM: RSA Fallback Parsing Accepts Non-Standard Formats

**File:** `rsa.rs:98-137`

**Problem:** `parse_public_key_pem()` and `parse_private_key_pem()` strip PEM headers and attempt DER parsing as a fallback. This accepts malformed or non-standard key formats that could contain unexpected parameters.

```rust
// CURRENT — fallback strips headers and tries DER
fn parse_public_key_pem(pem: &str) -> Result<RsaPublicKey, CryptoError> {
    if let Ok(key) = RsaPublicKey::from_public_key_pem(pem) {
        return Ok(key);
    }
    // Fallback: strip headers and try DER
    let stripped = pem
        .replace("-----BEGIN PUBLIC KEY-----", "")
        .replace("-----END PUBLIC KEY-----", "")
        .replace(['\n', '\r', ' '], "");
    let der = BASE64.decode(&stripped)?;
    RsaPublicKey::from_public_key_der(&der)?
}
```

**Fix:** Remove the fallback path. Only accept standard SPKI PEM for public keys and PKCS8 PEM for private keys.

```rust
fn parse_public_key_pem(pem: &str) -> Result<RsaPublicKey, CryptoError> {
    RsaPublicKey::from_public_key_pem(pem)
        .map_err(|e| CryptoError::InvalidPem(format!("Invalid public key PEM: {}", e)))
}

fn parse_private_key_pem(pem: &str) -> Result<RsaPrivateKey, CryptoError> {
    RsaPrivateKey::from_pkcs8_pem(pem)
        .map_err(|e| CryptoError::InvalidPem(format!("Invalid private key PEM: {}", e)))
}
```

**Testing:** Verify all existing key pairs generated by Bittery still parse correctly. Ensure no production data uses the fallback format (check stored keys).

---

## Implementation Order

1. **#2** (constant-time comparison) — standalone, no dependencies
2. **#3** (from_hex returns Result) — requires updating callers
3. **#9** (OsRng) — standalone replacement
4. **#11** (modular subtraction) — after #3 since both touch bigint.rs
5. **#6** (zeroize) — after above since it touches all files
6. **#17** (strict RSA parsing) — standalone, low risk
7. **#34** (data versioning, see 05-infrastructure) — prerequisite for #10 and #14
8. **#10** (length-prefixed concatenation) — breaking change, after #34
9. **#14** (PBKDF2 310k) — breaking change, after #34

### Implementation Status

- ✅ #2 complete
- ✅ #3 complete
- ✅ #6 complete
- ✅ #9 complete
- ✅ #10 complete
- ✅ #11 complete
- ✅ #14 complete
- ✅ #17 complete

## New Crate Dependencies

```toml
[dependencies]
subtle = "2"      # For #2 (constant-time comparison)
zeroize = { version = "1", features = ["derive"] }  # For #6
```
