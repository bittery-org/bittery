/**
 * Credential Handlers
 * Handles saving and updating credentials (password capture).
 */

import { core } from "./core-instance";
import { ensureDesktopWriteCapability } from "./desktop-key-material";
import {
	resolveAccountEmailForItemId,
	resolveAccountEmailForVault,
} from "./services/account-resolution";
import {
	onLocalItemCreated,
	onLocalItemUpdated,
} from "./services/local-item-cache-service";
import {
	ensureUnlockedOrRecoverFromDesktop,
	updateActivity,
} from "./session-manager";
import { trpcClient } from "./trpc-client";
import type { MessageResponse } from "./types";
import {
	getDecryptedItemsForCurrentMode,
	hostnameMatches,
} from "./vault-utils";

/**
 * Helper function to extract hostname from URL
 */
function extractHostname(url: string): string {
	try {
		const urlObj = new URL(url.startsWith("http") ? url : `https://${url}`);
		return urlObj.hostname;
	} catch {
		return url;
	}
}

async function getAllItemsForMatching() {
	return getDecryptedItemsForCurrentMode();
}

/**
 * Handle CHECK_EXISTING_CREDENTIALS message - Check if credentials already exist for URL/username
 */
export async function handleCheckExistingCredentials(payload: {
	url: string;
	username?: string;
	password?: string;
}): Promise<MessageResponse> {
	updateActivity();

	const { url, username, password } = payload;

	if (!url) {
		return {
			success: false,
			error: "URL is required",
		};
	}

	let hostname: string;
	try {
		const urlObj = new URL(url.startsWith("http") ? url : `https://${url}`);
		hostname = urlObj.hostname;
	} catch {
		return {
			success: false,
			error: "Invalid URL",
		};
	}

	const items = await getAllItemsForMatching();
	const resolvedItems = items.filter(
		(item): item is NonNullable<(typeof items)[number]> => item !== null,
	);
	const matchingItems = resolvedItems.filter((item) =>
		hostnameMatches(item?.url ?? "", hostname),
	);

	let exactMatches = matchingItems;
	if (username) {
		exactMatches = matchingItems.filter(
			(item) => item.username?.toLowerCase() === username.toLowerCase(),
		);
	}

	let hasChanges = true;
	if (exactMatches.length > 0 && username && password) {
		const exactPasswordMatch = exactMatches.some(
			(item) =>
				item.username?.toLowerCase() === username.toLowerCase() &&
				item.password === password,
		);
		hasChanges = !exactPasswordMatch;
	}

	return {
		success: true,
		existingCredentials: exactMatches.map((item) => ({
			id: item.id,
			vaultId: item.vaultId,
			username: item.username || "",
			url: item.url || "",
		})),
		hasDuplicates: exactMatches.length > 0,
		hasChanges,
	};
}

/**
 * Handle SAVE_NEW_CREDENTIAL message - Save a new credential
 */
export async function handleSaveNewCredential(payload: {
	vaultId: string;
	username: string;
	password: string;
	url: string;
}): Promise<MessageResponse> {
	updateActivity();

	const { vaultId, username, password, url } = payload;

	if (!vaultId || !username || !password || !url) {
		return {
			success: false,
			error: "Missing required fields",
			errorType: "validation",
		};
	}

	if (!(await ensureUnlockedOrRecoverFromDesktop())) {
		return {
			success: false,
			error: "Extension is locked. Please unlock and try again.",
			errorType: "locked",
		};
	}

	try {
		const accountEmail = await resolveAccountEmailForVault(vaultId);
		if (!accountEmail) {
			return {
				success: false,
				error:
					"Could not resolve account for the selected vault. Please re-authenticate.",
				errorType: "vault_key",
			};
		}

		const hasWriteCapability = await ensureDesktopWriteCapability(accountEmail);
		if (!hasWriteCapability) {
			return {
				success: false,
				error: "No vault keys available. Please re-authenticate.",
				errorType: "vault_key",
			};
		}
		const hostname = extractHostname(url);

		const result = await core.items.createItem(
			{
				vaultId,
				category: "login",
				data: {
					title: hostname,
					url,
					username,
					password,
				},
				accountEmail,
			},
			trpcClient as Parameters<typeof core.items.createItem>[1],
		);

		await onLocalItemCreated({
			itemId: result.itemId,
			vaultId,
			category: "login",
			encryptedData: result._encryptedData,
			accountEmail,
		});

		return { success: true, itemId: result.itemId };
	} catch (error) {
		console.error("Error saving credential:", error);
		const errorMessageRaw =
			error instanceof Error ? error.message : String(error);

		let errorMessage = "Failed to save credentials. Please try again.";
		let errorType = "unknown";

		if (
			errorMessageRaw.includes("network") ||
			errorMessageRaw.includes("fetch")
		) {
			errorMessage = "Network error. Check your connection and try again.";
			errorType = "network";
		} else if (
			errorMessageRaw.includes("decrypt") ||
			errorMessageRaw.includes("encryption")
		) {
			errorMessage = "Encryption error. Please unlock and try again.";
			errorType = "encryption";
		} else if (
			errorMessageRaw.includes("unauthorized") ||
			errorMessageRaw.includes("auth")
		) {
			errorMessage = "Authentication error. Please re-authenticate.";
			errorType = "auth";
		} else if (
			errorMessageRaw.includes("permission") ||
			errorMessageRaw.includes("access")
		) {
			errorMessage =
				"Permission denied. You may not have write access to this vault.";
			errorType = "permission";
		}

		return {
			success: false,
			error: errorMessage,
			errorType,
		};
	}
}

