---
id: 02
title: Bitwarden licensing & feature facts (cited)
type: wayfinder:research
status: claimed
assignee: research-subagent (charting session)
blocked-by: []
---

## Question

What are the current, citable facts about Bitwarden's licensing and self-hosting model that the comparison and self-hosting pages will rest on — and does Bittery's own code actually support the counter-claim?

Surface, with source URL and date checked for every claim:

- What exactly requires a paid license file when self-hosting Bitwarden today (premium features, SSO, enterprise policies, org features)? Official docs: https://bitwarden.com/help/licensing-on-premise/
- The proprietary `bitwarden_license/` directory: current licensing structure of Bitwarden's server repo (what is GPL/AGPL vs. Bitwarden License).
- Current Bitwarden pricing tiers (Free / Premium / Families / Teams / Enterprise) and what free self-hosting includes.
- Verify Bittery's own claim locally: `apps/server/src/services/billing/mod.rs:977-986` — self-hosted deployments unlock every feature with no license file and no subscription. Confirm what the code actually does.
- Bittery's actual license state post-relicense (#45): AGPLv3 server, GPLv3 clients, no proprietary carve-out — confirm from the repo's LICENSE files.
