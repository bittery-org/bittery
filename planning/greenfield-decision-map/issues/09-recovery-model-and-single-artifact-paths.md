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

`AUTH-010` requires the **Authentication profile identifier** to be printed on the Emergency Kit
alongside the Secret Key. Without it, a user restoring from the Kit after a Server-wide parameter change
cannot derive the right Authentication Key, and the Server cannot tell them which parameters to use
without reintroducing an account-existence oracle. Fold it into whatever the Kit's layout becomes.

Recovery paths that change the master password or the Secret Key necessarily re-derive and re-register
the Authentication Key, because `AUTH-003` binds both secrets into it. That re-registration is an
authenticated write and needs its place in each recovery flow.
