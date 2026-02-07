# Plan 04: Hooks & Client-Side Code

**Scope:** `packages/hooks/src/`, extension service worker
**Findings:** 10 (1 High, 6 Medium, 3 Low)

---

## #12 — HIGH: Decryption Errors Logged with Full Error Objects

**File:** `packages/hooks/src/internal/use-items-unified.ts:259-261`

**Problem:** `console.error` includes the full error object, which may contain partial decrypted data, key references, or internal crypto state. These appear in browser DevTools, crash reporting services, and may be captured by analytics.

```typescript
// CURRENT — full error object logged
console.error(
    `[useItemsUnified] Failed to decrypt item ${rawItem.id} for ${account.email}:`,
    error,
);
```

Also present in:
- `packages/hooks/src/items/use-vault-items.ts:152-155` — same pattern

**Fix:** Log only safe metadata. Never log the error object from crypto operations.

```typescript
console.error(
    `[useItemsUnified] Failed to decrypt item ${rawItem.id}`,
    error instanceof Error ? error.message : "Unknown error",
);
```

Remove the email from the log message as well (see #38 for the pattern).

Apply the same fix to `use-vault-items.ts:152-155` and any other decryption error logging.

**Testing:** Trigger a decryption failure and verify DevTools console shows only the item ID and error message string, not the full error object.

---

## #21 — MEDIUM: SRP Server Proof Verification Optional

**File:** `packages/hooks/src/auth/srp-unlock.ts:88-96`

**Problem:** Server proof verification is optional — if `finishResult.serverProof` is falsy, the check is skipped entirely. This breaks mutual authentication: a MITM server could respond without a proof and the client would accept it as valid.

```typescript
// CURRENT — optional verification
if (finishResult.serverProof) {
    await crypto.verifyServerSession(
        clientEphemeral.publicKey,
        clientSession,
        finishResult.serverProof,
    );
}
```

**Fix:** Make server proof mandatory.

```typescript
if (!finishResult.serverProof) {
    throw new Error("Server did not provide authentication proof. Connection may be compromised.");
}
await crypto.verifyServerSession(
    clientEphemeral.publicKey,
    clientSession,
    finishResult.serverProof,
);
```

**Server-side prerequisite:** Ensure the `quickUnlock` procedure in `auth.ts` always returns `serverProof` in its response. Currently it should already include `result.serverProof` — verify this is the case.

Apply the same mandatory check in:
- `packages/hooks/src/auth/srp-login.ts` (if it has a similar optional pattern)
- Extension service worker `auth-handlers.ts` (if applicable)

**Testing:** Verify login and unlock succeed with server proof present. Verify they fail if `serverProof` is removed from the response.

---

## #27 — MEDIUM: Account Switch Race Condition

**File:** `packages/hooks/src/auth/use-account-switcher.ts:119`

**Problem:** When switching accounts, `storage.setActiveAccount()` completes before query invalidation in `onSuccess`. Any mutations in-flight during the switch may execute against the wrong account's data, since they use the active account context.

```typescript
// CURRENT — mutations in-flight can target wrong account
const switchAccount = useMutation({
    mutationFn: async (account: ActiveAccount) => {
        await storage.setActiveAccount(account);
    },
    onSuccess: () => {
        // Query invalidation happens AFTER account switch
        queryClient.invalidateQueries({ queryKey: ["accounts"] });
        queryClient.invalidateQueries({ queryKey: ["vaults"] });
        queryClient.invalidateQueries({ queryKey: ["items"] });
    },
});
```

**Fix:** Cancel all in-flight mutations before switching, and invalidate queries as part of the mutation function (not just onSuccess).

```typescript
const switchAccount = useMutation({
    mutationFn: async (account: ActiveAccount) => {
        // 1. Cancel all in-flight queries and mutations
        await queryClient.cancelQueries();

        // 2. Clear all caches to prevent cross-account data leakage
        queryClient.removeQueries({ queryKey: ["vaults"] });
        queryClient.removeQueries({ queryKey: ["items"] });

        // 3. Switch the active account
        await storage.setActiveAccount(account);
    },
    onSuccess: () => {
        // 4. Trigger fresh data fetch for new account
        queryClient.invalidateQueries({ queryKey: ["accounts"] });
        queryClient.invalidateQueries({ queryKey: ["auth"] });
        queryClient.invalidateQueries({ queryKey: ["vaults"] });
        queryClient.invalidateQueries({ queryKey: ["items"] });
    },
});
```

**Testing:** Rapidly switch between accounts while a mutation is in progress. Verify no data from account A appears in account B's view.

---

## #32 — LOW: Logout Ignores Server Errors

**File:** `packages/hooks/src/auth/use-logout.ts:109`

**Problem:** Server-side logout errors are silently caught and ignored. If the server fails to invalidate the session, the JWT token remains valid server-side, but the client believes logout succeeded. An attacker who steals the token can continue using it.

```typescript
// CURRENT — server errors silently swallowed
try {
    // ... server logout call
} catch {
    // Ignore server errors during logout
}
```

**Fix:** Warn the user and retry, but still clear local data.

```typescript
try {
    await trpcClient.auth.logout.mutate({ sessionId });
} catch (error) {
    console.warn("[logout] Server-side session invalidation failed");
    // Still proceed with local cleanup, but inform user
    // Consider: queue a retry for when connectivity is restored
}

// Always clear local data regardless of server response
await storage.clearAll();
```

The key insight: always clear local data (defense in depth), but surface the server failure so the user knows the server session may still be active.

**Testing:** Simulate server unavailability during logout. Verify local data is cleared. Verify user sees a warning if desired.

---

## #33 — LOW: Decryption Failures Hidden as Placeholders

**File:** `packages/hooks/src/items/use-vault-items.ts:156`

**Problem:** Failed decryptions return placeholder items with `title: "[Decryption Failed]"` that blend in with real items. Users won't know if their vault is corrupted, if the wrong key is being used, or if items were tampered with.

```typescript
// CURRENT — silent placeholder
return {
    id: item.id,
    vaultId: item.vaultId,
    category: item.category as ItemCategory,
    title: "[Decryption Failed]",
    // ... metadata only
} as DecryptedItem;
```

**Fix:** Track failed decryptions separately and surface them to the user.

```typescript
// Instead of mixing placeholders with real items, track failures
const decryptedItems: DecryptedItem[] = [];
const failedItems: Array<{ id: string; vaultId: string }> = [];

for (const item of rawItems) {
    try {
        const decrypted = await decryptItem(item, vaultKey);
        decryptedItems.push(decrypted);
    } catch {
        failedItems.push({ id: item.id, vaultId: item.vaultId });
    }
}

// Return both lists so the UI can show a warning banner
return { items: decryptedItems, failedCount: failedItems.length };
```

The UI can then show a warning like "X items could not be decrypted" with a suggestion to re-login or contact support.

**Testing:** Corrupt an item's encrypted data and verify the failure is surfaced to the user rather than hidden.

---

## #38 — LOW: Emails in Unlock Error Messages

**File:** `packages/hooks/src/hooks/auth/use-quick-unlock-all.ts:168-170`

**Problem:** Error messages include all account email addresses that failed to unlock. These may be sent to error reporting services or shown in UI contexts where they shouldn't be visible.

```typescript
// CURRENT — emails in error message
throw new Error(
    `Failed to unlock any accounts. ${failed.map((f) => `${f.email}: ${f.error}`).join("; ")}`,
);
```

**Fix:** Remove emails from the error message. Return structured error data instead.

```typescript
throw new Error(
    `Failed to unlock ${failed.length} account(s). Please check your password and try again.`,
);
```

The `failed` array with emails is already available in the `QuickUnlockAllResult` returned by the mutation, so consumers can access the details if needed without putting them in the error message string.

**Testing:** Trigger unlock failure and verify error message doesn't contain email addresses.

---

## Implementation Order

1. **#12** (sanitize error logging) — immediate, minimal changes
2. **#38** (remove emails from errors) — immediate, one-line fix
3. **#21** (mandatory server proof) — requires verifying server returns proof
4. **#27** (account switch race) — needs careful testing
5. **#32** (logout error handling) — UI decision needed
6. **#33** (surface decryption failures) — requires UI changes
