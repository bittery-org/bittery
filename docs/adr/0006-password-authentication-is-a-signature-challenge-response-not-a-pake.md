# Password authentication is a signature challenge-response, not a PAKE

Status: accepted

`AUTH-003` named RFC 9807 OPAQUE as the intended protocol with its suite left open. The product runs a
signature challenge-response instead. Argon2id runs over the master password, HKDF-Extract mixes in the
Secret Key, and HKDF-Expand produces the seed for an Ed25519 Authentication Key. The Server stores the
public half. At each full sign-in the client signs a canonical, length-prefixed message binding a
purpose label, the protocol version, the Server identity, the Account identifier, and a single-use
Sign-in Challenge.

The reasoning starts from what a password-authenticated key exchange actually buys. No augmented PAKE
removes the offline dictionary attack against a stolen Server database; conceding that attack is the
definition of the category. OPAQUE's distinguishing property is pre-computation resistance, because its
oblivious-PRF step means the client never receives a salt. `AUTH-001` binds the Secret Key into the
credential, so any offline grind already costs roughly 128 bits on top of the password, and the Server
holds Vault ciphertext derived from the same two secrets and grindable at identical cost. The property
OPAQUE sells was therefore already held, and held better, by the Secret Key.

## Considered options

**OPAQUE, RFC 9807, on `opaque-ke` 4.0.1** was rejected on cost against that marginal gain. RFC 9807 is
Informational on the IRTF stream and its own text says the results "might not be suitable for
deployment". `opaque-ke` is effectively single-vendor with no credible alternative Rust implementation,
carried a five-month commit gap at the time of the decision, and its only audit is NCC Group, June 2021,
against version 0.5.0: four years and three major versions before the RFC sync. It would also have been
the product's hardest component to review and its least replaceable dependency.

**Reusing the frozen product's SRP-6a** was rejected, and the frozen implementation is the reason. It is
1,703 lines of hand-written Rust under `legacy/packages/crypto/core/crates/bittery-crypto-core/src/srp6a/`,
including its own big-integer module, whose source records that the modular exponentiation is not
constant-time because `num_bigint::BigUint::modpow` uses a variable-window algorithm. That is a secret
exponent in a variable-time routine. Adopting it means adopting bespoke big-integer arithmetic, which is
a larger review liability than the construction it would replace, not a smaller one. SRP is also less
standard than it appears: the CFRG's PAKE selection passed it over in favour of OPAQUE and CPace, TLS 1.3
removed SRP entirely, and it has no security proof. It would additionally have restored the pre-login
salt fetch this decision removes, and lost the pre-computation resistance that [ADR
0007](0007-the-authentication-salt-derives-from-the-secret-key.md) obtains for free.

**Sending a KDF-derived authentication hash**, as Bitwarden does, was rejected because the value on the
wire and at rest is password-equivalent. A Malicious Operator running modified Server code harvests it
silently, which contradicts the class ticket 04 spent its budget defending against.

**HMAC over the challenge** was rejected for the same reason at rest: the Server would hold the key it
verifies with.

**ECDSA over P-256** was rejected. Nothing outside the Rust core ever verifies, so P-256 buys no
interoperability and costs randomness at signing time and a nonce-reuse failure mode Ed25519 does not
have.

## Consequences

The construction is bespoke, and that is the cost this decision accepts. It is mitigated three ways.
The exchange itself is conventional: challenge-response against a registered public key is the shape of
SSH public-key authentication and WebAuthn. The novel part is the derivation alone, which is three steps
over separately audited primitives, and the product writes no big-integer arithmetic of its own.
`AUTH-013` makes an external cryptographic review of the written design note a gate before general
availability, ahead of any penetration test, because a design flaw found once Accounts exist is the
expensive one. `AUTH-012` requires the design note and conformance vectors now, so ticket 49's fixture
corpus proves the Rust core, the WASM build, and the Server agree byte for byte.

Because the protocol version is bound into both the signed message and the Server-side record, a
rejected version is a scheduled migration rather than a crisis: publish a new version, let each client
re-derive and re-register at next full sign-in, and refuse the old version at the Server. No Vault data
moves and nothing is decrypted. `AUTH-014` makes that path normative rather than implied.

Every surface authenticates identically, so the Server has exactly one authentication implementation and
no weaker path exists to steer a client onto. The Web client pays the full derivation cost for a
property `PRIVACY-015` says it cannot hold; that is accepted as the price of a single Server path.
