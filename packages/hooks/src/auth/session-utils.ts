/**
 * Session State Utilities
 *
 * Helper functions for checking session state across platforms.
 */

import type { IStorageAdapter } from "@bittery/storage";
import type { SessionState } from "./types";

/**
 * Get the current session state for an account.
 *
 * This function checks:
 * - Whether the session is valid (not expired)
 * - Whether quick unlock is available (stored secret key + valid session)
 * - Whether biometric unlock is available (if supported)
 * - Whether master password re-entry is required (mobile 30-day policy)
 *
 * @param storage - Storage adapter
 * @param email - Email for multi-account support (optional, uses active account if not provided)
 * @returns Session state information
 */
export async function getSessionState(
	storage: IStorageAdapter,
	email?: string,
): Promise<SessionState> {
	// Get active account email if not provided
	let resolvedEmail = email;
	if (!resolvedEmail) {
		const activeAccount = await storage.getActiveAccount();
		resolvedEmail =
			activeAccount?.type === "single" ? activeAccount.email : undefined;
	}

	// Check session validity
	const isValid = await storage.isSessionValid(resolvedEmail ?? undefined);

	// Check quick unlock availability
	const canQuickUnlock = await storage.canQuickUnlock(
		resolvedEmail ?? undefined,
	);

	// Check biometric unlock availability
	let canBiometricUnlock = false;
	if (storage.supportsBiometric && storage.canBiometricUnlock) {
		canBiometricUnlock = await storage.canBiometricUnlock(
			resolvedEmail ?? undefined,
		);
	}

	// Check if master password re-entry is required (mobile 30-day policy)
	let requiresPasswordReentry = false;
	if (storage.isMasterPasswordReentryRequired) {
		requiresPasswordReentry = await storage.isMasterPasswordReentryRequired(
			resolvedEmail ?? undefined,
		);
	}

	// Get session data for expiry info
	let expiresAt: number | null = null;
	let userId: string | null = null;
	if (storage.getStoredSessionData) {
		const sessionData = await storage.getStoredSessionData(
			resolvedEmail ?? undefined,
		);
		if (sessionData) {
			expiresAt = sessionData.expiresAt;
			userId = sessionData.userId;
		}
	}

	return {
		isValid,
		canQuickUnlock,
		canBiometricUnlock,
		requiresPasswordReentry,
		email: resolvedEmail ?? null,
		userId,
		expiresAt,
	};
}

/**
 * Clear session data for logout.
 *
 * @param storage - Storage adapter
 * @param email - Email for multi-account support (optional)
 * @param clearSecretKey - Whether to also clear the secret key (full logout vs lock)
 */
export async function clearSession(
	storage: IStorageAdapter,
	email?: string,
	clearSecretKey = false,
): Promise<void> {
	if (clearSecretKey) {
		await storage.clearAllStoredData(email);
	} else {
		await storage.clearSession(email);
	}
}

/**
 * Check if an email has an existing account on the server.
 *
 * @param trpcClient - tRPC client
 * @param email - Email to check
 * @returns Whether the email exists and the secret key hint
 */
export async function checkEmailExists(
	trpcClient: {
		auth: {
			checkEmail: {
				query(input: {
					email: string;
				}): Promise<{ exists: boolean; secretKeyHint?: string | null }>;
			};
		};
	},
	email: string,
): Promise<{ exists: boolean; secretKeyHint?: string | null }> {
	return trpcClient.auth.checkEmail.query({ email });
}
