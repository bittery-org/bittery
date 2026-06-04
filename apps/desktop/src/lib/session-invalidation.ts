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
	email: string,
): Promise<void> {
	const normalizedEmail = email.toLowerCase();

	// Keep secret key/account metadata but clear session-bearing local state.
	await storage.clearSession(normalizedEmail);
	await storage.clearStoredSession(normalizedEmail);
	await storage.storeAuthToken("", normalizedEmail);
	await storage.storeVaultKeys([], normalizedEmail);
	await storage.storeEncryptedPrivateKey("", normalizedEmail);
}

export async function findAccountEmailBySessionId(
	sessionId: string,
): Promise<string | null> {
	const accounts = await storage.getAccountsList();

	for (const account of accounts) {
		const sessionData = await storage.getStoredSessionData(account.email);
		if (sessionData?.sessionId === sessionId) {
			return account.email.toLowerCase();
		}
	}

	return null;
}
