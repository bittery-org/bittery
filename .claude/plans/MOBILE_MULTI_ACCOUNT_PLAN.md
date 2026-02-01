# Mobile Multi-Account Mode Implementation Plan

> **Status:** Planning Phase
> **Created:** 2026-02-02
> **Priority:** P0 (Critical Security Fixes) + P1 (Feature)

## Executive Summary

This document outlines the implementation plan for adding multi-account support to the Bittery mobile app, with special focus on the Android credential-provider (autofill) module. The plan addresses **critical security vulnerabilities** that could enable cross-account credential leakage, then builds comprehensive multi-account functionality with "All Accounts" mode.

### Critical Security Issue

**Attack Scenario:**
1. User unlocks Account A → MUK stored in global `VaultStateManager`
2. User switches to Account B in main app
3. Autofill still has Account A's MUK in memory
4. Database queries return items from ALL accounts (no userId filtering)
5. **Result: Account B user can access Account A's credentials without authentication**

### Confirmed Vulnerabilities

From code analysis on 2026-02-02:

1. **VaultStateManager.kt:31** - Single global MUK, no account tracking
   ```kotlin
   private var masterUnlockKey: ByteArray? = null  // GLOBAL!
   ```

2. **AutofillAuthActivity.kt:65-70** - No account validation
   ```kotlin
   if (VaultStateManager.isUnlocked()) {  // No email parameter!
       buildAndFinish(VaultStateManager.getMasterUnlockKey())
   }
   ```

3. **ItemDao.kt:44-50, 56-65** - Missing userId filters
   ```kotlin
   // Returns items from ALL accounts!
   suspend fun getLoginItemsByDomain(domain: String): List<ItemEntity>
   ```

4. **account-context.tsx** - Single account only, no "all accounts" support

---

## Implementation Phases

### Phase 1: CRITICAL SECURITY FIXES (MUST COMPLETE FIRST)
**Priority: P0 - Security Blocking**
**Timeline: Week 1 (5 days)**

#### 1.1 Refactor VaultStateManager to Per-Account MUK Management

**File:** `apps/mobile/modules/credential-provider/android/src/main/java/expo/modules/credentialprovider/state/VaultStateManager.kt`

**Current Issue:**
```kotlin
// Line 30-31: Single global MUK
@Volatile
private var masterUnlockKey: ByteArray? = null
```

**Required Changes:**
```kotlin
// Replace single MUK with per-account Map
private val accountMuks = ConcurrentHashMap<String, AccountMukData>()

data class AccountMukData(
    val muk: ByteArray,
    val timestamp: Long
)

// New methods:
fun setMasterUnlockKey(muk: ByteArray, email: String) {
    lock.write {
        // Clear previous key for this account (security: zero out memory)
        accountMuks[email]?.muk?.fill(0)

        // Store new key with timestamp
        accountMuks[email] = AccountMukData(
            muk = muk.copyOf(),
            timestamp = System.currentTimeMillis()
        )
    }
}

fun getMasterUnlockKey(email: String): ByteArray? {
    return lock.read {
        accountMuks[email]?.muk?.copyOf()
    }
}

fun clearMasterUnlockKey(email: String) {
    lock.write {
        accountMuks[email]?.muk?.fill(0)
        accountMuks.remove(email)
    }
}

fun clearAllMasterUnlockKeys() {
    lock.write {
        accountMuks.values.forEach { it.muk.fill(0) }
        accountMuks.clear()
    }
}

fun isUnlocked(email: String): Boolean {
    return lock.read { accountMuks.containsKey(email) }
}

fun getUnlockedAccounts(): List<String> {
    return lock.read { accountMuks.keys.toList() }
}
```

**Security Considerations:**
- Use ConcurrentHashMap for thread-safety
- Zero out ByteArray memory before clearing (prevent memory dumps)
- Return copies of MUK to prevent external modification
- Use read-write locks for compound operations

**Testing Requirements:**
- [ ] Unit tests for concurrent access to different account MUKs
- [ ] Verify memory is zeroed on clear
- [ ] Test that switching accounts doesn't leak MUKs
- [ ] Load test with 10+ accounts

---

#### 1.2 Add Account Validation to AutofillAuthActivity

**File:** `apps/mobile/modules/credential-provider/android/src/main/java/expo/modules/credentialprovider/activity/AutofillAuthActivity.kt`

