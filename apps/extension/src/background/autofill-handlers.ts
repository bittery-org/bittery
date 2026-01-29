/**
 * Autofill Handlers
 * Handles autofill-specific messages
 */

import { storage } from "../lib/storage";
import { AUTOFILL_REAUTH_WINDOW_MS } from "./constants";
import { desktopSync } from "./desktop-sync";
import {
	getLastActivityTimestamp,
	isUnlocked,
	updateActivity,
} from "./session-manager";
import type { MessageResponse } from "./types";
import {
	decryptVaultItems,
	decryptVaultItemsViaDesktop,
	hostnameMatches,
} from "./vault-utils";

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

	const authenticated = await storage.isAuthenticated();
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

	// Check if desktop is available and we should use desktop mode
	const desktopStatus = desktopSync.getLastStatus();
	const desktopAvailable = desktopStatus?.available && !desktopStatus.locked;

	if (desktopAvailable) {
		console.log(
			"[autofill] Using desktop mode for decryption (desktop available)",
		);
		try {
			const items = await decryptVaultItemsViaDesktop();
			const filtered = items.filter(
				(item) =>
					item?.category === "login" && hostnameMatches(item?.url, hostname),
			);
			return { success: true, items: filtered };
		} catch (error) {
			console.error(
				"[autofill] Desktop decryption failed, falling back to WASM:",
				error,
			);
			// Fall through to standalone mode
		}
	}

	console.log("[autofill] Using standalone mode (WASM crypto)");
	const items = await decryptVaultItems();

	// Filter by hostname and only include login items
	const filtered = items.filter(
		(item) =>
			item?.category === "login" && hostnameMatches(item?.url, hostname),
	);

	return { success: true, items: filtered };
}

/**
 * Handle GET_AUTOFILL_CREDIT_CARDS message - Get all credit card items
 */
export async function handleGetAutofillCreditCards(): Promise<MessageResponse> {
	updateActivity();

	// Check if desktop is available
	const desktopStatus = desktopSync.getLastStatus();
	const desktopAvailable = desktopStatus?.available && !desktopStatus.locked;

	let items;
	if (desktopAvailable) {
		console.log("[autofill] Using desktop mode for credit card decryption");
		try {
			items = await decryptVaultItemsViaDesktop();
		} catch (error) {
			console.error(
				"[autofill] Desktop decryption failed, falling back to WASM:",
				error,
			);
			items = await decryptVaultItems();
		}
	} else {
		console.log("[autofill] Using standalone mode for credit cards");
		items = await decryptVaultItems();
	}

	// Filter to only credit card items
	const creditCards = items.filter(
		(item) => item?.category === "credit-card" && item?.cardNumber,
	);

	return { success: true, items: creditCards };
}

/**
 * Handle GET_AUTOFILL_IDENTITIES message - Get all identity items
 */
export async function handleGetAutofillIdentities(): Promise<MessageResponse> {
	updateActivity();

	// Check if desktop is available
	const desktopStatus = desktopSync.getLastStatus();
	const desktopAvailable = desktopStatus?.available && !desktopStatus.locked;

	let items;
	if (desktopAvailable) {
		console.log("[autofill] Using desktop mode for identity decryption");
		try {
			items = await decryptVaultItemsViaDesktop();
		} catch (error) {
			console.error(
				"[autofill] Desktop decryption failed, falling back to WASM:",
				error,
			);
			items = await decryptVaultItems();
		}
	} else {
		console.log("[autofill] Using standalone mode for identities");
		items = await decryptVaultItems();
	}

	// Filter to only identity items
	const identities = items.filter((item) => item?.category === "identity");

	return { success: true, items: identities };
}
