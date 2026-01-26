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
	const email = await storage.getActiveAccountEmail();

	if (!email) {
		throw new Error("Quick unlock not available - no active account");
	}

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
	// Check if we have a valid session and MUK is still in memory
	const authenticated = await storage.isAuthenticated();
	const unlocked = isUnlocked();

	if (authenticated) {
		updateActivity();
	}

	return { success: true, authenticated, unlocked };
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
	const email = await storage.getActiveAccountEmail();
	const userId = await storage.getActiveAccountUserId();
	const sessionValid = await storage.isSessionValid();
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
	lock();
	return { success: true };
}
