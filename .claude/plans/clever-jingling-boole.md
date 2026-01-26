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
  activeAccount: string | "all" | null; // email address OR "all" for multi-account view
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

**Active Account Behavior:**
- When `activeAccount` is an email: All operations (search, item display, autofill) use ONLY that account
- When `activeAccount` is `"all"`: Operations fetch from ALL unlocked accounts and merge results
- Account switcher UI includes individual accounts + "All Accounts" option

**Implementation:**
1. Desktop/Extension/Mobile adapters implement multi-account methods
2. Web adapter keeps single-account structure (`supportsMultiAccount = false`)
3. MUK cache lives in memory only, cleared on lock
4. Account switching updates `activeAccount` field
5. Setting `activeAccount = "all"` enables cross-account search/display

### Phase 4: UI Components & Hooks (Basic Account Switching)

**Critical Files:**
- `packages/ui/src/components/account-switcher.tsx` (NEW)
- `packages/hooks/src/auth/use-account-switcher.ts` (NEW)
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

**UI Components:**

1. **Account Switcher Dropdown:**
   - Shows all added accounts
   - Displays active account badge
   - **"All Accounts" option** - sets `activeAccount = "all"`
   - "Add Account" button → navigates to login
   - "Lock All" button → clears all MUKs

**Search Behavior:**
- When a specific account is active: Search only in that account's items
- When "All Accounts" is selected: Search across all unlocked accounts

### Phase 5: Multi-Account Data Fetching & All Accounts View

**Critical Files:**
- `packages/shared/src/trpc-client-factory.ts` (NEW - per-account tRPC client)
- `packages/hooks/src/hooks/use-all-accounts-items.ts` (COMPLETE)
- `packages/hooks/src/auth/use-quick-unlock-all.ts` (NEW)
- `packages/ui/src/components/all-accounts-view.tsx` (NEW)
- `apps/desktop/src/routes/all-accounts.tsx` (NEW - All Accounts route)
- `apps/extension/src/popup/all-accounts.tsx` (NEW)
- Platform crypto wrappers (update to pass email parameter):
  - `apps/web/src/lib/wasm-crypto.ts`
  - `apps/desktop/src/lib/tauri-crypto.ts`
  - `apps/extension/src/lib/wasm-crypto.ts`
  - `apps/mobile/src/contexts/biometric-auth-context.tsx`

**Implementation:**

**CRITICAL INSIGHT: tRPC Multi-Account Strategy**

The tRPC API uses `ctx.session.userId` from the JWT to determine which user's data to return. This means we **cannot** use a single tRPC client for all accounts.

**Problem with Current Implementation:**
- In `apps/desktop/src/lib/providers.tsx` (and similar files), the tRPC client calls `storage.getAuthToken()` without an email parameter
- This always returns the **active account's** token
- All API calls go through this single client, limiting us to one account's data

**Solution:**
1. Keep the default tRPC client for single-account operations (active account only)
2. Create a **per-account tRPC client factory** that accepts a JWT token as parameter
3. For "All Accounts" operations, create separate tRPC clients for each unlocked account
4. Make parallel API calls with each account's client
5. Decrypt items with each account's MUK

This approach allows us to:
- Maintain backward compatibility with single-account flows
- Add multi-account support without breaking existing code
- Fetch data from multiple accounts concurrently

**1. Per-Account tRPC Client Factory:**

**Important:** We keep TWO types of tRPC clients:
- **Default client** (in `providers.tsx`) - Uses active account's token, for normal single-account operations
- **Per-account clients** (created on-demand) - Use specific account tokens, for multi-account operations

   ```typescript
   // packages/shared/src/trpc-client-factory.ts

   /**
    * Create a tRPC client for a specific account.
    * This is needed for multi-account operations since the API uses
    * the JWT token to determine which user's data to return.
    *
    * NOTE: This is separate from the default tRPC client in providers.tsx,
    * which always uses the active account's token. Use this factory when
    * you need to fetch data from a specific account that may not be active.
    */
   export function createAccountTrpcClient(authToken: string, serverUrl: string) {
     return createTRPCClient<AppRouter>({
       links: [
         httpBatchLink({
           url: buildTrpcUrl(serverUrl, '/trpc'),
           headers: {
             Authorization: `Bearer ${authToken}`,
           },
           fetch: (url, options) => {
             return fetch(url, {
               ...options,
               credentials: 'include',
             });
           },
         }),
       ],
     });
   }

   /**
    * Create tRPC clients for all unlocked accounts.
    * Returns a map of email → tRPC client.
    */
   export async function createAllAccountTrpcClients(
     storage: IStorageAdapter
   ): Promise<Map<string, ReturnType<typeof createAccountTrpcClient>>> {
     const unlockedEmails = await storage.getUnlockedAccounts();
     const clients = new Map();

     for (const email of unlockedEmails) {
       const authToken = await storage.getAuthToken(email);
       const serverUrl = await storage.getServerUrl(email) || DEFAULT_SERVER_URL;

       if (authToken) {
         clients.set(email, createAccountTrpcClient(authToken, serverUrl));
       }
     }

     return clients;
   }
   ```

