# Bittery greenfield

The product is in specification-first reconstruction. Use Wayfinder and `grill-with-docs` to resolve
product and architecture decisions before creating specs or implementation tickets.

## Legacy evidence

`legacy/` is the frozen pre-greenfield implementation. Read it only when current behavior or prior
art is relevant. Greenfield work never modifies, imports, builds, or depends on it. Address legacy
searches explicitly because `.ignore` excludes it from default search.

## Agent skills

### Issue tracker

Issues, Wayfinder maps, specs, and tickets are version-controlled Markdown under `planning/`. See
`docs/agents/issue-tracker.md`.

### Wayfinder questions

Ask every decision question through the `AskUserQuestion` tool. Do not ask decision questions as
prose in a chat message.

Each question must stand alone. Never point back to an earlier question by number or label. Restate
the decision it builds on, in full, inside the question you ask now. The maintainer answers one
screen at a time and cannot see the earlier round.

Give each question the context needed to answer it: what is already settled, why this question
follows from it, what each option means in concrete terms, and what each option costs. Prefer more
detail over less. A question the maintainer must ask you to explain is a failed question.

### Triage labels

Local issue status uses the default Matt Pocock skill vocabulary. See
`docs/agents/triage-labels.md`.

### Domain docs

Greenfield terminology is created lazily through domain-modeling; accepted decisions live in
`docs/adr/`. Legacy vocabulary is evidence, not authority. See `docs/agents/domain.md`.

## Checks

Greenfield build and test commands will be added by an approved repository-foundation ticket. Until
then, validate documentation links and run `git diff --check` for documentation-only changes.

