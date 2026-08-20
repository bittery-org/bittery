# Web host: Worker, adapters, and the Effect decision

Type: grilling
Status: ready-for-human
Blocked by: 39

## Question

The architecture pins Effect v4 and makes stable v4 a release gate, for a layer that owns clipboard, file picker, Worker lifecycle and visibility, and explicitly does not own Vault policy, session, replica, retries, sync scheduling, conflicts, or schemas. Research: **v4 is still a release candidate** (rc.111, cut 2026-08-20), stable is a soft "Q3/Q4 2026", `latest` on npm is 3.22.1, and the `rc` tag moved four times in eight days. The corpus's "during beta it is pinned exactly" is stale. See [library maturity](../research/library-maturity.md) and [corpus review, Worth a look #1](../research/corpus-review.md).

Decide:

- Effect v4 RC, Effect v3.22.1, or hand-written adapters. The gate should be "the platform layer has no pre-stable dependency", not another project's timeline.
- If Effect: exact pin, and whether Schema is isolated behind a thin local module so the 14-type-parameter blast radius is one file.
- Worker hosting: how the WASM runtime is owned, and what happens on Worker termination.
- The boundary rule that React feature modules never import Effect layers, WASM, or Worker internals.
- The transactional browser-store adapter, taking its floor from [browser durability](16-browser-durability-floor.md).
- Whether the release gate keeps a requirement ID so CI can enforce it.

Produces: an `ARCH-WEB-*` requirement family and a dependency decision with a named fallback.
