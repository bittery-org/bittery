---
id: 05
title: Bitwarden comparison page spec
type: wayfinder:prototype
status: closed
assignee: Julian Sigmund
blocked-by: [01, 02]
---

## Question

What should the new `/compare/bitwarden` page say? Produce `docs/specs/repositioning/compare-bitwarden.md` — a ready-to-implement copy spec targeting **"bitwarden alternative"**.

Every claim about Bitwarden must come from the cited facts in *Bitwarden licensing & feature facts (cited)* — scrupulously accurate, with citations preserved in the spec. Lead with the sharpest verifiable contrast: self-hosted Bittery unlocks every feature with no license file and no subscription; Bitwarden requires a paid license file for premium/enterprise features (incl. SSO) on your own hardware. Cover: page structure, feature comparison table, license comparison (AGPL/GPL no carve-out vs. proprietary `bitwarden_license/`), honest "where Bitwarden is ahead" section, CTA, title/meta. Include the #28/#37 ship-gate note.

## Resolution

Spec delivered: `docs/specs/repositioning/compare-bitwarden.md`. Resolved 2026-07-18.

### The central decision: the claim had to be narrowed

A code inventory run while writing the spec established that the obvious comparison — "Bitwarden charges for features, we don't" — is true but **incomplete in ways that would discredit the page**. Verified in this repo: Bittery has **no SSO, no SCIM, no directory sync** (absent, not gated — zero hits across `apps/server/src` and `apps/web/src`), **no offline access** (the product's own FAQ says the vault needs a connection, `faq-section.tsx:38`), **no released mobile apps**, and **no store-listed extensions** (sideloaded `.zip`). Bitwarden has all of these, plus published third-party audits.

So the page's claim is scoped to what is actually defensible:

> **Not** "Bittery has everything Bitwarden has, for free."
> **But** "everything Bittery has, you get in full when you self-host — no license file, no subscription, no proprietary directory."

Every section is written to that sentence. This is the spec's load-bearing decision; the alternative version converts worse on this specific keyword, because the "bitwarden alternative" searcher is a Bitwarden user who will check.

### Other decisions

- **H1 is "Bittery vs. Bitwarden", not the canonical tagline** — this page's H1 carries the comparison keyword; the tagline appears once, verbatim, in the final CTA, doing identity work rather than SERP work.
- **Precision preserved from the research:** copy says *paid features* require a license file tied to a cloud subscription — never "self-hosting requires a license file", which is false and the likeliest sentence to sink the page's credibility.
- **Three-column feature table** (Bittery self-hosted / Bitwarden self-hosted free / Bitwarden self-hosted licensed) — two columns would either overstate the free tier or understate the license requirement. The argument lands visually: the middle column is sparse, the right column is full *and* priced.
- **Losing rows stay in place**, grouped by capability area, not sorted to the bottom. A "Where Bitwarden is ahead" prose section is mandatory and ends with "If any of those is a requirement, use Bitwarden — genuinely."
- **No `FAQPage` markup** (rich results dead since 2026-05-07); `BreadcrumbList` only. No `Product`/`Review`/`aggregateRating` — self-published ratings are policy-gray and worst on this page.
- **Built to be correct with the billing flag off** — self-hosted-vs-self-hosted throughout, which is the stronger comparison anyway.
- **"Source-available" is used deliberately on the Bitwarden side only** — it is correct for `bitwarden_license/` and factually wrong for Bittery post-relicense (#45).

### New ship gate surfaced (G3) — unbacked feature claims on the marketing site

Beyond the known #28/#37 gates, three claims on the live site are contradicted by this spec's own feature table and must be resolved before publishing:

- `packages/shared/src/pricing.ts:159,272` advertises **account-level two-factor authentication** on all plans including Free. No implementation found — a repo-wide grep for `two_factor|twoFactor|webauthn|WebAuthn` across `apps/server/src`, `apps/web/src` and `packages/shared/src` returns **zero files**. Either it lives somewhere not yet located, or the claim is false.
- `packages/shared/src/pricing.ts:228` marks **"Mobile app" ✅ on every plan**; `download.tsx:97-112` says "Coming soon".
- `bento-grid.tsx:375-382` lists **iOS and Android with no "coming soon" marker**.

Also flagged (not a gate, but required for the page to be findable): `/compare/bitwarden` must be added by hand to `STATIC_ROUTES` in `sitemap[.]xml.ts:5-13` — nested routes are not picked up automatically.

### Open questions left for the human

Five reversible judgment calls are listed at the end of the spec: no `/compare` hub page; three-column vs. two-column table; the self-deprecating register in the "should you switch" sections; including Travel Mode as a differentiator row; and including exact dated prices (which creates a quarterly recheck obligation).
