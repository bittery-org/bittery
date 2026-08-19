# Domain docs

Read Bittery's domain documentation before exploring or changing product behavior.

## Sources

- `CONTEXT.md` is the product glossary and canonical vocabulary.
- `docs/adr/` contains accepted system decisions. Read the records relevant to the area being
  explored.
- Follow focused context pointers from the root glossary and relevant ADRs. In particular,
  `packages/storage/CONTEXT.md` explains storage policy and `packages/crypto/port/CONTEXT.md`
  explains the current crypto seam.

If a referenced document does not exist, proceed silently. Domain-modeling creates terminology and
ADRs lazily when a real decision resolves them.

## Vocabulary

Use the glossary's canonical term in maps, tickets, specs, implementation names, tests, and user
conversation. Avoid synonyms that `CONTEXT.md` explicitly rejects.

When a required concept is absent, either the proposed language does not belong to Bittery or the
glossary has a real gap. Resolve that through domain-modeling instead of inventing parallel terms.

## Decisions

Surface any conflict with an existing ADR explicitly. Reopen or supersede the decision deliberately;
implementation work does not silently override it.

The greenfield rebuild is allowed to differ from the frozen current product, but candidate design
notes are not accepted ADRs. Wayfinder resolution, glossary updates, and later specs keep those roles
separate.
