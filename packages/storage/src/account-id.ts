import type { IStorageAdapter } from "./adapter";
import type { AccountMetadata } from "./types";

/** Generate a new stable local account identifier. */
export function generateAccountId(): string {
	return crypto.randomUUID();
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
	return accounts.find((a) => a.email.toLowerCase() === email.toLowerCase())
		?.accountId;
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
