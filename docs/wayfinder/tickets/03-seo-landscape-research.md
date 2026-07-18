---
id: 03
title: SEO landscape & site indexability audit
type: wayfinder:research
status: closed
assignee: research-subagent (charting session)
blocked-by: []
---

## Question

What does the search landscape look like for the three target keywords, and what is the current SEO state of the marketing app?

Surface:

- For "open source password manager", "bitwarden alternative", "self-hosted password manager": who ranks today, what content shapes win (listicles, head-to-head comparisons, docs), and what the search intent is per keyword.
- Structured data recommendations for a product marketing site: which schema.org types Google currently rewards (SoftwareApplication, FAQPage, Organization, BreadcrumbList) and current guidelines.
- Local audit of `apps/marketing` (TanStack Start): how meta tags/titles are set per route, what `src/routes/sitemap[.]xml.ts` emits, robots.txt, canonical URLs, whether the docs routes (`src/routes/docs`) are indexable, Open Graph/Twitter cards — inventory what exists and the gaps.

## Resolution

Findings: `docs/research/seo-landscape-and-audit.md` on branch `research/seo-landscape` (commit `50c8d54`). SERP observations flagged as approximate; every external claim cited, checked 2026-07-18. Key answers:

**Search landscape:**
- **"open source password manager"** — mixed informational/commercial intent; ~half vendor landing pages (Bitwarden has a dedicated `/open-source/` page; Psono, Passbolt, KeePass), ~half listicles (It's FOSS, Opensource.com). Evergreen depth beats freshness.
- **"bitwarden alternative"** — highest intent, near-transactional. Winners are dedicated per-competitor "alternative" pages with head-to-head comparison tables (Proton Pass's page is the template). Demand spikes when Bitwarden stumbles (2024 SDK licensing scare).
- **"self-hosted password manager"** — technical DIY intent; homelab-blog listicles, vendor on-prem pages, Docker setup tutorials. Vaultwarden dominates mindshare but has no vendor site competing in SERPs — an opening. Lowest domain-authority barrier of the three.
- **Structured data:** SoftwareApplication, Organization, BreadcrumbList still supported. **FAQ rich results fully deprecated May 7, 2026** (verified against two Google pages); HowTo and sitelinks-searchbox also dead. Self-serving review stars are policy-gray.

**Local audit:** technical baseline is solid — SSR, per-route titles/descriptions via `src/lib/seo.ts`, canonicals + `og:url`, complete sitemap, allow-all robots.txt, full OG/Twitter cards, Organization/SoftwareApplication/FAQPage JSON-LD on the homepage. Gaps by severity:
1. **High (strategic):** zero keyword-targeted content — no comparison, open-source, or self-hosting landing pages; the winning content shapes are exactly the pages we lack.
2. **Medium:** docs soft 404 — unknown `/docs/...` slugs render NotFound with HTTP 200 (`docs/$.tsx` never throws `notFound()`).
3. **Medium:** no BreadcrumbList JSON-LD despite visible breadcrumbs on docs pages.
4. **Low–medium:** sitemap lacks `<lastmod>`; SoftwareApplication markup not rich-result eligible (no rating; `offers` gated behind billing flag).
5. **Low:** FAQPage JSON-LD now dead weight; robots.txt sitemap URL hardcoded; no `twitter:site`; single site-wide OG image.

The findings file ends with a 7-item prioritized recommendation list feeding the *Site-wide SEO & structured-data spec*.
