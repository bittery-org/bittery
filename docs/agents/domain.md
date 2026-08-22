# Domain documentation

Read `CONTEXT.md` before exploring or changing product behavior. It is the canonical product glossary.
Focused context documents beside storage, crypto, or another deep module explain that module's
machinery. Accepted cross-module decisions live in `docs/adr/`.

Use the glossary's canonical terms in maps, specifications, tickets, code, tests, UI copy, and
maintainer conversation. When a needed concept has no accepted name, use domain-modeling to add one
instead of creating synonyms in implementation.

Surface conflicts with an ADR explicitly. Amend or supersede the decision before implementation;
code does not silently override it. The `greenfield` branch and historical design notes are evidence,
not accepted decisions on this branch.
