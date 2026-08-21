# Conformance fixture corpus

Type: grilling
Status: ready-for-human
Blocked by: 08, 15, 39

## Question

`ARCH-SERVER-004` makes the fixture corpus the definition of compatibility for third-party clients, and the architecture requires native Rust, WASM, Swift, and Kotlin bindings to execute the same corpus. The first release ships only Rust and WASM, so decide what the corpus must prove now and what it must be shaped to accept later.

Decide:

- The fixture format, and whether the scenario shape in `scenarios/README.md` survives contact.
- What each fixture asserts: visible projection, durable replica, operation state, server state, emitted events.
- How crypto negative vectors are expressed, from [the envelope format](08-key-hierarchy-and-envelope-format.md).
- Whether the corpus is genuinely shared across hosts or splits by durability class, handed over from [browser durability](16-browser-durability-floor.md).
- How a third-party client runs it without the Rust engine.
- Where the twelve seed scenarios land, and which are replaced.

Produces: the corpus specification and the resolution of the seed scenario list.

The first-release gate must not require unshipped Swift and Kotlin bindings to execute the corpus.
Define a first-release Rust/WASM obligation and a fixture format that later native bindings must adopt;
this corrects the unconditional wording in `docs/greenfield/target/architecture.md`.

Ticket 53 also hands this ticket the integrated cryptographic review surface and acceptance-policy
fixtures. Reopened tickets 06 through 09 may replace all previously listed vectors.
### Inherited from ticket 06, password authentication protocol

`AUTH-013` hands this ticket every applicable RFC 9807 Appendix C real and fake vector plus Bittery-
profile positive and negative vectors. Rust and WASM must consume the same fixture bytes. Independent
cross-implementation execution is not a release requirement; external review separately covers the
pinned `opaque-ke` implementation and its integration.

The Bittery vectors pin the two-byte header, canonical OPRF input, Account and Server identities,
authenticated context, Argon2id profile, KE1 through KE3, registration record bytes, export-key HKDF,
and session-key confirmation MAC. Negative cases cover every rejected length, zero or unknown version,
context mismatch, malformed RFC payload, replayed attempt, and second KE3 submission.

### Inherited from ticket 08, key hierarchy and canonical envelope format

`CRYPTO-015` enumerates every rejection rule the corpus must prove: unknown format or context, wrong
body shape, nonzero forbidden epoch, short or trailing data, oversized or noncanonical tuples,
authentication failure, public-key mismatch, malformed or low-order keys, noncanonical Ed25519
signatures, and usage-limit overflow. Each rule has a negative fixture, no failure emits partial
plaintext, and authenticity failures expose one outcome. Nonce reuse is explicitly **not** detectable.

The shared crypto seed contains RFC 8452 AES-256-GCM-SIV, RFC 9180 Appendix A.2 HPKE, RFC 8032
Ed25519, and applicable Wycheproof vectors. Each key context has a positive vector plus relocation,
wrong-context, and field-reordering negatives. The fixture pins every `CRYPTO-011` domain label and
asserts pairwise distinctness; it pins the signed grant's exact HPKE body, the signed Item body, the
signed Account Private Object, the full Account Fingerprint, and the Attachment manifest. Rust and
WASM consume identical fixture bytes.

`CRYPTO-016` allows compatible manifest ranges but makes the committed lockfile resolution the
released and reviewed baseline. Fixture CI runs on every automated crypto update, which never
auto-merges; this ticket must expose the resolved dependency versions in corpus-run output.

### Inherited from Browser durability floor

The storage corpus has one host-independent semantic core plus mandatory Durability profiles; this
shape is settled, while this ticket still owns the fixture encoding and runner. Every adapter proves
the same typed-state, atomicity, isolation and Sync invariants. `native-crash-durable` adds forced
termination and reopen across its strongest persistence barrier. `browser-transactional` adds Worker
or background-runtime termination with the Origin intact, lost acknowledgement after commit,
best-effort persistence denial and whole-Origin removal. Origin removal must yield an absent Replica,
never partial recovery or a false claim that an Unsynced operation reached the Server.

### Inherited from Search and autofill index

The shared corpus gains semantic and cryptographic vectors for Unicode normalization and case folding;
exact/prefix/substring ranking; field exclusions; full ICANN and PRIVATE Public Suffix boundaries;
IDNA, IP, localhost and application matching; Account and Collection scopes; snapshot relocation,
chunk omission/reorder/duplication, stale source, interrupted asynchronous checkpoint, progressive
completeness, locked-Sync invalidation, removal, and Travel rekeying. Rust and WASM run the same first-
release vectors; later native bindings adopt them.
