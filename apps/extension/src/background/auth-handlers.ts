/**
 * Authentication Handlers
 * Handles LOGIN, QUICK_UNLOCK, CHECK_AUTH, and related authentication messages
 *
 * Uses shared auth utilities from @bittery/hooks for SRP login/unlock logic.
 */

import {
	performSRPLogin,
	performSRPUnlock,
	storeLoginSession,
	storeUnlockSession,
} from "@bittery/hooks/auth";
import { cryptoAdapter } from "../lib/crypto-adapter";
import { storage } from "../lib/storage";
import {
	isUnlocked,
	lock,
	setMasterUnlockKey,
	updateActivity,
} from "./session-manager";
import { trpcClient } from "./trpc-client";
import type { MessageResponse } from "./types";

/**
 * Handle LOGIN message - Full SRP authentication
 */
export async function handleLogin(payload: {
	email: string;
	password: string;
	secretKey: string;
}): Promise<MessageResponse> {
	const { email, password, secretKey } = payload;

	// Perform SRP login using shared utility
	const result = await performSRPLogin(
		{ email, password, secretKey },
		{ crypto: cryptoAdapter, trpcClient, storage },
	);

	// Store session data using shared utility
	await storeLoginSession(result, secretKey, storage, email);

	// Set MUK in extension's in-memory session manager (for auto-lock)
	setMasterUnlockKey(result.masterUnlockKey);

	// Start activity tracking
	updateActivity();

	return { success: true };
}

/**
 * Handle QUICK_UNLOCK message - Fast unlock using stored secret key
 */
export async function handleQuickUnlock(payload: {
	password: string;
}): Promise<MessageResponse> {
	const { password } = payload;

	// Get stored email for multi-account support
	const activeAccount = await storage.getActiveAccount();

	if (!activeAccount || activeAccount.type !== "single") {
		throw new Error("Quick unlock not available - no active account");
	}

	const email = activeAccount.email;

	// Perform SRP unlock using shared utility (retrieves stored secret key internally)
	const result = await performSRPUnlock(
		{ email, password },
		{ crypto: cryptoAdapter, trpcClient, storage },
	);

	// Store session data using shared utility
	await storeUnlockSession(result, storage, email);

	// Set MUK in extension's in-memory session manager (for auto-lock)
	setMasterUnlockKey(result.masterUnlockKey);

	// Start activity tracking
	updateActivity();

	return { success: true };
}

/**
 * Handle CHECK_AUTH message - Check if extension is authenticated and unlocked
 */
export async function handleCheckAuth(): Promise<MessageResponse> {
	// Check if we have a valid session
	const authenticated = await storage.isAuthenticated();

	// Ensure an active account is set if accounts exist but none is active
	// This handles the case where the first account is added but not set as active
	await ensureActiveAccountSet();

	// Try to restore sessions from storage if not already unlocked
	// This handles browser restart where in-memory MUKs are cleared
	if (authenticated && !isUnlocked()) {
		await tryRestoreAllSessions();
	}

	const unlocked = isUnlocked();

	if (authenticated && unlocked) {
		await updateActivity();
	}

	return { success: true, authenticated, unlocked };
}

/**
 * Ensure an active account is set if accounts exist but none is active
 * This handles the case where the first account is added but no active account is set
 */
async function ensureActiveAccountSet(): Promise<void> {
	try {
		const accounts = await storage.getAccountsList();
		if (accounts.length === 0) return;

		const activeAccount = await storage.getActiveAccount();
		if (activeAccount) return; // Already have an active account

		// No active account but we have accounts - set the first one as active
		console.log("[Auth] No active account set, defaulting to first account");

		if (accounts.length === 1) {
			// Single account - set it as active
			await storage.setActiveAccount({ type: "single", email: accounts[0].email });
			console.log(`[Auth] Set ${accounts[0].email} as active account`);
		} else {
			// Multiple accounts - check if any are unlocked
			const unlockedEmails = (await storage.getUnlockedAccounts?.()) ?? [];

			if (unlockedEmails.length > 1) {
				// Multiple unlocked - use "all" mode
				await storage.setActiveAccount({ type: "all" });
				console.log("[Auth] Set active account to 'all' mode");
			} else if (unlockedEmails.length === 1) {
				// One unlocked - use that one
				await storage.setActiveAccount({ type: "single", email: unlockedEmails[0] });
				console.log(`[Auth] Set ${unlockedEmails[0]} as active account`);
			} else {
				// None unlocked - default to first account
				await storage.setActiveAccount({ type: "single", email: accounts[0].email });
				console.log(`[Auth] Set ${accounts[0].email} as active account (none unlocked)`);
			}
		}
	} catch (error) {
		console.error("[Auth] Failed to ensure active account:", error);
	}
}

