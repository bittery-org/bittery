/**
 * Native Messaging
 * Handles communication with the desktop app for biometric unlock
 */

import { createStoredAccountRpcClient } from "@bittery/core/services/account-resolver";
import { selectActiveAccountAfterUnlock } from "@bittery/core/services/select-active-account";
import { getTravelModeEnforcer } from "@bittery/core/services/travel-mode-enforcer";
import { itemCache, storage } from "../lib/storage";
import { decrypt } from "../lib/wasm-crypto";
import {
	requestAllBiometricTransfer,
	requestSingleBiometricTransfer,
	STALE_DESKTOP_UNLOCK_RESPONSE,
} from "./biometric-transfer";
import { desktopSync } from "./desktop-sync";
import { PENDING_DESKTOP_UNLOCK, requireDesktopUnlock } from "./desktop-unlock";
import { sendNativeMessage } from "./native-messaging-client";
import {
	setDesktopModeSentinel,
	setMasterUnlockKey,
	updateActivity,
} from "./session-manager";
import type { MessageResponse } from "./types";

/**
 * Check if native biometric unlock is available
 */
export async function handleCheckNativeBiometric(): Promise<MessageResponse> {
	try {
		const response = await sendNativeMessage({
			type: "CHECK_BIOMETRIC_AVAILABLE",
		});

		return {
			success: true,
			available:
				response.type === "BIOMETRIC_STATUS" ? response.available : false,
			enabled: response.type === "BIOMETRIC_STATUS" ? response.enabled : false,
			appRunning:
				response.type === "BIOMETRIC_STATUS"
					? (response.appRunning ?? response.app_running ?? false)
					: false,
		};
	} catch (error) {
		console.error("[CHECK_NATIVE_BIOMETRIC] Error:", error);
		return {
			success: true,
			available: false,
			enabled: false,
			appRunning: false,
		};
	}
}

export { STALE_DESKTOP_UNLOCK_RESPONSE };

/** Same contract as above: a code for the UI to translate, not a sentence. */
export const TRAVEL_MODE_UNVERIFIED = "travel-mode-unverified";

function decodeMasterUnlockKey(value: string): Uint8Array {
	const binary = atob(value);
	const key = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		key[index] = binary.charCodeAt(index);
	}
	return key;
}

/**
 * Request biometric unlock from desktop app
 */