**2. Complete `useAllAccountsItems()` Hook:**
   ```typescript
   // packages/hooks/src/hooks/use-all-accounts-items.ts

   export function useAllAccountsItems(options: UseAllAccountsItemsOptions = {}) {
     const storage = usePlatformStorage();
     const crypto = usePlatformCrypto();

     return useQuery({
       queryKey: ['all-accounts-items'],
       queryFn: async (): Promise<MultiAccountItem[]> => {
         // 1. Get all unlocked accounts
         const unlockedEmails = await storage.getUnlockedAccounts();
         if (!unlockedEmails || unlockedEmails.length === 0) return [];

         // 2. For each account, fetch items with that account's JWT
         const allAccountItems = await Promise.all(
           unlockedEmails.map(async (email) => {
             try {
               // Get account's JWT token
               const authToken = await storage.getAuthToken(email);
               if (!authToken) return [];

               // Get account metadata
               const metadata = await storage.getAccountMetadata(email);
               if (!metadata) return [];

               // Get server URL
               const serverUrl = await storage.getServerUrl(email) || DEFAULT_SERVER_URL;

               // Create account-specific tRPC client
               const accountClient = createAccountTrpcClient(authToken, serverUrl);

               // Fetch all items for this account
               const rawItems = await accountClient.vault.listAllItems.query();

               // Decrypt items with this account's MUK
               const decryptedItems = await Promise.all(
                 rawItems.map(async (rawItem) => {
                   try {
                     // Get decrypted vault key for this vault + account
                     const vaultKey = await storage.getDecryptedVaultKey(
                       rawItem.vaultId,
                       email
                     );
                     if (!vaultKey) throw new Error('No vault key');

                     // Decrypt item data
                     const decryptedData = await crypto.decrypt(
                       {
                         ciphertext: rawItem.encryptedData,
                         iv: rawItem.encryptionIv,
                         algorithm: rawItem.encryptionAlgorithm,
                       },
                       vaultKey
                     );

                     const parsedData = JSON.parse(decryptedData);

                     return {
                       id: rawItem.id,
                       vaultId: rawItem.vaultId,
                       category: rawItem.category,
                       favorite: rawItem.favorite,
                       createdAt: rawItem.createdAt,
                       updatedAt: rawItem.updatedAt,
                       ...parsedData,
                       vault: {
                         id: rawItem.vault.id,
                         name: rawItem.vault.name,
                         type: rawItem.vault.type,
                         icon: rawItem.vault.icon,
                         imageUrl: rawItem.vault.imageUrl,
                       },
                       account: {
                         email: metadata.email,
                         userId: metadata.userId,
                         name: metadata.name,
                       },
                     } as MultiAccountItem;
                   } catch (error) {
                     console.error(`Failed to decrypt item ${rawItem.id}:`, error);
                     return null;
                   }
                 })
               );

               return decryptedItems.filter((item): item is MultiAccountItem => item !== null);
             } catch (error) {
               console.error(`Failed to fetch items for ${email}:`, error);
               return [];
             }
           })
         );

         // 3. Flatten and merge all items
         return allAccountItems.flat();
       },
       enabled: options.enabled !== false,
       staleTime: 5 * 60 * 1000, // 5 minutes
     });
   }
   ```

**3. Quick Unlock All Accounts:**
   ```typescript
   // packages/hooks/src/auth/use-quick-unlock-all.ts

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
       await storage.setMasterUnlockKey(masterUnlockKey, account.email);

       // Decrypt and cache vault keys for this account
       const vaultKeys = await storage.getVaultKeys(account.email);
       for (const vaultKey of vaultKeys || []) {
         // Decrypt vault key with MUK (will be cached in storage adapter)
         await storage.getDecryptedVaultKey(vaultKey.vaultId, account.email);
       }
     }

     // Set active account to "all"
     await storage.setActiveAccount("all");
   }
   ```

**4. Context-Aware Item Display:**
   ```typescript
   // Main vault view component (desktop/extension/mobile)

   export function VaultView() {
     const activeAccount = useActiveAccount();
     const storage = usePlatformStorage();

     // Conditional hook based on active account
     const singleAccountItems = useDecryptedItems({
       enabled: activeAccount !== 'all',
     });

     const allAccountsItems = useAllAccountsItems({
       enabled: activeAccount === 'all',
     });

     const items = activeAccount === 'all'
       ? allAccountsItems.items
       : singleAccountItems.items;

     const showAccountBadges = activeAccount === 'all';

     return (
       <div>
         <h1>
           {activeAccount === 'all'
             ? `All Accounts (${allAccountsItems.unlockedAccounts.length})`
             : 'Vaults'}
         </h1>

         {/* Search behavior changes based on context */}
         <SearchBar
           placeholder={
             activeAccount === 'all'
               ? 'Search across all accounts...'
               : 'Search...'
           }
         />

         {/* Item list with conditional account badges */}
         {items.map(item => (
           <ItemCard
             key={`${item.account?.email || activeAccount}-${item.id}`}
             item={item}
             showAccountBadge={showAccountBadges}
             accountEmail={item.account?.email}
             vaultName={item.vault.name}
           />
         ))}
       </div>
     );
   }
   ```

