# Memory-hard work is spent once, and only on human secrets

Status: accepted

OPAQUE performs exactly one Argon2id key-stretching run during full sign-in. Its session key authorizes
one Device-credential issuance, while its client-only export key yields the Account Unlock Key through
labeled HKDF expansion. A second password derivation would add no entropy or independent factor and
would double the cost on the weakest client.

Memory-hard work prices a dictionary attack, so the governing invariant is the entropy of the inputs,
not the route's name. Every route consuming any human-chosen secret uses the Account's pinned
key-derivation profile. A route may use HKDF without Argon2id only when every consumed secret is
independently machine-generated with at least 128 bits. Recovery therefore gets neither the frozen
product's weaker PBKDF2 exception nor an Argon2id run over random keys that have no dictionary to
grind.

## Considered options

**A second password derivation for Account unlocking** was rejected because OPAQUE already separates
the session and export keys and the labeled expansion narrows the latter to one job. Repeating
Argon2id over the same password creates cost, not independence.

**Running the pinned profile on every unlock route** was rejected because it spends memory-hard work
on independently generated 128-bit secrets without improving their guessing resistance.

**Giving recovery its own parameters** was rejected because it recreates a second migration surface
and the frozen product's cheaper route to the same Account keys.

## Consequences

A full sign-in costs one profile `0x01` run on every surface. Recovery ticket 09 must preserve the
128-bit floor for every machine-generated secret on an HKDF-only route. Conformance fixtures prove
that no route supplies its own parameters or silently selects a weaker profile.