**Current Issue:**
```kotlin
// Line 54-56: No email parameter
usernameId = getParcelableExtraCompat(...)
passwordId = getParcelableExtraCompat(...)
domain = intent.getStringExtra(BitteryAutofillService.EXTRA_AUTOFILL_DOMAIN)
// ← NO EMAIL!

// Line 65: No account context
val isUnlocked = VaultStateManager.isUnlocked()
```

**Required Changes:**

1. Add email to intent extras (in `BitteryAutofillService.kt`):
```kotlin
const val EXTRA_AUTOFILL_EMAIL = "autofill_email"
```

2. Update `AutofillAuthActivity.onCreate()`:
```kotlin
private var targetEmail: String? = null

override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    // Get target email from intent or active account
    targetEmail = intent.getStringExtra(BitteryAutofillService.EXTRA_AUTOFILL_EMAIL)

    if (targetEmail == null) {
        targetEmail = storageManager.getActiveAccountEmail()
    }

    if (targetEmail == null) {
        finishWithError("No active account")
        return
    }

    Log.d(TAG, "Autofill for account: $targetEmail")

    // CRITICAL: Validate session exists for this account
    if (!storageManager.hasValidSession(targetEmail!!)) {
        finishWithError("Invalid session for account $targetEmail")
        return
    }

    // Check if vault is unlocked FOR THIS SPECIFIC ACCOUNT
    val isUnlocked = VaultStateManager.isUnlocked(targetEmail!!)
    Log.d(TAG, "Vault unlocked for $targetEmail: $isUnlocked")

    if (isUnlocked) {
        buildAndFinish(
            VaultStateManager.getMasterUnlockKey(targetEmail!!),
            targetEmail!!
        )
        return
    }

    unlockAndContinue()
}

private fun buildAndFinish(muk: ByteArray?, email: String) {
    // Pass email to dataset builder for userId filtering
    val fieldIds = AutofillDatasetBuilder.FieldIds(usernameId, passwordId)

    activityScope.launch {
        val datasets = withContext(Dispatchers.IO) {
            datasetBuilder.buildDatasets(
                fieldIds = fieldIds,
                domain = domain,
                muk = muk,
                email = email,  // ← NEW: Pass email for filtering
                inlineSpec = null,
                attributionIntent = null
            )
        }

        // ... rest of implementation
    }
}
```

**Security Considerations:**
- Validate session exists before any unlock attempts
- Log account email for audit trail
- Pass email to all downstream operations
- Reject autofill if no valid account context

**Testing Requirements:**
- [ ] Test autofill with Account A unlocked
- [ ] Switch to Account B in main app (without unlocking)
- [ ] Trigger autofill → must require authentication for B
- [ ] Verify Account A's MUK is NOT accessible during B's autofill

---

#### 1.3 Add UserId Filtering to Database Queries

**File:** `apps/mobile/modules/credential-provider/android/src/main/java/expo/modules/credentialprovider/storage/dao/ItemDao.kt`

**Current Issue:**
```kotlin
// Line 44-50: Missing userId filter
@Query("""
    SELECT DISTINCT i.* FROM items i
    INNER JOIN item_domains d ON i.id = d.itemId
    WHERE d.domain = :domain AND i.category = 'login'
    ORDER BY i.lastUsedAt DESC, i.displayTitle ASC
""")
suspend fun getLoginItemsByDomain(domain: String): List<ItemEntity>
```

**Required Changes:**

Add userId parameter to ALL autofill queries:

```kotlin
// Update getLoginItemsByDomain
@Query("""
    SELECT DISTINCT i.* FROM items i
    INNER JOIN item_domains d ON i.id = d.itemId
    WHERE d.domain = :domain
      AND i.category = 'login'
      AND i.userId = :userId
    ORDER BY i.lastUsedAt DESC, i.displayTitle ASC
""")
suspend fun getLoginItemsByDomain(domain: String, userId: String): List<ItemEntity>

// Update getLoginItemsByDomainWithFallback
@Query("""
    SELECT DISTINCT i.* FROM items i
    INNER JOIN item_domains d ON i.id = d.itemId
    WHERE (d.domain = :domain OR d.domain = :parentDomain)
      AND i.category = 'login'
      AND i.userId = :userId
    ORDER BY
        CASE WHEN d.domain = :domain THEN 0 ELSE 1 END,
        i.lastUsedAt DESC,
        i.displayTitle ASC
""")
suspend fun getLoginItemsByDomainWithFallback(
    domain: String,
    parentDomain: String,
    userId: String
): List<ItemEntity>
```