**5. Extension Autofill - Context-Aware Search:**
   ```typescript
   // apps/extension/src/background/autofill.ts

   async function getAutofillSuggestions(url: string) {
     const activeAccount = await storage.getActiveAccountEmail();

     let items: MultiAccountItem[];

     if (activeAccount === 'all') {
       // "All Accounts" selected - search across all unlocked accounts
       const { items: allItems } = await useAllAccountsItems();
       items = allItems;
     } else if (activeAccount) {
       // Specific account selected - search only that account
       const { items: accountItems } = await useDecryptedItems();
       items = accountItems.map(item => ({
         ...item,
         account: {
           email: activeAccount,
           userId: await storage.getActiveAccountUserId(),
           name: (await storage.getAccountMetadata(activeAccount))?.name || '',
         },
       }));
     } else {
       // No account active
       return [];
     }

     // Filter items matching the current URL
     const matches = items.filter(item =>
       item.category === 'login' &&
       matchesUrl(item.url, url)
     );

     // Show account badge only when in "All Accounts" mode
     const showAccountBadge = activeAccount === 'all';

     return matches.map(item => ({
       ...item,
       displayText: showAccountBadge
         ? `${item.title} (${item.account.email})`
         : item.title,
     }));
   }
   ```

**6. Account-Specific Crypto Operations:**
   - All crypto operations now accept optional `email` parameter
   - If no email provided, use active account
   - Vault key decryption: `decryptVaultKey(encrypted, email)`
   - Item decryption: `decryptItem(item, vaultId, email)`
   - RSA operations: `decryptWithPrivateKey(data, email)`

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
- **Context-aware autofill:**
  - When specific account is active: Search only that account's items
  - When "All Accounts" is selected: Search all unlocked accounts (show email badges)
  - Display format when in "All Accounts" mode: "{title} ({account.email})"
  - When user selects item, use that account's credentials

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

**Week 4: Auth Hooks & Basic UI**
1. Create `useAccountSwitcher()` hook
2. Create account switcher component (without "All Accounts" option)
3. Integrate account switcher into platform headers
4. Test basic account switching UX

**Week 5: Multi-Account Data & All Accounts View**
1. Create `createAccountTrpcClient()` factory in `packages/shared`
2. Complete `useAllAccountsItems()` hook with per-account tRPC clients
3. Create `useQuickUnlockAll()` hook
4. Create All Accounts view route for desktop/extension
5. Update extension autofill to use all unlocked accounts
6. Update crypto wrappers to accept email parameter
7. Test multi-account item fetching and decryption

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

### 4. Desktop/Mobile Multi-Account & Context-Aware Search
- [ ] Add 2 accounts to desktop app
- [ ] Unlock all with biometric
- [ ] With Account A active, search for item - verify ONLY Account A items appear
- [ ] Switch to Account B in sidebar, verify vault data changes
- [ ] Search for same item, verify ONLY Account B items appear
- [ ] Switch to "All Accounts" in sidebar
- [ ] Verify items from both accounts appear with account badges
- [ ] Search for item, verify results from BOTH accounts appear
- [ ] Lock Account A, verify "All Accounts" view updates (only shows Account B)
- [ ] Lock all and re-unlock

### 5. Extension Autofill (Context-Aware)
- [ ] Add 2 accounts with different login items for same website
- [ ] Set active account to Account A
- [ ] Visit website, verify autofill shows ONLY Account A's items (no email badge)
- [ ] Switch to "All Accounts" in account switcher
- [ ] Visit website, verify autofill shows items from BOTH accounts WITH email badges
- [ ] Select item from Account A, verify it fills correctly
- [ ] Select item from Account B, verify it fills correctly
- [ ] Switch back to Account B
- [ ] Visit website, verify autofill shows ONLY Account B's items (no email badge)

### 6. Multi-Account tRPC & Data Fetching
- [ ] Add 2 accounts with different items
- [ ] Call `useAllAccountsItems()` hook
- [ ] Verify hook creates separate tRPC clients for each account
- [ ] Verify API calls are made with correct JWT tokens (check network tab)
- [ ] Verify items from both accounts are decrypted correctly
- [ ] Verify items have correct account metadata attached
- [ ] Test with one account having API error, verify other account still works

### 7. Team Invitations
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
