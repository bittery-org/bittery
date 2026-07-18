---
id: 09
title: Secondary pages copy-alignment spec
type: wayfinder:prototype
status: open
assignee:
blocked-by: [04]
---

## Question

Which existing marketing surfaces beyond the three keyword pages need copy alignment with the new positioning, and what should change on each? Produce `docs/specs/repositioning/secondary-pages.md`.

The positioning is now fixed by *Core positioning statement & tagline*: canonical tagline used verbatim, identity layer = open source / craft / self-host-unlocks-everything / zero-knowledge-as-consequence, with the Secret Key design and other proof points demoted to page-level. This spec applies that boundary to everything the homepage, comparison, self-hosting and README specs don't already own.

Covers:

- Inventory the affected surfaces — the download and about pages, the docs landing/overview under `apps/marketing/src/content/docs`, the footer, and any shared components carrying identity copy.
- Flag every remaining instance of retired or now-false language: "can't spy on you", "source-available" (factually wrong post-relicense #45), and zero-knowledge framed as a standalone badge rather than as a consequence of open source.
- Per surface: what changes, what stays, and whether it carries the tagline, the supporting statement, both, or neither.
- Include the #28/#37 ship-gate note.

Blocked on the homepage spec because the secondary pages align to how the identity language reads *in practice* there — not just to the abstract decisions.