**Security Considerations:**
- EVERY autofill query must filter by userId
- No fallback to all-items queries if userId missing
- Validate userId exists before query
- Log userId in queries for audit trail

**Testing Requirements:**
- [ ] Insert 10 items for Account A (userId: "user-a")
- [ ] Insert 10 items for Account B (userId: "user-b")
- [ ] Query with userId "user-a" → Assert: ONLY Account A's 10 items returned
- [ ] Query with userId "user-b" → Assert: ONLY Account B's 10 items returned
- [ ] Query with invalid userId → Assert: Empty result

---

#### 1.4 Fix Credential Provider Service UserId Filtering

**File:** `apps/mobile/modules/credential-provider/android/src/main/java/expo/modules/credentialprovider/service/BitteryCredentialProviderService.kt`

**Current Issue:**
```kotlin
// Line 130-138: No userId passed to queries
val items = if (domain.isNotEmpty() && parentDomain.isNotEmpty()) {
    database.itemDao().getLoginItemsByDomainWithFallback(domain, parentDomain)
} else if (domain.isNotEmpty()) {
    database.itemDao().getLoginItemsByDomain(domain)
} else {
    // TODO: Get userId from active account
    emptyList()
}
```

**Required Changes:**

1. Add helpers to `CredentialStorageManager`:
```kotlin
class CredentialStorageManager(private val context: Context) {

    suspend fun getActiveAccountUserId(): String? {
        val activeAccount = getActiveAccount()
        if (activeAccount?.type != "single") return null

        val sessionData = getStoredSessionData(activeAccount.email)
        return sessionData?.userId
    }

    suspend fun getUserIdForEmail(email: String): String? {
        val sessionData = getStoredSessionData(email)
        return sessionData?.userId
    }

    suspend fun getUnlockedAccountUserIds(): List<Pair<String, String>> {
        // Returns list of (email, userId) for all unlocked accounts
        val unlockedEmails = VaultStateManager.getUnlockedAccounts()
        return unlockedEmails.mapNotNull { email ->
            getUserIdForEmail(email)?.let { userId -> email to userId }
        }
    }
}
```

2. Update `BitteryCredentialProviderService.onBeginGetCredentialRequest()`:

**Option A: Active Account Only (More Secure)**
```kotlin
override fun onBeginGetCredentialRequest(
    request: BeginGetCredentialRequest,
    cancellationSignal: CancellationSignal,
    callback: OutcomeReceiver<BeginGetCredentialResponse, GetCredentialException>
) {
    serviceScope.launch {
        try {
            // Get active account email
            val activeEmail = storageManager.getActiveAccountEmail()
            if (activeEmail == null) {
                Log.w(TAG, "No active account")
                callback.onResult(BeginGetCredentialResponse.Builder()
                    .setAuthenticationActions(listOf(createUnlockAction()))
                    .build())
                return@launch
            }

            // Get userId for active account
            val userId = storageManager.getUserIdForEmail(activeEmail)
            if (userId == null) {
                Log.w(TAG, "No userId for account $activeEmail")
                callback.onResult(BeginGetCredentialResponse.Builder()
                    .setAuthenticationActions(listOf(createUnlockAction()))
                    .build())
                return@launch
            }

            // Check if this account's vault is unlocked
            val isAccountUnlocked = VaultStateManager.isUnlocked(activeEmail)

            // Query items with userId filtering
            if (isAccountUnlocked) {
                val items = if (domain.isNotEmpty() && parentDomain.isNotEmpty()) {
                    database.itemDao().getLoginItemsByDomainWithFallback(domain, parentDomain, userId)
                } else if (domain.isNotEmpty()) {
                    database.itemDao().getLoginItemsByDomain(domain, userId)
                } else {
                    database.itemDao().getLoginItemsByUserId(userId)
                }

                Log.d(TAG, "Found ${items.size} items for user $userId (email: $activeEmail)")
                // Build credential entries...
            }

            // ... rest of implementation
        } catch (e: Exception) {
            Log.e(TAG, "Error in onBeginGetCredentialRequest", e)
            callback.onError(GetCredentialUnknownException(e.message))
        }
    }
}
```

