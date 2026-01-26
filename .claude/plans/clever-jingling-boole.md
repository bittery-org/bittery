# Plan: Redesign Account/Team Architecture (1Password Model)

## Current Architecture Analysis

### Database Relationships (Many-to-Many)
- **Users can belong to multiple teams** via `teamMember` join table
- One session = one user (single `userId` in JWT)
- `vault.list` returns ALL vaults across ALL teams for authenticated user
- No concept of "active team" - user sees everything they have access to

### Key Tables
```
user (id, email, name, srpSalt, srpVerifier, publicKey, encryptedPrivateKey)
  ↓ (1:many)
teamMember (userId, teamId, role)
  ↓ (many:1)
team (id, name, ownerId)
  ↓ (1:many)
vault (id, name, type, teamId nullable)
  ↓ (1:many)
vaultKey (vaultId, userId, encryptedVaultKey, role)
```

### Current Limitations
- Web app: `supportsMultiAccount = false`
- Desktop/Mobile: Stubs exist but not implemented
- Session tied to single user - no account switching without logout/login
- No "All Accounts" view

## Proposed Architecture (1Password Model)

### Core Changes

1. **User → Team: One-to-One Relationship**
   - Remove `teamMember` many-to-many join table
   - Add `teamId` FK directly to `user` table (required, indexed)
   - Each user belongs to exactly ONE team/organization
   - Teams represent either:
     - Personal team (individual plan)
     - Organization team (business/family plan)

2. **Multi-Account Support**
   - An "account" = a complete user record (email + credentials + team)
   - Users can add multiple accounts to the app (different emails)
   - Example: `john@personal.com` (personal team) + `john@company.com` (org team)
   - Each account maintains its own:
     - SRP credentials and Master Unlock Key
     - RSA key pair
     - Vaults and items
     - Team membership (exactly one)

3. **Multi-Session Management**
   - Desktop/Mobile: Store multiple encrypted sessions (one per account email)
   - Web: Support account switcher with multiple JWT tokens in storage
   - Extension: Support account selector in popup, background manages multiple MUKs
   - "All Accounts" mode: Load and decrypt data from all active sessions concurrently

## Implementation Plan

### Phase 1: Database Schema Migration

**Critical Files:**
- `packages/db/src/schema/auth.ts`
- `packages/db/src/schema/team.ts`

**Migration Workflow:**
1. Modify schema files in `packages/db/src/schema/`
2. Run `pnpm db:generate` to auto-generate migration SQL
3. Review generated migration in `packages/db/migrations/`
4. Run `pnpm db:migrate` to apply migration

**Schema Changes:**

1. **Add `teamId` and `role` to `user` table:**
   ```typescript
   // packages/db/src/schema/auth.ts
   export const user = pgTable("user", {
     // ... existing fields
     teamId: text("team_id").references(() => team.id, { onDelete: 'SET NULL' }),
     role: text("role", { enum: ['owner', 'admin', 'member'] }).default('owner').notNull(),
   });

   // Add index for team lookups
   export const userTeamIdIdx = index("user_team_id_idx").on(user.teamId);
   ```

3. **Add `type` and `memberLimit` to `team` table:**
   ```typescript
   // packages/db/src/schema/team.ts
   export const team = pgTable("team", {
     // ... existing fields
     type: text("type", { enum: ['personal', 'family', 'organization'] })
       .default('personal')
       .notNull(),
     memberLimit: integer("member_limit"), // NULL = unlimited
   });
   ```

4. **Deprecate `teamMember` table:**
   - Add `deprecated` boolean column
   - Mark all rows as deprecated in migration
   - Keep table for 1-2 releases for rollback safety
   - Remove in future migration after confirming stability

5. **Update relations:**
   ```typescript
   // User → Team relation
   export const userRelations = relations(user, ({ one }) => ({
     team: one(team, {
       fields: [user.teamId],
       references: [team.id],
     }),
   }));

   // Team → Users relation (one-to-many)
   export const teamRelations = relations(team, ({ many }) => ({
     users: many(user),
   }));
   ```

**Generated Migration (via `pnpm db:generate`):**
After modifying the schema files above, Drizzle will generate SQL migration that includes:
- `ALTER TABLE team ADD COLUMN type ...`
- `ALTER TABLE team ADD COLUMN member_limit ...`
- `ALTER TABLE "user" ADD COLUMN team_id ...`
- `ALTER TABLE "user" ADD COLUMN role ...`
- Index creation for `user.team_id`

