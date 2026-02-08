/**
 * Credential Handlers
 * Handles saving and updating credentials (password capture).
 */

import { storage } from "../lib/storage";
import { core } from "./core-instance";
import {
	ensureDesktopWriteCapability,
	hydrateDesktopAccountMaterial,
} from "./desktop-key-material";
import { desktopSync } from "./desktop-sync";
import { isUnlocked, updateActivity } from "./session-manager";
import { trpcClient } from "./trpc-client";
import type { MessageResponse } from "./types";
import { getDecryptedItemsForCurrentMode, hostnameMatches } from "./vault-utils";

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

async function resolveAccountEmailForVault(
	vaultId: string,
): Promise<string | undefined> {
	const activeAccount = await storage.getActiveAccount();
	if (activeAccount?.type === "single") {
		return activeAccount.email;
	}

	const localUnlockedEmails = (await storage.getUnlockedAccounts?.()) ?? [];
	const desktopStatus = desktopSync.getLastStatus();
	const desktopUnlockedEmails =
		desktopStatus?.available && !desktopStatus.locked
			? (desktopStatus.unlockedAccounts ?? [])
			: [];

	const unlockedEmails = Array.from(
		new Set([...localUnlockedEmails, ...desktopUnlockedEmails]),
	);

	for (const email of unlockedEmails) {
		await hydrateDesktopAccountMaterial(email);
		let vaultKeys = await storage.getVaultKeys(email);
		if (!vaultKeys || vaultKeys.length === 0) {
			const hydrated = await ensureDesktopWriteCapability(email);
			if (hydrated) {
				vaultKeys = await storage.getVaultKeys(email);
			}
		}
		if (vaultKeys?.some((vaultKey) => vaultKey.vaultId === vaultId)) {
			return email;
		}
	}

	return undefined;
}

async function resolveAccountEmailForItem(
	itemId: string,
): Promise<string | undefined> {
	const activeAccount = await storage.getActiveAccount();
	if (activeAccount?.type !== "all") {
		return undefined;
	}

	const items = await getAllItemsForMatching();
	const item = items.find((candidate) => candidate?.id === itemId) as
		| { account?: { email?: string } }
		| undefined;

	return item?.account?.email;
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

	if (!isUnlocked()) {
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

		const hasWriteCapability =
			await ensureDesktopWriteCapability(accountEmail);
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

		await core.cache.onItemCreated({
			itemId: result.itemId,
			vaultId,
			category: "login",
			encryptedData: result._encryptedData,
			accountEmail,
		});

		return { success: true, itemId: result.itemId };
	} catch (error: any) {
		console.error("Error saving credential:", error);

		let errorMessage = "Failed to save credentials. Please try again.";
		let errorType = "unknown";

		if (
			error.message?.includes("network") ||
			error.message?.includes("fetch")
		) {
			errorMessage = "Network error. Check your connection and try again.";
			errorType = "network";
		} else if (
			error.message?.includes("decrypt") ||
			error.message?.includes("encryption")
		) {
			errorMessage = "Encryption error. Please unlock and try again.";
			errorType = "encryption";
		} else if (
			error.message?.includes("unauthorized") ||
			error.message?.includes("auth")
		) {
			errorMessage = "Authentication error. Please re-authenticate.";
			errorType = "auth";
		} else if (
			error.message?.includes("permission") ||
			error.message?.includes("access")
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

	if (!isUnlocked()) {
		return {
			success: false,
			error: "Extension is locked. Please unlock and try again.",
			errorType: "locked",
		};
	}

	try {
		let accountEmail = await resolveAccountEmailForItem(itemId);
		if (!accountEmail) {
			const activeAccount = await storage.getActiveAccount();
			if (activeAccount?.type === "single") {
				accountEmail = activeAccount.email;
			}
		}

		if (!accountEmail) {
			return {
				success: false,
				error: "Could not resolve account for this item.",
				errorType: "vault_key",
			};
		}

		const hasWriteCapability =
			await ensureDesktopWriteCapability(accountEmail);
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

		await core.cache.onItemUpdated({
			itemId,
			encryptedData: result._encryptedData,
			accountEmail: result._accountEmail,
		});

		return { success: true };
	} catch (error: any) {
		console.error("Error updating credential:", error);

		let errorMessage = "Failed to update credentials. Please try again.";
		let errorType = "unknown";

		if (
			error.message?.includes("network") ||
			error.message?.includes("fetch")
		) {
			errorMessage = "Network error. Check your connection and try again.";
			errorType = "network";
		} else if (
			error.message?.includes("decrypt") ||
			error.message?.includes("encryption")
		) {
			errorMessage = "Encryption error. Please unlock and try again.";
			errorType = "encryption";
		} else if (
			error.message?.includes("unauthorized") ||
			error.message?.includes("auth")
		) {
			errorMessage = "Authentication error. Please re-authenticate.";
			errorType = "auth";
		} else if (
			error.message?.includes("permission") ||
			error.message?.includes("access")
		) {
			errorMessage =
				"Permission denied. You may not have write access to this vault.";
			errorType = "permission";
		} else if (error.message?.includes("not found")) {
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