**Option B: All Unlocked Accounts (More Convenient)**
```kotlin
override fun onBeginGetCredentialRequest(
    request: BeginGetCredentialRequest,
    cancellationSignal: CancellationSignal,
    callback: OutcomeReceiver<BeginGetCredentialResponse, GetCredentialException>
) {
    serviceScope.launch {
        try {
            // Get all unlocked accounts
            val unlockedAccounts = storageManager.getUnlockedAccountUserIds()

            if (unlockedAccounts.isEmpty()) {
                Log.w(TAG, "No unlocked accounts")
                callback.onResult(BeginGetCredentialResponse.Builder()
                    .setAuthenticationActions(listOf(createUnlockAction()))
                    .build())
                return@launch
            }

            Log.d(TAG, "Querying credentials from ${unlockedAccounts.size} unlocked accounts")

            // Query items from ALL unlocked accounts
            val allItems = mutableListOf<ItemEntity>()

            for ((email, userId) in unlockedAccounts) {
                val items = if (domain.isNotEmpty() && parentDomain.isNotEmpty()) {
                    database.itemDao().getLoginItemsByDomainWithFallback(domain, parentDomain, userId)
                } else if (domain.isNotEmpty()) {
                    database.itemDao().getLoginItemsByDomain(domain, userId)
                } else {
                    database.itemDao().getLoginItemsByUserId(userId)
                }

                Log.d(TAG, "Found ${items.size} items for $email (userId: $userId)")
                allItems.addAll(items)
            }

            // Deduplicate by itemId (in case same item in multiple accounts)
            val uniqueItems = allItems.distinctBy { it.id }

            Log.d(TAG, "Total unique items across all unlocked accounts: ${uniqueItems.size}")

            // Decrypt and build credential entries
            val credentialEntries = uniqueItems.mapNotNull { item ->
                try {
                    // Get the account email for this item (from userId)
                    val accountEmail = unlockedAccounts.find { it.second == item.userId }?.first
                    if (accountEmail == null) {
                        Log.w(TAG, "No account found for userId ${item.userId}")
                        return@mapNotNull null
                    }

                    // Get MUK for this account
                    val muk = VaultStateManager.getMasterUnlockKey(accountEmail)
                    if (muk == null) {
                        Log.w(TAG, "No MUK for account $accountEmail")
                        return@mapNotNull null
                    }

                    // Decrypt and build credential entry
                    buildCredentialEntry(item, muk, accountEmail)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to process item ${item.id}", e)
                    null
                }
            }

            // ... rest of implementation with credentialEntries
        } catch (e: Exception) {
            Log.e(TAG, "Error in onBeginGetCredentialRequest", e)
            callback.onError(GetCredentialUnknownException(e.message))
        }
    }
}
```

**Recommendation: Use Option B (All Unlocked Accounts)**

Why:
- User has already authenticated and unlocked these accounts
- More convenient UX - see all available credentials
- Consistent with desktop/extension behavior
- Items can be labeled with account email in UI
- No security downside - user has access to all accounts anyway

**Security Considerations:**
- Only query items from accounts that are currently unlocked (have MUK in VaultStateManager)
- Filter by userId for each account to prevent cross-account leakage
- Log which accounts are being queried for audit trail
- Decrypt each item with correct account's MUK

**Testing Requirements:**
- [ ] Sign in with Account A, sync 5 credentials
- [ ] Sign in with Account B, sync 5 different credentials
- [ ] Unlock both accounts
- [ ] Request autofill → Should show credentials from BOTH accounts (10 total)
- [ ] Lock Account A
- [ ] Request autofill → Should show only Account B's credentials (5 total)
- [ ] Verify each credential decrypts with correct account's MUK
- [ ] Verify items are labeled with account email for clarity

---

#### 1.5 Update BiometricAuthContext for Per-Account Lock

**Files:**
- `apps/mobile/modules/credential-provider/src/CredentialProviderModule.kt`
- `apps/mobile/src/contexts/biometric-auth-context.tsx`

**Current Issue:**
```typescript
// BiometricAuthContext.tsx line 78-82: Clears global MUK
if (Platform.OS === "android" && CredentialProvider.isAvailable()) {
    CredentialProvider.clearMasterUnlockKey();  // ← No account context!
}
```

**Required Changes:**

