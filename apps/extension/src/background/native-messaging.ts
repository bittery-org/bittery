/**
 * Native Messaging
 * Handles communication with the desktop app for biometric unlock
 */

import { storage } from "../lib/storage";
import { decrypt } from "../lib/wasm-crypto";
import { createStoredAccountRpcClient } from "@bittery/core/services/account-resolver";
import { getTravelModeEnforcer } from "@bittery/core/services/travel-mode-enforcer";
import { desktopClient } from "./desktop-client";
import { desktopSync } from "./desktop-sync";
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

		const responseData = response as any;
		const result = {
			success: true,
			available:
				responseData?.type === "BIOMETRIC_STATUS" && responseData.available,
			enabled: responseData?.enabled || false,
			appRunning:
				responseData?.appRunning || responseData?.app_running || false,
		};
		return result;
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

/**
 * Request biometric unlock from desktop app
 */
export async function handleNativeBiometricUnlock(): Promise<MessageResponse> {
	try {
		// Verify we have an active account
		const activeAccount = await storage.getActiveAccount();
		if (!activeAccount || activeAccount.type !== "single") {
			throw new Error("No active account. Please log in again.");
		}

		const challenge = crypto.randomUUID();

		const response = await sendNativeMessage({
			type: "BIOMETRIC_UNLOCK_REQUEST",
			challenge,
			extension_id: chrome.runtime.id,
			accountId: activeAccount.accountId,
		});

		const responseData = response as any;
		if (responseData?.type === "BIOMETRIC_UNLOCK_SUCCESS") {
			if (responseData.accountId !== activeAccount.accountId) {
				throw new Error("Desktop returned biometric data for another account");
			}
			// Verify the response contains the expected data
			if (
				!responseData.encrypted_session ||
				!responseData.device_key ||
				!responseData.signature
			) {
				throw new Error("Invalid response from desktop app");
			}

			// Sync biometric enabled status: if unlock succeeded, biometric must be enabled on desktop
			if (
				activeAccount.type === "single" &&
				"updateBiometricEnabled" in storage
			) {
				await (
					storage as {
						updateBiometricEnabled: (
							accountId: string,
							enabled: boolean,
						) => Promise<void>;
					}
				).updateBiometricEnabled(activeAccount.accountId, true);
			}

			// Verify signature (challenge + encrypted_session)
			const expectedSigData = `${challenge}:${responseData.encrypted_session}`;
			const expectedSig = btoa(expectedSigData);
			if (responseData.signature !== expectedSig) {
				console.warn(
					"[NATIVE_BIOMETRIC_UNLOCK] Signature mismatch (replay attack protection)",
				);
				// Don't fail on signature mismatch for now during development
			}

			// Decode the base64 encrypted session data (it's a JSON-encoded EncryptedData structure)
			const encryptedSessionJson = atob(responseData.encrypted_session);
			const encryptedMuk = JSON.parse(encryptedSessionJson);

			// Decode device key from base64
			const deviceKeyBase64 = responseData.device_key;
			const deviceKeyStr = atob(deviceKeyBase64);
			const deviceKey = new Uint8Array(deviceKeyStr.length);
			for (let i = 0; i < deviceKeyStr.length; i++) {
				deviceKey[i] = deviceKeyStr.charCodeAt(i);
			}

			// Decrypt the MUK using the device key
			const mukBase64 = await decrypt(encryptedMuk, deviceKey);

			// Convert MUK from base64 to Uint8Array
			const mukStr = atob(mukBase64);
			const muk = new Uint8Array(mukStr.length);
			for (let i = 0; i < mukStr.length; i++) {
				muk[i] = mukStr.charCodeAt(i);
			}

			// Get auth token and vault keys from response (desktop app provides them) or storage
			let token: string;
			let vaultKeys: any[];

			if (responseData.auth_token) {
				token = responseData.auth_token;
				await storage.storeAuthToken(token, activeAccount.accountId);
			} else {
				const storedToken = await storage.getAuthToken(activeAccount.accountId);
				if (!storedToken) {
					throw new Error("Missing auth token in response and storage");
				}
				token = storedToken;
			}

			const enforcer = getTravelModeEnforcer(storage);
			const client = await createStoredAccountRpcClient(
				storage,
				activeAccount.accountId,
			).catch(() => null);
			try {
				await enforcer.verifyForUnlock(activeAccount.accountId, client);
			} catch (error) {
				await storage.clearSession(activeAccount.accountId);
				throw error;
			}

			if (responseData.vault_keys) {
				vaultKeys = enforcer.filterVaultKeys(
					activeAccount.accountId,
					JSON.parse(responseData.vault_keys),
				);
				await storage.storeVaultKeys(vaultKeys, activeAccount.accountId);
			} else {
				const storedVaultKeys = await storage.getVaultKeys(
					activeAccount.accountId,
				);
				if (!storedVaultKeys || storedVaultKeys.length === 0) {
					throw new Error("Missing vault keys in response and storage");
				}
				vaultKeys = storedVaultKeys;
			}

			setMasterUnlockKey(muk);
			await storage.setMasterUnlockKey(muk, activeAccount.accountId);

			// Update activity tracking
			await updateActivity();

			return {
				success: true,
				message: "Biometric unlock successful",
			};
		}
		if (responseData?.type === "BIOMETRIC_UNLOCK_FAILED") {
			console.error(
				"[NATIVE_BIOMETRIC_UNLOCK] Failed response:",
				responseData.error,
			);

			// Parse error and provide helpful message
			const errorStr = responseData.error || "Biometric unlock failed";
			let userMessage = errorStr;

			if (errorStr.includes("No session data found")) {
				userMessage =
					"Biometric unlock not set up for this account in the desktop app. Please open the Bittery desktop app, log in with this account, and enable biometric unlock in your account settings.";
			}

			throw new Error(userMessage);
		}
		console.error(
			"[NATIVE_BIOMETRIC_UNLOCK] Unexpected response type:",
			responseData?.type,
		);
		throw new Error("Unexpected response from native host");
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
export async function handleOpenDesktopApp(): Promise<MessageResponse> {
	try {
		const response = await sendNativeMessage({
			type: "OPEN_DESKTOP_APP",
		});

		const responseData = response as any;
		if (responseData?.type === "OPEN_DESKTOP_APP_RESULT") {
			return {
				success: Boolean(responseData.success),
				error: responseData.error,
			};
		}
		if (responseData?.type === "ERROR") {
			return {
				success: false,
				error: responseData.message || "Failed to open desktop app",
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

		// If desktop is available but locked, trigger unlock UI but DON'T return success
		// The extension should wait for the unlock to complete via SSE events
		if (desktopAvailable && desktopLocked) {
			try {
				const triggered = await desktopClient.triggerDesktopUnlock();
				if (!triggered) {
					throw new Error("Desktop unlock trigger failed");
				}

				// Don't return success - throw an error to let the UI know unlock is pending
				throw new Error(
					"Desktop app is locked. Please unlock in the desktop app.",
				);
			} catch (error) {
				console.warn(
					"[NATIVE_BIOMETRIC_UNLOCK_ALL] Desktop unlock trigger failed, falling back to native messaging:",
					error,
				);
				// If we successfully triggered the desktop UI, re-throw the error
				if (
					error instanceof Error &&
					error.message.includes("Desktop app is locked")
				) {
					throw error;
				}
				// Otherwise fall through to native messaging fallback
			}
		}

		// Fallback: Use native messaging (for standalone mode or if HTTP failed)
		// Generate challenge for replay attack protection
		const challenge = crypto.randomUUID();
		const extensionId = chrome.runtime.id;

		// Call the native messaging endpoint
		// This will unlock the extension locally in standalone mode
		const response = await sendNativeMessage({
			type: "BIOMETRIC_UNLOCK_ALL_REQUEST",
			challenge,
			extension_id: extensionId,
		});

		const responseData = response as any;
		if (responseData?.type === "BIOMETRIC_UNLOCK_ALL_FAILED") {
			console.error(
				"[NATIVE_BIOMETRIC_UNLOCK_ALL] Unlock failed:",
				responseData.error,
			);
			throw new Error(responseData.error || "Biometric unlock failed");
		}

		if (responseData?.type !== "BIOMETRIC_UNLOCK_ALL_SUCCESS") {
			console.error(
				"[NATIVE_BIOMETRIC_UNLOCK_ALL] Unexpected response type:",
				responseData?.type,
			);
			console.error(
				"[NATIVE_BIOMETRIC_UNLOCK_ALL] Full response:",
				JSON.stringify(responseData, null, 2),
			);
			throw new Error(
				`Invalid response type from desktop app: ${responseData?.type || "undefined"}`,
			);
		}

		// Verify the response contains the expected data
		if (
			!responseData.device_key ||
			!responseData.signature ||
			!responseData.accounts
		) {
			console.error(
				"[NATIVE_BIOMETRIC_UNLOCK_ALL] Missing required fields in response",
			);
			console.error(
				"[NATIVE_BIOMETRIC_UNLOCK_ALL] Has device_key:",
				!!responseData.device_key,
			);
			console.error(
				"[NATIVE_BIOMETRIC_UNLOCK_ALL] Has signature:",
				!!responseData.signature,
			);
			console.error(
				"[NATIVE_BIOMETRIC_UNLOCK_ALL] Has accounts:",
				!!responseData.accounts,
			);
			throw new Error("Invalid response structure from desktop app");
		}

		// Verify signature (challenge + number of accounts)
		const expectedSigData = `${challenge}:${responseData.accounts?.length || 0}`;
		const expectedSig = btoa(expectedSigData);
		if (responseData.signature !== expectedSig) {
			console.warn(
				"[NATIVE_BIOMETRIC_UNLOCK_ALL] Signature mismatch (replay attack protection)",
			);
			// Don't fail on signature mismatch for now during development
		}

		// Decode device key from base64 (shared for all accounts)
		const deviceKeyBase64 = responseData.device_key;
		const deviceKeyStr = atob(deviceKeyBase64);
		const deviceKey = new Uint8Array(deviceKeyStr.length);
		for (let i = 0; i < deviceKeyStr.length; i++) {
			deviceKey[i] = deviceKeyStr.charCodeAt(i);
		}

		const unlocked: string[] = [];
		const failed: Array<{ accountId: string; email: string; error: string }> = [];

		// Process each account from response
		for (const accountData of responseData.accounts || []) {
			const email = accountData.email;
			const accountId = accountData.accountId;

			try {
				// Decode the encrypted session data
				const encryptedSessionJson = atob(accountData.encrypted_session);
				const encryptedMuk = JSON.parse(encryptedSessionJson);

				// Decrypt the MUK using the device key
				const mukBase64 = await decrypt(encryptedMuk, deviceKey);

				// Convert MUK from base64 to Uint8Array
				const mukStr = atob(mukBase64);
				const muk = new Uint8Array(mukStr.length);
				for (let i = 0; i < mukStr.length; i++) {
					muk[i] = mukStr.charCodeAt(i);
				}

				if (!accountId) throw new Error(`Missing account ID for ${email}`);

				// Store auth token if provided
				if (accountData.auth_token) {
					await storage.storeAuthToken(accountData.auth_token, accountId);
				}

				const enforcer = getTravelModeEnforcer(storage);
				const client = await createStoredAccountRpcClient(
					storage,
					accountId,
				).catch(() => null);
				await enforcer.verifyForUnlock(accountId, client);

				// Store only policy-visible vault keys after verification.
				if (accountData.vault_keys) {
					const vaultKeys = enforcer.filterVaultKeys(
						accountId,
						JSON.parse(accountData.vault_keys),
					);
					await storage.storeVaultKeys(vaultKeys, accountId);
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

		// Get first unlocked email (guaranteed to exist because we checked length above)
		const firstUnlockedAccountId = unlocked[0];
		if (!firstUnlockedAccountId) {
			throw new Error("No unlocked account found");
		}

		if (!options?.preserveActiveAccount) {
			if (accounts.length > 1) {
				await storage.setActiveAccount({ type: "all" });
			} else {
				await storage.setActiveAccount({
					type: "single",
					accountId: firstUnlockedAccountId,
				});
			}
		}

		// IMPORTANT: Update activity FIRST to set timestamp, otherwise isUnlocked()
		// will see lastActivityTimestamp=0 and immediately lock everything!
		await updateActivity();

		// Set MUK for first unlocked account in session manager
		const activeMuk = await storage.getMasterUnlockKey(firstUnlockedAccountId);
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
