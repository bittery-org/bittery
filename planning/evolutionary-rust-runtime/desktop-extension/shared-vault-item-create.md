# Item creation in writable shared Vaults

## Frontier resolution

Question: does the migrated Desktop need another creator or key format for shared Vault Items?

No. Preserve the mounted behavior through Core `CreateItem`. The
[Vault route](../../../apps/desktop/src/routes/vault/route.tsx) passes the selected Vault's stable
Account/Vault IDs and category from the shared
[creation sheet](../../../packages/ui/src/components/vault/create-item-sheet.tsx), including shared
Vaults. [useCreateItem](../../../packages/core/src/hooks/items/use-create-item.ts) reaches
[ItemCommands](../../../packages/core/src/services/item-commands.ts), which encrypts for that Vault
without a personal-only branch. Duplicate Item uses this creation path too.

Actual Core inspection found the obsolete personal-only guard, and then a second missing capability:
[Vault crypto](../../../packages/core/src/services/vault-crypto.ts) opens owner/MUK wrappers or
RSA member wrappers using the Account's encrypted private key. Rotation wraps keys for other members
with RSA. Core Bootstrap, Item mutation, Attachment and Move currently only support MUK wrappers;
a test fixture that labels a MUK wrapper as shared does not prove member compatibility.

Preserve both existing representations with one private Core Vault-key opener. Move the existing
`decrypt_rsa_wrapped_key` implementation from the crypto API into crypto-core and delegate from
both callers; retain AES-GCM private-key envelopes, RSA-4096 OAEP/SHA-256, base64 key bytes and the
32-byte check unchanged. No persisted conversion, new algorithm or host crypto API is introduced.
MUK wrappers retain strict User/Vault context checks. RSA wrappers have no embedded Vault/User
context in the existing format: their scope comes from current verified authority plus the exact
Account's private key, with Item/Attachment AAD still checked. Do not invent a wrapper context.

Keep the encrypted private-key envelope beside the MUK in the existing live Account/incarnation
key entry. Existing guarded sign-in, password/biometric unlock and native transfer publication copy
it from their exact Session. This is ciphertext needed by synchronous projections, not another
Session owner or plaintext private-key cache. Lock, replacement, teardown and owner loss already
retire that same live entry. Temporary decrypted PEM, encoded key and decoded key are zeroized.
Missing/foreign private material fails closed; malformed MUK JSON is never accepted via RSA fallback.
Route Bootstrap Item/Attachment projections and validation, Item creation/existing mutations/shares,
Import, foreground Attachments and Move preparation through the same opener. Readiness, role,
Account incarnation, lock and publication guards remain at their existing admission boundaries.

This is routine preservation of actual mounted behavior, not a new product choice. The first
MUK-backed vertical is verified; RSA member integration must pass before ticket 85 closes.

## Contract

The existing creator accepts Login, Secure Note, Credit Card, Identity and Authenticator Items in
current writable personal or shared Vault authority. Owner, admin and member retain write access;
read-only authority is refused. Preserve category encoding, Account/Vault/Item-bound AAD, immutable
HTTP/fingerprint, encrypted overlay, atomic acceptance, cancellation and dispatch.

Use only active verified Vault authority and live keys of the exact Account incarnation. A key in
an obsolete generation does not authorize a hidden/absent Vault. Foreign User/Vault wrapper contexts
and keys that cannot unwrap with the current Account material fail before acceptance, with no Operation or
optimistic Item written. Existing lock, generation and readiness fences remain. Ticket 70 supplies
its pending-deletion fence separately; ticket 71 owns Travel changes and physical erasure.

## Acceptance

Extend the existing five-category test through the public Core request into shared authority with
a distinct real Vault key wrapped for the installed Account. Decrypt accepted ciphertext with that
key and existing AAD; confirm category, plaintext projection, immutable request and durable overlay.
Prove writable shared roles; refuse read-only personal/shared roles, foreign wrappers, wrong MUK,
and an absent active Vault whose old generation still holds a key. Reuse lock/commit/cancellation
regressions; introduce no copied encryption or presentation logic.

Then use actual RSA-wrapped shared-member authority and encrypted private-key Session data through
Core installation/unlock, read and write. Verify all categories and reuse the same opener across
Item/Attachment/Move/Import consumers. Prove missing/foreign private key refusal and lock/restart/
replacement isolation. Crypto API/Core interoperability tests preserve the existing wrapper format.

Record red/green, targeted Core tests, independent review and formatting/Clippy. These are capability
checks. Real Desktop creation/duplication in shared Vaults and Server convergence remain required
in 66/72/73; controlled capabilities are not production acceptance. Full phase CI remains required.