export async function handleNativeBiometricUnlock(): Promise<MessageResponse> {
	try {
		const activeAccount = await storage.getActiveAccount();
		if (!activeAccount || activeAccount.type !== "single") {
			throw new Error("No active account. Please log in again.");
		}

		const transfer = await requestSingleBiometricTransfer({
			accountId: activeAccount.accountId,
			extensionId: chrome.runtime.id,
		});
		if (!transfer.ok) {
			throw new Error(transfer.code);
		}

		const { material } = transfer;
		await storage.setBiometricEnabled(activeAccount.accountId, true);

		const mukBase64 = await decrypt(material.encryptedMuk, material.deviceKey);
		const muk = decodeMasterUnlockKey(mukBase64);

		if (material.authToken) {
			await storage.storeAuthToken(material.authToken, activeAccount.accountId);
		} else if (!(await storage.getAuthToken(activeAccount.accountId))) {
			throw new Error("Missing auth token in response and storage");
		}

		const enforcer = getTravelModeEnforcer(storage, itemCache);
		const client = await createStoredAccountRpcClient(
			storage,
			activeAccount.accountId,
		).catch(() => null);
		if (!(await enforcer.verifyOrClear(activeAccount.accountId, client))) {
			throw new Error(TRAVEL_MODE_UNVERIFIED);
		}

		if (material.vaultKeys) {
			await storage.storeVaultKeys(
				enforcer.filterVaultKeys(activeAccount.accountId, material.vaultKeys),
				activeAccount.accountId,
			);
		} else {
			const storedVaultKeys = await storage.getVaultKeys(
				activeAccount.accountId,
			);
			if (!storedVaultKeys || storedVaultKeys.length === 0) {
				throw new Error("Missing vault keys in response and storage");
			}
		}

		setMasterUnlockKey(muk);
		await storage.setMasterUnlockKey(muk, activeAccount.accountId);
		await updateActivity();

		return {
			success: true,
			message: "Biometric unlock successful",
		};
	} catch (error) {
		console.error("[NATIVE_BIOMETRIC_UNLOCK] Error:", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Request desktop app to open
 */
export async function handleOpenDesktopApp(payload?: {
	intent?: "create_item" | "view_item";
	url?: string;
	itemId?: string;
	vaultId?: string;
}): Promise<MessageResponse> {
	try {
		const response = await sendNativeMessage({
			type: "OPEN_DESKTOP_APP",
			intent: payload?.intent,
			url: payload?.url,
			itemId: payload?.itemId,
			vaultId: payload?.vaultId,
		});

		if (response.type === "OPEN_DESKTOP_APP_RESULT") {
			return {
				success: response.success,
				error: response.error,
			};
		}
		if (response.type === "ERROR") {
			return {
				success: false,
				error: response.message || "Failed to open desktop app",
			};
		}
		return { success: true };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Biometric unlock all accounts
 * Strategy: If desktop available, unlock desktop. Otherwise unlock extension locally.
 */
export async function handleNativeBiometricUnlockAll(options?: {
	forceLocalUnlock?: boolean;
	preserveActiveAccount?: boolean;
}): Promise<MessageResponse> {
	try {
		const accounts = await storage.getAccountsList();

		if (accounts.length === 0) {
			throw new Error("No accounts found");
		}

		// Check if desktop is available and unlocked
		const desktopStatus = desktopSync.getLastStatus();
		const desktopAvailable = desktopStatus?.available;
		const desktopLocked = desktopStatus?.locked ?? true;
		const desktopUnlockedAccounts = desktopStatus?.unlockedAccounts ?? [];

		// If desktop is available AND unlocked, we can use desktop mode directly
		if (
			!options?.forceLocalUnlock &&
			desktopAvailable &&
			!desktopLocked &&
			desktopUnlockedAccounts.length > 0
		) {
			// Desktop is already unlocked - just set sentinel and return success
			setDesktopModeSentinel();

			return {
				success: true,
				result: {
					unlocked: desktopUnlockedAccounts,
					failed: [],
					mode: "desktop",
				},
			};
		}

		// Desktop available but locked: it owns the unlock. Report the handoff as a
		// status rather than a success, so the popup waits for the pushed
		// `unlock` event instead of claiming the vault is open.
		//
		// `forceLocalUnlock` skips this, but only ever runs when the desktop is
		// already unlocked (see `desktop-key-material.ensureDesktopWriteCapability`),
		// so it cannot open a divergence.
		if (!options?.forceLocalUnlock && desktopAvailable && desktopLocked) {
			const desktopUnlock = await requireDesktopUnlock();
			if (desktopUnlock.required) {
				return {
					success: true,
					status: PENDING_DESKTOP_UNLOCK,
					desktopReachable: desktopUnlock.triggered,
				};
			}
		}

		const transfer = await requestAllBiometricTransfer({
			expectedAccountIds: accounts.map((account) => account.accountId),
			extensionId: chrome.runtime.id,
		});
		if (!transfer.ok) {
			throw new Error(transfer.code);
		}

		const unlocked: string[] = [];
		const failed: Array<{ accountId: string; email: string; error: string }> =
			[];

		// Read before the loop below can tear a session down.
		const previousActive = await storage.getActiveAccount();

		for (const material of transfer.materials) {
			const { accountId, email } = material;

			try {
				const mukBase64 = await decrypt(
					material.encryptedMuk,
					material.deviceKey,
				);
				const muk = decodeMasterUnlockKey(mukBase64);

				if (material.authToken) {
					await storage.storeAuthToken(material.authToken, accountId);
				}

				const enforcer = getTravelModeEnforcer(storage, itemCache);
				const client = await createStoredAccountRpcClient(
					storage,
					accountId,
				).catch(() => null);
				if (!(await enforcer.verifyOrClear(accountId, client))) {
					failed.push({
						accountId,
						email,
						error: TRAVEL_MODE_UNVERIFIED,
					});
					continue;
				}

				if (material.vaultKeys) {
					await storage.storeVaultKeys(
						enforcer.filterVaultKeys(accountId, material.vaultKeys),
						accountId,
					);
				}

				await storage.setMasterUnlockKey(muk, accountId);

				unlocked.push(accountId);
			} catch (error) {
				if (accountId) await storage.clearSession(accountId);
				failed.push({
					accountId,
					email,
					error: error instanceof Error ? error.message : "Unknown error",
				});
				console.error(
					`[NATIVE_BIOMETRIC_UNLOCK_ALL] Failed to process ${email}:`,
					error,
				);
			}
		}

		if (unlocked.length === 0) {
			throw new Error("Failed to unlock any accounts");
		}

		// All-accounts mode was removed; even when several accounts unlock, the app
		// operates on a single active account.
		const activeAccountId = selectActiveAccountAfterUnlock({
			previousActive,
			unlockedAccountIds: unlocked,
			accounts,
		});
		if (!activeAccountId) {
			throw new Error("No unlocked account found");
		}

		if (!options?.preserveActiveAccount) {
			await storage.setActiveAccount({
				type: "single",
				accountId: activeAccountId,
			});
		}

		// IMPORTANT: Update activity FIRST to set timestamp, otherwise isUnlocked()
		// will see lastActivityTimestamp=0 and immediately lock everything!
		await updateActivity();

		const activeMuk = await storage.getMasterUnlockKey(activeAccountId);
		if (activeMuk) {
			setMasterUnlockKey(activeMuk);
		}

		return {
			success: true,
			result: { unlocked, failed },
			message: "Biometric unlock completed",
		};
	} catch (error) {
		console.error("[NATIVE_BIOMETRIC_UNLOCK_ALL] Error:", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
