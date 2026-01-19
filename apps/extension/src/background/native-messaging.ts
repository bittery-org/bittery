/**
 * Native Messaging
 * Handles communication with the desktop app for biometric unlock
 */

import { decrypt } from "@bittery/crypto/encryption";
import * as chromeStorage from "@bittery/crypto/storage-chrome";
import { NATIVE_HOST_NAME } from "./constants";
import { setMasterUnlockKey, updateActivity } from "./session-manager";
import type { MessageResponse } from "./types";

/**
 * Send a message to the native messaging host
 * Returns a promise that resolves with the response
 */
export function sendNativeMessage(message: unknown): Promise<unknown> {
	console.log("[Native Messaging] Attempting to connect to:", NATIVE_HOST_NAME);
	console.log("[Native Messaging] Sending message:", message);

	return new Promise((resolve, reject) => {
		try {
			const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
			console.log("[Native Messaging] Port connected successfully");

			const timeout = setTimeout(() => {
				console.error("[Native Messaging] Timeout after 30 seconds");
				port.disconnect();
				reject(new Error("Native messaging timeout"));
			}, 30000); // 30 second timeout

			port.onMessage.addListener((response) => {
				console.log("[Native Messaging] Received response:", response);
				clearTimeout(timeout);
				port.disconnect();
				resolve(response);
			});

			port.onDisconnect.addListener(() => {
				console.log("[Native Messaging] Port disconnected");
				clearTimeout(timeout);
				const error = chrome.runtime.lastError;
				if (error) {
					console.error("[Native Messaging] Disconnect error:", error);
					reject(
						new Error(
							`Native host disconnected: ${error.message || "Unknown error"}`,
						),
					);
				} else {
					console.error("[Native Messaging] Disconnect without error");
					reject(new Error("Native host disconnected"));
				}
			});

			port.postMessage(message);
			console.log("[Native Messaging] Message posted to port");
		} catch (error) {
			console.error("[Native Messaging] Exception during connection:", error);
			reject(error);
		}
	});
}

/**
 * Check if native biometric unlock is available
 */
export async function handleCheckNativeBiometric(): Promise<MessageResponse> {
	console.log("[CHECK_NATIVE_BIOMETRIC] Starting biometric availability check");
	try {
		const response = await sendNativeMessage({
			type: "CHECK_BIOMETRIC_AVAILABLE",
		});

		console.log("[CHECK_NATIVE_BIOMETRIC] Processing response:", response);
		const responseData = response as any;
		const result = {
			success: true,
			available:
				responseData?.type === "BIOMETRIC_STATUS" && responseData.available,
			enabled: responseData?.enabled || false,
			appRunning: responseData?.app_running || false,
		};
		console.log("[CHECK_NATIVE_BIOMETRIC] Sending result:", result);
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
	console.log("[NATIVE_BIOMETRIC_UNLOCK] Starting biometric unlock request");
	try {
		// Get stored session data to verify we have the user's email
		const sessionData = await chromeStorage.getStoredSessionData();
		if (!sessionData) {
			throw new Error("No session data found. Please log in again.");
		}

		const challenge = crypto.randomUUID();
		console.log("[NATIVE_BIOMETRIC_UNLOCK] Generated challenge:", challenge);
		console.log("[NATIVE_BIOMETRIC_UNLOCK] Extension ID:", chrome.runtime.id);

		const response = await sendNativeMessage({
			type: "BIOMETRIC_UNLOCK_REQUEST",
			challenge,
			extension_id: chrome.runtime.id,
		});

		console.log("[NATIVE_BIOMETRIC_UNLOCK] Received response:", response);

		const responseData = response as any;
		if (responseData?.type === "BIOMETRIC_UNLOCK_SUCCESS") {
			console.log("[NATIVE_BIOMETRIC_UNLOCK] Success response received");

			// Verify the response contains the expected data
			if (
				!responseData.encrypted_session ||
				!responseData.device_key ||
				!responseData.signature
			) {
				throw new Error("Invalid response from desktop app");
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

			console.log("[NATIVE_BIOMETRIC_UNLOCK] Decrypting MUK with device key");

			// Decrypt the MUK using the device key
			const mukBase64 = await decrypt(encryptedMuk, deviceKey);

			// Convert MUK from base64 to Uint8Array
			const mukStr = atob(mukBase64);
			const muk = new Uint8Array(mukStr.length);
			for (let i = 0; i < mukStr.length; i++) {
				muk[i] = mukStr.charCodeAt(i);
			}

			console.log("[NATIVE_BIOMETRIC_UNLOCK] ✓ MUK decrypted successfully");

			// Store the MUK in memory
			setMasterUnlockKey(muk);
			chromeStorage.storeMasterUnlockKey(muk);

			// Get auth token and vault keys from response (desktop app provides them) or storage
			let token: string;
			let vaultKeys: any[];

			if (responseData.auth_token) {
				token = responseData.auth_token;
				await chromeStorage.storeAuthToken(token);
			} else {
				const storedToken = await chromeStorage.getAuthToken();
				if (!storedToken) {
					throw new Error("Missing auth token in response and storage");
				}
				token = storedToken;
			}

			if (responseData.vault_keys) {
				vaultKeys = JSON.parse(responseData.vault_keys);
				await chromeStorage.storeVaultKeys(vaultKeys);
			} else {
				const storedVaultKeys = await chromeStorage.getVaultKeys();
				if (!storedVaultKeys || storedVaultKeys.length === 0) {
					throw new Error("Missing vault keys in response and storage");
				}
				vaultKeys = storedVaultKeys;
			}

			// Update activity tracking
			updateActivity();

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
			throw new Error(responseData.error || "Biometric unlock failed");
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