1. Update Kotlin module:
```kotlin
@ReactMethod
fun clearMasterUnlockKey(email: String? = null, promise: Promise? = null) {
    try {
        if (email != null) {
            VaultStateManager.clearMasterUnlockKey(email)
            Log.d(TAG, "Cleared MUK for account: $email")
        } else {
            VaultStateManager.clearAllMasterUnlockKeys()
            Log.d(TAG, "Cleared all MUKs")
        }
        promise?.resolve(true)
    } catch (e: Exception) {
        Log.e(TAG, "Failed to clear MUK", e)
        promise?.reject("CLEAR_ERROR", e.message, e)
    }
}

@ReactMethod
fun setMasterUnlockKey(mukBase64: String, email: String? = null, promise: Promise? = null) {
    try {
        val muk = Base64.decode(mukBase64, Base64.NO_WRAP)

        if (email != null) {
            VaultStateManager.setMasterUnlockKey(muk, email)
            Log.d(TAG, "Set MUK for account: $email")
        } else {
            // Fallback: get active account email
            val activeEmail = storageManager.getActiveAccountEmail()
            if (activeEmail != null) {
                VaultStateManager.setMasterUnlockKey(muk, activeEmail)
                Log.d(TAG, "Set MUK for active account: $activeEmail")
            } else {
                throw IllegalStateException("No email provided and no active account")
            }
        }
        promise?.resolve(true)
    } catch (e: Exception) {
        Log.e(TAG, "Failed to set MUK", e)
        promise?.reject("SET_ERROR", e.message, e)
    }
}
```

2. Update BiometricAuthContext:
```typescript
const handleAppStateChange = useCallback(async (nextAppState: AppStateStatus) => {
    if (!activeAccount) return;

    // App going to background
    if (appState.current === "active" &&
        (nextAppState === "background" || nextAppState === "inactive")) {
        await storage.storeBackgroundTimestamp(activeAccount.email);
    }

    // App coming back to foreground
    if ((appState.current === "background" || appState.current === "inactive") &&
        nextAppState === "active") {

        const shouldRequireAuth = await storage.shouldRequireAuthAfterBackground(
            activeAccount.email
        );

        if (shouldRequireAuth) {
            // CRITICAL: Clear MUK for THIS ACCOUNT ONLY
            await storage.clearMasterUnlockKey(activeAccount.email);

            if (Platform.OS === "android" && CredentialProvider.isAvailable()) {
                CredentialProvider.clearMasterUnlockKey(activeAccount.email);  // ← Pass email!
            }

            // ... trigger re-auth UI
        }
    }

    appState.current = nextAppState;
}, [activeAccount, router]);
```

**Security Considerations:**
- Clear only specific account's MUK on auto-lock
- Preserve other unlocked accounts
- Log which account is being locked
- Handle null email gracefully

**Testing Requirements:**
- [ ] Unlock Account A and Account B
- [ ] Background the app (Account A is active)
- [ ] Wait past Account A's auto-lock timeout
- [ ] Foreground the app
- [ ] Verify: Account A's MUK is cleared (requires re-auth)
- [ ] Verify: Account B's MUK remains (still unlocked)

---

#### 1.6 Fix Multi-Account Sync Support

**File:** `apps/mobile/src/hooks/use-credential-provider-sync.ts`

**Current Issue:**
```typescript
// Line 199-202: Skips "all accounts" mode
const activeAccount = await storage.getActiveAccount();
if (!activeAccount || activeAccount.type !== "single") {
    console.warn("[CredentialProviderSync] No single active account, skipping vault sync");
    return null;
}
```

**Required Changes:**