**Post-Migration Data Backfill (optional script):**
Since there are no live users with multiple teams, the backfill is simple:
- Any existing users without `teamId` will get personal team on next login (handled in signup/login logic)
- Can write a one-time script to backfill existing users if needed
- Mark `teamMember` table as deprecated (add `deprecated BOOLEAN` column)

### Phase 2: API & Authentication Changes

**Critical Files:**
- `packages/api/src/routers/auth.ts`
- `packages/api/src/routers/team.ts`
- `packages/api/src/routers/vault.ts`

**Auth Router Changes:**

1. **Update `signup` mutation:**
   ```typescript
   // Remove organizationName input
   // Auto-create personal team

   signup: publicProcedure
     .input(z.object({
       email: z.string().email(),
       name: z.string().min(2),
       secretKeyHint: z.string(),
       // ... crypto fields
     }))
     .mutation(async ({ input }) => {
       // 1. Create user
       const userId = nanoid();

       // 2. Create personal team
       const teamId = nanoid();
       await db.insert(team).values({
         id: teamId,
         name: `${input.name}'s Team`,
         ownerId: userId,
         type: 'personal',
         memberLimit: 1,
       });

       // 3. Create user with teamId
       await db.insert(user).values({
         id: userId,
         teamId, // Link to personal team
         role: 'owner',
         // ... other fields
       });

       // 4. Create default personal vault
       // 5. Return session + team info
       return {
         userId,
         token,
         sessionId,
         user: {
           teamId,
           teamName: team.name,
           teamType: 'personal',
           role: 'owner',
         },
       };
     })
   ```

2. **Update `finishLogin` mutation:**
   ```typescript
   // Simplified query - no teamMember join needed

   finishLogin: publicProcedure
     .mutation(async ({ input }) => {
       // ... SRP verification ...

       // Get user with team (simple join)
       const userData = await db.query.user.findFirst({
         where: eq(user.id, userId),
         with: { team: true }, // Direct relation
       });

       return {
         token,
         serverProof,
         user: {
           teamId: userData.teamId,
           teamName: userData.team.name,
           teamType: userData.team.type,
           role: userData.role,
         },
       };
     })
   ```

**Team Router Changes:**

1. **Remove endpoints:**
   - DELETE: `team.addMember` (users can't be added to teams manually)
   - DELETE: `team.updateMemberRole` (use user.role instead)
   - DELETE: `team.removeMember` (users belong to exactly one team)

2. **Update `team.list`:**
   ```typescript
   // Now returns single team instead of array
   list: protectedProcedure
     .query(async ({ ctx }) => {
       const userData = await db.query.user.findFirst({
         where: eq(user.id, ctx.session.userId),
         with: { team: true },
       });

       return userData.team; // Single team, not array
     })
   ```

3. **Update invitation flow:**
   ```typescript
   inviteMember: protectedProcedure
     .input(z.object({
       teamId: z.string(),
       email: z.string().email(),
       role: z.enum(['admin', 'member']),
     }))
     .mutation(async ({ input }) => {
       // Check team capacity (family teams have limits)
       const team = await db.query.team.findFirst({
         where: eq(team.id, input.teamId),
         with: { users: true },
       });

       if (team.type === 'family') {
         const currentMembers = team.users.length;
         if (currentMembers >= team.memberLimit) {
           throw new TRPCError({
             code: 'BAD_REQUEST',
             message: 'Team has reached member limit',
           });
         }
       }

       // Create invitation (user will signup with this)
       const token = nanoid(32);
       await db.insert(teamInvitation).values({
         teamId: input.teamId,
         email: input.email,
         role: input.role,
         token,
         expiresAt: addDays(new Date(), 7),
       });

       return { token };
     })
   ```

4. **Add new endpoint for invitation signup:**
   ```typescript
   // In auth router
   signupWithInvitation: publicProcedure
     .input(z.object({
       token: z.string(),
       // ... standard signup fields
     }))
     .mutation(async ({ input }) => {
       // 1. Validate invitation
       const invitation = await db.query.teamInvitation.findFirst({
         where: eq(teamInvitation.token, input.token),
       });

       // 2. Create user account
       const userId = nanoid();
       await db.insert(user).values({
         id: userId,
         teamId: invitation.teamId, // User joins invited team
         role: invitation.role,
         // ... other fields
       });

       // 3. Grant vault access (encrypt vault keys with user's RSA public key)

       // 4. Mark invitation as accepted

       return { userId, teamId: invitation.teamId };
     })
   ```

**Vault Router Changes:**

1. **Simplify queries (no teamMember join):**
   ```typescript
   // Before: Join through teamMember
   const teamVaults = await db
     .select()
     .from(vault)
     .innerJoin(teamMember, eq(vault.teamId, teamMember.teamId))
     .where(eq(teamMember.userId, userId));

   // After: Direct query via user.teamId
   const userData = await db.query.user.findFirst({
     where: eq(user.id, userId),
   });

   const teamVaults = await db.query.vault.findMany({
     where: eq(vault.teamId, userData.teamId),
   });
   ```

2. **Update `vault.list` to return user's single team vaults:**
   ```typescript
   list: protectedProcedure
     .query(async ({ ctx }) => {
       // Get user's team
       const userData = await db.query.user.findFirst({
         where: eq(user.id, ctx.session.userId),
       });

       // Get all vaults for user's team
       const vaults = await db.query.vault.findMany({
         where: eq(vault.teamId, userData.teamId),
       });

       return vaults;
     })
   ```

### Phase 3: Storage Adapters & Multi-Account Session Management

**Critical Files:**
- `packages/storage/src/adapter.ts` (interface definition)
- Platform-specific adapters:
  - `packages/storage/src/adapters/web.ts` (no changes, single account)
  - `packages/storage/src/adapters/tauri.ts` (add multi-account support)
  - `packages/storage/src/adapters/chrome.ts` (add multi-account support)
  - `packages/storage/src/adapters/react-native.ts` (add multi-account support)

**Storage Structure:**
```typescript
// Multi-account data stored in localStorage/SecureStore/chrome.storage
interface MultiAccountSessionStorage {
  activeAccount: string | "all" | null;
  accounts: Record<string, AccountSessionData>;
  globalSettings: { lastActiveAt: number };
}

