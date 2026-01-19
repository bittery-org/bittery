/**
 * QR Scan Handlers
 * Handles tab screenshot capture and TOTP field updates
 */

import { chromeStorage, decrypt, encrypt } from "@bittery/crypto";
import { isUnlocked, updateActivity } from "./session-manager";
import { trpcClient } from "./trpc-client";
import type { MessageResponse } from "./types";

/**
 * Handle CAPTURE_TAB_SCREENSHOT message - Capture screenshot of current tab
 */
export async function handleCaptureTabScreenshot(): Promise<MessageResponse> {
	updateActivity();

	try {
		// Get the current active tab
		const [tab] = await chrome.tabs.query({
			active: true,
			currentWindow: true,
		});

		if (!tab?.id) {
			return {
				success: false,
				error: "No active tab found",
			};
		}

		// Capture the visible area of the tab
		const dataUrl = await chrome.tabs.captureVisibleTab(undefined, {
			format: "png",
		});

		if (!dataUrl) {
			return {
				success: false,
				error: "Failed to capture tab screenshot",
			};
		}

		return {
			success: true,
			dataUrl,
		};
	} catch (error: any) {
		console.error("Error capturing tab screenshot:", error);

		// Handle specific Chrome permission errors
		if (
			error.message?.includes("Cannot access") ||
			error.message?.includes("permission")
		) {
			return {
				success: false,
				error:
					"Cannot capture this page. Try refreshing or opening a different page.",
			};
		}

		return {
			success: false,
			error: error.message || "Failed to capture tab screenshot",
		};
	}
}

/**
 * TOTP data structure for updating an item
 */
interface TotpUpdateData {
	totpSecret: string;
	totpIssuer?: string;
	totpAccountName?: string;
	totpAlgorithm?: "SHA1" | "SHA256" | "SHA512";
	totpDigits?: 6 | 7 | 8;
	totpPeriod?: number;
}

/**
 * Handle UPDATE_ITEM_TOTP message - Add/update TOTP field on an existing item
 */
export async function handleUpdateItemTotp(payload: {
	itemId: string;
	totp: TotpUpdateData;
}): Promise<MessageResponse> {
	updateActivity();

	const { itemId, totp } = payload;

	// Validate inputs
	if (!itemId || !totp?.totpSecret) {
		return {
			success: false,
			error: "Missing required fields (itemId and TOTP secret)",
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

	try {
		// Get the existing item
		const item = await trpcClient.vault.getItem.query({ itemId });

		if (!item) {
			return {
				success: false,
				error: "Item not found",
				errorType: "not_found",
			};
		}

		// Verify item is a login item (TOTP can only be added to login items)
		if (item.category !== "login") {
			return {
				success: false,
				error: "TOTP can only be added to login items",
				errorType: "invalid_category",
			};
		}

		// Get vault key for the item's vault
		const vaultKeys = await chromeStorage.getVaultKeys();
		if (!vaultKeys || vaultKeys.length === 0) {
			return {
				success: false,
				error: "No vault keys available. Please re-authenticate.",
				errorType: "vault_key",
			};
		}

		const vaultKeyData = vaultKeys.find((vk) => vk.vaultId === item.vaultId);
		if (!vaultKeyData) {
			return {
				success: false,
				error: "Vault key not found for this item.",
				errorType: "vault_key",
			};
		}

		// Decrypt vault key
		const vaultKey = await chromeStorage.decryptVaultKey(
			vaultKeyData.encryptedVaultKey,
		);

		// Decrypt existing item data
		const decrypted = await decrypt(
			{
				algorithm: item.encryptionAlgorithm,
				iv: item.encryptionIv,
				ciphertext: item.encryptedData,
			},
			vaultKey,
		);

		const existingData = JSON.parse(decrypted);

		// Merge existing data with new TOTP fields
		const updatedData = {
			...existingData,
			totpSecret: totp.totpSecret,
			totpIssuer: totp.totpIssuer || existingData.totpIssuer,
			totpAccountName: totp.totpAccountName || existingData.totpAccountName,
			totpAlgorithm: totp.totpAlgorithm || existingData.totpAlgorithm || "SHA1",
			totpDigits: totp.totpDigits || existingData.totpDigits || 6,
			totpPeriod: totp.totpPeriod || existingData.totpPeriod || 30,
		};

		// Encrypt updated data
		const encryptedData = await encrypt(JSON.stringify(updatedData), vaultKey);

		// Update item via tRPC
		await trpcClient.vault.updateItem.mutate({
			itemId,
			encryptedData: encryptedData.ciphertext,
			encryptionIv: encryptedData.iv,
		});

		return {
			success: true,
			message: "TOTP added successfully",
		};
	} catch (error: any) {
		console.error("Error updating item TOTP:", error);

		// Determine error type and message
		let errorMessage = "Failed to update item with TOTP. Please try again.";
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
			errorMessage = "Item not found. It may have been deleted.";
			errorType = "not_found";
		}

		return {
			success: false,
			error: errorMessage,
			errorType,
		};
	}
}
