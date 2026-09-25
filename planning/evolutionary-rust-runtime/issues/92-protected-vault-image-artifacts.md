# Protect indispensable accepted Vault-image artifacts

Type: research
Status: resolved
Blocked by: 65, 69
Spec: ../desktop-extension/vault-image-artifact-protection.md

## Question

How can existing accepted Create/UpdateVault image work retain only protected, inaccessible evidence
when Travel hides its Vault, while preserving immutable requests, public image bytes, existing crypto
formats and readable legacy artifact/recovery data?

## Evidence and bounded investigation

The current shared image ingress deliberately persists plaintext. SQLite stores raw chunks in
`vault_image_artifact_chunks.plaintext`; the Core facade and browser port also operate on raw image
bytes. Ticket65 permits indispensable encrypted artifacts, not a plaintext exception because an image
will eventually be public on the Server. Ticket71 therefore cannot claim compliance by retaining the
current artifact or silently deleting accepted work that still needs it.

Inspect existing `EncryptedData`/AES-GCM/AAD primitives and Device/Account/Vault key lifetimes. Compare
protection at ingress with guarded conversion of legacy raw artifacts; distinguish Create's not-yet-
created Vault and Update's existing Vault, `ArtifactReady`, `RemoteUploadConfirmed`, frozen requests
and terminal cleanup. Identify which bytes remain indispensable at each stage using actual recovery
coverage and Server staging behavior. Preserve current HTTP bytes/digests and existing cipher vectors.

Select one shared Core protection/read policy, versioned compatibility path and recovery/key ownership
after independent review. Hosts remain opaque storage capabilities. No new login-equivalent secret,
host crypto implementation, second artifact backend, plaintext exception or fake staging evidence is
authorized. Do not implement a format change before its explicit migration/architectural decision.

## Output and readiness

Record concrete options, selected verdict, required generated/storage/crypto compatibility vectors and
test-first acceptance in the focused spec. If a bounded implementation prerequisite is required, create
its dependency-ordered ticket before ticket71 starts. Resolve this research only after that mechanism
is selected; ticket71 remains unready while this question is open.

## Comments

2026-09-09: opened during the actual Travel ownership inventory, with parent authorization for bounded
technical investigation. Existing67/69 capability evidence does not establish image protection.
No source change, new cryptographic algorithm, persisted-format rewrite or acceptance is claimed.

2026-09-09: root selected a fresh per-artifact key with existing AES-GCM/AAD envelopes and a wrapper
under the existing Device key. Hidden reads/decryption remain Core-fenced; cleanup needs no key.
Encrypted recovery transfers only the artifact key inside its existing authenticated stream and
rewraps at the destination, without image decryption or source Device-key export. The focused spec
fixes scope/metadata/chunk binding, additive local/recovery versions and legacy readers.
[Delivery93](93-protected-vault-image-artifact-storage.md) is drafted before source changes. Independent
mechanism/compatibility review is requested;92 remains claimed and93 needs-triage until it completes.
This gates71 and70's image-retirement variant, not70's no-image foundation.

2026-09-09 final independent review: mechanism and93 readiness pass after adding the accepted
protected-publication witness and protected-publication → source-witness commit → raw-cleanup order.
No extra cipher/MAC/backend is needed. Legacy User identity comes from exact validated Account/Replica
ownership; portable repair preserves existing Account identity while changing Device-key domain.
Research92 is resolved and93 is ready for bounded implementation. Actual protection, migration,
cross-key-domain recovery and erasure evidence remain93 acceptance work.
