---
id: 01
title: Core positioning statement & tagline
type: wayfinder:grilling
status: closed
assignee: Julian Sigmund
blocked-by: []
---

## Question

What is Bittery's new core positioning statement and tagline, now that "The password manager that can't spy on you" is retired?

Decide, via `/grilling` + `/domain-modeling` (drafting candidate taglines to react to is encouraged):

- The one-line tagline (GitHub repo description, README headline, homepage hero) — must center **open source**, the ambition to be the best password manager, and easy self-hosting.
- The supporting positioning statement: how the pillars rank (open source → trust/verifiability, self-host unlocks everything, zero-knowledge encryption, ease of use).
- The messaging boundary: which claims are identity-level vs. page-level proof points.

This blocks every page spec — the homepage, comparison page, self-hosting page, and README specs all inherit its language.

## Resolution

Resolved by `/grilling` session, 2026-07-18.

### Canonical tagline

> The open source password manager you'll actually want to open.

**Used verbatim on all three surfaces** — GitHub repo description, README headline, homepage hero. Downstream specs **quote** this string; they do not re-phrase it.

### Supporting positioning statement

> Self-host Bittery and every feature unlocks — no license file, no subscription, no tiers. It's open source end to end, so the zero-knowledge encryption isn't a promise you have to trust; it's code you can read.

The supporting statement is **load-bearing, not decorative**: the tagline is deliberately soft (see decision 2), so the differentiation lives here. Any surface that carries the tagline should carry this statement — or a surface-appropriate variant of it — directly beneath.

### Messaging boundary

**Identity-level** (appears on every surface):

1. Open source (AGPLv3 server / GPLv3 clients, no proprietary carve-out)
2. The craft / ambition claim
3. Self-hosting unlocks every feature — no license file, no subscription, no tiers
4. Zero-knowledge encryption **as a consequence of** open source, never as a standalone badge

**Page-level proof points** (used where relevant; never promoted into the tagline): the two-key / Secret Key design, the Rust crypto core, cross-platform coverage, sharing & secure links, AGPL-vs-`bitwarden_license/` specifics, deployment mechanics.

### Decisions and rationale

1. **Audience** — mainstream privacy-conscious searcher is primary; the self-hoster / FOSS-native is a loud secondary. The contrast job belongs to `/compare/bitwarden` and the deployment job to `/self-hosting`, which frees the tagline to do identity work only. Writing the tagline at the self-hoster would make the front door read as infrastructure software and cede the mainstream search intent the map targets.
2. **Ambition register — craft, not superlative.** A bare "best password manager" is the one claim on the site that cannot be cited, sitting directly above a comparison page that scrupulously sources everything else. Craft language also attacks the category's real weakness (open source password managers feel like infrastructure) and preserves the equity in the existing hero's register.
3. **Self-hosting is not in the tagline** — it leads the supporting statement instead. Three claims overflow the GitHub repo description surface, and a soft craft line followed immediately by a hard verifiable fact is a stronger one-two than either half alone. This does **not** conflict with the map's "no-license-file claim leads, never buried" rule, which is scoped to the `/self-hosting` page.
4. **Zero-knowledge is merged into the open source claim**, not ranked beside it. Every competitor claims both; stating that open source is *what makes the zero-knowledge claim checkable* converts two generic badges into one argument. Accepted cost: the Secret Key / two-key design — the strongest pure-security differentiator — drops firmly to page-level.
5. **One canonical string, not per-surface variants.** Strategic: repetition builds recognition. Operational: four downstream specs inherit this language across four separate sessions, and a canonical string makes them mechanical rather than interpretive, which is where drift would otherwise creep in. Constraint accepted: the tagline must work as plain text, with no reliance on line breaks or typographic emphasis.

### Consequences for downstream specs

- **Accepted trade-off:** the tagline is *not* differentiated when it travels alone (a badge, a tweet, a directory listing). Differentiation is carried by the supporting statement. Specs should avoid surfaces where the tagline appears stripped of its supporting line.
- **Factual staleness to fix (independent of repositioning, both now wrong post-relicense #45):**
  - `README.md:1` — H1 reads "Bittery — Zero-Knowledge Password Manager"; `README.md:7` calls Bittery "source-available". Owned by the **README & repo metadata spec**. Decision 4 resolves the H1.
  - `apps/marketing/src/components/landing/hero.tsx:6-10` — trust strip reads `Zero-knowledge encryption · Source-available · Self-hostable`. "Source-available" is factually wrong. Owned by the **Homepage copy spec**.
- The homepage hero currently gradient-emphasises a single word ("redesigned"). Per decision 5 the new tagline must read correctly without that treatment; emphasis is optional styling, not load-bearing.
