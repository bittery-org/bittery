import type { AccountStore } from "./account-store";
import type { AccountMetadata } from "./types";

/**
 * Monotonic counter guaranteeing uniqueness for the `randomUUID` fallback path.
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

	return generateAccountId();
}

/** Resolve accountId from active single-account config, validating against list. */
export function resolveActiveAccountId(
	activeAccountId: string,
	accounts: AccountMetadata[],
): string | null {
	return findAccountById(accounts, activeAccountId) ? activeAccountId : null;
}

/**
 * Resolve the user id used as encryption-context AAD from one exact account.
 * The live session wins over persisted metadata, but this never falls back to
 * the active account: a missing scoped identity must fail rather than cross accounts.
 */
export async function resolveUserIdForAccount(
	storage: AccountStore,
	accountId: string,
	opts?: { errorMessage?: string },
): Promise<string> {
	// No `?.` guards: every `AccountStore` method is total on every platform.
	const sessionData = await storage.getStoredSessionData(accountId);
	if (sessionData?.userId) {
		return sessionData.userId;
	}

	const accountMetadata = await storage.getAccountMetadata(accountId);
	if (accountMetadata?.userId) {
		return accountMetadata.userId;
	}

	throw new Error(
		opts?.errorMessage ?? "User ID not available for encryption context",
	);
}
