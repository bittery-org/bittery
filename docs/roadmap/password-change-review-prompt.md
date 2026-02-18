Review and verify the existing Master Password change implementation.

## Architecture Context

Bittery uses a deterministic key derivation model:

```
Password + Secret Key + Email
        │
        ▼
  PBKDF2-SHA256 (310k iterations, salt=email)
        │
        ▼
    32-byte master_key
        │
    HKDF-SHA256 split
    ┌───┴───┐
    ▼       ▼
 Auth Key  MUK (Master Unlock Key)
    │       │
    │       ├── AES-GCM-encrypts → Vault Keys (own vaults only)
    │       ├── AES-GCM-encrypts → RSA-4096 Private Key
    │       │                            │
    │       │                            └── RSA-OAEP-decrypts → Shared Vault Keys
    │       │
    │       └── Vault Keys → AES-GCM-encrypt → Items
    │
    └── Used as SRP password (verifier stored on server)
```

The MUK is NOT an independent blob — it is fully derived from password + secretKey + email. Changing the password changes the MUK, which means everything encrypted with the MUK must be re-encrypted.

## Expected Password Change Flow

1. User is logged in → old MUK is available in memory
2. User enters current password (verified via SRP auth or local derivation check)
3. User enters new password
4. Client derives old keys: `deriveKeys(currentPassword, secretKey, email)` → oldMUK (or uses cached MUK)
5. Client derives new keys: `deriveKeys(newPassword, secretKey, email)` → newAuthKey, newMUK
6. Client generates new SRP credentials: new `srpSalt` + `srpVerifier` from newAuthKey
7. Client decrypts RSA Private Key with oldMUK → re-encrypts with newMUK
8. Client decrypts all MUK-encrypted Vault Keys with oldMUK → re-encrypts with newMUK
9. Client sends to server: `{ srpSalt, srpVerifier, encryptedPrivateKey, encryptedVaultKeys[] }`
10. Server updates user record + vault key records in a single atomic DB transaction
11. All other active sessions are invalidated via `deleteAllUserSessions()`

### What must NOT change
- RSA Key Pair itself (same keys, just private key re-wrapped)
- RSA Public Key on server (unchanged)
- Shared Vault Keys (encrypted with RSA, not MUK — untouched)
- Item ciphertexts (encrypted with vault keys, which themselves don't change)
- Secret Key (unchanged)

## What to verify

1. **Derivation**: Is the old MUK derived (or taken from cache) and the new MUK derived from the new password correctly?
2. **Re-encryption scope**: Are ALL MUK-encrypted vault keys re-encrypted? Are RSA-encrypted (shared) vault keys correctly skipped?
3. **RSA Private Key**: Is it decrypted with old MUK and re-encrypted with new MUK?
4. **SRP credentials**: Are new `srpSalt` and `srpVerifier` generated from the new authKey?
5. **Atomicity**: Are `srpSalt`, `srpVerifier`, `encryptedPrivateKey`, and all `encryptedVaultKeys` updated in a single DB transaction? A partial write would break the account.
6. **Session invalidation**: Are all other sessions invalidated after successful password change?
7. **Error handling**: What happens if the request fails mid-update? Is there rollback? Can the account end up in a broken state?
8. **Secret Key source**: Where does the client get the Secret Key during password change? (Should be from localStorage or memory, user should not need to re-enter it)

Please explore the codebase, trace the complete password change flow from UI through crypto to API, and report whether the implementation matches the expected flow. Flag any deviations, missing steps, or potential issues.
