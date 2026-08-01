import { itemCache, storage } from "./storage";

export function isUnauthorizedRpcError(error: unknown): boolean {
	if (
		error &&
		typeof error === "object" &&
		"data" in error &&
		(error as any).data?.code === "UNAUTHORIZED"
	) {
		return true;
	}
	return false;
}

/**
 * The server rejected this account's credentials, so it is a sign-out, not a lock:
 * `forgetSession` drops the session-bound secrets (`jwt_token`, `vault_keys`,
 * `encrypted_private_key`) *and* `session_data`, so no quick-unlock offer survives and the
 * master password is required.
 *
 * `AccountStore` sits on a `PlatformPort` and cannot reach the record-backed cache, so the
 * encrypted item cache has to be dropped from here (CONTRACT.md §12.3) — leaving it behind
 * after a forced sign-out is a real leak.
 */
export async function invalidateDesktopAccountSession(
	accountId: string,
): Promise<void> {
	await storage.forgetSession(accountId);
	await itemCache.clearItemCache(accountId);
}

export async function findAccountIdBySessionId(
	sessionId: string,
): Promise<string | null> {
	const accounts = await storage.getAccountsList();

	for (const account of accounts) {
		const sessionData = await storage.getStoredSessionData(account.accountId);
		if (sessionData?.sessionId === sessionId) {
			return account.accountId;
		}
	}

	return null;
}

/** @deprecated Use findAccountIdBySessionId */
export async function findAccountEmailBySessionId(
	sessionId: string,
): Promise<string | null> {
	const accountId = await findAccountIdBySessionId(sessionId);
	if (!accountId) {
		return null;
	}
	const accounts = await storage.getAccountsList();
	return (
		accounts.find((account) => account.accountId === accountId)?.email ?? null
	);
}

export async function handleDesktopUnauthorizedError(): Promise<{
	prefillEmail?: string;
	shouldRedirect: boolean;
}> {
	const activeAccount = await storage.getActiveAccount();

	if (activeAccount?.type === "single") {
		const accounts = await storage.getAccountsList();
		const meta = accounts.find(
			(account) => account.accountId === activeAccount.accountId,
		);
		await invalidateDesktopAccountSession(activeAccount.accountId);
		return {
			prefillEmail: meta?.email,
			shouldRedirect: true,
		};
	}

	return { shouldRedirect: false };
}