/**
 * Try to restore all account sessions from encrypted storage
 * Called on startup/auth check to restore sessions after browser restart
 */
async function tryRestoreAllSessions(): Promise<void> {
	try {
		const accounts = await storage.getAccountsList();
		if (accounts.length === 0) return;

		const restoredEmails: string[] = [];

		// Try to restore each account's session
		for (const account of accounts) {
			try {
				const restored = await storage.tryRestoreSession(false, account.email);
				if (restored) {
					restoredEmails.push(account.email);
					console.log(`[Auth] Restored session for ${account.email}`);
				}
			} catch (error) {
				console.error(`[Auth] Failed to restore session for ${account.email}:`, error);
			}
		}

		// If we restored any sessions, set the session manager's global MUK
		// (just a sentinel value indicating "at least one account is unlocked")
		if (restoredEmails.length > 0) {
			// Update activity timestamp FIRST to prevent immediate auto-lock
			await updateActivity();

			const muk = await storage.getMasterUnlockKey(restoredEmails[0]);
			if (muk) {
				setMasterUnlockKey(muk);
				console.log(`[Auth] Restored ${restoredEmails.length} account(s), set session manager MUK`);
			}
		}
	} catch (error) {
		console.error("[Auth] Failed to restore sessions:", error);
	}
}

/**
 * Handle CAN_QUICK_UNLOCK message - Check if quick unlock is available
 */
export async function handleCanQuickUnlock(): Promise<MessageResponse> {
	const canQuickUnlock = await storage.canQuickUnlock();
	return { success: true, canQuickUnlock };
}

/**
 * Handle GET_AUTH_TOKEN message - Get the auth token
 */
export async function handleGetAuthToken(): Promise<MessageResponse> {
	const token = await storage.getAuthToken();
	return { success: true, token };
}

/**
 * Handle GET_SESSION_DATA message - Get stored session data
 */
export async function handleGetSessionData(): Promise<MessageResponse> {
	const activeAccount = await storage.getActiveAccount();
	const userId = await storage.getActiveAccountUserId();
	const sessionValid = await storage.isSessionValid();

	const email = activeAccount?.type === "single" ? activeAccount.email : null;

	return {
		success: true,
		sessionData:
			email && userId ? { email, userId, isValid: sessionValid } : null,
	};
}

/**
 * Handle LOGOUT message - Clear session and lock
 */
export async function handleLogout(): Promise<MessageResponse> {
	await storage.clearSession();
	lock();
	return { success: true };
}

/**
 * Handle LOCK message - Manual lock (clears MUK but keeps vault keys)
 */
export async function handleLock(): Promise<MessageResponse> {
	// Lock extension (clears session manager's global MUK and all per-account MUKs)
	await lock();

	return { success: true };
}

/**
 * Handle QUICK_UNLOCK_ALL message - Unlock all accounts with password
 */
export async function handleQuickUnlockAll(payload: {
	password: string;
}): Promise<MessageResponse> {
	const { password } = payload;

	// Get list of all accounts
	const accounts = await storage.getAccountsList();

	if (accounts.length === 0) {
		throw new Error("No accounts found");
	}

	const unlocked: string[] = [];
	const failed: string[] = [];

	// Attempt to unlock each account
	for (const account of accounts) {
		try {
			// Check if account has stored secret key
			const hasSecretKey = await storage.hasStoredSecretKey(account.email);
			if (!hasSecretKey) {
				console.log(
					`[QUICK_UNLOCK_ALL] Skipping ${account.email} - no stored secret key`,
				);
				failed.push(account.email);
				continue;
			}

			// Perform SRP unlock for this account
			const result = await performSRPUnlock(
				{ email: account.email, password },
				{ crypto: cryptoAdapter, trpcClient, storage },
			);

			// Store unlock session data
			await storeUnlockSession(result, storage, account.email);

			unlocked.push(account.email);
		} catch (error) {
			console.error(`[QUICK_UNLOCK_ALL] Failed to unlock ${account.email}:`, error);
			failed.push(account.email);
		}
	}

	// If no accounts unlocked, fail
	if (unlocked.length === 0) {
		throw new Error("Failed to unlock any accounts");
	}

	// Set active account mode
	if (accounts.length > 1) {
		await storage.setActiveAccount({ type: "all" });
	} else {
		await storage.setActiveAccount({ type: "single", email: unlocked[0] });
	}

	// Set MUK for first unlocked account in session manager
	const activeMuk = await storage.getMasterUnlockKey(unlocked[0]);
	if (activeMuk) {
		setMasterUnlockKey(activeMuk);
	}

	updateActivity();

	return {
		success: true,
		result: { unlocked, failed },
	};
}
