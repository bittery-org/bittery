# Vault grants are flat, signed, and sealed to a stable Account Key Set

Status: accepted

The OPAQUE-derived Account Unlock Key wraps one random, stable Account Key Set containing X25519 and
Ed25519 private material. Credential and protocol changes re-wrap that one object instead of changing
the Account's public identity or reissuing every Vault grant. Vault keys are HPKE-sealed directly to
each member; no Team-wide key opens Vault content, so Team membership alone grants no decryption and a
departure rotates only affected Vaults.

Encryption alone does not authenticate a shared Vault against a Vault Co-member. Every grant is
therefore signed over its policy fields and exact HPKE body, and every Item revision is signed over its
canonical unsigned content before the signature is encrypted with it. The Item's signed Attachment
manifest commits to wrapped Attachment keys and ordered chunk-envelope digests. The Account Private
Object is likewise signed inside its HPKE ciphertext because Base mode lets anyone with the public key
create ciphertext to the Account.

An Account Fingerprint covers the Account identifier and both public keys and is bound into every
grant signature. It supplies a stable out-of-band value, not automatic key transparency: a Malicious
Operator's public-key substitution remains Acknowledged unless Users compare fingerprints.

Wrapping Vault keys directly under the Account Unlock Key was rejected because every password,
Secret Key, profile, or protocol change would fan out through the sharing graph. A Team-wide content
key was rejected because it violates per-Vault least privilege and makes departures rotate unrelated
Vaults. Leaving grants, revisions, Attachments, or the Account Private Object unsigned was rejected
because any holder of the relevant encryption key—or, for HPKE Base mode, any holder of the public
key—could substitute content without the claimed author.
