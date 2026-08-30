# Add the five-category Runtime Item interface

Type: task
Status: ready-for-agent
Blocked by: 22, 24, 31, 32, 43, 45, 46, 48
Parent: [28 — finalized E1–E10 frontier](28-remaining-item-write-kinds.md#2026-08-30--final-web-item-and-import-frontier-resolved)

## Outcome

The shared Rust Runtime protocol, projections, bindings, and client facade represent Login, Secure
Note, Credit Card, Identity, and Authenticator Items without a Login-only admission guard, while the
existing Server Item routes and Web Import writer remain unchanged.

## Work

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

## Path ownership and failure domain

This slice owns Item vocabulary and behavior in
`packages/client-runtime/crates/bittery-client-core`, the shallow binding definitions in
`packages/client-runtime/crates/bittery-client-bindings`, ADR-0012 generated Runtime/native/Web
artifacts under `packages/client-runtime/generated`, and the platform-neutral client facade under
`packages/client-runtime/src/client`. It may extend the existing Replica conformance corpus for
these shapes. It owns category encoding, decryption, redaction, and admission failures only. It does
not own `apps/server` route behavior, `apps/web` presentation, Vault creation, or Import dispatch.

## Verification

- Start with failing vectors that round-trip every field of all five categories through encryption,
  Bootstrap, projection, create/update, dispatch, outcome validation, and guarded reconciliation.
- Prove ordinary category-independent actions accept every category, optional fields survive a
  Bittery/provider round trip, malformed category/field combinations fail closed, no plaintext is
  persisted outside existing ciphertext authority, and diagnostics reveal no decrypted values.
- Run the focused Core/binding/generator/client tests, Replica conformance generation check,
  `pnpm exec turbo -F @bittery/client-runtime check-types`, `pnpm check:ci`,
  `pnpm check:ci:rust`, and `git diff --check` before resolving the ticket.
