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
  - Ship-gates recorded in every spec: do not publish repositioned copy while [#28](https://github.com/bittery-org/bittery/issues/28) (import docs false claims) and [#37](https://github.com/bittery-org/bittery/issues/37) (fake Safari badge) are open. **Gate G3 added by the comparison spec:** the site advertises account-level 2FA (`packages/shared/src/pricing.ts:159,272`) with no implementation found anywhere in the repo, and marks "Mobile app" available on every plan while downloads say "Coming soon" — every spec that touches a feature list inherits this gate.

## Decisions so far

<!-- one line per closed ticket: gist + link to the ticket file holding the detail -->

- [Bitwarden licensing & feature facts (cited)](tickets/02-bitwarden-facts-research.md) — core claim confirmed and sharpened: Bitwarden gates paid features behind a license file tied to a cloud subscription, its SSO/SCIM server code is source-available-only; Bittery's billing code verifiably unlocks everything self-hosted. Findings on branch `research/bitwarden-facts`. Fog surfaced: stale FSL mention in `docs/design-explorations/marketing-NOTES.md`.
- [Core positioning statement & tagline](tickets/01-core-positioning-and-tagline.md) — canonical tagline: *"The open source password manager you'll actually want to open."*, used verbatim on all three surfaces, with a load-bearing supporting statement leading on the no-license-file punch. Ambition claimed as craft, not superlative; zero-knowledge merged into the open source claim rather than ranked beside it; Secret Key design drops to page-level. Identity layer = open source, craft, self-host-unlocks-everything, ZK-as-consequence.
- [Bitwarden comparison page spec](tickets/05-bitwarden-comparison-spec.md) — `docs/specs/repositioning/compare-bitwarden.md` delivered. Claim deliberately **narrowed** after a code inventory: not "Bittery has everything Bitwarden has for free", but "everything Bittery *has*, you get in full when you self-host". Bittery genuinely lacks SSO/SCIM, offline access, shipped mobile apps and store-listed extensions — all stated plainly in a three-column table with a mandatory "Where Bitwarden is ahead" section. H1 is "Bittery vs. Bitwarden" (tagline moves to the final CTA). New ship gate G3 surfaced: unbacked 2FA / mobile-app claims on the live site.
- [SEO landscape & site indexability audit](tickets/03-seo-landscape-research.md) — winning shapes per keyword identified (dedicated landing/comparison pages with tables); FAQ rich results deprecated May 2026; site's technical SEO baseline is solid, the strategic gap is exactly the keyword pages this map is specifying. Findings on branch `research/seo-landscape`.

## Not yet specified

- Internal linking strategy between the homepage, comparison page, self-hosting page, and docs.
- A final cross-spec consistency review before hand-off to execution.
- Stale FSL license mention in `docs/design-explorations/marketing-NOTES.md` (surfaced by the Bitwarden facts research) — likely a one-line fix at execution time, or a small task ticket if specs need it gone sooner.

## Out of scope

- Executing the specs (code/copy changes to the marketing app, README, repo metadata) — follow-on effort, gated on #28/#37.
- [#28](https://github.com/bittery-org/bittery/issues/28), [#37](https://github.com/bittery-org/bittery/issues/37), [#44](https://github.com/bittery-org/bittery/issues/44) themselves — independently tracked corrective work.
- **Fixing the G3 unbacked feature claims** (account-level 2FA advertised but not implemented; "Mobile app" marked available on every plan; iOS/Android listed without a "coming soon" marker) — same class as #28/#37: corrective work, not a spec. **Still needs filing as an issue** — surfaced by the comparison spec, no tracking issue exists yet.
- German / localized copy — marketing site is English-only today.
- Comparison pages beyond Bitwarden (1Password, Proton Pass, Vaultwarden, KeePass).
- Launch/announcement work (Show HN, r/selfhosted, relicense blog post) — separate future effort.
