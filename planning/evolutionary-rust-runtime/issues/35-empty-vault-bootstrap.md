# Empty Vault Bootstrap authority

Type: task
Status: claimed
Blocked by: 22
Spec: ../spec.md#bootstrap

## Outcome

The bounded Bootstrap protocol represents every accessible Vault needed by the first Web slice even
when that Vault has no Items, and Rust stages and promotes its encrypted summary and wrapped key as
authority without weakening page replay, byte bounds, or Account scope.

## Why this blocks first-slice acceptance

Ticket 32's complete browser scenario proved that full Rust Sign-in and Bootstrap reach the Server,
while the Runtime Vault projection remains empty for a newly created personal Vault. PostgreSQL has
the Vault and `vault_key` rows. `bootstrap_items` currently derives `selected_vault_ids` exclusively
from Items on the current page and inlines Vault summaries only inside those Items, so an empty Vault
cannot cross the wire. `AcceptCreateLoginItem` correctly refuses work without a ready personal Vault.

## Maintainer decision required

Decide how accessible Vault summaries participate in the existing bounded, resumable Bootstrap
protocol. The answer must define page ownership and replay behavior, avoid an unbounded all-Vaults
side list, and keep an empty Vault representable without manufacturing an Item. Implementation must
not infer this product protocol choice.

## Work after the decision

- Add the Server red test for a newly created accessible Vault with zero Items.
- Change the Server schema, OpenAPI, generated API contract, and generated Rust wire types together.
- Stage and promote standalone Vault authority in Rust while preserving generation/page identity,
  exact replay, byte bounds, and wrapped-key ciphertext.
- Prove an empty personal Vault appears in the real Runtime projection and permits the first durable
  offline Login Item acceptance.

## Verification

Start from the failing empty-Vault Server/Runtime test and retain its output. Run targeted Server,
generated-contract, Runtime Bootstrap, and Web acceptance checks, followed by `pnpm check:ci` and
`pnpm check:ci:rust` from a clean tree.

## Comments

### 2026-08-24 — discovered by ticket 32

This is a product defect, not a fixture failure: the database authority exists, but the current wire
shape has nowhere to carry it when a Vault contains no Item. Ticket 32 remains red and keeps its Web
work set aside until this protocol frontier is decided and delivered.

### 2026-08-24 — maintainer decision: one two-phase feed

The maintainer chose one bounded, resumable Bootstrap feed with an explicit phase. Vault pages come
first, ordered and cursor-paginated independently; Item pages follow only after the terminal Vault
page. The request, response, stored page identity, and replay fingerprint carry the closed phase tag,
so an Item cursor is never interpreted as a Vault cursor. Both phases share the generation's pinned
Sync watermark and existing old-or-new promotion boundary.

Vault pages carry standalone Vault summaries and wrapped keys, including Vaults with zero Items.
Item pages carry Items and no longer need an embedded Vault summary as the authority source. Each
phase obeys the response byte budget, exact replay is phase-and-cursor scoped, and promotion requires
terminal completion of both phases. This avoids an unbounded all-Vault side list, repeated key
material on every Item page, and a second independently orchestrated route.

### 2026-08-24 — split into two independently green slices

- **A, Server and generated wire contract.** Add the empty-Vault red Server test, implement bounded
  phase-tagged Vault-then-Item pages, regenerate OpenAPI, TypeScript API contract, and Rust Server
  wire types, and leave all Server/generated checks green. This slice owns Server and generated
  contract paths only.
- **B, Runtime Bootstrap consumption.** Begin with a Rust test that cannot stage the new Vault phase,
  then consume phase-tagged pages, bind phase into page identity/fingerprint and resume, require both
  terminal phases before promotion, and verify standalone empty-Vault authority. This slice owns
  client-core implementation and tests only.

Each slice receives an independent review. Ticket 32 resumes only after B; ticket 35 resolves only
after the restored browser path and both full gates prove the complete boundary.
