/**
 * Autofill Handlers
 * Handles autofill-specific messages.
 */

import {
	rankItemsByUsefulness,
	rankItemsForHostname,
} from "../lib/autofill-ranking";
import { storage } from "../lib/storage";
import { AUTOFILL_REAUTH_WINDOW_MS } from "./constants";
import { isDesktopLockedNow, isDesktopUnlockedNow } from "./desktop-status";
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
		// A locked desktop is the reason the extension is locked, and the popup
		// can't resolve it — only the desktop app can. Tell the overlay so it
		// offers to unlock the desktop instead of opening the popup.
		return {
			success: true,
			authenticated: false,
			unlocked: false,
			desktopLocked: await isDesktopLockedNow(),
		};
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

	// Ranked, not just filtered: the exact host for the page the user is on comes
	// first, then parent/child domains, then anything that merely shares a
	// registrable domain. `rankItemsForHostname` also considers an item's
	// secondary `urls`, which plain `hostnameMatches` on `url` ignored.
	const logins = items.filter(
		(item): item is NonNullable<typeof item> => item?.category === "login",
	);

	return { success: true, items: rankItemsForHostname(logins, hostname) };
}

/**
 * Handle GET_AUTOFILL_CREDIT_CARDS message - Get all credit card items
 */
export async function handleGetAutofillCreditCards(): Promise<MessageResponse> {
	updateActivity();

	const items = await getDecryptedItemsForCurrentMode();
	const creditCards = items.filter(
		(item): item is NonNullable<typeof item> =>
			item?.category === "credit-card" && Boolean(item?.cardNumber),
	);

	return { success: true, items: rankItemsByUsefulness(creditCards) };
}

/**
 * Handle GET_AUTOFILL_IDENTITIES message - Get all identity items
 */
export async function handleGetAutofillIdentities(): Promise<MessageResponse> {
	updateActivity();

	const items = await getDecryptedItemsForCurrentMode();
	const identities = items.filter(
		(item): item is NonNullable<typeof item> => item?.category === "identity",
	);

	return { success: true, items: rankItemsByUsefulness(identities) };
}
