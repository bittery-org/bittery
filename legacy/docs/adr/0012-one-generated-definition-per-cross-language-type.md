# One generated definition per cross-language type

A concept that has a Rust definition has exactly one TypeScript definition, and that
definition is generated. Hand-written TypeScript may alias it, narrow it or brand it. It may
not restate it.

Bittery crosses the Rust/TypeScript boundary in four places, and each one already has a
generator: the HTTP API (`openapi.v1.json` → `openapi-typescript` → `packages/api-contract`),
the crypto core (uniffi → `packages/crypto/wasm/generated` and
`packages/crypto/android/generated`), the Tauri
command surface and the desktop↔extension IPC protocol (both ts-rs →
`apps/desktop/src/generated`). Before this record, three of those four were routinely
re-typed by hand downstream of the generator — `packages/shared/vault-mapping.ts` restated
the vault shapes, `packages/types` restated fourteen uniffi records, `auth-service.ts`
restated the login responses, and the Tauri commands had no TypeScript representation at all.
The duplicates were not wrong when written. They drift, silently, in the direction that
matters least until it matters most: a role string, a KDF parameter, a login response.

The four layers below are exhaustive. Every type belongs to exactly one of them, and the
layer decides who is allowed to write it.

**Generated wire types** are produced by a generator from a Rust definition and committed.
Nobody edits them and nobody re-declares them. **Facade types** — `api-contract/facade-types.ts`
for the server, `crypto/port/types.ts` for the crypto seam — give the generated shapes
ergonomic names and retype the fields the wire spells as strings into `Date`, `bigint` or a
branded id. They are thin by construction: an alias, an `Omit`, an intersection. **Client
domain types** describe what the server can never see — decrypted item plaintext, display
models, import and export formats — and are hand-written because no Rust definition of them
exists or could. **App and view types** are props, route state and view models; they never
name a server shape.

Where a package genuinely cannot import its generator's output, restating the shape is
allowed and a compile-time drift guard is mandatory. `packages/shared/item-mapping.ts` is the
worked example: a type-only assertion that fails the build when the generated shape moves.
Two such constraints are real and stay. `packages/sync` does not depend on `packages/storage`,
so it restates the vault-key entry. `packages/crypto/port` must not import the platform
bindings at runtime, so it restates the uniffi records and the `CryptoError` tag table. Both
now carry guards. A restatement without a guard is the defect this record exists to prevent.

Generation is only as good as its enforcement, so the drift checks are part of the decision
rather than a consequence of it. CI runs `check:generated` for the TypeScript API types,
diffs freshly generated uniffi and ts-rs bindings against the committed ones, and rejects
breaking changes to `/api/v1`. Closed sets — roles, item categories, sync event types,
billing status, error codes — are Rust enums that reach OpenAPI as string enums, so the
client unions are generated rather than typed twice; `apps/server/src/db/enums.rs` is their
single home.

ts-rs returns for the Tauri and desktop-IPC seams only. [ADR 0011](0011-axum-rest-openapi-replaces-qubit.md)
removed ts-rs along with Qubit because it was generating the *API* client, where OpenAPI is
the better contract: it is language-neutral, versioned and publishable, and self-hosted
operators consume it. None of that applies to a command surface and an IPC protocol that are
private to two binaries shipped together. There the choice is ts-rs or a hand-mirrored
discriminated union pinned by an integer version constant, which is what
`desktop_ipc.rs` and `desktop-protocol.ts` were. OpenAPI remains the only contract for
`/api/v1`, and ts-rs is confined to seams that never leave the machine.

The cost is real: a schema change now fails the build in more places, and adding a route
means regenerating two artifacts and bumping the count assertions in
`apps/server/src/http/api/mod.rs`. That checkpoint is deliberate. The alternative — letting
each client keep a private copy of the server's mind — is how a zero-knowledge product ends
up decrypting with the wrong parameters.
