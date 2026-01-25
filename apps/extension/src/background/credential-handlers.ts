/**
 * Credential Handlers
 * Handles saving and updating credentials (password capture)
 */

import { storage } from "../lib/storage";
import { encrypt } from "../lib/wasm-crypto";
import { isUnlocked, updateActivity } from "./session-manager";
import { trpcClient } from "./trpc-client";
import type { MessageResponse } from "./types";
import { decryptVaultItems, hostnameMatches } from "./vault-utils";

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

	// Extract hostname from URL
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

	const items = await decryptVaultItems();

	// Filter by hostname
	const matchingItems = items.filter((item) =>
		hostnameMatches(item?.url, hostname),
	);

	// If username is provided, filter further to find exact username matches
	let exactMatches = matchingItems;
	if (username) {
		exactMatches = matchingItems.filter(
			(item) => item.username?.toLowerCase() === username.toLowerCase(),
		);
	}

	// Check if credentials have actually changed
	let hasChanges = true; // Default to true (show prompt)
	if (exactMatches.length > 0 && username && password) {
		// Check if any of the exact matches have the same password
		const exactPasswordMatch = exactMatches.some(
			(item) =>
				item.username?.toLowerCase() === username.toLowerCase() &&
				item.password === password,
		);

		// If we found an exact match (same username AND password), there are no changes
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
		hasChanges, // New field to indicate if credentials actually changed
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

	// Validate inputs
	if (!vaultId || !username || !password || !url) {
		return {
			success: false,
			error: "Missing required fields",
			errorType: "validation",
		};
	}

	// Check if extension is still unlocked
	if (!isUnlocked()) {
		return {
			success: false,
			error: "Extension is locked. Please unlock and try again.",
			errorType: "locked",
		};
	}

	// Get vault key for the selected vault
	const vaultKeys = await storage.getVaultKeys();
	if (!vaultKeys || vaultKeys.length === 0) {
		return {
			success: false,
			error: "No vault keys available. Please re-authenticate.",
			errorType: "vault_key",
		};
	}

	const vaultKeyData = vaultKeys.find((vk) => vk.vaultId === vaultId);
	if (!vaultKeyData) {
		return {
			success: false,
			error: "Vault key not found. Please select a different vault.",
			errorType: "vault_key",
		};
	}

	try {
		// Decrypt vault key
		const vaultKey = await storage.decryptVaultKey(
			vaultKeyData.encryptedVaultKey,
		);

		// Extract hostname from URL for title
		const hostname = extractHostname(url);

		// Prepare credential data to encrypt (all data goes in encryptedData)
		const credentialData = {
			title: hostname,
			url,
			username,
			password,
		};

		// Encrypt credential data with vault key
		const encryptedData = await encrypt(
			JSON.stringify(credentialData),
			vaultKey,
		);

		// Create item via tRPC
		const result = await trpcClient.vault.createItem.mutate({
			vaultId,
			category: "login",
			encryptedData: encryptedData.ciphertext,
			encryptionIv: encryptedData.iv,
			encryptionAlgorithm: encryptedData.algorithm,
		});

		return { success: true, itemId: result.itemId };
	} catch (error: any) {
		console.error("Error saving credential:", error);

		// Determine error type and message
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

	// Validate inputs
	if (!itemId || !vaultId || !username || !password || !url) {
		return {
			success: false,
			error: "Missing required fields",
			errorType: "validation",
		};
	}

	// Check if extension is still unlocked
	if (!isUnlocked()) {
		return {
			success: false,
			error: "Extension is locked. Please unlock and try again.",
			errorType: "locked",
		};
	}

	// Get vault key for the selected vault
	const vaultKeys = await storage.getVaultKeys();
	if (!vaultKeys || vaultKeys.length === 0) {
		return {
			success: false,
			error: "No vault keys available. Please re-authenticate.",
			errorType: "vault_key",
		};
	}

	const vaultKeyData = vaultKeys.find((vk) => vk.vaultId === vaultId);
	if (!vaultKeyData) {
		return {
			success: false,
			error: "Vault key not found. Please select a different vault.",
			errorType: "vault_key",
		};
	}

	try {
		// Decrypt vault key
		const vaultKey = await storage.decryptVaultKey(
			vaultKeyData.encryptedVaultKey,
		);

		// Extract hostname from URL for title
		const hostname = extractHostname(url);

		// Prepare credential data to encrypt (all data goes in encryptedData)
		const credentialData = {
			title: hostname,
			url,
			username,
			password,
		};

		// Encrypt credential data with vault key
		const encryptedData = await encrypt(
			JSON.stringify(credentialData),
			vaultKey,
		);

		// Update item via tRPC
		await trpcClient.vault.updateItem.mutate({
			itemId,
			encryptedData: encryptedData.ciphertext,
			encryptionIv: encryptedData.iv,
		});

		return { success: true };
	} catch (error: any) {
		console.error("Error updating credential:", error);

		// Determine error type and message
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
