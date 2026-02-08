/**
 * Autofill Handlers
 * Handles autofill-specific messages.
 */

import type { DecryptedItem } from "@bittery/shared/types";
import { storage } from "../lib/storage";
import { AUTOFILL_REAUTH_WINDOW_MS } from "./constants";
import { core } from "./core-instance";
import {
	getLastActivityTimestamp,
	isUnlocked,
	updateActivity,
} from "./session-manager";
import type { MessageResponse } from "./types";
import { hostnameMatches } from "./vault-utils";

/**
 * Handle CHECK_AUTOFILL_AUTH message - Check if autofill is authenticated
 */
export async function handleCheckAutofillAuth(): Promise<MessageResponse> {
	const unlocked = isUnlocked();

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
 * Get all decrypted items from @bittery/core.
 */
async function getAllDecryptedItems(): Promise<Array<DecryptedItem | null>> {
	const { accountsInfo, isAllAccountsMode } =
		await core.accounts.resolveAccounts();
	return core.items.fetchAndDecryptItems(accountsInfo, { isAllAccountsMode });
}

/**
 * Handle GET_AUTOFILL_ITEMS message - Get autofill items for a hostname
 */
export async function handleGetAutofillItems(payload: {
	hostname: string;
}): Promise<MessageResponse> {
	updateActivity();

	const { hostname } = payload;
	const items = await getAllDecryptedItems();

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

	const items = await getAllDecryptedItems();
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

	const items = await getAllDecryptedItems();
	const identities = items.filter((item) => item?.category === "identity");

	return { success: true, items: identities };
}
