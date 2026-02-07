I've completed a comprehensive security audit of the auth, crypto core, tRPC API, and hooks packages. Here's a        
  consolidated report organized by severity.                                                                            
                                                                                                                        
  ---                                                                                                                   
  CRITICAL Findings (Fix Immediately)

  1. Hardcoded JWT Secret Fallback

  packages/auth/src/index.ts:27-29

  The JWT secret falls back to "bittery-secret-change-in-production" if the env var is not set. This enables complete
  authentication bypass -- any attacker can forge valid JWTs.

  Fix: Throw on startup if JWT_SECRET is not set. Enforce minimum entropy (32+ bytes).

  ---
  2. Non-Constant-Time SRP Proof Comparison (Timing Attack)

  packages/crypto/core/.../srp6a/bigint.rs:166-168

  pub fn equals(&self, other: &SrpInt) -> bool {
      self.value == other.value  // Standard == is timing-dependent
  }

  Used in both client (client.rs:216) and server (server.rs:129) proof verification. Enables byte-by-byte timing attacks
   to forge SRP session proofs.

  Fix: Use subtle::ConstantTimeEq from the subtle crate.

  ---
  3. Silent Zero Return on Hex Parse Failure in SRP

  packages/crypto/core/.../srp6a/bigint.rs:41-54

  SrpInt::from_hex() returns zero on parse failure via unwrap_or_else(BigUint::zero). Combined with unwrap_or_default()
  throughout the SRP module (client.rs:73,229, server.rs:147), invalid crypto parameters silently degrade to zero values
   instead of failing.

  Fix: Return Result<SrpInt, CryptoError> and propagate errors.

  ---
  4. Unauthenticated Logout Endpoints (DoS)

  packages/api/src/routers/auth.ts:576-599

  Both logout and logoutAll are publicProcedure. Any attacker can force-logout any user by guessing/enumerating
  sessionIds or userIds:

  logout: publicProcedure        // Anyone can call with any sessionId
  logoutAll: publicProcedure     // Anyone can call with any userId

  Fix: Make both protectedProcedure. Verify session/user ownership.

  ---
  5. Missing Ownership Check on revokeDevice

  packages/api/src/routers/auth.ts:744-761

  The endpoint prevents revoking the current session but doesn't verify the target session belongs to the authenticated
  user. An attacker can revoke any user's device session.

  Fix: Verify session.userId === ctx.session.userId before revocation.

  ---
  HIGH Findings

  6. No Memory Zeroization for Cryptographic Keys

  Entire crypto core

  Sensitive key material (master_key, vault keys, RSA private keys, SRP shared secrets) is never zeroized after use.
  Memory dumps or cold-boot attacks can recover keys.

  Fix: Use the zeroize crate. Derive Zeroize on all key structs.

  ---
  7. User Enumeration via checkEmail

  packages/api/src/routers/auth.ts:527-539

  Returns { exists: true/false, secretKeyHint } for any email -- allows building a list of all registered users and
  leaks secret key hints.

  Fix: Return constant response regardless of existence, or require authentication.

  ---
  8. No Rate Limiting on SRP Login

  packages/api/src/routers/auth.ts:338-522

  startLogin, finishLogin, and quickUnlock have no rate limiting. Unlimited brute-force attempts possible.

  Fix: Implement per-(email, IP) rate limiting with exponential backoff and account lockout.

  ---
  9. Inconsistent Entropy Sources in Rust Crypto

  encryption.rs:57, secret_key.rs:33, srp6a/bigint.rs:58

  RSA uses OsRng (secure), but encryption IVs, secret key generation, and SRP ephemeral values use thread_rng(), which
  has weaker seeding guarantees.

  Fix: Use OsRng consistently for all cryptographic randomness.

  ---
  10. Non-Standard Key Derivation Concatenation

  packages/crypto/core/.../key_derivation.rs:47-79

  Password and secret key are concatenated with | separator (format!("{}|{}", password, secret_key)). No length encoding
   means "a|b" + "c" and "a" + "b|c" can collide. Email as PBKDF2 salt is predictable.

  Fix: Use length-prefixed concatenation. Consider random salt stored alongside the verifier.

  ---
  11. SrpInt Subtraction Silently Returns Zero on Underflow

  packages/crypto/core/.../srp6a/bigint.rs:122-134

  If self < other, subtraction returns zero instead of performing modular arithmetic correctly. This can silently
  produce zero session keys.

  Fix: Implement proper modular subtraction.

  ---
  12. Decryption Errors Logged with Full Error Objects

  packages/hooks/src/hooks/internal/use-items-unified.ts:259-261 (and similar locations)

  console.error includes full error objects that may contain partial decrypted data or key references. Visible in
  DevTools and crash reporting.

  Fix: Log only safe metadata (item ID, error type). Never log error objects from crypto operations.

  ---
  13. Console Logging of Verification Codes

  packages/api/src/routers/share.ts:656

  console.log(`[SHARE] Verification code for ${email}: ${code}`);

  Fix: Remove immediately.

  ---
  MEDIUM Findings
  #: 14
  Finding: PBKDF2 iterations 100k vs OWASP-recommended 310k+ for SHA-256
  Location: key_derivation.rs
  ────────────────────────────────────────
  #: 15
  Finding: Share link race condition -- non-atomic access counting allows one-time links to be used multiple times
  Location: share.ts:803-913
  ────────────────────────────────────────
  #: 16
  Finding: Share rate limit race condition -- check-then-increment is not atomic
  Location: share.ts:934-987
  ────────────────────────────────────────
  #: 17
  Finding: RSA key parsing fallback accepts non-standard DER formats
  Location: rsa.rs:98-137
  ────────────────────────────────────────
  #: 18
  Finding: Email normalization inconsistency -- .toLowerCase() applied inconsistently across auth flows
  Location: Multiple files
  ────────────────────────────────────────
  #: 19
  Finding: MUK not cleared after use in vault operation hooks (JS variables not zeroed)
  Location: use-create-vault.ts:164
  ────────────────────────────────────────
  #: 20
  Finding: Vault keys cached in local Map without explicit clearing
  Location: use-items-unified.ts:192
  ────────────────────────────────────────
  #: 21
  Finding: SRP server proof verification optional in quick unlock (backwards compat) -- breaks mutual auth
  Location: srp-unlock.ts:88-96
  ────────────────────────────────────────
  #: 22
  Finding: Account emails in React Query keys -- visible in DevTools, potentially sent to analytics
  Location: use-items-unified.ts:127
  ────────────────────────────────────────
  #: 23
  Finding: Decrypted items cached 10 min in React Query including plaintext passwords
  Location: use-decrypted-item.ts:155
  ────────────────────────────────────────
  #: 24
  Finding: No input length validation on SRP parameters, file names, content types
  Location: auth.ts, vault.ts
  ────────────────────────────────────────
  #: 25
  Finding: No audit logging for password changes, key rotation, account deletion, vault member changes
  Location: All routers
  ────────────────────────────────────────
  #: 26
  Finding: Share link IDOR -- admin can revoke owner's links; members can view all links
  Location: share.ts:257-456
  ────────────────────────────────────────
  #: 27
  Finding: Account switch race condition -- mutations in-flight can target wrong account
  Location: use-account-switcher.ts:119
  ────────────────────────────────────────
  #: 28
  Finding: Verification code brute force -- 6-digit code with only 5 attempts per code, but unlimited codes per email
  Location: share.ts:727-785
  ────────────────────────────────────────
  #: 29
  Finding: Key rotation not transactional -- partial failure leaves vault inconsistent
  Location: vault.ts:1367-1473
  ────────────────────────────────────────
  #: 30
  Finding: Session tokens stored in plaintext in database
  Location: auth/src/index.ts:153-168
  ---
  LOW / Informational
  ┌─────┬─────────────────────────────────────────────────────────────────┬─────────────────────────────┐
  │  #  │                             Finding                             │          Location           │
  ├─────┼─────────────────────────────────────────────────────────────────┼─────────────────────────────┤
  │ 31  │ IP header spoofing (X-Forwarded-For)                            │ context.ts:26-30            │
  ├─────┼─────────────────────────────────────────────────────────────────┼─────────────────────────────┤
  │ 32  │ Logout ignores server errors -- session stays valid server-side │ use-logout.ts:109           │
  ├─────┼─────────────────────────────────────────────────────────────────┼─────────────────────────────┤
  │ 33  │ Decryption failures hidden behind placeholder items             │ use-vault-items.ts:156      │
  ├─────┼─────────────────────────────────────────────────────────────────┼─────────────────────────────┤
  │ 34  │ No encrypted data versioning for future algorithm migration     │ Auth package                │
  ├─────┼─────────────────────────────────────────────────────────────────┼─────────────────────────────┤
  │ 35  │ Debug console.log(result) in auth router                        │ auth.ts:475                 │
  ├─────┼─────────────────────────────────────────────────────────────────┼─────────────────────────────┤
  │ 36  │ Weak nanoid(32) for non-SRP session keys                        │ auth/src/index.ts:289       │
  ├─────┼─────────────────────────────────────────────────────────────────┼─────────────────────────────┤
  │ 37  │ No backup codes or recovery mechanism                           │ Architecture-wide           │
  ├─────┼─────────────────────────────────────────────────────────────────┼─────────────────────────────┤
  │ 38  │ Emails leaked in unlock error messages                          │ use-quick-unlock-all.ts:168 │
  └─────┴─────────────────────────────────────────────────────────────────┴─────────────────────────────┘
  ---
  Positive Findings

  The architecture has strong foundations:
  - Dual-key model (password + secret key) is well-designed
  - SRP-6a prevents server from ever seeing passwords
  - Client-side encryption with AES-256-GCM before any network call
  - RSA-4096 for vault sharing is appropriate
  - HKDF domain separation with distinct info strings
  - MUK never persisted unencrypted across all platforms
  - Proper account isolation in multi-account mode
  - RustCrypto dependencies are well-maintained and audited

  ---
  Recommended Priority Actions

  This week (Critical):
  1. Remove JWT secret fallback -- crash if not set
  2. Implement constant-time SRP proof comparison (subtle crate)
  3. Make logout/logoutAll protected with ownership checks
  4. Fix revokeDevice authorization
  5. Remove console.log of verification codes

  Next sprint (High):
  6. Add zeroize to all Rust key material
  7. Switch all crypto RNG to OsRng
  8. Fix SrpInt::from_hex() to return Result (not silent zero)
  9. Add rate limiting to login endpoints
  10. Remove/restrict checkEmail endpoint
  11. Fix SrpInt subtraction underflow

  Month 1 (Medium):
  12. Atomic share link access counting
  13. Increase PBKDF2 to 310k iterations
  14. Add audit logging for sensitive operations
  15. Add input length validation across all endpoints
  16. Make SRP server proof verification mandatory