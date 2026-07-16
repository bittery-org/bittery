/**
 * Autofill Handlers
 * Handles autofill-specific messages.
 */

import { hostnameMatches } from "../lib/hostname";
import { storage } from "../lib/storage";
import { AUTOFILL_REAUTH_WINDOW_MS } from "./constants";
import { isDesktopUnlockedNow } from "./desktop-status";
import {
	getLastActivityTimestamp,
	isUnlocked,
	setDesktopModeSentinel,
	updateActivity,
} from "./session-manager";
import type { MessageResponse } from "./types";
import { getDecryptedItemsForCurrentMode } from "./vault-utils";

/**
 * Handle CHECK_AUTOFILL_AUTH message - Check if autofill is authenticated
 */
export async function handleCheckAutofillAuth(): Promise<MessageResponse> {
	const desktopUnlocked = await isDesktopUnlockedNow();
	let unlocked = isUnlocked();

	// Service worker restart can lose sentinel MUK; recover desktop mode eagerly.
	if (!unlocked && desktopUnlocked) {
		setDesktopModeSentinel();
		unlocked = true;
	}

	if (!unlocked) {
		return { success: true, authenticated: false, unlocked: false };
	}

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

	const localAuthenticated = await storage.isAuthenticated();
	const authenticated = localAuthenticated || desktopUnlocked;

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
	const items = await getDecryptedItemsForCurrentMode();

	const filtered = items.filter(
		(item) =>
			item?.category === "login" && hostnameMatches(item?.url ?? "", hostname),
	);

	return { success: true, items: filtered };
}

/**
 * Handle GET_AUTOFILL_CREDIT_CARDS message - Get all credit card items
 */
export async function handleGetAutofillCreditCards(): Promise<MessageResponse> {
	updateActivity();

	const items = await getDecryptedItemsForCurrentMode();
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

	const items = await getDecryptedItemsForCurrentMode();
	const identities = items.filter((item) => item?.category === "identity");

	return { success: true, items: identities };
}
