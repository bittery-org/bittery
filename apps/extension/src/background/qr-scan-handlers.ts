/**
 * QR Scan Handlers
 * Handles tab screenshot capture and TOTP field updates
 */

import { ensureDesktopWriteCapability } from "./desktop-key-material";
import { updateExtensionItem } from "./extension-item-mutations";
import { resolveAccountEmailForItemId } from "./services/account-resolution";
import {
	ensureUnlockedOrRecoverFromDesktop,
	updateActivity,
} from "./session-manager";
import type { MessageResponse } from "./types";
import { getDecryptedItemsForCurrentMode } from "./vault-utils";

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
		const item = (await getDecryptedItemsForCurrentMode()).find(
			(candidate) => candidate?.id === itemId,
		);

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

		const accountEmail = await resolveAccountEmailForItemId(itemId);
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

		await updateExtensionItem({
			itemId,
			accountEmail,
			data: {
				totpSecret: totp.totpSecret,
				totpIssuer: totp.totpIssuer || item.totpIssuer,
				totpAccountName: totp.totpAccountName || item.totpAccountName,
				totpAlgorithm: totp.totpAlgorithm || item.totpAlgorithm || "SHA1",
				totpDigits: totp.totpDigits || item.totpDigits || 6,
				totpPeriod: totp.totpPeriod || item.totpPeriod || 30,
			},
		});

		return {
			success: true,
			message: "TOTP added successfully",
		};
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
