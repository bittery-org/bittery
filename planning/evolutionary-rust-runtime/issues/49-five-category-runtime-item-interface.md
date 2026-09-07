# Add the five-category Runtime Item interface

Type: task
Status: resolved
Blocked by: 22, 24, 31, 32, 43, 45, 46, 48
Parent: [28 — finalized E1–E10 frontier](28-remaining-item-write-kinds.md#final-web-item-and-import-frontier)

## Delivered

Delivered in `a29257df`. The contract below records this foundation's scope; later cutovers
are tracked separately.

Recorded validation: focused checks and `pnpm check:ci:rust` passed. A clean root `pnpm check:ci`
pass was not established at delivery; final integration verification remains ticket 58's gate.

## Contract

- Replace Login-only drafts and decrypted projections with one Rust-defined closed category union.
  Preserve every current editable/importable field, including Login TOTP, Password history,
  Passkeys, Custom fields and linked Item identity; retain `totp` as the Server wire spelling for
  Authenticator.
- Make Bootstrap decryption, create/update, dispatch, outcome validation, authoritative
  reconciliation, and the Account-scoped Items projection preserve the exact category and data.
  Favorite, trash, restore, move, permanent delete, Share, and Attachment authority must no longer
  reject an otherwise valid Item merely because it is not Login.
- Generate the matching Web, Kotlin, and Swift closed values under ADR 0012 and expose them through
  `packages/client-runtime/src/client`; keep diagnostic, error, and stringification surfaces
  redacted.
- Preserve current cryptographic algorithms, key hierarchy, AAD, and persisted Item ciphertext
  format. Do not change the Server Item schema, create-Vault route, Import route, or any host UI.

## Verification

- Start with failing vectors that round-trip every field of all five categories through encryption,
  Bootstrap, projection, create/update, dispatch, outcome validation, and guarded reconciliation.
- Prove ordinary category-independent actions accept every category, optional fields survive a
  Bittery/provider round trip, malformed category/field combinations fail closed, no plaintext is
  persisted outside existing ciphertext authority, and diagnostics reveal no decrypted values.
- Run the focused Core/binding/generator/client tests, Replica conformance generation check,
  `pnpm exec turbo -F @bittery/client-runtime check-types`, `pnpm check:ci`,
  `pnpm check:ci:rust`, and `git diff --check` before resolving the ticket.
