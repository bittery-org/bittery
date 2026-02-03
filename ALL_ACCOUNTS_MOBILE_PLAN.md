# Mobile "All Accounts" Mode Plan & Spec

Date: 2026-02-03

This document defines the implementation plan and spec for adding "All Accounts"
mode to the mobile app, integrating with storage, auth, and the credential-
provider module (autofill). This is a design/plan only; no code changes are
included here.

---

## Goals

- Add "All Accounts" mode to the mobile app (parity with desktop + extension).
- Single biometric prompt unlocks all accounts when enabled.
- Global (device-level) settings for auto-lock, biometric, and related auth
  behavior.
- Integrate "All Accounts" with the Android credential provider without data
  leakage.
- Use the existing hooks in `packages/hooks` that already support unified
  multi-account mode.

## Non-Goals

- Server-side changes.
- Desktop/extension UI changes (except for shared hooks behavior verification).
- Removing per-account server URL configuration (still per account).

---

## User Experience Spec

### Account Switcher
- Show "All Accounts" option only when 2+ accounts exist.
- Selecting "All Accounts":
  - If no accounts are unlocked: show toast + route to unlock (all).
  - If at least one account unlocked: set active account to `{ type: "all" }`
    and refresh.
- Trigger display:
  - In all-accounts mode show "All Accounts" label plus count of unlocked
    accounts.
  - Use avatar group (like extension) showing up to 2 unlocked accounts.

### Unlock Screen
- Supports both single-account and all-accounts unlock:
  - Password: `useQuickUnlockAll` when in all-accounts mode.
  - Biometric: `storage.unlockAllAccountsWithBiometric()` (single prompt).
- On success:
  - If multiple accounts exist, set active account to `{ type: "all" }`.
  - If only one account exists, set `{ type: "single", email }`.
- Partial success:
  - Show "Unlocked X of Y accounts".
  - Enter all-accounts mode with only unlocked accounts active.

### Vault Lists and Item Detail
- Do not show account labels/badges in item lists.
- Item detail views should remain unchanged unless specifically needed for
  editing flows (no account banner).
- Hooks already return account metadata in unified mode (no new API required).

### Create Item
- In all-accounts mode, user must choose a target account.
- Vault picker should show account name/email in the vault list.
- When a vault is selected, pass `accountEmail` to `useCreateItem`.

### Settings (Global)
Settings apply to all accounts on the device:
- Auto-lock timeout (global).
- Biometric unlock (global toggle).
- Master password re-entry cadence (global logic).
- Server URL remains per account.
UI copy should indicate "applies to all accounts on this device".

---

## Technical Design

### 1) Account Context (Mobile)
Update `apps/mobile/src/contexts/account-context.tsx` to:
- Expose `activeAccountConfig` (ActiveAccount from storage).
- Provide `activeAccount` only when config is `type === "single"`.
- Provide `isAllAccountsMode` boolean.
- Add `switchAllAccounts()` helper.
- Do not auto-rewrite `activeAccount` to first account when
  `type === "all"`.

### 2) Storage Adapter (React Native)
Implement missing multi-account biometric method.

`unlockAllAccountsWithBiometric()`
- Mirror desktop/tauri behavior:
  1) Find first account that supports biometric unlock.
  2) Show a single prompt.
  3) For each account, decrypt stored MUK with `skipBiometric = true`.
  4) Store MUK in memory for each account.
  5) Return `{ unlocked, failed }`.

Global settings storage:
- Introduce global (non-namespaced) keys:
  - `bittery_auto_lock_timeout_global`
  - `bittery_biometric_enabled_global`
- Add methods to read/write these values.
- When toggled:
  - Update all account-scoped settings for compatibility.
  - Update all `StoredSessionData.biometricEnabled` values to prevent stale
    auth checks.

### 3) Auth and Autolock
Update `apps/mobile/src/contexts/biometric-auth-context.tsx`:
- Treat auth as global when in all-accounts mode.
- On background:
  - Store single background timestamp (global).
