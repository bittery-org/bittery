# Wayfinder map: Reposition Bittery as the open source password manager

Charted from [#46 — Reposition Bittery as an open source password manager (marketing, docs, SEO)](https://github.com/bittery-org/bittery/issues/46). Label: `wayfinder:map`.

## Destination

A reviewed set of ready-to-implement, English-only copy specs (in-repo markdown under `docs/specs/repositioning/`, delivered via PR) that reposition Bittery as **the go-to open source password manager** — covering: homepage hero + value props, a new `/compare/bitwarden` page, a new `/self-hosting` marketing page, README rewrite, GitHub repo description/topics, and a site-wide SEO metadata/structured-data/indexability plan. Executing the specs is a separate follow-on effort.

## Notes

- **Tracker convention (local-markdown):** each ticket is a file in `tickets/NN-slug.md` with frontmatter `id`, `title`, `type` (`wayfinder:research|prototype|grilling|task`), `status` (`open|claimed|closed`), `assignee`, `blocked-by` (list of ids). A ticket is **claimed** by setting `status: claimed` + `assignee` before any work. The **frontier** = tickets with `status: open` whose every `blocked-by` id has `status: closed`. Resolutions are appended to the ticket file as a `## Resolution` section, then `status: closed`.
- Skills to consult per ticket type: `/grilling` + `/domain-modeling` (grilling), `/prototype` (prototype/spec tickets), `/research` (research tickets, AFK subagents).
- **Standing decisions from charting:**
  - "Can't spy on you" is fully retired (survives only in `README.md:9` and the GitHub repo description). New identity: open source + best password manager ambition + easy self-hosting.
  - Comparison target is **Bitwarden only**.
  - Keyword → page mapping: homepage = "open source password manager"; `/compare/bitwarden` = "bitwarden alternative"; `/self-hosting` = "self-hosted password manager" (the no-license-file / every-feature-self-hosted claim leads, never buried).
  - Specs are **English only** — the marketing site is EN-only today; localization is a later effort.
  - Comparison claims about Bitwarden must be **cited and dated** — the audience this attracts is exactly the audience that checks.
  - Ship-gates recorded in every spec: do not publish repositioned copy while [#28](https://github.com/bittery-org/bittery/issues/28) (import docs false claims) and [#37](https://github.com/bittery-org/bittery/issues/37) (fake Safari badge) are open.

## Decisions so far

<!-- one line per closed ticket: gist + link to the ticket file holding the detail -->

- [Bitwarden licensing & feature facts (cited)](tickets/02-bitwarden-facts-research.md) — core claim confirmed and sharpened: Bitwarden gates paid features behind a license file tied to a cloud subscription, its SSO/SCIM server code is source-available-only; Bittery's billing code verifiably unlocks everything self-hosted. Findings on branch `research/bitwarden-facts`. Fog surfaced: stale FSL mention in `docs/design-explorations/marketing-NOTES.md`.
- [SEO landscape & site indexability audit](tickets/03-seo-landscape-research.md) — winning shapes per keyword identified (dedicated landing/comparison pages with tables); FAQ rich results deprecated May 2026; site's technical SEO baseline is solid, the strategic gap is exactly the keyword pages this map is specifying. Findings on branch `research/seo-landscape`.

## Not yet specified

- Whether the download, about, and existing docs pages need copy alignment with the new positioning — depends on the tagline/positioning outcome.
- Internal linking strategy between the homepage, comparison page, self-hosting page, and docs.
- A final cross-spec consistency review before hand-off to execution.
- Stale FSL license mention in `docs/design-explorations/marketing-NOTES.md` (surfaced by the Bitwarden facts research) — likely a one-line fix at execution time, or a small task ticket if specs need it gone sooner.

## Out of scope

- Executing the specs (code/copy changes to the marketing app, README, repo metadata) — follow-on effort, gated on #28/#37.
- [#28](https://github.com/bittery-org/bittery/issues/28), [#37](https://github.com/bittery-org/bittery/issues/37), [#44](https://github.com/bittery-org/bittery/issues/44) themselves — independently tracked corrective work.
- German / localized copy — marketing site is English-only today.
- Comparison pages beyond Bitwarden (1Password, Proton Pass, Vaultwarden, KeePass).
- Launch/announcement work (Show HN, r/selfhosted, relicense blog post) — separate future effort.
