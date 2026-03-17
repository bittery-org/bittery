# Breach Detection: Implementation Plan

## Overview

Add a **Breached** issue category to the existing Sentinel security dashboard using the [Have I Been Pwned Pwned Passwords k-anonymity API](https://haveibeenpwned.com/API/v3#PwnedPasswords). All password hashing is done client-side; only a 5-character SHA-1 prefix is ever sent to the server (which proxies to HIBP), so neither the server nor HIBP ever sees a full hash or plaintext password. Results are cached in `localStorage` per item and refreshed at most once per week. Checks run automatically on Sentinel page load.

## UI Decision

- **Placement**: 4th issue tab inside the existing Sentinel dashboard (`/security`), alongside Weak / Reused / Old
- **Trigger**: Automatically on page load; results cached client-side for 7 days per item (or until that item is updated)
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

localStorage-backed cache, keyed by item ID. No passwords or hashes are stored — only check outcomes.

- `getCache(itemId): BreachResult | null`
- `setCache(itemId, result: BreachResult): void`
- `needsCheck(item, cache): boolean` — true when: no entry exists, entry is older than 7 days, or `item.updatedAt` is more recent than `cache.checkedAt`
- `clearAll(): void` — called on logout / account switch to prevent stale results surviving across users

---

### Phase 2 — Server-Side HIBP Proxy

**New `packages/api/src/routers/breach.ts`**

Single `protectedProcedure` mutation `checkRange`:

| Concern | Implementation |
|---|---|
| Input validation | `z.string().regex(/^[0-9a-f]{5}$/i)` — server rejects anything that isn't exactly 5 hex chars |
| Server-side cache | In-process `Map<prefix, { data: string; cachedAt: Date }>`, TTL 24 h — avoids hitting HIBP for every user request |
| HIBP call | `GET https://api.pwnedpasswords.com/range/{prefix}` with `Add-Padding: true` |
| Return value | Raw `SUFFIX:COUNT\n...` text — server never parses, stores, or logs the content |
| Rate limiting | Via `packages/rate-limit/` — e.g. 200 requests/hour per authenticated user |
| Error handling | On HIBP timeout/error: throw `TRPCError` with code `INTERNAL_SERVER_ERROR` so the client can retry gracefully |

**`packages/api/src/routers/index.ts`**

Register `breachRouter` on the app router.

---

### Phase 3 — Client-Side Breach Check Hook

**New `packages/core/src/hooks/use-breach-check.ts`**

Accepts: `items: VaultItem[]` (already decrypted, in-memory from the existing `useItems` hook).

Flow on mount / when items change:

1. Read cache for every item that has a password field
2. Use `needsCheck` to build the list of items that require a fresh check
3. Deduplicate by SHA-1 prefix — one HIBP call covers all passwords sharing the same 5-char prefix
4. Compute SHA-1 client-side via `crypto.subtle.digest('SHA-1', new TextEncoder().encode(password))` — uses the native Web Crypto API, no new WASM or Rust changes required
5. Call `trpc.breach.checkRange.mutate({ prefix })` **sequentially** with a short delay between calls to avoid hammering HIBP rate limits
6. Parse the response, check suffix membership, write result to `breach-cache.ts`

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

**`apps/web/src/routes/_app/security.tsx`**

- Call `useBreachCheck(items)` alongside the existing `usePasswordSecurity`
- Pass `breachResults` into `usePasswordSecurity` and `isChecking`/`progress` into `SecurityDashboard`

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
| [packages/shared/src/password-analysis.ts](../../../packages/shared/src/password-analysis.ts) | Shared types + score constants |
| [packages/api/src/routers/index.ts](../../../packages/api/src/routers/index.ts) | Router registration |
| [packages/rate-limit/](../../../packages/rate-limit/) | Rate limiting primitives to reuse |
| [packages/i18n/messages/en.json](../../../packages/i18n/messages/en.json) | i18n strings |

---

## Verification Checklist

- [ ] `password` → shows as breached with count > 3,000,000
- [ ] Strong random password → shows as clean
- [ ] Network tab: server receives only 5-char prefix; no plaintext password or full hash in any request or log
- [ ] Reload page within 7 days → zero new breach network calls (all served from localStorage)
- [ ] Update a vault item → cache entry for that item is invalidated; re-checked on next load
- [ ] Sentinel score drops proportionally when breached items are present
- [ ] Logout / account switch → `clearAll()` is called; next login starts with a fresh cache
- [ ] Rapid repeated calls from the same user are rejected after rate-limit threshold

---

## Further Considerations

### Logout cache cleanup
`breach-cache.clearAll()` must be called during logout and account switching to prevent stale results surviving across different users on the same device. Hook into the existing auth-service logout path where other in-memory state is currently cleared.

### Sequential vs parallel HIBP calls
Sequential with a short inter-call delay (e.g. 100 ms) is the right default to stay within HIBP's rate limits for large vaults. A configurable concurrency limit could be added later if performance becomes a concern for users with hundreds of logins.

### Browser extension compatibility
`crypto.subtle.digest` is available inside extension service workers and content scripts, so `use-breach-check` could be reused in the browser extension without any changes to the protocol or hook interface.

### SHA-1 and security
SHA-1 is cryptographically broken for collision resistance but is still perfectly suitable here: it is only used as the input format required by the HIBP k-anonymity API, not for any authentication or integrity purpose. The security guarantee comes from the k-anonymity model (only a prefix is transmitted), not from SHA-1 being collision-resistant.