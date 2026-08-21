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

Conduct Wayfinder and `grill-with-docs` sessions in German. Ask questions, explain concepts, and
discuss trade-offs with the maintainer in German. Write the resulting Wayfinder maps, decisions,
specs, tickets, ADRs, and other repository artifacts in English.

Before opening `AskUserQuestion`, give the maintainer a short primer in the chat. Name the concrete
thing being decided, define each technical or domain term, give one small example, and explain why the
choice matters in practice. State the recommendation and its main reason. Use a few short paragraphs:
enough to understand the question without the answer UI, but not a wall of text. The answer UI then
uses short labels and one concise consequence per option.

Ask every decision question through the `AskUserQuestion` tool, or the equivalent your harness
offers. A decision put as prose in a chat message has not been asked.

Each question stands alone. The maintainer answers one screen at a time and cannot see the earlier
round, so restate in full any decision this one builds on rather than naming it by number or label.

Recommend an answer. Put the option you recommend first and end its label with `(Recommended)`. When
the choice is genuinely too close to call, say so in the question and give the trade-off instead.

Use plain language. Short sentences, common words, one idea per sentence. Restate what is settled and
what each option costs: around six lines of question text and one or two sentences per option. A
question the maintainer has to read twice is a failed question.

### Maintainer communication

Lead normal answers with the direct answer, then explain the terms and reasoning needed to understand
it. Do not assume the maintainer shares the agent's internal shorthand. Translate technical terms,
large numbers, and abstract rules into their practical effect, preferably with one concrete example.
Aim for a few short paragraphs or a compact list: complete enough to follow on the first read, without
burying the answer in background material.

### Triage labels

Local issue status uses the default Matt Pocock skill vocabulary. See
`docs/agents/triage-labels.md`.

### Domain docs

Greenfield terminology is created lazily through domain-modeling; accepted decisions live in
`docs/adr/`. Legacy vocabulary is evidence, not authority. See `docs/agents/domain.md`.

## Checks

Greenfield build and test commands will be added by an approved repository-foundation ticket. Until
then, validate documentation links and run `git diff --check` for documentation-only changes.
