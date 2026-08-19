# Bittery greenfield

The product is in specification-first reconstruction. Use Wayfinder and `grill-with-docs` to resolve
product and architecture decisions before creating specs or implementation tickets.

## Legacy evidence

`legacy/` is the frozen pre-greenfield implementation. Read it only when current behavior or prior
art is relevant. Greenfield work never modifies, imports, builds, or depends on it. Address legacy
searches explicitly because `.ignore` excludes it from default search.

## Agent skills

### Issue tracker

Issues, Wayfinder maps, specs, and tickets are private local Markdown under `.scratch/`. See
`docs/agents/issue-tracker.md`.

### Triage labels

Local issue status uses the default Matt Pocock skill vocabulary. See
`docs/agents/triage-labels.md`.

### Domain docs

Greenfield terminology is created lazily through domain-modeling; accepted decisions live in
`docs/adr/`. Legacy vocabulary is evidence, not authority. See `docs/agents/domain.md`.

## Checks

Greenfield build and test commands will be added by an approved repository-foundation ticket. Until
then, validate documentation links and run `git diff --check` for documentation-only changes.

