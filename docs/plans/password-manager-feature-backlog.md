# Bittery Password Manager Feature Backlog

## Purpose

This document is a planning scratchpad for deciding what should be added to the public roadmap next.

It combines:

- features already present in the current roadmap page
- features already described elsewhere in marketing, pricing, and product docs
- new feature ideas grouped by priority and audience

This is intentionally broader than the current roadmap. The goal is to capture the full product surface first, then decide what is worth promoting into the roadmap.

## Current Product Surface

### Core security and account model

- Zero-knowledge architecture
- End-to-end client-side encryption
- AES-256-GCM encryption with context-bound integrity checks
- Dual-key model: Master Password plus Secret Key
- SRP-6a authentication
- Per-vault encryption keys
- RSA-4096 for vault sharing
- Recovery Kit based account recovery
- Master password change flow without re-encrypting all vault data
- Session revocation across devices
- Master password re-auth for sensitive actions
- Device/session management with rename, revoke, and sign out all devices
- Quick unlock on supported devices using biometrics or PIN
- Self-hosted deployment option

### Platforms and access

- Web app
- Desktop app for macOS, Windows, and Linux
- Browser extension
- Mobile app for iOS and Android
- Cross-device sync
- Offline access after sync
- Browser autofill
- Browser and Android passkey autofill
- Password save prompt in extension
- Password generator

### Vault and item management

- Vault-based organization
- Import from major password managers and browsers
- Export of vault data
- Logins
- Secure notes
- Credit cards
- Identities
- TOTP secrets / authenticator support
- Secure file attachments / encrypted file storage
- Password history
- Item tags
- Favorites
- Archive and restore for deleted items
- Custom vault icons

### Security insights

- Sentinel password health dashboard
- Weak password detection
- Reused password detection
- Security recommendations and hygiene checks

### Sharing and collaboration

- Shared vaults
- Team management
- Sharing with team members
- Secure share links for individual items
- Share link revocation
- Share link access logging / audit trail
- Role-based access on collaborative plans
- Family plan support
- Team plan support

### Commercial and admin surface

- Free, Personal, Family, and Team plans
- Billing and subscription management
- Annual billing
- Plan-based limits and entitlements
- Priority support on paid plans
- Admin console for teams
- Activity logs for teams
- Custom policies for teams

## Current Roadmap Snapshot

### Already marked done on the roadmap page

- Billing
- Onboarding
- Account Recovery
- Session Revocation
- Master Password Re-Auth
- Password History
- Secure File Storage
- Import
- Team Management
- Sharing

### Marked in progress on the roadmap page

- Device Setup
- Export
- Security Audit
- Internationalization

### Marked planned on the roadmap page

- iOS Autofill
- Emergency Access
- Travel Mode
- Offboarding Flow
- SSH Key Management
- CLI and Dev Tools
- More Item Types

## Gaps Between Current Product and Best-in-Class Password Managers

These are the areas where Bittery appears weakest relative to mature products like 1Password, Bitwarden, Proton Pass, and Dashlane.

### Platform and autofill gaps

- Native iOS autofill is still planned rather than fully shipped
- Firefox extension support is still todo
- Safari extension support is still todo
- Android autofill is not clearly described in public docs
- Passkey support is shipped, but the public docs do not describe it clearly enough yet

### User safety and migration gaps

- Emergency access is not available yet
- Travel mode is not available yet
- Offboarding and credential rotation workflows are incomplete
- Sentinel is not surfaced clearly enough in public docs
- There is no known external breach detection via Have I Been Pwned or similar

### Collaboration and admin gaps

- No public mention of approval workflows for access changes
- No public mention of SCIM, SSO, or enterprise identity provisioning
- No public mention of item-level permissions beyond role-based access
- No public mention of event export, SIEM integration, or compliance reporting
- No public mention of delegated administration or break-glass accounts

### Developer and power-user gaps

- CLI is still only planned
- SSH key handling is still only planned
- No public mention of secrets injection for local development or CI environments
- No public mention of API tokens or service accounts
- No public mention of browserless access or terminal workflows

## Must-Haves Before Public Launch

These feel like the highest-leverage features to finish before treating the product as broadly launch-ready.

### 1. iOS autofill

Why it matters:

- mobile password managers feel broken without system autofill
- it directly affects daily usability and first impressions
- it closes one of the clearest platform parity gaps

### 2. Export that is complete and trustworthy

Why it matters:

- data portability is core to user trust
- it reduces lock-in concerns for privacy-conscious buyers
- it is table stakes for serious password managers

### 3. Recovery flow that is easy to understand and test

Why it matters:

- account recovery is one of the biggest fear points for new users
- the docs mention Recovery Kit behavior, so the UX must be very clear
- launch support load will be lower if recovery is obvious and verifiable

### 4. Device setup and sign-in flow polish

Why it matters:

- the Secret Key model is more secure but adds friction
- poor device onboarding can make the product feel harder than competitors
- QR-based or deep-link based setup can become a strong differentiator if polished

