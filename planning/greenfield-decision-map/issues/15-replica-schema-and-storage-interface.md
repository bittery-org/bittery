# Replica schema and transactional storage interface

Type: grilling
Status: ready-for-human
Blocked by: 08

## Question

`ARCH-STORE-001` promises shared engine-level replica semantics with varying physical storage, and leaves both the schema and the adapter interface undefined.

Decide:

- The logical replica schema: entities, keys, indexes, and what is stored as ciphertext versus engine-visible plaintext, checked against the closed plaintext list.
- The transactional adapter interface the engine requires: atomicity scope, isolation, durability contract, and what an adapter must prove.
- Where decrypted material may exist and for how long.
- Generation and promotion semantics for bootstrap, so an interrupted bootstrap never replaces the last usable generation.
- What happens to the replica on lock, sign-out, Account removal, and Device wipe, and which invariants must hold across those.
- Whether the same schema serves a constrained credential-provider runtime.

Produces: a schema specification, an adapter conformance contract, and seed scenarios 5 and 10.
