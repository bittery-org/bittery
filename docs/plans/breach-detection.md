# Breach Detection: Implementation Plan

## Overview

Add a **Breached** issue category to the existing Sentinel security dashboard using the [Have I Been Pwned Pwned Passwords k-anonymity API](https://haveibeenpwned.com/API/v3#PwnedPasswords). All password hashing is done client-side; only a 5-character SHA-1 prefix is ever sent to the server (which proxies to HIBP), so neither the server nor HIBP ever sees a full hash or plaintext password. Results are cached in **IndexedDB** per item and refreshed at most once per week. Checks run automatically in the background after vault unlock, not just on Sentinel page load.

> **Why not store breach results in the database?** Storing even a boolean `isBreached` flag server-side would reveal to the server which specific vault items are compromised. Even without passwords or hashes, that is a privacy leak — the server would know which accounts a user needs to change. IndexedDB keeps all outcomes client-side, preserving zero-knowledge end-to-end.

## UI Decision

- **Placement**: 4th issue tab inside the existing Sentinel dashboard (`/security`), alongside Weak / Reused / Old
- **Trigger**: Automatically in the background after vault unlock/sync completes; the Sentinel page just reads from the cache and displays whatever is available, showing live progress if a background check is still in flight
- **Background mechanism**: Web Worker handles SHA-1 hashing and communicates results back via `postMessage`; the main thread only dispatches work and writes to IndexedDB
- **Results cached**: client-side (IndexedDB) for 7 days per item, or until that item is updated
- **Scope**: Passwords only — no email breach checking (which would require sending email addresses to HIBP)

---

## The k-Anonymity Protocol

This is how the check remains zero-knowledge end-to-end:

```
Client:  SHA-1("hunter2") → "f3bbbd..." → prefix="f3bbb" + suffix="d..."
         Sends to server:  { prefix: "f3bbb" }        ← only 5 chars

Server:  proxies to HIBP  GET /range/f3bbb             ← HIBP sees server IP, not user
         returns raw text: "D...:45\n3DEF...:1201\n..." ← list of suffixes + breach counts

Client:  checks if own suffix "d..." appears in the returned list
         → stores { itemId, isBreached, breachCount, checkedAt } in localStorage
         → password never left the browser; full hash never left the browser
```

The `Add-Padding: true` request header is sent to HIBP so that all responses have the same number of lines, preventing timing-based inference even at the network layer.

---

## Implementation Phases

### Phase 1 — Shared Types & Cache Utility

**`packages/shared/src/password-analysis.ts`**

- Add `"breached"` to the `PasswordIssueType` union
- Add `BreachResult` type: `{ itemId: string; isBreached: boolean; breachCount: number; checkedAt: Date }`
- Add `breachedItems: BreachedItem[]` to `PasswordSecurityReport`
- Add a breach score penalty constant — highest penalty (e.g. `−10` per item, vs `−5` for weak)

**New `packages/core/src/services/breach-cache.ts`**

IndexedDB-backed cache (via a thin wrapper — no new dependency needed, the native `indexedDB` API is sufficient), keyed by item ID. No passwords or hashes are stored — only check outcomes.

- `getCache(itemId): Promise<BreachResult | null>`
- `setCache(itemId, result: BreachResult): Promise<void>`
- `getAll(): Promise<Map<string, BreachResult>>` — bulk read for initial render without N individual awaits
- `needsCheck(item, cache): boolean` — true when: no entry exists, entry is older than 7 days, or `item.updatedAt` is more recent than `cache.checkedAt`
- `clearAll(): Promise<void>` — called on logout / account switch to prevent stale results surviving across users

> **Why IndexedDB over localStorage?** localStorage is synchronous (blocks the main thread during reads/writes), limited to ~5 MB, and stores everything as a plain string. IndexedDB is fully async, handles structured objects natively, has no practical size limit for this use case, and works correctly inside Web Workers where localStorage is not available.

---

### Phase 2 — Server-Side HIBP Proxy

**New `packages/api/src/routers/breach.ts`**

Single `protectedProcedure` mutation `checkRange`:

| Concern | Implementation |
|---|---|
| Input validation | `z.string().regex(/^[0-9a-f]{5}$/i)` — server rejects anything that isn't exactly 5 hex chars |
| Server-side cache | In-process `Map<prefix, { data: string; cachedAt: Date }>`, TTL 72 h — HIBP prefix data changes infrequently so a longer TTL meaningfully reduces outbound calls | 
| Request coalescing | If a request for prefix `X` is already in-flight, queue subsequent requests for `X` and resolve them all from the single HIBP response rather than issuing duplicate HTTP calls |
| HIBP call | `GET https://api.pwnedpasswords.com/range/{prefix}` with `Add-Padding: true` |
| Return value | Raw `SUFFIX:COUNT\n...` text — server never parses, stores, or logs the content |
| Rate limiting | Via `packages/rate-limit/` — 60 requests/hour per authenticated user (conservative; the server cache absorbs repeated lookups for popular prefixes) |
| Error handling | On HIBP 429 or timeout: return a structured `{ retryAfter: number }` error so the client backs off correctly; do **not** throw a generic 500 |

**`packages/api/src/routers/index.ts`**

Register `breachRouter` on the app router.

---

### Phase 3 — Client-Side Breach Check Hook

**New `packages/core/src/services/breach-worker.ts`** (Web Worker)

Contains only pure, non-React logic that runs off the main thread:
- Receives `{ itemId, password }` messages
- Computes SHA-1 via `crypto.subtle.digest` (available in workers)
- Posts back `{ itemId, prefix, suffix }`

The worker is instantiated once per app session and reused across all checks.

**New `packages/core/src/services/breach-checker.ts`**

Plain async service (not a hook) that orchestrates the full background check. Designed to be started once after vault unlock, independent of any UI component being mounted.

Flow:

1. Read all cached results from IndexedDB via `breach-cache.getAll()`
2. Filter to items that `needsCheck` (never checked, stale > 7 days, or updated since last check)
3. Deduplicate by SHA-1 prefix — one HIBP call covers all passwords sharing the same 5-char prefix
4. Sort unchecked items first, stale items second — prioritise items users have never seen results for
5. Send passwords to the Web Worker in batches; receive `{ prefix, suffix }` back
6. For each unique prefix, call `trpc.breach.checkRange.mutate({ prefix })` sequentially with **150 ms inter-call delay + full jitter** (random 0–50 ms added to each delay to avoid thundering-herd if multiple tabs are open)
7. On 429 / `retryAfter` response: pause the entire queue for the specified duration before continuing
8. Parse the response, check suffix membership, write each result to IndexedDB
9. Emit progress events via a `BroadcastChannel('breach-check')` so any open UI tab can react
10. After completing a session, record a `lastFullScanAt` timestamp in IndexedDB; skip re-running until the next day even if the user navigates away and back

**New `packages/core/src/hooks/use-breach-check.ts`**

Accepts: `items: VaultItem[]` (already decrypted, in-memory from the existing `useItems` hook).

This hook is **read-only** — it does not start checks itself. It:
- Reads the current cache snapshot from IndexedDB on mount
- Subscribes to the `BroadcastChannel('breach-check')` for live updates while mounted
- Exposes `isChecking`, `progress`, and the latest `results` map

The actual check is started by calling `breach-checker.start(items)` from the vault unlock flow, not from this hook.

Returns:
```ts
{
  results: Map<string, BreachResult>;   // itemId → result
  isChecking: boolean;
  progress: { done: number; total: number };
}
```

**`packages/core/src/hooks/use-password-security.ts`**

- Accept an optional `breachResults: Map<string, BreachResult>` parameter
- Compute `breachedItems` from the map; include in the returned `PasswordSecurityReport`
- Apply breach penalty in score formula (highest penalty tier)

---

### Phase 4 — UI Integration

**Vault unlock / app initialisation path** (exact file TBD during implementation)

- After vault items are decrypted and in memory, call `breachChecker.start(items)` once
- This starts the background worker; checks proceed regardless of which page the user is on

**`apps/web/src/routes/_app/security.tsx`**

- Call `useBreachCheck(items)` to subscribe to live cache updates
- Pass `breachResults` into `usePasswordSecurity` and `isChecking`/`progress` into `SecurityDashboard`
- If `results` is already populated from a previous background run, the page renders immediately with the cached data and no spinner is shown

**`apps/web/src/components/dashboard/security-dashboard.tsx`**

- 4th `IssueCard` for Breached — distinct critical/red colour, shows count
- 4th tab in the drilldown panel showing per-item breach count ("seen X,XXX times in data breaches")
- Progress bar / spinner while checking ("Checking X of Y passwords…")
- Last-checked timestamp so users know how fresh the results are
- Empty state when no breached passwords are found

**`packages/i18n/messages/en.json`** — new keys under the `sentinel_*` namespace:

| Key | Content |
|---|---|
| `sentinel_breach_title` | `"Breached"` |
| `sentinel_breach_description` | `"Passwords found in known data breaches"` |
| `sentinel_breach_card_label` | `"Breached passwords"` |
| `sentinel_breach_checking` | `"Checking {done} of {total} passwords…"` |
| `sentinel_breach_item_seen_count` | `"Seen {count, number} times in data breaches"` |
| `sentinel_breach_last_checked` | `"Last checked {date}"` |
| `sentinel_breach_no_breaches` | `"No breached passwords found"` |
| `sentinel_breach_recommendation_title` | `"Change breached passwords immediately"` |
| `sentinel_breach_recommendation_description` | `"These passwords have appeared in known data breaches. Change them now and enable two-factor authentication wherever possible."` |

---

## Relevant Files

| File | Role |
|---|---|
| [apps/web/src/components/dashboard/security-dashboard.tsx](../../../apps/web/src/components/dashboard/security-dashboard.tsx) | Main Sentinel UI — add 4th card + tab |
| [apps/web/src/routes/_app/security.tsx](../../../apps/web/src/routes/_app/security.tsx) | Sentinel page entry point |
| [packages/core/src/hooks/use-password-security.ts](../../../packages/core/src/hooks/use-password-security.ts) | Security report hook to extend |
| [packages/core/src/hooks/use-breach-check.ts](../../../packages/core/src/hooks/use-breach-check.ts) | UI hook — reads cache, subscribes to live updates |
| [packages/core/src/services/breach-checker.ts](../../../packages/core/src/services/breach-checker.ts) | Background orchestrator — starts after vault unlock |
| [packages/core/src/services/breach-worker.ts](../../../packages/core/src/services/breach-worker.ts) | Web Worker — SHA-1 hashing off the main thread |
| [packages/core/src/services/breach-cache.ts](../../../packages/core/src/services/breach-cache.ts) | IndexedDB cache — stores check outcomes only |
| [packages/shared/src/password-analysis.ts](../../../packages/shared/src/password-analysis.ts) | Shared types + score constants |
| [packages/api/src/routers/index.ts](../../../packages/api/src/routers/index.ts) | Router registration |
| [packages/rate-limit/](../../../packages/rate-limit/) | Rate limiting primitives to reuse |
| [packages/i18n/messages/en.json](../../../packages/i18n/messages/en.json) | i18n strings |

---

## Verification Checklist

- [ ] `password` → shows as breached with count > 3,000,000
- [ ] Strong random password → shows as clean
- [ ] Network tab: server receives only 5-char prefix; no plaintext password or full hash in any request or log
- [ ] Reload page within 7 days → zero new breach network calls (all served from IndexedDB)
- [ ] Open Sentinel page before background check finishes → shows cached data immediately + live progress bar for in-flight items
- [ ] Open Sentinel page after background check already finished → shows all results instantly, no spinner
- [ ] Update a vault item → cache entry for that item is invalidated; re-checked on next background run
- [ ] Sentinel score drops proportionally when breached items are present
- [ ] Logout / account switch → `clearAll()` is called; next login starts with a fresh cache
- [ ] Rapid repeated calls from the same user are rejected after rate-limit threshold
- [ ] HIBP returns 429 → client pauses queue for `retryAfter` duration, then resumes; does not drop remaining items
- [ ] Two browser tabs open at once → only one tab runs the checker; second tab receives updates via `BroadcastChannel`
- [ ] Full scan already completed today → opening app a second time does not trigger any HIBP calls

---

## Further Considerations

### Logout cache cleanup
`breach-cache.clearAll()` must be called during logout and account switching to prevent stale results surviving across different users on the same device. Hook into the existing auth-service logout path where other in-memory state is currently cleared.

### HIBP call throttling
Sequential with a **150 ms base delay + up to 50 ms random jitter** between each prefix request. The jitter is important: without it, multiple tabs or multiple app restarts in quick succession produce a burst pattern that can trigger HIBP rate limiting even though each individual session looks polite. The `lastFullScanAt` guard (max one full scan per 24 h session) is the primary protection against excessive API use; the per-call delay is a secondary safeguard for large vaults within that window.

### Preventing duplicate work across tabs
`BroadcastChannel('breach-check')` is used both to distribute progress updates and to implement a simple leader-election signal: when a tab starts a checker run it broadcasts a `{ type: 'started' }` message; any other tab that receives this message while its own checker is idle will skip starting its own run and rely on `BroadcastChannel` updates instead.

### Browser extension compatibility
`crypto.subtle.digest` is available inside extension service workers and content scripts, so `use-breach-check` could be reused in the browser extension without any changes to the protocol or hook interface.

### SHA-1 and security
SHA-1 is cryptographically broken for collision resistance but is still perfectly suitable here: it is only used as the input format required by the HIBP k-anonymity API, not for any authentication or integrity purpose. The security guarantee comes from the k-anonymity model (only a prefix is transmitted), not from SHA-1 being collision-resistant.