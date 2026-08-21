# Recovery model and single-artifact paths

Type: grilling
Status: resolved
Blocked by: 08

## Question

`AUTH-001` claims master password and Secret Key "jointly protect" account encryption, and the corpus then defines at least two paths that defeat that with one artifact: a Recovery Key holding a second wrapping of the master key, and an Emergency Kit that is a single printable page carrying both the Secret Key and the Recovery Key. The exception is never stated. `AUTH-006`'s "revocable" is also unenforceable: an operator's backup of the wrapped blob plus the old Recovery Key still opens the account unless every vault key rotates. See [corpus review, Critical #3](../research/corpus-review.md).

Decide:

- The exception clause on `AUTH-001` naming every single-artifact path that exists.
- What the Emergency Kit contains, and whether printing both secrets on one page survives the threat model.
- What "revoke a Recovery Key" means: delete the wrapper as best-effort, or mandatory master-unlock-key and Vault-key rotation.
- Master password change without Server decryption: the exact ceremony.
- Secret Key rotation: whether it is supported, and what it costs.
- What the UI tells a user about the strength of each recovery artifact.

Produces: `AUTH-001` and `AUTH-006` rewrites, ceremony specifications, and glossary precision on Recovery Key versus Emergency Kit.
### Inherited from ticket 06, password authentication protocol

`AUTH-010` requires the **key-derivation profile identifier** to be printed on the Emergency Kit
alongside the Secret Key. Without it, a user restoring from the Kit after a Server-wide parameter change
cannot derive the right Authentication Key, and the Server cannot tell them which parameters to use
without reintroducing an account-existence oracle. Fold it into whatever the Kit's layout becomes.

Recovery paths that change the master password or the Secret Key necessarily re-derive and re-register
the Authentication Key, because `AUTH-003` binds both secrets into it. That re-registration is an
authenticated write and needs its place in each recovery flow.

### Inherited from ticket 07, key derivation profiles

`AUTH-020` sets an entropy floor this ticket must satisfy. A derivation path may skip the memory-hard
step only where **every secret it consumes is machine-generated with at least 128 bits**. If the
Emergency Kit or a Recovery Key falls below that, it must be stretched under the Account's pinned
profile instead, and no path may ever use a weaker profile. The frozen product's 100,000-iteration
recovery route against a 600,000-iteration main route is the defect this closes.

`AUTH-019` makes the Emergency Kit the primary carrier of the **key-derivation profile identifier**.
Trusted-device enrollment is the other carrier. A fresh Device never accepts a Server-selected pin
and never walks the registry; a missing, stale, or unsupported Kit field refuses full sign-in with
recovery guidance. The profile remains a separate field beside the stable `SK1` Secret Key code.

### Inherited from ticket 08, key hierarchy and canonical envelope format

`CRYPTO-002` gives this ticket exactly one object to protect. A Recovery Key wraps the **Account Key
Set** under key context `0x02` and nothing else, so "what does a Recovery Key open" has a single
answer, and revoking one is a question about that envelope rather than about every Vault key. Master
password change is the same operation: re-wrap one envelope, leave every grant intact.

`CRYPTO-011` deliberately reserves no recovery derivation label. This ticket must first decide whether
its final construction derives a wrapping or authentication key; only then may it add the exact literal
to the closed registry. `AUTH-020` still binds machine-generated recovery artifacts to a 128-bit floor.
The Emergency Kit must carry enough to reconstruct the Account Fingerprint (`CRYPTO-014`) if
out-of-band verification is to work for a User who has lost every Device.

The Account Private Object in context `0x12` is HPKE Base ciphertext containing a signed canonical
payload. This ticket supplies its monotonically increasing object generation and atomic publication
order. A revoked Device that already holds the Account Key Set can still open and sign such an object;
the threat model must state that limit rather than treating the signature as Device revocation.

## Answer

Promoted to a rewritten [`AUTH-001`](../../../docs/greenfield/target/product.md) and `AUTH-006`, new
`AUTH-022` through `AUTH-030`, amendments to `AUTH-004`, `AUTH-005`, `CRYPTO-009`, `CRYPTO-010`,
`CRYPTO-011`, `PRIVACY-005` and `PRIVACY-007`, three ADRs, and seven new
[`CONTEXT.md`](../../../CONTEXT.md) terms.

**One rule replaces the joint-protection claim.** `AUTH-001` now says every route to the Account keys
consumes **two independent factors**, and names the closed list: master password with Secret Key,
Recovery Key with Secret Key, enrolled Device with its local authorization. No exception clause is
needed, because there is no exception. The rejected alternative was an entropy rule allowing a single
machine-generated 128-bit artifact to stand alone; it is correct about guessing and blind to a
photographed sheet of paper. ADR 0012.

**A Recovery Key alone opens nothing.** `bittery/1/recovery-unlock` consumes the Recovery Key **and**
the Secret Key. One extra HKDF input makes a stolen recovery sheet inert, and makes revocation a real
defence against a thief rather than only against a well-behaved Server.

**The Kit splits into two sheets.** `AUTH-022`: the Emergency Kit carries the Server address, the
Account email, the Secret Key, the key-derivation profile identifier, and the Account Fingerprint,
with no Recovery Key, no master password, and a printed line against writing one. The Recovery Key
gets its own sheet. `AUTH-023` refuses to finish Account creation until the Kit is saved or printed,
and states that the saved file is unencrypted; a passphrase-protected Kit file was rejected as a
second forgettable human secret inside the disaster path.

**Recovery gets its own credential, not a back door.** `AUTH-026` runs the same `AUTH-003`
challenge-response under `bittery/1/recovery-auth/1`, so there is still no pre-login request and no
enumeration oracle. The Server serves the key context `0x02` envelope only after it succeeds. The
flow shows no Vault content until a new master password is set, the Secret Key is rotated, a new
Recovery Key is issued, both sheets are produced, and every other Device is signed out. Recovery
replaces every secret carried to it; reprinting a Kit whose Secret Key had not changed would be
theatre.

**Master password change requires the current password,** including on an unlocked Device that
already holds the Account Key Set (`AUTH-025`). That is what stops brief access to a borrowed laptop
becoming a permanent lockout of its owner. The ceremony is one atomic write: re-wrap key context
`0x01`, re-register the Authentication Key. The salt is unchanged, so contexts `0x02` and `0x03`
survive and no other Device or Recovery Key is disturbed. Signing out other Devices is offered and
**off by default**.

**Secret Key rotation is supported and propagates.** `AUTH-027` adds an **Account Private Object**,
key context `0x12`, sealed to the Account's own encryption key, holding the current Secret Key. An
enrolled Device picks up a rotation on its next sync instead of being re-enrolled by hand. The Secret
Key now exists on a Server as ciphertext, which widens nothing, because whoever opens the object
already holds the Account Key Set. ADR 0014.

**"Revoked" is downgraded to the truth.** `AUTH-030` deletes the recovery envelope and the recovery
authentication record and writes a Security History entry, then offers a Secret Key rotation.
`AUTH-028` states that rotating or revoking a wrapping secret is **forward protection only**: a
backed-up envelope plus the matching old secrets still opens the same Account Key Set. Only a new
Account Key Set ends that, and the first release ships none, because `CRYPTO-005` binds the Account
Fingerprint into every grant signature so every granter would have to re-issue, and `CRYPTO-012` would
need a retained history of signing keys or every past revision becomes unverifiable. The remedy for a
confirmed compromise is export into a fresh Account. `PRIVACY-005` gained the matching Acknowledged
attack. ADR 0013.

**Printed secrets are checkable.** `AUTH-024`: 16 random bytes, prefix `SK1` or `RK1`, Crockford
Base32 in groups of five, one Crockford check symbol, and a QR on each sheet. The client validates the
check symbol before any derivation runs, so a typing error is never reported as a wrong password after
a slow Argon2id run.

**Users are shown their live routes.** `AUTH-029` renders `AUTH-001`'s closed list as one screen built
from real state, with every route revocable from it. A route the product grows without amending
`AUTH-001` shows up there as a defect.

**Recovery Keys stay optional and stay the User's.** `AUTH-006`: offered hard at Account creation,
never required or forbidden by a Server, because a Server cannot enforce a policy over a secret it
never sees. Whether one exists is operator-visible, so `PRIVACY-007` names it.

**Ruled out of scope:** peer-held, delegated, and administrator-assisted recovery. `AUTH-005` now says
so, which makes `AUTH-001`'s closed list the whole set of ways back in.

## Reopened 2026-08-20

The promoted answer incorrectly says the password and recovery routes each combine one human-chosen
and one machine-generated factor. Recovery Key and Secret Key are both machine-generated. The next
answer must distinguish two independently generated secrets from two independently stored or
different-category authentication factors.

The recovery ceremony must also define an atomic authorization order. It currently rotates the Secret
Key, publishes it in an Account Private Object decryptable by the long-lived Account Key Set, and
signs out every other Device. A Device being revoked must not receive the post-recovery object before
revocation takes effect. State what protection is and is not possible against a Malicious Operator
that gives this ciphertext to a Device already holding the Account Key Set.

Resolve after ticket 08, keeping recovery no more complex than the threat model requires.

### Inherited from the reopened password authentication decision

The Emergency Kit now carries the one-byte authentication-protocol version as well as the one-byte
key-derivation profile. A password or Secret Key change replaces the OPAQUE registration and the
export-key-wrapped Account Key Set atomically. The replacement ceremony must produce and require the
updated Kit before the old pair is deleted.

If an old OPAQUE version is unsafe to execute, an enrolled Device may authorize replacement and this
ticket must decide whether its independent recovery route may do the same. Without one of those routes,
the Account is unrecoverable; the operator has no reset or migration bypass.

## Answer — second pass 2026-08-21

Promoted to rewritten [`AUTH-001`](../../../docs/greenfield/target/product.md), `AUTH-006`, and
`AUTH-022` through `AUTH-030`; the byte-level recovery section in the
[`cryptographic format`](../../../docs/greenfield/target/cryptographic-format.md); accepted ADRs
[0012](../../../docs/adr/0012-every-route-to-the-account-keys-consumes-two-factors.md),
[0013](../../../docs/adr/0013-rotating-a-wrapping-secret-is-forward-protection-only.md),
[0014](../../../docs/adr/0014-the-current-secret-key-is-stored-sealed-to-the-account-key-set.md),
and [0018](../../../docs/adr/0018-recovery-authentication-is-independent-of-opaque.md); and revised
recovery language in [`CONTEXT.md`](../../../CONTEXT.md).

**The closed route list survives; the false factor claim does not.** Remote password and recovery
routes each combine two separately sourced secrets intended for separate storage. The enrolled-Device
route combines a Device-held key with its local authorization. Recovery Key and Secret Key are both
machine-generated secrets, so Bittery no longer calls them different authentication-factor categories.

**Bittery emits separate recovery documents and makes no unverifiable storage claim.** The Emergency
Kit and Recovery sheet are separate outputs on every surface; no combined file, page, encrypted bundle,
or password field exists. Account creation still requires the Kit to be saved or printed. The product
tells the User to store the Recovery sheet elsewhere but cannot claim to know that they did.

**`RK1` is independent of OPAQUE.** One HKDF-Extract-SHA-512 root consumes the Recovery Key and Secret
Key. Account- and Server-bound labeled expansions yield a `0x02` wrapping key and a deterministic
Ed25519 signing seed. The Server stores only the versioned public key. This route remains executable
when the Account's old OPAQUE version is unsafe; an operator reset still does not exist. The narrow
custom-protocol exception, its vectors, and its integration join the external-review and penetration-
test gate. ADR 0018.

**Recovery uses two bound signatures, never a bearer reset session.** A five-minute signed challenge
gates release of the encrypted recovery envelope. Successful proof opens a thirty-minute proven state.
The second signature covers the same attempt and every canonical replacement field. A failed proof
consumes the attempt; expiry changes nothing; and a byte-identical committed request can be retried
idempotently until the deadline. The format specification fixes the HKDF inputs, exact labels, field
order, widths, lengths, rejection rules, and fixtures.

**Recovery is one atomic cutover after both new documents are saved.** It replaces the OPAQUE
registration and wrapper, recovery public key and wrapper, signed Account Private Object, and
Device-credential issuance request; revokes every old Device and session; records the event; and
consumes the attempt. An honest Server cannot expose the new private object to a Device revoked by
that transaction. A Malicious Operator can still deliver it to any old Device that already holds the
long-lived Account Key Set. Preventing that needs Account Key Set or per-Device key rotation and is not
claimed in the first release.

**Routine password change remains narrow.** It requires the current password, even on an unlocked
Device, and atomically replaces only the OPAQUE registration and `0x01` wrapper. Other routes survive.
The User saves a replacement Kit only when the ceremony also changes a version byte printed on it.

**Ordinary Secret Key rotation preserves trusted Devices by default.** The User may select Device and
session revocations. Those revocations, new authentication and recovery records and wrappers, the new
Account Private Object, and its monotonic generation check commit atomically after the replacement Kit
is confirmed saved. Recovery remains the exceptional path that revokes every old Device and session.

**Recovery Keys are removed, not over-promised as revoked.** Remove Recovery Key deletes the live
wrapper and public-key record, logs the action, and offers Secret Key rotation. The UI calls the result
forward protection and explains that old copied wrappers and matching secrets are not erased. A true
Account-key boundary still requires export into a fresh Account. ADR 0013.

**The Account-access screen explains compromise conditions instead of scoring strength.** It names
each route's inputs, dates, live state, loss or theft consequence, and available actions, and warns
about separate storage. It never claims knowledge of password quality, physical storage, or platform
protection it cannot observe.

No fog graduated and no new ticket was needed. [Device enrollment protocol](10-device-enrollment-protocol.md)
inherits the canonical Device-credential request and honest-Server cutover requirements.
