# Current capability disposition

Status: **In progress**. This pass records decisions already made. Every current capability must be
accounted for before implementation.

| Current capability | Disposition | Candidate target |
| --- | --- | --- |
| Rust cryptographic implementation | Keep | One shared Rust crypto implementation beneath the engine |
| Master password plus Secret Key | Keep | New versioned derivation/format after security grilling |
| SRP authentication | Replace | RFC 9807 OPAQUE, pending conformance gate |
| Deterministic fake login verifier | Replace | RFC 9807 fake OPAQUE exchanges with the ordinary versioned Server setup |
| Rate-limiting subsystem | Replace | Exhaustive subject, source, and Server-capacity scopes with progressive cooldowns and no hard Account lock |
| Recovery Key and Emergency Kit | Keep | Simplified user-held recovery model |
| Multiple local Accounts | Keep | Extend across multiple Servers and All Accounts scope |
| Hosted Bittery cloud | Remove | Fully self-hosted product |
| Billing, plans, Stripe, entitlements | Remove | Operator resource policy only |
| Implicit Team of one | Remove | Explicit Teams; Users own Personal Vaults |
| Personal and shared Vaults | Simplify | Personal Vaults and Team Vaults with explicit ownership |
| Vault-level collaboration | Keep | Primary ongoing sharing mechanism |
| Per-Item Share links | Keep | Encrypted snapshot with richer optional policy |
| Fixed Item categories | Keep | Fixed categories plus encrypted custom fields |
| Favorite as plaintext metadata | Replace | Encrypt Favorite |
| Password history field | Replace | Bounded encrypted Item revision history |
| Attachments and wrapped Attachment keys | Defer | Keep architecture; full first-release UX may defer |
| Sentinel | Keep | Local analysis, available in scoped and All Accounts views |
| Travel mode | Simplify | Honest eviction and offline limitations |
| Encrypted local cache | Keep | Engine-owned transactional replica |
| TypeScript outbound queue and Sync orchestration | Replace | Rust persistent operation/Sync state machine |
| SSE realtime | Simplify | Optional wake-up hint only |
| Staged bootstrap and cursor Sync | Keep | Engine-owned and fault-tested |
| React shared core/providers | Replace | Thin UI binding over ClientRuntime |
| Tauri Desktop | Keep | Thin Tauri shell; native engine owner |
| Tauri/WebView mobile | Remove | SwiftUI and Kotlin/Compose native clients |
| Android TypeScript credential projection/key bridge | Replace | Native constrained runtime and shared encrypted replica |
| Chrome extension | Keep | Background-owned runtime and narrow typed clients |
| Firefox extension | Keep | Required official target |
| Safari extension | Defer | Architecture-compatible future target |
| Qubit/RPC | Remove | Versioned HTTP/OpenAPI |
| Generated cross-language definitions | Keep | Canonical protocol/binding generation and fixtures |
| Domain-owned Server SQL | Keep | SQLx checked SQL beside vertical domain modules |
| Generic repository tier | Remove | Purpose-shaped domain queries and atomic writer mechanics |
| Redis correctness dependency | Remove | PostgreSQL is the default abuse-state authority; durable Redis is an optional selected authority, never a live fallback |
| SMTP requirement | Replace | Optional integration; essential flows work without it |
| External service requests by default | Remove | Explicit opt-in per integration |

## Unclassified

The following families still need exhaustive disposition passes:

- Every administration command and deployment option.
- Import/export formats and portability promises.
- Breach detection and favicon acquisition.
- Detailed Team invitation and governance behavior.
- Detailed Share access modes and anonymous-recipient flows.
- Device management and reauthentication policy.
- Passkey creation/use behavior in extension and native credential providers.
- Attachment quotas, chunking, offline pinning, and garbage collection.
- Audit retention and operator observability.
- Localization, accessibility, themes, and supported platform versions.
- Marketing application and documentation site.