interface AccountSessionData {
  jwt: string;
  userId: string;
  email: string;
  teamId: string;
  teamName: string;
  teamType: "personal" | "family" | "organization";
  role: "owner" | "admin" | "member";
  secretKey: string; // Stored in plaintext (useless without password)
  encryptedSession: EncryptedData;
  vaultKeys: VaultKeyData[];
}

// In-memory only (NEVER persisted)
type MasterUnlockKeyCache = Map<string, Uint8Array>;
```

**Implementation:**
1. Desktop/Extension/Mobile adapters implement multi-account methods
2. Web adapter keeps single-account structure (`supportsMultiAccount = false`)
3. MUK cache lives in memory only, cleared on lock
4. Account switching updates `activeAccount` field
5. "All Accounts" mode sets `activeAccount = "all"`, loads all MUKs

### Phase 4: UI Components & Hooks

**Critical Files:**
- `packages/ui/src/components/account-switcher.tsx` (NEW)
- `packages/hooks/src/auth/use-account-switcher.ts` (NEW)
- `packages/hooks/src/vault/use-all-accounts-items.ts` (NEW)
- `apps/web/src/routes/all-accounts.tsx` (NEW - All Accounts view)
- Platform headers:
  - `apps/web/src/components/layout/header.tsx`
  - `apps/desktop/src/components/layout/sidebar.tsx`
  - `apps/extension/src/popup/components/header.tsx`

**New Hooks:**

1. **`useAccountSwitcher()`:**
   ```typescript
   export function useAccountSwitcher() {
     const accounts = useQuery(['accounts'], () => storage.getAccountsList());
     const activeEmail = useQuery(['activeAccount'], () => storage.getActiveAccountEmail());

     const switchAccount = useMutation(
       (email: string | "all") => storage.setActiveAccount(email)
     );

     const removeAccount = useMutation(
       (email: string) => storage.removeAccount(email)
     );

     return { accounts, activeEmail, switchAccount, removeAccount };
   }
   ```

2. **`useAllAccountsItems()`:**
   ```typescript
   export function useAllAccountsItems() {
     return useQuery(['all-accounts-items'], async () => {
       const unlockedEmails = await storage.getUnlockedAccounts();

       // Load items from each account
       const allItems = [];
       for (const email of unlockedEmails) {
         const vaultKeys = await storage.getVaultKeys(email);
         // Decrypt vault keys with account's MUK
         // Fetch items from API with account's JWT
         // Decrypt items and add to allItems
       }

       return allItems; // Unified list with source account
     });
   }
   ```

**UI Components:**

1. **Account Switcher Dropdown:**
   - Shows all added accounts
   - Displays active account badge
   - "All Accounts" option
   - "Add Account" button → navigates to login
   - "Lock All" button → clears all MUKs

2. **All Accounts View:**
   - Route: `/all-accounts/vaults`
   - Shows unified item list from all unlocked accounts
   - Each item displays: title, username, URL, **source account**
   - Search across all accounts
   - Filter by vault/account
   - Click item → shows detail with edit/copy actions

### Phase 5: Crypto & Multi-Account Key Management

**Critical Files:**
- `packages/storage/src/adapter.ts` (add MUK cache methods to interface)
- `packages/storage/src/adapters/*.ts` (implement MUK cache per adapter)
- `packages/hooks/src/auth/use-quick-unlock-all.ts` (NEW)
- Platform crypto wrappers (update to pass email parameter):
  - `apps/web/src/lib/wasm-crypto.ts`
  - `apps/desktop/src/lib/tauri-crypto.ts`
  - `apps/extension/src/lib/wasm-crypto.ts`
  - `apps/mobile/src/contexts/biometric-auth-context.tsx`

**Implementation:**

1. **MUK Cache (in-memory only, per storage adapter):**
   Each storage adapter (Tauri, Chrome, React Native) maintains its own in-memory MUK cache:
   ```typescript
   // In each adapter class (e.g., TauriStorageAdapter)
   export class TauriStorageAdapter implements IStorageAdapter {
     private mukCache: Map<string, Uint8Array> = new Map();

     async getMasterUnlockKey(email?: string): Promise<Uint8Array | null> {
       const activeEmail = email || await this.getActiveAccountEmail();
       if (!activeEmail || activeEmail === 'all') return null;
       return this.mukCache.get(activeEmail) || null;
     }

     async setMasterUnlockKey(key: Uint8Array, email: string): Promise<void> {
       this.mukCache.set(email, key);
     }

     async clearMasterUnlockKey(email?: string): Promise<void> {
       if (email) {
         this.mukCache.delete(email);
       } else {
         this.mukCache.clear(); // Lock all
       }
     }

     async getUnlockedAccounts(): Promise<string[]> {
       return Array.from(this.mukCache.keys());
     }
   }
   ```

2. **Quick Unlock All Accounts:**
   ```typescript
   async function quickUnlockAllAccounts(password: string) {
     const accounts = await storage.getAccountsList();

     for (const account of accounts) {
       const secretKey = account.secretKey;

       // Derive MUK from password + secret key
       const { masterUnlockKey } = await deriveKeys(
         password,
         secretKey,
         account.email
       );

       // Store in memory cache
       mukCache.set(account.email, masterUnlockKey);

       // Decrypt vault keys for this account
       for (const vaultKey of account.vaultKeys) {
         const decrypted = await decryptVaultKey(
           vaultKey.encryptedVaultKey,
           masterUnlockKey
         );
         // Store decrypted key (in memory)
       }
     }

     // Set active account to "all"
     await storage.setActiveAccount("all");
   }
   ```

3. **Account-Specific Crypto Operations:**
   - All crypto operations now accept optional `email` parameter
   - If no email provided, use active account
   - Vault key decryption: `decryptVaultKey(encrypted, email)`
   - Item decryption: `decryptItem(item, vaultId, email)`
   - RSA operations: `decryptWithPrivateKey(data, email)`

4. **Extension Background Service Worker:**
   - MUK cache lives in service worker memory
   - Autofill queries active account's items first
   - If no match, check other unlocked accounts
   - Prompt user: "Found login for {site} in {account}, switch?"

### Phase 6: Platform-Specific Integration

**Web (`apps/web`):**
- **NO CHANGES** - Keep `supportsMultiAccount = false`
- Single account only (simplest UX for web)
- Users wanting multiple accounts use desktop/extension

**Desktop (`apps/desktop`):**
- Implement multi-account in Tauri storage adapter
- Add account switcher to sidebar
- Biometric unlock: Prompt once, unlock all accounts
- Native menu items: "Switch Account", "Lock All"

**Extension (`apps/extension`):**
- Implement multi-account in Chrome storage adapter
- Add account switcher to popup header
- Background service worker: MUK cache in memory
- Autofill: Use active account, prompt if match in other account

**Mobile (`apps/mobile`):**
- Implement multi-account in React Native storage adapter
- Add account switcher to profile/settings screen
- Biometric unlock: Prompt once, unlock all accounts
- Credential Provider: Filter by active account

## Implementation Order

Execute phases in this specific order to avoid breaking changes:

**Week 1: Database & Schema**
1. Modify `packages/db/src/schema/auth.ts` (add `teamId`, `role` to user)
2. Modify `packages/db/src/schema/team.ts` (add `type`, `memberLimit`)
3. Update Drizzle relations (user → team, team → users)
4. Run `pnpm db:generate` to create migration
5. Review generated migration SQL
6. Run `pnpm db:migrate` on development database
7. Test data integrity

**Week 2: Backend API**
1. Update `auth.signup` to auto-create personal team
2. Update `auth.finishLogin` to return team info from user table
3. Simplify vault queries (remove teamMember joins)
4. Update team invitation flow
5. Add `auth.signupWithInvitation` endpoint
6. Remove deprecated team membership endpoints
7. Test API changes with Postman/REST client

**Week 3: Storage Adapters**
1. Define multi-account data structures in TypeScript
2. Update `IStorageAdapter` interface
3. Implement desktop adapter (Tauri)
4. Implement extension adapter (Chrome storage)
5. Implement mobile adapter (React Native)
6. Keep web adapter unchanged (single account)
7. Test storage operations on each platform

**Week 4: Auth Hooks & Crypto**
1. Create `useAccountSwitcher()` hook
2. Create `useQuickUnlockAll()` hook
3. Implement MUK cache (in-memory Map)
4. Update crypto wrappers to accept email parameter
5. Test multi-account unlock flow

**Week 5: UI Components**
1. Create account switcher component
2. Create All Accounts view route
3. Create `useAllAccountsItems()` hook
4. Integrate account switcher into platform headers
5. Test account switching UX

**Week 6: Platform Integration**
1. Desktop: Sidebar integration, biometric unlock
2. Extension: Popup integration, autofill logic
3. Mobile: Profile screen integration, credential provider
4. Test end-to-end multi-account flows on each platform

**Week 7: Testing & Polish**
1. Integration testing across all platforms
2. Edge case testing (session expiry, account removal)
3. Performance testing (All Accounts view with many items)
4. Security review (MUK cache isolation)
5. Documentation updates

## Critical Files

### Database
- `packages/db/src/schema/auth.ts` (add teamId to user)
- `packages/db/src/schema/team.ts` (add type, remove teamMember)

### API
- `packages/api/src/routers/auth.ts` (signup creates personal team)
- `packages/api/src/routers/team.ts` (remove member management)
- `packages/api/src/routers/vault.ts` (simplify queries)

### Storage & Crypto
- `packages/storage/src/adapter.ts` (storage interface)
- `packages/storage/src/adapters/*.ts` (platform-specific storage implementations)
- `packages/storage/src/types.ts` (multi-account data structures)

### UI
- `packages/ui/src/components/account-switcher.tsx` (new component)
- `apps/*/src/components/layout/header.tsx` (integrate switcher)

### Platform Crypto Wrappers
- `apps/web/src/lib/wasm-crypto.ts`
- `apps/desktop/src/lib/tauri-crypto.ts`
- `apps/extension/src/lib/wasm-crypto.ts`
- `apps/mobile/src/lib/crypto/index.ts`

## User Decisions

### 1. Migration Strategy
**DECISION: Not a concern** - Currently no live users with multiple teams, so we can implement the new schema directly without complex migration.

### 2. Personal Team Auto-Creation
**DECISION: Yes - Always Create Personal Team**
- On signup: Auto-create personal team automatically
- If user joins org via invitation: They get a separate account in that org
- Users can have multiple accounts (personal + org(s))
- Similar to 1Password Individual + Business model

### 3. Team Types
**DECISION: Three team types**
- `personal`: Individual user, single member (1 user limit)
- `family`: Family sharing plan (6 user limit, configurable)
- `organization`: Business plan (unlimited users)

### 4. All Accounts View - Data Loading
**DECISION: Full Decryption Upfront**
- Decrypt all vault keys from all accounts when unlocking
- Show unified list immediately
- Higher memory usage, slower unlock, but best UX
- Can optimize later with lazy loading if performance issues arise

## Verification Plan

### 1. Database Migration
- [ ] Run migration on test database
- [ ] Verify all existing users have `teamId`
- [ ] Verify no orphaned vault keys
- [ ] Test foreign key constraints

### 2. Multi-Account Login
- [ ] Create 2 accounts with different emails
- [ ] Log in to both accounts in web app
- [ ] Verify both sessions stored in localStorage
- [ ] Switch between accounts, verify vault data changes
- [ ] Test "All Accounts" view shows both accounts' vaults

### 3. Crypto & Key Management
- [ ] Unlock account A → Verify MUK for A in memory
- [ ] Unlock account B → Verify MUK for B in memory
- [ ] Switch to account A → Decrypt vault item successfully
- [ ] Lock all → Verify all MUKs cleared
- [ ] Quick unlock all → Verify all accounts unlocked

### 4. Desktop/Mobile Multi-Account
- [ ] Add 2 accounts to desktop app
- [ ] Unlock all with biometric
- [ ] Switch accounts in sidebar
- [ ] Test "All Accounts" view
- [ ] Lock all and re-unlock

### 5. Extension Autofill
- [ ] Add 2 accounts with different login items
- [ ] Visit website matching account A's login
- [ ] Verify autofill suggests account A's credentials
- [ ] Switch to account B, verify no suggestions
- [ ] Test "All Accounts" mode offers both

### 6. Team Invitations
- [ ] User A (org owner) invites user B via email
- [ ] User B accepts → Verify new account created with teamId = org team
- [ ] User B logs in → Verify they see org team's vaults
- [ ] User B's personal account remains separate

## Migration Rollout Strategy

### Phase 1: Backend Changes (Breaking)
1. Deploy database migration (add user.teamId, deprecate teamMember)
2. Update API to enforce one-team-per-user
3. Run data migration script to assign primary team to each user

### Phase 2: Platform Support (Progressive)
1. **Web**: Enable multi-account, deploy account switcher
2. **Desktop**: Update Tauri storage adapter, deploy sidebar switcher
3. **Extension**: Update Chrome storage, deploy popup switcher
4. **Mobile**: Update RN storage, deploy account menu

### Phase 3: User Communication
1. Announce breaking change: "Multi-team access deprecated"
2. Guide users to create separate accounts per organization
3. Provide migration tool to split existing multi-team users
4. Deprecation timeline: 30 days before forced migration

## Key Edge Cases & Solutions

### 1. Personal Team Deletion
**Problem:** User tries to delete their personal team.
**Solution:** Personal teams are undeletable. Show error: "Personal teams cannot be deleted. To close your account, use Account Settings."

### 2. Session Expiry (One Account)
**Problem:** One account's session expires while others remain valid.
**Solution:**
- Check session validity per account on app load
- Show notification: "Session expired for {email}"
- User can re-unlock that account without affecting others
- Clear MUK from memory for expired account only

### 3. Family Team Member Limit Reached
**Problem:** Family team owner tries to invite 7th member (limit is 6).
**Solution:**
- Check capacity in `team.inviteMember` endpoint
- Count: current members + pending invitations
- Return error: "Team has reached member limit (6). Upgrade to Organization plan for unlimited members."

### 4. Invitation to Existing User
**Problem:** Team owner invites email that already has an account.
**Solution:**
- In `team.inviteMember`, check if user exists
- If exists, return error: "This email already has a Bittery account. They cannot join multiple teams."
- Future enhancement: Allow user to create second account with different email

### 5. Account Removal (Local)
**Problem:** User removes account from desktop app, but account still exists on server.
**Solution:**
- Only remove local session data
- Do not delete user account on server
- User can re-add account by logging in again
- Prompt: "Remove {email} from this device? Your account and data will remain on other devices."

### 6. Team Owner Leaves
**Problem:** Team owner tries to delete their account while owning a family/org team.
**Solution:**
- Check if user is owner of non-personal team
- Return error: "Transfer team ownership before deleting account."
- Provide UI to transfer ownership to another admin/member

### 7. All Accounts View - One Account Locked
**Problem:** User is in "All Accounts" view, locks one account.
**Solution:**
- Remove locked account's items from view
- Show notification: "{email} locked. Showing remaining accounts."
- If all accounts locked, redirect to unlock screen

### 8. Cross-Platform Session Sync
**Problem:** User adds account on desktop, then opens mobile.
**Solution:**
- No automatic sync (security risk)
- User must manually add accounts on each device
- Show onboarding tip: "Add your other accounts on this device"

## Estimated Complexity

- **Database Migration**: Medium (needs careful data handling)
- **Session Storage**: High (multi-account state management)
- **API Changes**: Low (mostly simplification)
- **UI Components**: Medium (account switcher + all accounts view)
- **Crypto Key Management**: High (multiple MUKs in memory)
- **Platform-Specific**: Medium per platform (4 platforms)

**Total**: Large architectural change, requires coordination across all layers.
