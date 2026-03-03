# Security

Bittery is a zero-knowledge password manager. The server never has access to your passwords, encryption keys, or any plaintext vault data. All encryption and decryption happens on your device.

This document describes the security architecture, cryptographic design, and vulnerability reporting process.

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

- **Email**: security@bittery.com
- **Do not** open a public GitHub issue for security vulnerabilities
- Include steps to reproduce, affected versions, and potential impact
- You will receive an acknowledgment within 48 hours
- We aim to provide a fix or mitigation within 7 days for critical issues

We appreciate responsible disclosure and will credit reporters (with permission) in release notes.

## Security Model Overview

Bittery uses a **dual-key architecture**: your account password and a randomly generated **Secret Key** are both required to derive encryption keys. This means that even if the server database is fully compromised, an attacker cannot decrypt your data without both factors — neither of which the server ever sees.

### What the Server Stores

| Data | Format | Can the server read it? |
|------|--------|------------------------|
| Email address | Plaintext | Yes |
| Secret Key hint | First segment only (`A3-XXXXXX`) | Partial (for UX) |
| SRP salt and verifier | Hex strings | Cannot recover password |
| RSA public key | PEM plaintext | Yes (needed for sharing) |
| RSA private key | AES-GCM-AAD-V1 encrypted | No |
| Vault encryption keys | AES-GCM-AAD-V1 or RSA-OAEP encrypted | No |
| Vault item data | AES-GCM-AAD-V1 encrypted | No |
| Shared item snapshots | AES-GCM-AAD-V1 encrypted | No |
| Session tokens | SHA-256 hashed | No (only hash stored) |

### What Never Leaves Your Device (Unencrypted)

- Account password
- Full Secret Key
- Master Unlock Key
- Vault encryption keys (decrypted)
- RSA private key (decrypted)
- Plaintext passwords, notes, or any item data

## Cryptographic Architecture

### Key Derivation

Your master password and Secret Key are combined into a single input using length-prefixed concatenation (preventing collision attacks), then processed through two stages:

1. **PBKDF2-SHA256** with 310,000 iterations and your lowercase email as the salt, producing a 256-bit master key
2. **HKDF-SHA256** splits this master key into two purpose-specific keys:
   - **Auth Key** (info: `"bittery-auth-key"`) — used for SRP-6a authentication
   - **Master Unlock Key** (info: `"bittery-unlock-key"`) — encrypts your vault keys and RSA private key

The iteration count follows [OWASP recommendations](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) for PBKDF2-SHA256. Intermediate keys are securely erased from memory using the Rust `zeroize` crate.

### Secret Key

Format: `A3-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX`

- **Version prefix**: `A3` (version 3)
- **Character set**: Base32 (`A-Z`, `2-7`) — excludes confusable characters (`0`, `1`, `8`, `9`, `O`, `I`, `L`)
- **Entropy**: ~130 bits from a cryptographically secure random generator
- **Storage**: Generated on signup, shown once to the user. Only the first segment (`A3-XXXXXX`) is stored server-side as a hint.

The Secret Key ensures that even a weak master password cannot be brute-forced from the server database alone — an attacker would need both factors.

### Symmetric Encryption

Bittery uses **AES-256-GCM** for symmetric encryption. Serialized payloads use the algorithm identifier **`AES-GCM-AAD-V1`**.

- **Key size**: 256 bits
- **IV/Nonce**: 96 bits, cryptographically random, generated fresh for every encryption operation
- **Authentication**: GCM provides authenticated encryption (AEAD) — tampering is detected automatically
- **Context binding**: Item and attachment payloads are bound to deterministic entity context (`vaultId`, `entityId`, `entityType`, `version`, `userId`) to prevent ciphertext swapping across entities
- **Output format**: JSON containing base64-encoded ciphertext, IV, and algorithm identifier

### Asymmetric Encryption

Each user has an **RSA-4096** key pair:

- **Padding**: OAEP with SHA-256 (randomized — same plaintext produces different ciphertexts)
- **Public key**: Stored on the server in SPKI PEM format (needed for vault sharing)
- **Private key**: Encrypted with the Master Unlock Key (`AES-GCM-AAD-V1` payload format backed by AES-256-GCM) before being stored on the server

RSA is used exclusively for encrypting vault keys when sharing vaults with other users. It is not used for bulk data encryption.

### All Crypto in Rust

All cryptographic operations are implemented in a single Rust codebase (`packages/crypto/core/`) and compiled to platform-specific bindings:

| Platform | Binding |
|----------|---------|
| Web | WebAssembly (WASM) |
| Server | NAPI (Node/Bun native addon) |
| Desktop | Tauri commands (direct Rust calls) |
| Mobile | Expo native module |

This eliminates the risk of JavaScript crypto implementation bugs and ensures consistent behavior across all platforms.

## Authentication

### SRP-6a Protocol