```typescript
const syncVaultData = useCallback(async (): Promise<{
    vaultKeys: number;
    items: number;
    domains: number;
} | null> => {
    if (!isAvailable || Platform.OS !== "android") {
        return null;
    }

    try {
        const activeAccount = await storage.getActiveAccount();

        // Determine which accounts to sync
        let accountsToSync: string[] = [];

        if (!activeAccount) {
            console.warn("[CredentialProviderSync] No active account");
            return null;
        }

        if (activeAccount.type === "single") {
            accountsToSync = [activeAccount.email];
        } else if (activeAccount.type === "all") {
            // Get all unlocked accounts
            const unlockedAccounts = await storage.getUnlockedAccounts();
            if (unlockedAccounts.length === 0) {
                console.warn("[CredentialProviderSync] No unlocked accounts in all mode");
                return null;
            }
            accountsToSync = unlockedAccounts;
        }

        console.log(`[CredentialProviderSync] Syncing ${accountsToSync.length} accounts`);

        let totalVaultKeys = 0;
        let totalItems = 0;
        let totalDomains = 0;

        // Sync each account separately with correct userId
        for (const email of accountsToSync) {
            const result = await syncSingleAccount(email);
            if (result) {
                totalVaultKeys += result.vaultKeys;
                totalItems += result.items;
                totalDomains += result.domains;
            }
        }

        return {
            vaultKeys: totalVaultKeys,
            items: totalItems,
            domains: totalDomains,
        };
    } catch (err) {
        console.error("[CredentialProviderSync] Multi-account sync failed:", err);
        return null;
    }
}, [isAvailable]);

async function syncSingleAccount(email: string): Promise<{
    vaultKeys: number;
    items: number;
    domains: number;
} | null> {
    console.log(`[CredentialProviderSync] Syncing account: ${email}`);

    // Get session data for this account
    const sessionData = await storage.getStoredSessionData(email);
    if (!sessionData) {
        console.warn(`[CredentialProviderSync] No session data for ${email}`);
        return null;
    }

    const userId = sessionData.userId;
    console.log(`[CredentialProviderSync] UserId for ${email}: ${userId}`);

    // Get vault keys for this account
    const vaultKeys = await storage.getVaultKeys(email);
    if (!vaultKeys || vaultKeys.length === 0) {
        console.warn(`[CredentialProviderSync] No vault keys for ${email}`);
        return null;
    }

    // Filter items to those from this account's vaults
    const vaultIdsWithKeys = new Set(vaultKeys.map(vk => vk.vaultId));
    const accountItems = items.filter(
        item => item.category === "login" &&
                vaultIdsWithKeys.has(item.vaultId) &&
                item._encrypted
    );

    console.log(`[CredentialProviderSync] Account ${email}: ${accountItems.length} items from ${vaultKeys.length} vaults`);

    // Prepare sync data WITH userId
    const syncData = {
        userId,  // ← CRITICAL: Include userId for database filtering
        vaultKeys: prepareVaultKeysData(vaultKeys),
        items: prepareItemsData(accountItems, userId),
    };

    // Sync to native database
    const result = await CredentialProvider.syncVaultData(JSON.stringify(syncData));
    console.log(`[CredentialProviderSync] Sync result for ${email}:`, result);
    return result;
}
```

**Security Considerations:**
- Tag each item with correct userId during sync
- Filter items to vaults user has keys for
- Sync accounts independently
- Validate userId exists before syncing

**Testing Requirements:**
- [ ] Sign in with Account A and Account B
- [ ] Switch to "All Accounts" mode
- [ ] Trigger sync
- [ ] Verify native database has items with userId "user-a" and userId "user-b"
- [ ] Request autofill while Account A is active → Only userId "user-a" items
- [ ] Switch to Account B as active → Only userId "user-b" items

---

### Phase 2: App-Level Multi-Account Support
**Priority: P1 - Feature Critical**
**Timeline: Week 2 (5 days)**

#### 2.1 Enhance AccountProvider for All Accounts Mode

**File:** `apps/mobile/src/contexts/account-context.tsx`

**Add to context interface:**
```typescript
interface AccountContextValue {
    allAccounts: AccountMetadata[];
    activeAccount: AccountMetadata | null;
    activeMode: ActiveAccount;        // NEW: single/all/null
    unlockedAccounts: string[];       // NEW: unlocked emails
    isLoading: boolean;
    refreshAccounts: () => Promise<void>;
    switchAccount: (email: string) => Promise<void>;
    switchToAllAccounts: () => Promise<void>;  // NEW
    removeAccount: (email: string) => Promise<void>;
    lockAccount: (email: string) => Promise<void>;     // NEW
    lockAllAccounts: () => Promise<void>;              // NEW
}
```

**Implementation:**
- Track active mode: "single" | "all" | null
- Track unlocked accounts via `storage.getUnlockedAccounts()`
- Support switching to "all accounts" mode
- Lock individual accounts or all accounts
- Refresh unlocked state periodically (every 5-10 seconds)

---

#### 2.2 Multi-Account Biometric Unlock

**File:** `apps/mobile/src/contexts/biometric-auth-context.tsx`

**New function:**
```typescript
const unlockMultipleAccountsWithBiometric = async (
    emails: string[]
): Promise<Map<string, BiometricAuthResult>>
```

**Implementation:**
- Show single biometric prompt for all accounts
- On success, decrypt MUK for each account
- Set MUK in memory and native for each account
- Return success/failure map per account
- Use biometric grace period (10 min)

