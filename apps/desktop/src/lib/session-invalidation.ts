import { storage } from "./storage";

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

export async function invalidateDesktopAccountSession(
	accountId: string,
): Promise<void> {
	await storage.clearSession(accountId);
	await storage.clearStoredSession(accountId);
	await storage.storeAuthToken("", accountId);
	await storage.storeVaultKeys([], accountId);
	await storage.storeEncryptedPrivateKey("", accountId);
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

async function resolveUnauthorizedAccountId(
	error: unknown,
): Promise<string | null> {
	if (
		error &&
		typeof error === "object" &&
		"data" in error &&
		typeof (error as { data?: { sessionId?: string } }).data?.sessionId ===
			"string"
	) {
		const sessionId = (error as { data: { sessionId: string } }).data.sessionId;
		return findAccountIdBySessionId(sessionId);
	}
	return null;
}

export async function handleDesktopUnauthorizedError(
	error: unknown,
): Promise<{ prefillEmail?: string; shouldRedirect: boolean }> {
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

	if (activeAccount?.type === "all") {
		const failingAccountId = await resolveUnauthorizedAccountId(error);
		if (failingAccountId) {
			await invalidateDesktopAccountSession(failingAccountId);
			const unlockedAccounts = await storage.getUnlockedAccounts?.();
			return {
				shouldRedirect: !unlockedAccounts || unlockedAccounts.length === 0,
			};
		}
	}

	return { shouldRedirect: false };
}