Bittery uses the **Secure Remote Password (SRP-6a)** protocol ([RFC 5054](https://www.rfc-editor.org/rfc/rfc5054)) for authentication. SRP is a zero-knowledge proof protocol — the server verifies you know your password without ever receiving it, not even as a hash.

**Parameters**:
- **Prime group**: 4,096-bit safe prime (RFC 5054 group)
- **Generator**: g = 5
- **Hash**: SHA-256

**How it works**:

1. During **signup**, the client computes an SRP verifier (`v = g^x mod N`) from the Auth Key and sends it to the server along with a random salt. The server stores only the salt and verifier.
2. During **login**, a Diffie-Hellman-like key exchange occurs:
   - Client and server exchange ephemeral public values
   - Both sides independently compute a shared session key
   - Client sends a proof that it knows the password (without revealing it)
   - Server verifies the proof and responds with its own proof
3. If successful, a **JWT session token** is created from the shared session key.

At no point does the server see the password, the Auth Key, or any value that could be used to derive them.

### Login KDF Policy and Pinning

During login challenge (`startLogin`), the server returns explicit KDF parameters (`schemaVersion`, `algorithm`, `iterations`, `salt`).

The client enforces:
- `algorithm` must be `pbkdf2-sha256`
- `iterations` must be at least `310,000`
- `salt` must be valid hex and at least 16 bytes
- after first successful login, the client pins values locally; future logins reject schema/algorithm/salt changes and iteration downgrades

This blocks KDF downgrade/tampering attempts if the login challenge path is manipulated.

### Session Management

- **JWT algorithm**: HS256 (HMAC-SHA256) with a server-side secret (minimum 32 bytes)
- **Session duration**: 30 days
- **Token binding**: JWT payload includes `sessionId` and a SHA-256 hash of the SRP session key, both verified against the database on every request
- **Device tracking**: Each session records platform, browser, OS, and device name for the user to review and revoke
- **Revocation**: Users can revoke individual sessions or all sessions from any device

### Login Rate Limiting

- **5 free attempts** per email + IP combination
- **Exponential backoff** after the 5th attempt: lockout duration doubles each attempt (capped at 30 minutes)
- Rate limit state is tracked via SHA-256 hash of email + IP address

## Encryption Layers

```
Account Password + Secret Key + Email
        │
        ▼
   PBKDF2-SHA256 (310k iterations)
        │
        ▼
   HKDF-SHA256 split
        │
   ┌────┴────┐
   ▼         ▼
Auth Key   Master Unlock Key
   │         │
   │    ┌────┴─────────────────┐
   │    ▼                      ▼
   │  Vault Keys          RSA Private Key
   │  (AES-GCM-AAD-V1)    (AES-GCM-AAD-V1)
   │    │
   │    ▼
   │  Item Data
   │  (AES-GCM-AAD-V1, random IV per item, context-bound)
   │
   ▼
SRP-6a Authentication
(zero-knowledge proof)
```

### Personal Vaults

1. A random 256-bit vault key is generated when a vault is created
2. The vault key is encrypted with your Master Unlock Key (`AES-GCM-AAD-V1`) and stored in the `vaultKey` table
3. Each item in the vault is encrypted with the vault key using AES-256-GCM with a fresh random IV and deterministic context binding

### Shared Vaults (Teams)

When you share a vault with another user:

1. The vault key is encrypted with the recipient's **RSA-4096 public key** (OAEP padding)
2. The encrypted vault key is stored in the `vaultKey` table for the recipient
3. The recipient decrypts the vault key using their RSA private key (which they decrypt using their own Master Unlock Key)

This means vault sharing never exposes the vault key to the server — only the recipient's public key is used, and only they hold the corresponding private key.

### Key Rotation

When a member is removed from a shared vault, key rotation occurs automatically:

1. A new random vault key is generated
2. The new key is encrypted for each remaining member (RSA-OAEP for shared members, `AES-GCM-AAD-V1` for the owner)
3. All items in the vault are re-encrypted with the new key (each with a fresh random IV)
4. The old vault key entries for the removed member are deleted

This ensures the removed member cannot decrypt any data added after their removal, even if they retained a copy of the old vault key.

## Secure Sharing (Share Links)

Items can be shared via encrypted links:

1. A random share key is generated client-side
2. The item data is decrypted with the vault key, then re-encrypted with the share key (`AES-GCM-AAD-V1`)
3. The encrypted snapshot and encrypted share key are sent to the server
4. The server generates a unique share token (32-character nanoid)

**Access controls**:
- **Email-restricted**: Only verified email addresses can access the link (6-digit verification code, max 5 attempts)
- **Expiration**: Configurable from 1 hour to 30 days
- **One-time use**: Optional single-access limit
- **Audit logging**: Every access attempt is logged with email, IP, user agent, and success/failure
- **Rate limiting**: Maximum 50 shares per user per day

## Data Storage

### Soft Deletes

Deleted items are not immediately removed — they are marked with a `deletedAt` timestamp, allowing recovery from the trash. This also preserves the audit trail.

### Audit Logging

Security-relevant actions are logged with:
- User ID, action type, and affected entity
- IP address and user agent
- Arbitrary metadata for context

Audit logs use a non-foreign-key user reference so they survive account deletion.

## Cryptographic Parameters Summary

| Parameter | Value |
|-----------|-------|
| Key derivation | PBKDF2-SHA256 + HKDF-SHA256 |
| PBKDF2 iterations | 310,000 |
| Master key size | 256 bits |
| Vault key size | 256 bits |
| Symmetric encryption | AES-256-GCM (`AES-GCM-AAD-V1`) |
| Ciphertext binding | Deterministic entity context for items and attachments |
| GCM IV length | 96 bits (random per operation) |
| Login KDF hardening | Baseline policy checks + local parameter pinning |
| Asymmetric encryption | RSA-4096 OAEP (SHA-256) |
| SRP group | 4,096-bit safe prime (RFC 5054) |
| SRP hash | SHA-256 |
| Secret Key entropy | ~130 bits |
| JWT algorithm | HS256 |
| Session duration | 30 days |

## Third-Party Audits

Bittery has not yet undergone a third-party security audit. If you are a security researcher interested in reviewing the codebase, please reach out at security@bittery.com.