**UX:** Single biometric prompt unlocks all accounts with biometric enabled

---

#### 2.3 Integrate useAccountSwitcher Hook

**File:** `apps/mobile/src/components/account-switcher.tsx` (new)

**Integration:**
- Use existing `useAccountSwitcher` hook from `@bittery/hooks`
- Display all accounts with locked/unlocked indicators
- "All Accounts" mode option
- Lock individual or all accounts
- Add account button
- Account-specific settings access

**Placement:** Header component, settings screen

---

#### 2.4 Query Hooks Integration

**Files:** Various in `@bittery/hooks`

**Note:** The existing `useItemsUnified` hook in `@bittery/hooks` already handles multi-account queries correctly by respecting the active account mode and querying across unlocked accounts when appropriate.

**Mobile App Changes Needed:**
- Ensure AccountProvider tracks `activeMode` and `unlockedAccounts` properly
- Invalidate queries when switching accounts or locking/unlocking accounts
- No changes to existing hooks required - they already support multi-account

---

### Phase 3: UI/UX Enhancements
**Timeline: Week 3 Days 1-2**

#### 3.1 Unlock Screen Updates

**File:** `apps/mobile/app/(auth)/unlock.tsx`

**Add:**
- Account picker if multiple accounts exist
- "Unlock All" button for biometric unlock of all accounts
- Show unlocked accounts count
- Switch to "All Accounts" mode after unlocking multiple

---

#### 3.2 Vault Screen Updates

**File:** `apps/mobile/app/(app)/vault.tsx`

**Add:**
- Account email badge on items when in "all accounts" mode
- Unlocked accounts indicator in header
- Filter by account option
- Visual distinction between single/all modes

---

#### 3.3 Settings Integration

**Add settings:**
- Account switcher in settings
- Per-account auto-lock timeout
- Per-account biometric settings
- Remove account option

---

### Phase 4: Testing & Validation
**Timeline: Week 3 Days 3-5**

#### 4.1 Security Test Suite (CRITICAL)

