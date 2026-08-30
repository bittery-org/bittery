# Add the five-category Runtime Item interface

Type: task
Status: resolved
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

## Comments

### 2026-08-31 — resolved

Commit `a29257df` replaces the Login-only Runtime Item boundary with the Rust-defined closed Login,
Secure Note, Credit Card, Identity, and Authenticator values across protocol, encrypted Bootstrap,
projections, create/update dispatch, retained outcomes, guarded reconciliation, bindings, generated
Web/Kotlin/Swift/WASM artifacts, and Replica conformance. The Server continues to spell
Authenticator as `totp`. The implementation preserves the existing encryption algorithms, key
hierarchy, AAD, and persisted Item ciphertext format: category selects the existing inner plaintext
shape rather than adding a new persisted category field. Independent review approved the corrected
implementation with no remaining findings.

`pnpm --filter @bittery/client-runtime run check` passed, including 515 Core unit tests, five
Attachment API tests, three Replica-corpus tests, three Server-contract tests, 45 binding tests,
five generated-contract tests, 31 generator tests, and all generated native/WASM drift checks.
`pnpm check:ci:rust` passed end to end, including the Server, 139 crypto tests plus nine vectors, the
Runtime and generated bindings/WASM, and 89 plus 50 Desktop tests. The focused Runtime TypeScript
tests passed 21/21; focused Biome, Runtime type checking, and `git diff --check` also passed. The
independent reviewer separately passed focused Rust coverage, the client tests 13/13, generator tests
12/12, package type checking, and the diff check.

The root `pnpm check:ci` reached Biome and stopped only on the preserved, pre-existing Ticket 58 Web,
composition, and browser-harness draft; it exposed no Ticket 49 defect. Deliberately left open for
Ticket 58: Web consumer-callsite migration and formatting of that host-cutover draft. This ticket
does not change Server routes, Web UI behavior, Vault creation, Import dispatch, or make a Web hook
the reusable interface.
