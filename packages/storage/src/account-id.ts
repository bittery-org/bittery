import type { AccountStore } from "./account-store";
import type { AccountMetadata } from "./types";

/**
 * Monotonic counter guaranteeing uniqueness for the `randomUUID` fallback path.
 * Without this, several accounts minted within the same millisecond (e.g. the
 * synchronous `ensureAccountIds` map) would collide on `Date.now()` and alias
 * each other's per-account storage.
 */
let accountIdFallbackCounter = 0;

/** Generate a new stable local account identifier. */
export function generateAccountId(): string {
	const uuid = globalThis?.crypto?.randomUUID?.();
	if (uuid) {
		return uuid;
	}
	// Collision-proof fallback: timestamp + monotonic counter + randomness.
	accountIdFallbackCounter += 1;
	const random = Math.random().toString(36).slice(2, 10);
	return `acct_${Date.now().toString(36)}_${accountIdFallbackCounter}_${random}`;
}

/** Find account metadata by accountId. */
export function findAccountById(
	accounts: AccountMetadata[],
	accountId: string,
): AccountMetadata | undefined {
	return accounts.find((a) => a.accountId === accountId);
}

/** Canonicalize a server URL for local account identity comparisons. */
export function normalizeAccountServerUrl(serverUrl: string): string {
	const trimmed = serverUrl.trim();
	try {
		return new URL(trimmed).toString().replace(/\/+$/, "");
	} catch {
		return trimmed.replace(/\/+$/, "");
	}
}

/**
 * Resolve one existing account by normalized server URL + normalized email.
 * Ambiguous metadata is rejected instead of guessing which downgrade pin to use.
 */
export function findAccountByServerEmail(
	accounts: AccountMetadata[],
	serverUrl: string,
	email: string,
): AccountMetadata | undefined {
	const normalizedUrl = normalizeAccountServerUrl(serverUrl);
	const normalizedEmail = email.trim().toLowerCase();
	const matches = accounts.filter(
		(account) =>
			normalizeAccountServerUrl(account.serverUrl ?? "") === normalizedUrl &&
			account.email.trim().toLowerCase() === normalizedEmail,
	);
	if (matches.length > 1) {
		throw new Error(
			`Ambiguous account for server and email: ${normalizedUrl} ${normalizedEmail}`,
		);
	}
	return matches[0];
}

/** Find accountId for a display email within a known accounts list. */
export function resolveAccountIdFromEmailInList(
	accounts: AccountMetadata[],
	email: string,
): string | undefined {
	const matches = accounts.filter(
		(a) => a.email.toLowerCase() === email.toLowerCase(),
	);
	if (matches.length > 1) {
		throw new Error(`Ambiguous account email: ${email}`);
	}
	return matches[0]?.accountId;
}

/**
 * Resolve a storage scope identifier (accountId or display email) to an accountId.
 * Falls back to the active account when scope is omitted.
 *
 * Throws rather than returning `undefined`. An unresolved scope used to flow into
 * `AccountStore`, whose omitted-accountId fallback resolves to the *active* account —
 * so a scope naming one account silently read and wrote another's data.
 */
export async function resolveAccountScopeId(
	storage: AccountStore,
	scope?: string,
	opts?: { errorMessage?: string },
): Promise<string> {
	const resolved = await tryResolveAccountScopeId(storage, scope);
	if (!resolved) {
		throw new Error(opts?.errorMessage ?? "Account identity is required");
	}
	return resolved;
}

/** Split out only so {@link resolveAccountScopeId} reads as resolve-or-throw. */
async function tryResolveAccountScopeId(
	storage: AccountStore,
	scope?: string,
): Promise<string | undefined> {
	if (!scope) {
		return (await storage.getActiveAccount()) ?? undefined;
	}

	const accounts = await storage.getAccountsList();
	if (findAccountById(accounts, scope)) {
		return scope;
	}

	return resolveAccountIdFromEmailInList(accounts, scope);
}

/** Find account by serverUrl + userId pair (canonical dedup key at login). */
export function findAccountByServerUser(
	accounts: AccountMetadata[],
	serverUrl: string,
	userId: string,
): AccountMetadata | undefined {
	const normalizedUrl = normalizeAccountServerUrl(serverUrl);
	return accounts.find(
		(a) =>
			a.userId === userId &&
			normalizeAccountServerUrl(a.serverUrl ?? "") === normalizedUrl,
	);
}

/**
 * Resolve existing accountId for (serverUrl, userId) or mint a new one.
 * This is the only place email/userId map to accountId at login.
 */
export function resolveOrCreateAccountId(
	accounts: AccountMetadata[],
	serverUrl: string,
	userId: string,
): string {
	const existing = findAccountByServerUser(accounts, serverUrl, userId);
	if (existing) {
		return existing.accountId;
	}

	const legacyCandidates = accounts.filter(
		(account) => account.userId === userId && !account.serverUrl,
	);
	if (legacyCandidates.length > 1) {
		throw new Error(
			`Ambiguous legacy accounts without server URL for user ${userId}`,
		);
	}
	const legacyCandidate = legacyCandidates[0];
	if (legacyCandidate) {
		legacyCandidate.serverUrl = normalizeAccountServerUrl(serverUrl);
		return legacyCandidate.accountId;
	}
	return generateAccountId();
}

/** Ensure every account in the list has an accountId (legacy migration helper). */
export function ensureAccountIds(
	accounts: AccountMetadata[],
): AccountMetadata[] {
	return accounts.map((account) =>
		account.accountId
			? account
			: { ...account, accountId: generateAccountId() },
	);
}

/** Resolve accountId from active single-account config, validating against list. */
export function resolveActiveAccountId(
	activeAccountId: string,
	accounts: AccountMetadata[],
): string | null {
	return findAccountById(accounts, activeAccountId) ? activeAccountId : null;
}

/**
 * Canonical `getStoredSessionData → getAccountMetadata → getActiveAccountUserId`
 * triad for resolving the current user id used as encryption-context AAD.
 * Tries the account's live session first, then its persisted metadata, then
 * falls back to whatever account is currently active. Throws when none of
 * those sources have a userId.
 */
export async function resolveUserIdForAccount(
	storage: AccountStore,
	accountId?: string,
	opts?: { errorMessage?: string },
): Promise<string> {
	// No `?.` guards: every `AccountStore` method is total on every platform.
	const sessionData = await storage.getStoredSessionData(accountId);
	if (sessionData?.userId) {
		return sessionData.userId;
	}

	if (accountId) {
		const accountMetadata = await storage.getAccountMetadata(accountId);
		if (accountMetadata?.userId) {
			return accountMetadata.userId;
		}
	}

	const activeUserId = await storage.getActiveAccountUserId();
	if (activeUserId) {
		return activeUserId;
	}

	throw new Error(
		opts?.errorMessage ?? "User ID not available for encryption context",
	);
}

/**
 * Same as {@link resolveUserIdForAccount}, but resolves a storage scope
 * (accountId or legacy email) to an accountId first via {@link resolveAccountScopeId}.
 */
export async function resolveUserIdForScope(
	storage: AccountStore,
	scope?: string,
	opts?: { errorMessage?: string },
): Promise<string> {
	const accountId = await resolveAccountScopeId(storage, scope);
	return resolveUserIdForAccount(storage, accountId, opts);
}