**Test 1: Cross-Account Isolation**
- Unlock Account A
- Switch to Account B (don't unlock)
- Trigger autofill
- ✓ Assert: Only Account B's credentials shown (or unlock required)
- ✓ Assert: Account A's MUK not accessible

**Test 2: Database Filtering**
- Insert 10 items for Account A (userId: "user-a")
- Insert 10 items for Account B (userId: "user-b")
- Query with userId "user-a"
- ✓ Assert: Only 10 Account A items returned
- Switch active account to B
- Trigger autofill
- ✓ Assert: Only Account B's items shown

**Test 3: Auto-Lock Per Account**
- Unlock Account A and B
- Set Account A as active
- Background app, wait past timeout
- Foreground app
- ✓ Assert: Account A locked, Account B still unlocked

**Test 4: Multi-Account Sync**
- Sign in with 2 accounts
- Switch to "all accounts" mode
- Sync credentials
- ✓ Verify database has correct userId for each item
- ✓ Verify autofill returns correct items per account

---

#### 4.2 Integration Tests

- Switch between single account and all accounts mode
- Unlock multiple accounts with single biometric
- Query items across accounts
- Lock individual accounts
- Remove account while in all accounts mode
- Restore session after app restart

---

#### 4.3 Performance Tests

- Test with 10+ accounts
- Measure sync time for all accounts
- Measure query performance with userId filtering
- Verify no memory leaks with per-account MUK storage
- Measure biometric unlock time for multiple accounts

---

### Phase 5: Backward Compatibility

#### 5.1 Migration Strategy

- Existing users: Continue single-account mode by default
- Add "Add Another Account" option in settings
- Preserve existing biometric settings per account
- No breaking changes to storage format
- Auto-migrate global MUK to per-account on first use

#### 5.2 Rollout Plan

1. Deploy Phase 1 security fixes first - no user-facing changes
2. Run security test suite - must pass 100%
3. Enable multi-account UI for new users
4. Gradual rollout to existing users via feature flag
5. Monitor for issues, rollback if needed

---

## Critical Files to Modify

### Phase 1: Security Fixes
1. `apps/mobile/modules/credential-provider/android/src/main/java/expo/modules/credentialprovider/state/VaultStateManager.kt`
2. `apps/mobile/modules/credential-provider/android/src/main/java/expo/modules/credentialprovider/activity/AutofillAuthActivity.kt`
3. `apps/mobile/modules/credential-provider/android/src/main/java/expo/modules/credentialprovider/storage/dao/ItemDao.kt`
4. `apps/mobile/modules/credential-provider/android/src/main/java/expo/modules/credentialprovider/service/BitteryCredentialProviderService.kt`
5. `apps/mobile/modules/credential-provider/src/CredentialProviderModule.kt`
6. `apps/mobile/src/contexts/biometric-auth-context.tsx`
7. `apps/mobile/src/hooks/use-credential-provider-sync.ts`

### Phase 2: Multi-Account Support
8. `apps/mobile/src/contexts/account-context.tsx`
9. `apps/mobile/app/(auth)/unlock.tsx`
10. `apps/mobile/src/components/account-switcher.tsx` (new)

---

## Edge Cases & Security Considerations

### Edge Cases

1. **Account removed while unlocked:** Clear MUK immediately, invalidate all queries
2. **Biometric disabled mid-session:** Gracefully fall back to password unlock
3. **30-day password re-entry during all accounts unlock:** Show password screen for that account
4. **Network failure during sync:** Partial sync with rollback, retry on next sync
5. **Storage corruption:** Validate data before use, clear if invalid, log error
6. **Multiple rapid account switches:** Debounce switches, cancel in-flight queries
7. **Biometric hardware failure:** Fall back to password, clear biometric settings
8. **Database schema migration:** Handle gracefully, preserve userId in all migrations

### Security Validations

1. **Zero-knowledge maintained:** Each account has separate MUK encrypted with device key
2. **Session isolation:** Switching accounts clears previous account's queries
3. **No MUK persistence unencrypted:** MUK only in memory, encrypted at rest
4. **Database isolation:** userId filtering on ALL queries, no exceptions
5. **Auto-lock enforcement:** Per-account timeouts respected, no global override
6. **Biometric security:** 30-day password re-entry enforced, 10-min grace period
7. **Memory security:** Zero out ByteArray on clear, no lingering secrets
8. **Audit logging:** Log all account operations, MUK operations, autofill requests

---

## Verification Checklist

Before marking implementation complete, verify:

- [ ] No cross-account MUK access possible (verified via security tests)
- [ ] Database queries always filter by userId (code review + tests)
- [ ] Autofill returns only active account credentials (integration tests)
- [ ] Auto-lock clears correct account MUK (unit + integration tests)
- [ ] Biometric works with multiple accounts (manual testing)
- [ ] Sync includes userId for all items (verify database schema)
- [ ] Account switching invalidates queries (React Query devtools)
- [ ] No credential leakage in any test scenario (penetration testing)
- [ ] Performance acceptable with 10+ accounts (load testing)
- [ ] Backward compatible with existing users (migration testing)
- [ ] Memory properly zeroed on clear (memory profiling)
- [ ] All logging includes account context (log analysis)

---

## Implementation Timeline Summary

| Week | Phase | Focus | Deliverable |
|------|-------|-------|-------------|
| 1 | Phase 1 | Security Fixes | Per-account MUK, userId filtering, no cross-account leakage |
| 2 | Phase 2 | Multi-Account UI | All accounts mode, account switcher, multi-biometric unlock |
| 3 | Phases 3-4 | Polish & Testing | UI updates, comprehensive testing, security validation |

**Total Timeline:** 3 weeks (15 working days)

---

## Success Criteria

### Security (Must Pass - No Exceptions):
✓ Zero cross-account credential leakage
✓ All database queries filtered by userId
✓ Autofill respects active account context
✓ Auto-lock clears correct account MUK
✓ No security regression in any test
✓ All security tests passing at 100%

### Functionality:
✓ Switch between single/all accounts modes
✓ Single biometric unlocks multiple accounts
✓ Query items across unlocked accounts
✓ Lock individual or all accounts
✓ Sync credentials with correct userId
✓ Remove accounts without affecting others
✓ Restore sessions for multiple accounts

### Performance:
✓ Acceptable performance with 10+ accounts
✓ No memory leaks
✓ Sync completes within reasonable time
✓ UI remains responsive during operations

---

## References

- Original exploration: 3 explore agents ran on 2026-02-02
- Security analysis: Confirmed vulnerabilities via code review
- Desktop/extension reference: Already have working multi-account support
- Storage adapter: React Native adapter already supports multi-account (namespacing, caching)
