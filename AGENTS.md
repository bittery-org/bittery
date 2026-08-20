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

Ask every decision question through the `AskUserQuestion` tool, or the equivalent your harness
offers. A decision put as prose in a chat message has not been asked.

Each question stands alone. The maintainer answers one screen at a time and cannot see the earlier
round, so restate in full any decision this one builds on rather than naming it by number or label.

Recommend an answer. Put the option you recommend first and end its label with `(Recommended)`. When
the choice is genuinely too close to call, say so in the question and give the trade-off instead.

Write plain English. Short sentences, common words, one idea per sentence. Explain a technical term
the first time it appears in a round. Say what is settled, what the choice is, and what each option
costs, then stop: around six lines of question text, and one or two sentences per option. A question
the maintainer has to read twice is a failed question.

### Triage labels

Local issue status uses the default Matt Pocock skill vocabulary. See
`docs/agents/triage-labels.md`.

### Domain docs

Greenfield terminology is created lazily through domain-modeling; accepted decisions live in
`docs/adr/`. Legacy vocabulary is evidence, not authority. See `docs/agents/domain.md`.

## Checks

Greenfield build and test commands will be added by an approved repository-foundation ticket. Until
then, validate documentation links and run `git diff --check` for documentation-only changes.