/**
 * Handle UPDATE_EXISTING_CREDENTIAL message - Update an existing credential
 */
export async function handleUpdateExistingCredential(payload: {
	itemId: string;
	vaultId: string;
	username: string;
	password: string;
	url: string;
}): Promise<MessageResponse> {
	updateActivity();

	const { itemId, vaultId, username, password, url } = payload;

	if (!itemId || !vaultId || !username || !password || !url) {
		return {
			success: false,
			error: "Missing required fields",
			errorType: "validation",
		};
	}

	if (!(await ensureUnlockedOrRecoverFromDesktop())) {
		return {
			success: false,
			error: "Extension is locked. Please unlock and try again.",
			errorType: "locked",
		};
	}

	try {
		const accountEmail = await resolveAccountEmailForItemId(
			itemId,
			getAllItemsForMatching,
		);

		if (!accountEmail) {
			return {
				success: false,
				error: "Could not resolve account for this item.",
				errorType: "vault_key",
			};
		}

		const hasWriteCapability = await ensureDesktopWriteCapability(accountEmail);
		if (!hasWriteCapability) {
			return {
				success: false,
				error: "No vault keys available. Please re-authenticate.",
				errorType: "vault_key",
			};
		}
		const hostname = extractHostname(url);

		const result = await core.items.updateItem(
			{
				itemId,
				vaultId,
				data: {
					title: hostname,
					url,
					username,
					password,
				},
				accountEmail,
			},
			trpcClient as Parameters<typeof core.items.updateItem>[1],
		);

		await onLocalItemUpdated({
			itemId,
			encryptedData: result._encryptedData,
			accountEmail: result._accountEmail,
		});

		return { success: true };
	} catch (error) {
		console.error("Error updating credential:", error);
		const errorMessageRaw =
			error instanceof Error ? error.message : String(error);

		let errorMessage = "Failed to update credentials. Please try again.";
		let errorType = "unknown";

		if (
			errorMessageRaw.includes("network") ||
			errorMessageRaw.includes("fetch")
		) {
			errorMessage = "Network error. Check your connection and try again.";
			errorType = "network";
		} else if (
			errorMessageRaw.includes("decrypt") ||
			errorMessageRaw.includes("encryption")
		) {
			errorMessage = "Encryption error. Please unlock and try again.";
			errorType = "encryption";
		} else if (
			errorMessageRaw.includes("unauthorized") ||
			errorMessageRaw.includes("auth")
		) {
			errorMessage = "Authentication error. Please re-authenticate.";
			errorType = "auth";
		} else if (
			errorMessageRaw.includes("permission") ||
			errorMessageRaw.includes("access")
		) {
			errorMessage =
				"Permission denied. You may not have write access to this vault.";
			errorType = "permission";
		} else if (errorMessageRaw.includes("not found")) {
			errorMessage = "Credential not found. It may have been deleted.";
			errorType = "not_found";
		}

		return {
			success: false,
			error: errorMessage,
			errorType,
		};
	}
}
