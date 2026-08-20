# Memory-hard work is spent once, and only on human secrets

Status: proposed

Previously accepted; reopened by Wayfinder ticket 07 on 2026-08-20.

`AUTH-003` said the Vault-unlock derivation was "a second, independent memory-hard run". It is not a
second run. One Argon2id run covers the master password, HKDF-Extract mixes in the Secret Key, and
HKDF-Expand under two labels yields the Authentication Key seed and the Vault-unlock material.
`AUTH-015` states the single-run rule and `AUTH-003` is amended to match.

The second run bought nothing. HKDF-Expand siblings are computationally independent, so an
Authentication Key that leaks reveals nothing about the unlock material and the reverse holds too.
That is the whole of what `AUTH-002` asks for. A second Argon2id run over the same password adds no
entropy, no new secret, and no new independence. It only costs time, and it costs it on browser WASM,
which is the weakest build the product supports and the one a full sign-in is slowest on. The frozen
product ran one PBKDF2 and split with HKDF into `bittery-auth-key` and `bittery-unlock-key`; that part
of the old design was right.

The same reasoning decides which other paths are stretched at all. Stretching prices a dictionary
attack, so it earns its cost only where there is a dictionary to grind. The Secret Key is
machine-generated at roughly 128 bits and has no dictionary; running Argon2id over it protects
nothing. `AUTH-020` therefore stretches every path consuming a user-chosen secret, and permits HKDF
alone only where every secret a path consumes is machine-generated with at least 128 bits.

That rule exists because of a specific defect. The frozen product derived the recovery path with
PBKDF2 at 100,000 iterations while the main path ran at 600,000, outside the KDF profile entirely
(`packages/crypto/core/crates/bittery-crypto-core/src/recovery.rs:20,87-92`). An attacker grinds the
cheap door. The fix is to remove the stretch from paths that never needed it and forbid a weaker
profile anywhere, not to tune a second number that someone must remember to keep in step.

## Considered options

**Keeping two independent runs** was rejected. It is defensible only if each purpose should survive a
break in the other's salt derivation, and both salts derive from the same Secret Key, so that break is
not independent. Paying double on the weakest surface for it is the wrong trade.

**Splitting the two runs in time**, authenticating at sign-in and deferring the unlock derivation to
first unlock, was rejected. Sign-in is immediately followed by unlock, so the user waits the same
total, and it invents a state where a Device is signed in but cannot decrypt.

**One profile governing every path with no exceptions, recovery included,** was rejected, though it is
the simplest rule to audit. It spends a full Argon2id run on paths where it protects nothing, and it
is felt hardest on the Emergency Kit path, which a locked-out user reaches while already stressed.

**A deliberately heavier profile for recovery** was rejected outright. Defending a weak recovery
artifact by brute cost is a signal that the artifact's entropy is the real problem.

## Consequences

A full sign-in costs one Argon2id run at the parameters `AUTH-016` fixes, everywhere, on every
surface.

`AUTH-020` binds the recovery work: the Emergency Kit and any Recovery Key must be machine-generated
with at least 128 bits, or they do not qualify for the HKDF-only path and must be stretched. That is
now a stated entropy floor rather than an assumption.

There is one profile per Account, not one for authentication and one for Vault unlock, so the glossary
term is **key-derivation profile**. `AUTH-010`, which named it the Authentication profile, is amended.

`AUTH-012`'s conformance vectors must pin the HKDF labels, because the labels now carry the whole of
the domain separation. A label collision would silently make the Authentication Key seed and the
Vault-unlock material the same value, and nothing else in the design would catch it.
