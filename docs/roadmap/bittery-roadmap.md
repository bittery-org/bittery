# Bittery – Product Roadmap

## Critical for Launch

| Feature | Status | Notes |
|---|---|---|
| iOS Autofill | ❌ Missing | Apple Developer License required. Without iOS Autofill, Bittery is barely usable for mobile users – high priority. |
| Billing | ✅ Done | Billing system is complete (plans, payment processing, upgrades/downgrades). |
| Onboarding | ✅ Done | First-run onboarding flow and import handoff are complete. |
| Device Setup | 🟡 Needs Testing | Desktop-first flow implemented (account selection, setup QR, deep link prefill). Validate end-to-end on mobile scanner + deep link opening. |
| Account Recovery | ✅ Done | Implemented in Desktop App (Recovery Kit PDF + forgotten Master Password flow). |
| Export Finalization | 🟡 Partial | Already exists, needs to be finalized and tested. Important trust signal (no lock-in). |
| Security Audit | 🟡 Partial | 2 partial audits completed so far. Full audit needed incl. Session Revocation enforcement. |
| Session Revocation | 🟡 Partial | Session Management exists in Web App. Token Revocation must be enforced across all clients (Desktop, Mobile, Extension). |
| Master Password Re-Auth | ✅ Done | Implemented in Desktop App with periodic Master Password re-authentication. |

## Important Features

| Feature | Status | Notes |
|---|---|---|
| Emergency Access | ❌ Missing | Trusted contacts that gain access after inactivity. Architecturally challenging with Zero-Knowledge. |
| Password History | ✅ Done | Implemented for login items on Desktop + Mobile with encrypted history and restore support. |
| Travel Mode | ❌ Missing | Hide specific vaults during border crossings. Strong differentiator. |
| Secure File Storage | ✅ Done | Encrypted file attachments for items are now available. |
| Import | ✅ Done | Import support is available for bringing data from other password managers into Bittery. |
| i18n | ❌ Missing | At minimum English & German. Complex but important for international launch. |

## Team / Business Features

| Feature | Status | Notes |
|---|---|---|
| Team Management | ✅ Done | Invites, settings, vault access in Web App. |
| Sharing | ✅ Done | Sharing configuration in Web App, sharing view as well. |
| Offboarding Flow | ❌ Missing | On team removal: cleanly revoke access, mark shared passwords as compromised in Sentinel. |

## Planned for Later

| Feature | Notes |
|---|---|
| SSH Key Management | Attractive for developer audience. |
| CLI / Devtools | Secrets in CI/CD pipelines, scripts, automation. |
| Additional Item Categories | Server logins, software licenses, passports, etc. |

---

*Last updated: March 3, 2026*
