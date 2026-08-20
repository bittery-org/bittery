# Key derivation profiles and downgrade resistance

Type: grilling
Status: ready-for-human
Blocked by: 04, 06

## Question

Format altitude. The frozen product uses PBKDF2-HMAC-SHA256 at 600,000 iterations, with `argon2` present only as a reserved comment, and derives the recovery path at **100,000** iterations outside the KDF profile: a 6x weaker route to the same master key. See [current-state verification](../research/current-state-verification.md). `AUTH-002` domain-separates authentication from Vault-key derivation, so a full sign-in runs two expensive KDFs on the weakest devices.

Decide:

- Argon2id parameters per platform class, or a reasoned choice of something else, with a benchmark budget that is measured rather than asserted.
- Unicode normalisation and encoding of the password before derivation.
- The profile record: how parameters are represented, versioned, and upgraded.
- Downgrade resistance. The frozen client pins parameters after first use so they cannot be silently weakened; this has no successor requirement. Decide whether pinning is a `MUST` and what happens on a legitimate upgrade.
- Whether every derivation path, recovery included, is governed by one profile with no exceptions.
- The combined cost of two KDFs on a low-end device, and whether that changes `AUTH-002`.

Produces: `AUTH-*` requirements at parameter level, a versioned profile format, and negative test vectors.
