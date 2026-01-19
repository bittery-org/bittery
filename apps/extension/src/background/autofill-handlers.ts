/**
 * Autofill Handlers
 * Handles autofill-specific messages
 */

import { chromeStorage } from "@bittery/crypto";
import { AUTOFILL_REAUTH_WINDOW_MS } from "./constants";
import {
	getLastActivityTimestamp,
	isUnlocked,
	updateActivity,
} from "./session-manager";
import type { MessageResponse } from "./types";
import { decryptVaultItems, hostnameMatches } from "./vault-utils";

/**
 * Handle CHECK_AUTOFILL_AUTH message - Check if autofill is authenticated
 */
export async function handleCheckAutofillAuth(): Promise<MessageResponse> {
	const unlocked = isUnlocked();

	if (!unlocked) {
		return { success: true, authenticated: false, unlocked: false };
	}

	// Additional check: autofill requires more frequent re-auth
	const now = Date.now();
	const timeSinceLastActivity = now - getLastActivityTimestamp();
	const needsReauth = timeSinceLastActivity > AUTOFILL_REAUTH_WINDOW_MS;

	if (needsReauth) {
		return {
			success: true,
			authenticated: false,
			unlocked: true,
			needsReauth: true,
		};
	}

	const authenticated = await chromeStorage.isAuthenticated();
	return { success: true, authenticated, unlocked: true, needsReauth: false };
}

/**
 * Handle UPDATE_AUTOFILL_TIMESTAMP message - Update activity timestamp
 */
export async function handleUpdateAutofillTimestamp(): Promise<MessageResponse> {
	updateActivity();
	return { success: true };
}

/**
 * Handle GET_AUTOFILL_ITEMS message - Get autofill items for a hostname
 */
export async function handleGetAutofillItems(payload: {
	hostname: string;
}): Promise<MessageResponse> {
	updateActivity();

	const { hostname } = payload;

	const items = await decryptVaultItems();

	// Filter by hostname
	const filtered = items.filter((item) => hostnameMatches(item?.url, hostname));

	return { success: true, items: filtered };
}
