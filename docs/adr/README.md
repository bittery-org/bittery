# Architecture decision records

Each file records one decision that has already been made, so nobody has to re-derive it
from the code or re-propose the alternative that was rejected. Files are numbered
sequentially (`0001-slug.md`); numbers are never reused and existing records are amended
rather than deleted.

Add one only when all three are true: the decision is **hard to reverse**, it is
**surprising without context** (a reader would ask "why on earth is it like this?"), and a
**real alternative** was weighed and rejected. Anything else belongs in a code comment.

Deeper design context that is not decision-shaped lives next to the code —
`packages/storage/CONTEXT.md`, `SECURITY.md`, `docs/kdf-policy.md`. ADRs cross-reference
those rather than restating them.

## Records

- [0010 — Desktop renderer crypto runs in a WASM worker](0010-desktop-renderer-crypto-runs-in-a-wasm-worker.md)
- [0011 — Axum REST and OpenAPI replace Qubit JSON-RPC](0011-axum-rest-openapi-replaces-qubit.md)
- [0012 — One generated definition per cross-language type](0012-one-generated-definition-per-cross-language-type.md)
