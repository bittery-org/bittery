# Security Fix Plans

Comprehensive security remediation plans based on the Bittery security audit. Organized by code area for focused implementation.

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 4 |
| HIGH | 7 |
| MEDIUM | 17 |
| LOW | 9 |
| **Total** | **37** |

> Finding #5 (revokeDevice ownership check) has been fixed and is excluded from these plans.

## Plans

| Plan | Scope | Findings | Critical/High |
|------|-------|----------|---------------|
| [01-crypto-core.md](./01-crypto-core.md) | Rust crypto library (`packages/crypto/core/`) | 8 | 2C + 3H |
| [02-auth-package-router.md](./02-auth-package-router.md) | Auth package + auth router (`packages/auth/`, `api/routers/auth.ts`) | 9 | 2C + 2H |
| [03-share-vault-routers.md](./03-share-vault-routers.md) | Share & vault routers (`api/routers/share.ts`, `vault.ts`) | 7 | 1H |
| [04-hooks-client-side.md](./04-hooks-client-side.md) | Shared hooks & client code (`packages/hooks/`, extension) | 10 | 1H |
| [05-infrastructure.md](./05-infrastructure.md) | Infrastructure & cross-cutting concerns | 3 | 0 |

## Cross-Plan Dependencies

```
#34 (data versioning, 05-infrastructure)
 └─ MUST be implemented before:
    ├─ #10 (key derivation concatenation change, 01-crypto-core)
    └─ #14 (PBKDF2 iteration increase, 01-crypto-core)

#21 (server proof verification, 04-hooks-client-side)
 └─ Requires server-side change in quickUnlock to always return serverProof
    (related to 02-auth-package-router)

#4 (unauthenticated logout, 02-auth-package-router)
 └─ Requires client-side changes in all apps to update logout mutation calls
    (related to 04-hooks-client-side)
```

## Suggested Global Implementation Priority

### Week 1 (Critical)
1. **#1** — Remove JWT secret fallback (02-auth)
2. **#2** — Constant-time SRP proof comparison (01-crypto)
3. **#3** — Fix SrpInt::from_hex silent zero (01-crypto)
4. **#4** — Make logout/logoutAll protected (02-auth)
5. **#13** — Remove console.log of verification codes (03-share)
6. **#35** — Remove console.log(result) in auth (02-auth)

### Week 2 (High)
7. **#6** — Add zeroize to Rust key material (01-crypto)
8. **#9** — Switch all crypto RNG to OsRng (01-crypto)
9. **#11** — Fix SrpInt subtraction underflow (01-crypto)
10. **#7** — Fix user enumeration via checkEmail (02-auth)
11. **#8** — Add rate limiting to login endpoints (02-auth)
12. **#12** — Sanitize decryption error logging (04-hooks)

### Sprint 2 (Medium — server-side)
13. **#15** — Atomic share link access counting (03-share)
14. **#16** — Atomic rate limit check-then-increment (03-share)
15. **#29** — Transactional key rotation (03-share-vault)
16. **#26** — Fix share IDOR (03-share)
17. **#28** — Limit verification codes per email (03-share)
18. **#24** — Input length validation on SRP params (02-auth)
19. **#30** — Hash session tokens in DB (02-auth)
20. **#18** — Email normalization consistency (02-auth)

### Sprint 3 (Medium — client-side)
21. **#21** — Mandatory SRP server proof verification (04-hooks)
22. **#19** — Clear MUK after vault operations (04-hooks)
23. **#20** — Clear vault key cache (04-hooks)
24. **#22** — Remove emails from React Query keys (04-hooks)
25. **#23** — Reduce decrypted item cache time (04-hooks)
26. **#27** — Fix account switch race condition (04-hooks)
27. **#25** — Add audit logging for sensitive ops (03-share-vault)

### Sprint 4 (Low + Infrastructure)
28. **#17** — Strict RSA key parsing (01-crypto)
29. **#31** — IP header spoofing mitigation (05-infra)
30. **#32** — Handle logout server errors (04-hooks)
31. **#33** — Surface decryption failures to user (04-hooks)
32. **#36** — Stronger session key generation (02-auth)
33. **#38** — Remove emails from unlock error messages (04-hooks)

### Long-term
34. **#34** — Encrypted data versioning (05-infra) — prerequisite for #10, #14
35. **#10** — Length-prefixed key derivation (01-crypto) — breaking change
36. **#14** — Increase PBKDF2 to 310k iterations (01-crypto) — breaking change
37. **#37** — Backup codes / recovery mechanism (05-infra)

## Critical Files

| File | Findings |
|------|----------|
| `packages/crypto/core/crates/bittery-crypto-core/src/srp6a/bigint.rs` | #2, #3, #9, #11 |
| `packages/crypto/core/crates/bittery-crypto-core/src/key_derivation.rs` | #10, #14 |
| `packages/crypto/core/crates/bittery-crypto-core/src/encryption.rs` | #6, #9 |
| `packages/crypto/core/crates/bittery-crypto-core/src/secret_key.rs` | #9 |
| `packages/crypto/core/crates/bittery-crypto-core/src/rsa.rs` | #17 |
| `packages/auth/src/index.ts` | #1, #30, #36 |
| `packages/api/src/routers/auth.ts` | #4, #7, #8, #18, #24, #35 |
| `packages/api/src/routers/share.ts` | #13, #15, #16, #25, #26, #28 |
| `packages/api/src/routers/vault.ts` | #24, #25, #29 |
| `packages/hooks/src/internal/use-items-unified.ts` | #12, #20, #22 |
| `packages/hooks/src/auth/srp-unlock.ts` | #21 |
| `packages/hooks/src/hooks/auth/use-quick-unlock-all.ts` | #38 |
| `packages/api/src/context.ts` | #31 |
