/**
 * QR Scan Handlers
 * Handles tab screenshot capture and TOTP field updates
 */

import { resolveAccountScopeId } from "@bittery/storage/account-id";
import { crypto } from "../lib/crypto";
import { storage } from "../lib/storage";
import { apiClient } from "./api-client";
import { core } from "./core-instance";
import { ensureDesktopWriteCapability } from "./desktop-key-material";
import { resolveAccountEmailForVault } from "./services/account-resolution";
import { onLocalItemUpdated } from "./services/local-item-cache-service";
import {
	ensureUnlockedOrRecoverFromDesktop,
	updateActivity,
} from "./session-manager";
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
		// @ts-expect-error - Chrome types may not include captureVisibleTab
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
	} catch (error) {
		console.error("Error capturing tab screenshot:", error);
		const errorMessage = error instanceof Error ? error.message : String(error);

		// Handle specific Chrome permission errors
		if (
			errorMessage.includes("Cannot access") ||
			errorMessage.includes("permission")
		) {
			return {
				success: false,
				error:
					"Cannot capture this page. Try refreshing or opening a different page.",
			};
		}

		return {
			success: false,
			error: errorMessage || "Failed to capture tab screenshot",
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
	if (!(await ensureUnlockedOrRecoverFromDesktop())) {
		return {
			success: false,
			error: "Extension is locked. Please unlock and try again.",
			errorType: "locked",
		};
	}

	try {
		// Get the existing item
		const { data: item } = await apiClient.items.get(itemId);

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

		const accountEmail = await resolveAccountEmailForVault(item.vaultId);
		if (!accountEmail) {
			return {
				success: false,
				error:
					"Could not resolve account for this vault. Please re-authenticate.",
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

		// Get vault key for the item's vault. `AccountStore` is keyed by accountId, so the
		// email has to be resolved first.
		const accountId = await resolveAccountScopeId(storage, accountEmail);
		const vaultKey = await core.vaultCrypto.getVaultKey({
			vaultId: item.vaultId,
			accountId,
		});
		if (!vaultKey) {
			return {
				success: false,
				error: "Vault key not found for this item.",
				errorType: "vault_key",
			};
		}

		try {
			const session = await storage.getStoredSessionData(accountId);
			if (!session) {
				throw new Error("Session data not available. Please re-authenticate.");
			}
			const scope = {
				vaultId: item.vaultId,
				itemId: item.id,
				version: item.version ?? 1,
				userId: session.userId,
			};
			const decrypted = await core.vaultCrypto.decryptItem(
				{
					algorithm: item.encryptionAlgorithm,
					iv: item.encryptionIv,
					ciphertext: item.encryptedData,
				},
				vaultKey,
				scope,
			);

			const existingData = JSON.parse(decrypted);
			const updatedData = {
				...existingData,
				totpSecret: totp.totpSecret,
				totpIssuer: totp.totpIssuer || existingData.totpIssuer,
				totpAccountName: totp.totpAccountName || existingData.totpAccountName,
				totpAlgorithm:
					totp.totpAlgorithm || existingData.totpAlgorithm || "SHA1",
				totpDigits: totp.totpDigits || existingData.totpDigits || 6,
				totpPeriod: totp.totpPeriod || existingData.totpPeriod || 30,
			};
			const encryptedData = await core.vaultCrypto.encryptItem(
				JSON.stringify(updatedData),
				vaultKey,
				scope,
			);

			await apiClient.items.update(
				itemId,
				{
					encryptedData: encryptedData.ciphertext,
					encryptionIv: encryptedData.iv,
					encryptionAlgorithm: encryptedData.algorithm,
				},
				{ etag: `"${item.version}"` },
			);

			await onLocalItemUpdated({
				itemId,
				encryptedData,
				accountEmail,
			});

			return {
				success: true,
				message: "TOTP added successfully",
			};
		} finally {
			await crypto.destroyKey(vaultKey);
		}
	} catch (error) {
		console.error("Error updating item TOTP:", error);
		const errorMessageRaw =
			error instanceof Error ? error.message : String(error);

		// Determine error type and message
		let errorMessage = "Failed to update item with TOTP. Please try again.";
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
