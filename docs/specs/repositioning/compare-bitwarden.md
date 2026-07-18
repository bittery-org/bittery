# Copy spec — `/compare/bitwarden`

**Status:** ready to implement, **gated** (see [Ship gates](#ship-gates) — this page must not ship first).
**Target keyword:** "bitwarden alternative" (highest-intent of the three keywords in this effort).
**Wayfinder ticket:** [05 — Bitwarden comparison page spec](../../wayfinder/tickets/05-bitwarden-comparison-spec.md).
**Language:** English only.

Source material, all dated **2026-07-18**:

- Bitwarden + Bittery licensing facts: `docs/research/bitwarden-licensing-facts.md` on branch `research/bitwarden-facts` (commit `2c0987c`). **Every claim about Bitwarden on this page traces to that file.**
- SERP landscape: `docs/research/seo-landscape-and-audit.md` on branch `research/seo-landscape` (commit `50c8d54`).
- Positioning: [ticket 01 — Core positioning statement & tagline](../../wayfinder/tickets/01-core-positioning-and-tagline.md).

---

## 0. The honest-scope problem (read before writing any copy)

The obvious comparison page — "Bitwarden makes you pay for features; we don't" — is **true but incomplete**, and shipping the incomplete version on the one page whose entire value is credibility would be self-defeating. The audience for "bitwarden alternative" is the audience that checks.

What the code inventory established:

- **Bittery has no SSO, no SCIM, no directory sync.** Not gated — absent. So "Bitwarden charges for SSO on your own hardware" cannot be answered with "ours is free"; the honest answer is "we don't have it yet."
- **Bittery has no offline access.** The product's own FAQ says the vault needs a connection to unlock (`apps/marketing/src/components/landing/faq-section.tsx:38`). Bitwarden works offline. This is a real, user-visible loss for the exact self-hoster this page attracts.
- **Bittery's mobile apps are not released** (`apps/marketing/src/routes/download.tsx:97-112` — "Coming soon"), and the browser extension ships as a sideloaded `.zip` rather than store listings (`download.tsx:114-146`).
- **Bitwarden has published third-party security audits and a decade of operation.** Bittery has neither.

Therefore the page's claim is scoped precisely, and this scoping is the spec's central instruction:

> **The claim is not "Bittery has everything Bitwarden has, for free."
> The claim is "everything Bittery has, you get in full when you self-host — no license file, no subscription, no proprietary directory."**

Write every section to that sentence. A reader who leaves believing Bittery is a drop-in replacement for an enterprise Bitwarden deployment has been misled, and will say so publicly.

---

## 1. Route, metadata, and structured data

**Route:** `apps/marketing/src/routes/compare/bitwarden.tsx`, `createFileRoute("/compare/bitwarden")`. No `compare/index.tsx` hub for now — one comparison page doesn't need an index, and an empty hub is a thin-content liability. (Revisit if a second comparison page is ever specced; competitor pages beyond Bitwarden are explicitly out of scope for this effort.)

**Sitemap:** add `/compare/bitwarden` to the hardcoded `STATIC_ROUTES` array in `apps/marketing/src/routes/sitemap[.]xml.ts:5-14`. It will **not** be picked up automatically. This is a required part of shipping the page, not a follow-up.

**Meta**, via the shared `seo()` helper (`apps/marketing/src/lib/seo.ts`):

- **Title:** `Bittery vs. Bitwarden — an open source Bitwarden alternative`
  (58 chars. Leads with the head-to-head form that wins this SERP, carries the exact keyword phrase without reading as keyword stuffing.)
- **Description:** `Self-host Bittery and every feature unlocks — no license file, no subscription. Bitwarden gates premium and SSO behind a paid cloud license. An honest, cited comparison.`
  (167 chars. "Honest" and "cited" are the differentiator against the affiliate listicles that dominate this query.)
- **OG image:** default `/og-image.png` for launch. A per-page comparison OG image is a nice-to-have, not a blocker.

**Structured data** (appended alongside the `seo()` spread, following the pattern at `apps/marketing/src/routes/index.tsx:19-70`):

- **`BreadcrumbList`** — `Home → Compare → Bittery vs. Bitwarden`. Supported, cheap, and this page is the site's first genuinely nested route.
- **Do not add `FAQPage` markup.** FAQ rich results were fully removed from Google Search on 2026-05-07 and the documentation was deleted 2026-06-15. On-page FAQ *content* stays (it earns long-tail and AI-answer surface); the markup earns nothing. The existing homepage `FAQPage` block is separately flagged for removal in the site-wide SEO spec — do not copy the pattern here.
- **Do not add `Product`, `Review`, or `aggregateRating` markup.** Self-published ratings about your own product are policy-gray, and doing it on the page that stakes everything on honesty is a bad trade.

---

## 2. Page structure

Ordered top to bottom. The shape follows the template that wins this query (a dedicated head-to-head page anchored by one large comparison table), with one deliberate departure: an unflinching "where Bitwarden is ahead" section, which the affiliate pages do not have and which is this page's actual competitive advantage.

| # | Section | Job |
|---|---|---|
| 1 | Hero | Name the comparison, land the license-file contrast in two lines |
| 2 | The short answer | Let a scanner leave in 20 seconds with the correct impression, including the caveats |
| 3 | The license-file difference | The core argument, cited |
| 4 | Feature comparison table | The scannable artifact this SERP expects |
| 5 | Where Bitwarden is ahead | Credibility. Non-negotiable |
| 6 | Who should switch / who shouldn't | Convert the right reader, repel the wrong one |
| 7 | Migration | Remove the switching cost objection |
| 8 | FAQ | Long-tail + objection handling |
| 9 | Final CTA | Convert |

---

## 3. Section-by-section copy

### 3.1 Hero

**H1:** `Bittery vs. Bitwarden`

**Subline (H2 or lead paragraph):**

> Bitwarden is a good password manager. Its premium and enterprise features, though — including SSO — need a paid license file issued by a bitwarden.com subscription, even when you run it on your own server. Bittery works the other way around: self-host it and everything unlocks.

**Note on the tagline.** The canonical tagline — *"The open source password manager you'll actually want to open."* — is **not** the H1 here. Ticket 01 fixes it for the GitHub repo description, the README headline, and the homepage hero; this page's H1 must carry the comparison keyword. Use the tagline once, lower on the page, in the final CTA (§3.9), where it does identity work rather than SERP work.

**CTA buttons:** primary = self-host (deep-link to `/docs/self-hosting/overview`), secondary = the comparison table anchor. Deliberately *not* signup-first: this reader is evaluating, not converting, and self-hosting is the differentiated offer. If `billingMarketingEnabled()` is false, the cloud CTA anywhere on this page must read "Join the waitlist" (see §6).

**Opening with a concession is intentional.** "Bitwarden is a good password manager" costs nothing — the reader already believes it, they're a user — and buys the credibility that makes the following sentence land. A page that opens by attacking Bitwarden reads as marketing and gets discounted wholesale.

### 3.2 The short answer

A boxed summary directly under the hero, three bullets. Most of this SERP's traffic will read only this.

> **The short answer**
>
> - **Self-hosted Bittery has every feature, with no license file, no subscription, and no cloud account.** Self-hosted Bitwarden is free for its free tier; premium and organization features require a license file generated by a paid subscription on Bitwarden's cloud.
> - **Bittery is open source end to end** — AGPLv3 server, GPLv3 clients, no proprietary directory. Bitwarden's SSO and SCIM server code sits in a `bitwarden_license/` directory under a source-available license that permits production use only with a paid subscription.
> - **Bitwarden is more mature.** It has mobile apps, offline access, store-listed extensions, published third-party audits, and enterprise features Bittery hasn't built. If you need SSO, you need Bitwarden.

That third bullet stays in the summary box. Burying it lower would be exactly the manipulation this page is trying not to commit.

### 3.3 The license-file difference

**H2:** `The license-file difference`

Prose, 3–4 short paragraphs. Every factual sentence carries a citation (§5).

Content to cover, in order:

1. **The mechanism, stated precisely.** Self-hosting Bitwarden's server is free, and the free tier genuinely needs no license. But to use paid features on hardware you own, you first start a subscription on Bitwarden's cloud, then download a license file and upload it to your own instance. For an organization, the org must be **created in Bitwarden's cloud first**, and the license is bound to your server's installation ID.
   **Do not write "self-hosting Bitwarden requires a license file."** It's false, and it's the single most likely sentence to get this page discredited. The accurate claim — *paid features* require a license tied to a cloud subscription — is sharper anyway.
2. **The license expires.** Licenses must be re-uploaded on renewal and when seat counts change; an organization is disabled after a 60-day grace window. The self-hosted instance depends on a continuing cloud relationship.
3. **Teams organizations cannot self-host at all** — only Families and Enterprise licenses can be imported. Worth its own sentence; it's concrete, surprising, and verifiable.
4. **The Bittery side, verifiable in code.** Self-hosted mode is one environment variable (`BITTERY_MODE=self-hosted`). Every feature entitlement returns true and every quota returns unlimited, before any plan or subscription logic runs. There is no license file, no installation ID, and no call to a licensing server anywhere in the path. **Link to the exact source lines on GitHub** (`apps/server/src/services/billing/mod.rs`, `resolve_effective_entitlements`) — the whole point is that the reader can check it, so make checking a one-click action.

Then the framing sentence that ties it to the positioning:

> That's what open source is for here. You don't have to take the encryption claims on trust — the code that decides what you're allowed to use is the same code you can read.

### 3.4 Feature comparison table

**H2:** `Feature by feature`

Build on `apps/marketing/src/components/landing/pricing-comparison.tsx`, which already renders a feature matrix. Three columns:

| | **Bittery (self-hosted)** | **Bitwarden (self-hosted, free)** | **Bitwarden (self-hosted, licensed)** |

Three columns rather than two is the honest structure: collapsing Bitwarden into one column would either overstate the free tier's limits or understate the license requirement. It also makes the argument visually, without a word of copy — the middle column is sparse, the right column is full *and* has a price attached.

**Rows** (✅ / ❌ / short text; every Bitwarden cell traceable to the research file):

| Row | Bittery self-hosted | BW self-hosted free | BW self-hosted licensed |
|---|---|---|---|
| Cost to unlock all available features | Free | — | Paid cloud subscription |
| License file required | No | No | Yes — tied to a cloud subscription |
| Cloud account required to self-host | No | No | Yes — org created in Bitwarden's cloud |
| Server license | AGPLv3, no carve-out | AGPLv3 core + source-available `bitwarden_license/` | Same |
| Client licenses | GPLv3 | GPLv3 core | Same |
| Unlimited items and devices | ✅ | ✅ | ✅ |
| Logins, notes, cards, identities | ✅ | ✅ | ✅ |
| Built-in TOTP authenticator | ✅ | ❌ | ✅ |
| File attachments | ✅ | ❌ | ✅ |
| Password health dashboard | ✅ | ❌ | ✅ |
| Vault sharing / shared vaults | ✅ Unlimited | Limited (free org: 2 users, 2 collections) | ✅ |
| Secure share links | ✅ | ❌ | ✅ (Send — free tier is text-only) |
| Team management & audit log | ✅ | ❌ | ✅ |
| Travel Mode | ✅ | ❌ | ❌ |
| Passkeys | ✅ | ✅ | ✅ |
| Autofill (browser extension) | ✅ | ✅ | ✅ |
| Import from 1Password, Bitwarden, LastPass | ✅ | ✅ | ✅ |
| **Offline vault access** | ❌ | ✅ | ✅ |
| **iOS and Android apps** | Coming soon | ✅ | ✅ |
| **Extensions in browser stores** | ❌ Sideloaded | ✅ | ✅ |
| **SSO (SAML/OIDC)** | ❌ Not available | ❌ | ✅ Enterprise license |
| **SCIM / directory sync** | ❌ Not available | ❌ | ✅ Enterprise license |
| **Emergency access (trusted contact)** | ❌ | ❌ | ✅ Premium |
| **Published third-party audit** | ❌ Not yet | ✅ | ✅ |
| Account recovery kit | ✅ | ❌ | ✅ (account recovery, Enterprise) |

**Implementation rules for this table — all load-bearing:**

- **Do not sort the losing rows to the bottom** and do not visually de-emphasize them. Group by capability area (core vault → sharing & teams → platforms → enterprise → assurance) so the ❌ rows sit where a reader naturally expects them. A table that has been arranged to flatter is legible as such.
- **Bittery's "Emergency access" row must say ❌.** `packages/shared/src/pricing.ts:167` advertises "Emergency Kit & Recovery" — that is the Recovery Kit (self-recovery via Secret Key), *not* Bitwarden-style trusted-contact emergency access. Do not conflate them; they are different features and a reader who has used Bitwarden's will notice immediately.
- **Do not add an account-level 2FA row.** See ship gate G3 — the site currently advertises it and the implementation could not be found. Until that's resolved, the row cannot be filled in honestly in either direction, so it stays off the table.
- Bitwarden's Send-vs-share-links equivalence is close but not exact (free-tier Send is text-only, no file sends). Keep the parenthetical.
- Every Bitwarden ❌/✅ needs a citation anchor (§5). Bittery cells are verifiable in the repo and need no citation, but the self-hosted-unlocks-everything claim should link the billing source line.

### 3.5 Where Bitwarden is ahead

**H2:** `Where Bitwarden is ahead`

Prose, not a table — a table here would read as a checklist to be minimized, and prose signals the concession is meant.

Cover, without softening:

- **Offline access.** Bitwarden unlocks and works without a connection. Bittery needs one. If you want a vault that survives your network being down, that's a real reason to stay.
- **Mobile.** Bitwarden's iOS and Android apps ship today. Bittery's don't yet.
- **Distribution.** Bitwarden's extensions are in the Chrome, Firefox, and Edge stores. Bittery's is a sideloaded package right now.
- **Enterprise features.** SSO, SCIM, and directory sync exist in Bitwarden. Bittery hasn't built them. Bitwarden charges for them; we don't have them. Those aren't the same thing, and we're not going to pretend they are.
- **Track record.** Bitwarden has years of operation and published third-party security audits. Bittery is new. Youth is not a security property.

Close the section:

> If any of those is a requirement, use Bitwarden — genuinely. This page is here to help you decide, not to win.

That last sentence is the most valuable one on the page for the audience it targets, and it should not be cut for being off-message. It *is* the message.

### 3.6 Who should switch — and who shouldn't

**H2:** `Should you switch?`

Two short lists, side by side, equal visual weight.

**Switch to Bittery if:**
- You want to self-host and have every feature, without a subscription or a license file
- You want the whole thing open source, with no proprietary directory
- You're an individual, a family, or a small team on desktop and the web
- You'd rather read the code than trust a promise

**Stay with Bitwarden if:**
- You need offline access
- Mobile apps are essential to your daily use
- You need SSO, SCIM, or directory sync
- You need a published third-party audit and a long operating history

### 3.7 Migration

**H2:** `Moving your vault`

Short. Bittery imports Bitwarden's JSON and CSV exports; link the import documentation.

> ⚠️ **Blocked on ship gate G1.** Open issue [#28](https://github.com/bittery-org/bittery/issues/28) reports false claims in the import documentation. This section drives readers straight into those docs, and it is the section a switching reader trusts most. Do not write or ship it until #28 is resolved, then describe **only** what the verified importer actually supports.

### 3.8 FAQ

On-page content only, no `FAQPage` markup (§1). Suggested questions:

- **Is Bittery a Bitwarden fork?** No — a separate codebase (Rust server, own clients). It imports Bitwarden exports; it is not Vaultwarden.
- **Is Bitwarden not open source?** Its core is AGPLv3 and genuinely open source. The commercial modules — including the SSO and SCIM server code — are in `bitwarden_license/` under a source-available license that permits production use only with a paid subscription. Bittery has no such directory.
- **What's the catch with self-hosting Bittery for free?** You run and back up the server. Bittery's business model is the hosted service; the self-hosted build isn't a crippled edition of it.
- **How do I know self-hosted really unlocks everything?** Read the entitlement function — link it.
- **Can I use Bittery with Vaultwarden?** No. Different servers, different protocols; Vaultwarden is a Bitwarden-compatible server, Bittery is its own stack.

The Vaultwarden question is worth including even though Vaultwarden is out of scope as a *comparison target*: the reader searching "bitwarden alternative" who self-hosts is very likely to arrive already knowing Vaultwarden, and answering it pre-empts the top comment on any thread where this page gets posted.

### 3.9 Final CTA

Reuse `FinalCta` (`apps/marketing/src/components/landing/final-cta.tsx`). This is where the canonical tagline appears, once:

> **The open source password manager you'll actually want to open.**
>
> Self-host it and every feature unlocks — no license file, no subscription, no tiers. It's open source end to end, so the zero-knowledge encryption isn't a promise you have to trust; it's code you can read.

Both strings are quoted verbatim from ticket 01. Do not re-phrase them; four specs inherit this language and the value is in it being identical everywhere.

Primary CTA: self-hosting docs. Secondary: GitHub repository. Cloud signup only if `billingMarketingEnabled()` (§6).

---

## 4. Voice

- **Concede early and specifically.** Every concession is credibility spent on the claims that matter.
- **Never write a superlative about Bittery.** Per ticket 01 decision 2, the ambition is expressed as craft, not ranking — and on a cited comparison page an uncitable claim is a stain on the cited ones.
- **Prefer mechanism to adjective.** "Your organization must be created in Bitwarden's cloud first" beats "Bitwarden's self-hosting is restrictive."
- **Never characterize Bitwarden's motives.** State what the license says and let the reader draw conclusions. This is also the only version that stays accurate if Bitwarden changes its terms.
- **Zero-knowledge is a consequence of open source**, never a standalone badge (ticket 01, decision 4).
- **Never use "source-available" about Bittery.** It's factually wrong post-relicense (#45). It is the correct word for Bitwarden's `bitwarden_license/` modules — that asymmetry is precisely the point, so use it deliberately on one side only.

---

## 5. Citation requirements

This page's only durable asset is that it's checkable. Non-negotiable:

1. **Every claim about Bitwarden carries an inline source link**, to Bitwarden's own documentation or repository — never to a third-party listicle. The needed URLs are in `docs/research/bitwarden-licensing-facts.md` §1–§3.
2. **A visible "Bitwarden facts verified on <date>" line** near the comparison table, with the date the claims were last checked. Facts as of **2026-07-18** at time of writing.
3. **A stated recheck cadence.** Bitwarden's pricing and licensing terms change; a stale comparison page is worse than none. Recommend quarterly, with the date line updated on every check whether or not anything changed.
4. **Prices carry their as-of date** (Premium $19.80/yr, Enterprise $6/user/mo, checked 2026-07-18). If keeping prices current is not realistic, omit exact prices and say "a paid subscription" — an out-of-date price is the most citable kind of error.
5. **The two marketing-safe formulations** at the end of the research file are cleared for verbatim use.

---

## 6. Billing-flag behavior

The pricing section and hero CTA are gated behind `VITE_BILLING_MARKETING_ENABLED` (`apps/marketing/src/lib/urls.ts:33-36`); when off, the homepage shows a waitlist and the FAQ states that paid subscriptions aren't being sold yet. This page must respect that:

- **Flag off:** no Bittery cloud prices anywhere. Cloud CTAs read "Join the waitlist." The comparison stays self-hosted-vs-self-hosted throughout — which is the stronger comparison regardless, and the one the target keyword wants.
- **Flag on:** a cloud pricing row may be added to the table. Bittery's cloud prices then appear alongside Bitwarden's, with both dated.

The self-hosted columns are the page's spine and do not depend on the flag. Build the page so it is correct and complete with the flag off.

---

## Ship gates

**Do not publish this page while any of these is open.** This page invites scrutiny of exactly the claims below; publishing it first turns fixable inaccuracies into a public credibility problem on the page least able to absorb one.

- **G1 — [#28](https://github.com/bittery-org/bittery/issues/28), false claims in import docs.** The migration section (§3.7) points readers directly at these docs. Hard blocker.
- **G2 — [#37](https://github.com/bittery-org/bittery/issues/37), fake Safari badge.** A page arguing that we're the honest option cannot coexist with a "Mac App Store" Safari card for an extension that doesn't exist (`apps/marketing/src/routes/download.tsx:133-139`). Hard blocker.
- **G3 — Unbacked feature claims on the marketing site (new; surfaced while writing this spec).** File as an issue and resolve before publishing:
  - `packages/shared/src/pricing.ts:158-165,272` advertises **account-level two-factor authentication** on all plans including Free. No implementation was found in `apps/server/src/services/auth.rs` or the web app. Either it exists somewhere not yet located, or the claim is false and must be removed.
  - `packages/shared/src/pricing.ts:227-230` marks **"Mobile app" ✅ on every plan** while `apps/marketing/src/routes/download.tsx:97-112` says "Coming soon."
  - `apps/marketing/src/components/landing/bento-grid.tsx:375-382` lists **iOS and Android with no "coming soon" marker**.

  This page's feature table states plainly that Bittery has no mobile apps yet. Shipping that table while the pricing table two clicks away claims mobile is available is a contradiction a comparison-shopping reader will find.

- **G4 — Sitemap entry.** `/compare/bitwarden` added to `STATIC_ROUTES` (§1). Not a credibility gate, but the page is invisible to search without it, which defeats the point.

---

## Open questions for the human

Judgment calls made to keep the spec complete and actionable. Each is cheap to reverse.

1. **No `/compare` hub page.** Assumed unnecessary for a single comparison and a thin-content risk. Reverse if more comparison pages are planned sooner than expected.
2. **Three-column table instead of two.** Chosen for honesty; it is more work to build and denser to read. A two-column version with a "requires license" annotation is the fallback.
3. **The self-deprecating register in §3.5 and §3.6** ("use Bitwarden — genuinely") is a deliberate bet: on this specific keyword, credibility converts better than persuasion. It is stronger than typical marketing copy is comfortable with, and it's the spec's most reversible-but-consequential choice.
4. **Travel Mode is included as a differentiator row.** It's real and shipped, and Bitwarden has no equivalent — but it invites "which other unique features?" and Bittery's answer is currently short.
5. **Exact prices included, with dates.** They create a maintenance obligation (§5.4). Dropping to "a paid subscription" is the low-maintenance alternative.
