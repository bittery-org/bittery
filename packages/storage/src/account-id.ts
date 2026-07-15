import type { IStorageAdapter } from "./adapter";
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
 * Resolve a storage scope identifier (accountId or legacy email) to accountId.
 * Falls back to the active single account when scope is omitted.
 */
export async function resolveAccountScopeId(
	storage: IStorageAdapter,
	scope?: string,
): Promise<string | undefined> {
	if (!scope) {
		const active = await storage.getActiveAccount();
		return active?.type === "single" ? active.accountId : undefined;
	}

	const accounts = await storage.getAccountsList();
	if (findAccountById(accounts, scope)) {
		return scope;
	}

	const byEmail = resolveAccountIdFromEmailInList(accounts, scope);
	if (byEmail) {
		return byEmail;
	}

	if (!storage.supportsMultiAccount) {
		const active = await storage.getActiveAccount();
		if (active?.type === "single") {
			return active.accountId;
		}
	}

	return undefined;
}

/** Find account by serverUrl + userId pair (canonical dedup key at login). */
export function findAccountByServerUser(
	accounts: AccountMetadata[],
	serverUrl: string,
	userId: string,
): AccountMetadata | undefined {
	const normalizedUrl = serverUrl.replace(/\/$/, "");
	return accounts.find(
		(a) =>
			a.userId === userId &&
			(a.serverUrl ?? "").replace(/\/$/, "") === normalizedUrl,
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
		legacyCandidate.serverUrl = serverUrl.replace(/\/$/, "");
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