### 5. Security audit completion and publishable summary

Why it matters:

- third-party validation is especially important for a new password manager
- it reduces buyer hesitation for both personal and business users
- it gives marketing a concrete trust artifact

### 6. Clear cross-platform autofill matrix

Why it matters:

- users need to know exactly what works today
- current public messaging appears inconsistent across Chrome, Firefox, Safari, iOS, and mobile autofill
- launch messaging should not overpromise platform coverage

### 7. Password health essentials

Recommended scope:

- better public positioning for Sentinel
- clearer in-product remediation flows
- optional future breach detection via Have I Been Pwned or similar
- missing 2FA / missing TOTP opportunities

Why it matters:

- users expect more than storage from a modern password manager
- these features create ongoing product value after migration

## Strong Next Features After Launch

These are not blockers for launch, but they would noticeably increase product competitiveness.

### Personal and family features

- Emergency Access
- Travel Mode
- Secure item sharing with more granular expiry and recipient controls
- Richer password generator presets
- stronger Sentinel presentation and remediation flows
- Secure notes templates
- More item types such as bank accounts, passports, software licenses, Wi-Fi, database credentials, health insurance, and memberships
- Family-safe onboarding with simple invite and recovery guidance

### Team and business features

- Offboarding Flow with forced credential rotation playbooks
- Shared item ownership and transfer workflows
- Vault access approval workflows
- Fine-grained permissions at vault, folder, and item level
- Team activity feed with exportable audit logs
- Policy controls for passkeys, TOTP, sharing, attachment uploads, and recovery requirements
- Domain verification and automatic team join
- SSO and SCIM for larger customers
- Managed service accounts / bot accounts for internal tools

### Developer and power-user features

- CLI and local shell integration
- SSH Key Management
- Git signing key storage
- Secret injection for local development, scripts, and CI/CD
- Encrypted environment file workflows
- API tokens with scoped permissions
- Secret references usable in Docker, GitHub Actions, and Kubernetes manifests

## Nice-to-Haves

These are valuable, but probably not worth displacing the launch-critical work.

- Custom item templates
- Secure contact cards
- Location-aware autofill suggestions
- Website change history for saved logins
- Shared item comments and notes for teams
- Smarter saved searches
- Duplicate cleanup suggestions
- Browser extension mini-audit panel on login pages
- Secure one-time reveal links for secrets
- Printable family recovery packet

## Big-Bet Ideas

These could become differentiators if Bittery wants to push beyond parity.

### Passkey-first identity layer

- full passkey creation, storage, sync, and autofill story across web, extension, mobile, and desktop
- passkey migration assistant for services that support upgrade from passwords
- admin controls and reporting for passkey adoption in teams

### Privacy-first trust center

- public cryptography explainer with audit status
- reproducible build documentation
- security event transparency log
- user-verifiable client integrity or signed release attestations

### Shared vaults built for families

- emergency access plus inheritance workflows
- parent and child role models
- recovery delegation without exposing the whole account
- household vault bundles for Wi-Fi, streaming, school, and banking access

### Secrets platform for developers

- CLI plus SDKs
- secret references for local apps
- short-lived secrets and rotation hooks
- audit-friendly sharing for engineering teams

## Recommended Prioritization

If the goal is to choose what to add to the roadmap next, this ordering looks defensible.

### Tier 1: launch-critical

- iOS autofill
- export completion and polish
- device setup polish
- security audit completion
- recovery UX hardening
- password health essentials

### Tier 2: strong post-launch value

- Emergency Access
- Travel Mode
- Offboarding Flow
- More Item Types
- CLI and Dev Tools

### Tier 3: business expansion

- advanced admin policies
- audit log export
- access approval workflows
- SSO / SCIM
- service accounts

### Tier 4: differentiation bets

- SSH Key Management
- passkey-first workflows
- privacy trust center
- deeper developer secrets platform

## Candidate Features Worth Discussing For the Public Roadmap

If the next roadmap revision should stay compact, these are the strongest candidates to add or elevate:

- Android Autofill
- Firefox Extension Support
- Safari Extension Support
- Passkey Management and Autofill
- Sentinel Improvements and Public Positioning
- Breach Detection via Have I Been Pwned or Similar
- Vault Access Approval Workflows
- Audit Log Export
- SSO and SCIM
- Secret Injection for Developers
- API Tokens and Service Accounts
- Domain Verification for Team Onboarding

## Source Inconsistencies To Resolve Before Updating The Roadmap

These should be verified because the current public material appears to disagree.

- Android autofill and passkey support are shipped, but public docs do not explain the coverage clearly enough
- Sentinel exists today, but the public docs do not explain what it covers versus what it does not cover

## Suggested Next Working Session

When we turn this into a roadmap update, a clean next step would be:

1. confirm which current features are truly shipped versus only documented
2. choose 5 to 8 roadmap items max
3. separate launch blockers from differentiation work
4. decide whether Bittery is prioritizing consumer trust, family features, team adoption, or developer workflows first