- On foreground:
  - If auto-lock timeout elapsed:
    - `storage.lockAllAccounts()` and clear native MUK.
  - If biometric enabled:
    - `unlockAllAccountsWithBiometric()` (single prompt).
  - If master-password reentry required for any account:
    - Route to unlock (all) with clear messaging.

Update `apps/mobile/app/index.tsx`:
- If `activeAccountConfig.type === "all"`:
  - If any unlocked accounts -> proceed.
  - Else if any valid sessions -> route to unlock (all).
  - Else -> login.

### 4) Unified Hooks
- Use existing hooks:
  - `useItems()` already uses unified logic via `useItemsUnified`.
  - `useAllVaultKeys()` already carries account metadata in all-accounts mode.
  - `useUpdateItem()` already resolves the correct account by item.
- Ensure invalidation when switching to/from all-accounts mode:
  - Clear query cache and invalidate account-related queries.

---

## Credential Provider (Android Autofill) — Phase 2

Goal: full multi-account autofill with no data leakage.

### Security Model
- Store and query vault data scoped by `userId`.
- Maintain multiple MUKs in native memory, one per account.
- Autofill suggestions should be labeled per account.

### Native Changes (Android)
VaultStateManager:
- Extend to store multiple MUKs keyed by `userId` (or email):
  - `setMasterUnlockKey(userId, muk)`
  - `getMasterUnlockKey(userId)`
  - `clearMasterUnlockKey(userId)` and `clearAllMasterUnlockKeys()`
  - `isUnlocked(userId)`

Credential database queries:
- Enforce user scoping everywhere:
  - `ItemDao.getLoginItemsByDomain*` should accept `userId`.
  - `VaultKeyDao.getByVaultId` must include `userId`.

CredentialProviderService:
- Determine active users and build suggestions per account:
  - Use active account list from RN (or shared prefs).
  - Do not label suggestions with account name/email.

GetCredentialsActivity:
- When decrypting:
  - Use correct MUK for the item's `userId`.

### React Native Integration
CredentialProvider sync:
- Sync vault data for all unlocked accounts, each with its `userId`.
- Provide account metadata for display (labeling in autofill UI).

Unlock flow:
- When all-accounts unlock succeeds:
  - Set MUK in native VaultStateManager for each unlocked account.
  - Clear all on lock or auto-lock.

---

## Security and Edge Cases Checklist

1) ActiveAccount type "all" should never be auto-downgraded to "single".
2) Biometric toggle must update session data for all accounts to prevent stale
   biometric checks.
3) Autofill leakage:
   - Enforce userId scoping at DB and service layers.
   - Multiple MUKs required (no cross-account decrypt).
4) Partial unlock:
   - Items from locked accounts must not appear.
5) Master password re-entry:
   - If any unlocked account requires re-entry, force unlock screen.
6) Account removal:
   - If removing last unlocked account while in all-accounts mode, route to
     login/unlock.

---

## Implementation Steps (Suggested Order)

1) Account context updates (support all-accounts config).
2) Storage adapter:
   - `unlockAllAccountsWithBiometric()`
   - Global settings and session-data updates.
3) Account switcher UI (All Accounts option + avatar group).
4) Unlock screen changes (unlock all + biometric single prompt).
5) App entry routing + biometric auth context global handling.
6) Vault list UI account badges and create-item account selection.
7) Credential provider Phase 2 (multi-MUK + user scoped queries).
8) QA and regression testing.

---

## Testing Plan

- Multi-account login -> keep active as single; do not auto-switch to all.
- Switch between single and all modes without data leakage.
- Unlock all with password and biometric (single prompt).
- Auto-lock triggers one lock for all accounts.
- Items list shows account badges in all-accounts mode.
- Create item in all-accounts routes to correct account/vault.
- Autofill shows only correct account items; no cross-account leakage.

---

## Decisions (Locked)

- Autofill suggestions must not display account name/email.
- Item lists should not display account labels/badges.
- Do not auto-switch to all-accounts after adding a second account.
- No configurable "Autofill Account" preference for now.
