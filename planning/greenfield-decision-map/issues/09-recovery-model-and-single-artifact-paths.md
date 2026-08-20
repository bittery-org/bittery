# Recovery model and single-artifact paths

Type: grilling
Status: ready-for-human
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
Without it, a fresh Device must walk the profile registry downward, paying one Argon2id run per
attempt, so Kit contents are load-bearing for recovery latency as well as correctness.

### Inherited from ticket 08, key hierarchy and canonical envelope format

`CRYPTO-002` gives this ticket exactly one object to protect. A Recovery Key wraps the **Account Key
Set** under key context `0x02` and nothing else, so "what does a Recovery Key open" has a single
answer, and revoking one is a question about that envelope rather than about every Vault key. Master
password change is the same operation: re-wrap one envelope, leave every grant intact.

`CRYPTO-011` reserves the label `bittery/1/recovery-unlock` for deriving the wrapping key from the
Recovery Key, and `AUTH-020` already binds recovery artifacts to a 128-bit floor with no memory-hard
step, because the Recovery Key is machine-generated. The Emergency Kit must now also print or carry
enough to reconstruct the Account Fingerprint (`CRYPTO-014`), if out-of-band verification is to work
for a User who has lost every Device.
