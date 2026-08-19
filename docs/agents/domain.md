# Domain docs

Read Bittery's greenfield domain documentation before exploring or changing product behavior.

## Sources

- `CONTEXT.md`, once domain-modeling creates it, is the greenfield product glossary and canonical
  vocabulary.
- `docs/adr/`, once decisions warrant it, contains accepted greenfield system decisions.
- `legacy/CONTEXT.md`, `legacy/docs/adr/`, and focused legacy context documents are evidence about
  the previous product. They do not govern the greenfield design.

If a referenced document does not exist, proceed silently. Domain-modeling creates terminology and
ADRs lazily when a real decision resolves them.

## Vocabulary

Use the greenfield glossary's canonical term in maps, tickets, specs, implementation names, tests,
and user conversation. Avoid synonyms that `CONTEXT.md` explicitly rejects.

When a required concept is absent, either the proposed language does not belong to Bittery or the
glossary has a real gap. Resolve that through domain-modeling instead of inventing parallel terms.

## Decisions

Surface any conflict with an existing ADR explicitly. Reopen or supersede the decision deliberately;
implementation work does not silently override it.

Candidate design notes and legacy ADRs are not accepted greenfield ADRs. Wayfinder resolution,
glossary updates, and later specs keep those roles separate.
