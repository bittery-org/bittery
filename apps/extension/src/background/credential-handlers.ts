/**
 * Credential Handlers
 * Handles saving and updating credentials (password capture).
 */

import {
	extractHostname,
	hostnameMatches,
	parseHostname,
} from "../lib/hostname";
import {
	type CredentialErrorType,
	classifyCredentialError,
} from "./credential-error";
import { ensureDesktopWriteCapability } from "./desktop-key-material";
import {
	createExtensionItem,
	updateExtensionItem,
} from "./extension-item-mutations";
import type {
	CheckExistingCredentialsResponse,
	CredentialCapture,
	SaveNewCredentialResponse,
	UpdateExistingCredentialResponse,
} from "./router/contract";
import {
	resolveAccountEmailForItemId,
	resolveAccountEmailForVault,
} from "./services/account-resolution";
import {
	ensureUnlockedOrRecoverFromDesktop,
	updateActivity,
} from "./session-manager";
import { getDecryptedItemsForCurrentMode } from "./vault-utils";

const CREDENTIAL_ERROR_MESSAGES: Partial<Record<CredentialErrorType, string>> =
	{
		network: "Network error. Check your connection and try again.",
		encryption: "Encryption error. Please unlock and try again.",
		auth: "Authentication error. Please re-authenticate.",
		permission:
			"Permission denied. You may not have write access to this vault.",
		not_found: "Credential not found. It may have been deleted.",
	};

function describeCredentialError(
	errorType: CredentialErrorType,
	fallback: string,
): string {
	return CREDENTIAL_ERROR_MESSAGES[errorType] ?? fallback;
}

/**
 * Handle CHECK_EXISTING_CREDENTIALS message - Check if credentials already exist for URL/username
 */
export async function handleCheckExistingCredentials(payload: {
	url: string;
	username?: string;
	password?: string;
}): Promise<CheckExistingCredentialsResponse> {
	updateActivity();

	const { url, username, password } = payload;

	if (!url) {
		return {
			success: false,
			error: "URL is required",
		};
	}

	const hostname = parseHostname(url);
	if (!hostname) {
		return {
			success: false,
			error: "Invalid URL",
		};
	}

	const items = await getDecryptedItemsForCurrentMode();
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
export async function handleSaveNewCredential(
	payload: CredentialCapture,
): Promise<SaveNewCredentialResponse> {
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

		const result = await createExtensionItem({
			vaultId,
			category: "login",
			data: {
				title: hostname,
				url,
				username,
				password,
			},
			accountEmail,
		});

		return { success: true, itemId: result.itemId };
	} catch (error) {
		console.error("Error saving credential:", error);
		const errorType = classifyCredentialError(error);

		return {
			success: false,
			error: describeCredentialError(
				errorType,
				"Failed to save credentials. Please try again.",
			),
			errorType,
		};
	}
}

/**
 * Handle UPDATE_EXISTING_CREDENTIAL message - Update an existing credential
 */
export async function handleUpdateExistingCredential(
	payload: CredentialCapture & { itemId: string },
): Promise<UpdateExistingCredentialResponse> {
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
		const accountEmail = await resolveAccountEmailForItemId(itemId);

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
		await updateExtensionItem({
			itemId,
			data: {
				title: hostname,
				url,
				username,
				password,
			},
			accountEmail,
		});

		return { success: true };
	} catch (error) {
		console.error("Error updating credential:", error);
		const errorType = classifyCredentialError(error);

		return {
			success: false,
			error: describeCredentialError(
				errorType,
				"Failed to update credentials. Please try again.",
			),
			errorType,
		};
	}
}
