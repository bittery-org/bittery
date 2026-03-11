/**
 * Background Message Router
 *
 * Keeps runtime message handling isolated from service-worker bootstrap wiring.
 * Runtime message types are preserved for popup/content compatibility.
 */

import type {
	PasskeyCreateHandlerPayload,
	PasskeyGetHandlerPayload,
} from "../passkey/types";
import {
	handleCanQuickUnlock,
	handleCheckAuth,
	handleGetAuthToken,
	handleGetSessionData,
	handleLock,
	handleLogin,
	handleLogout,
	handleQuickUnlock,
	handleQuickUnlockAll,
} from "./auth-handlers";
import {
	handleCheckAutofillAuth,
	handleGetAutofillCreditCards,
	handleGetAutofillIdentities,
	handleGetAutofillItems,
	handleUpdateAutofillTimestamp,
} from "./autofill-handlers";
import {
	handleCheckExistingCredentials,
	handleSaveNewCredential,
	handleUpdateExistingCredential,
} from "./credential-handlers";
import { desktopSync } from "./desktop-sync";
import {
	handleCheckNativeBiometric,
	handleNativeBiometricUnlock,
	handleNativeBiometricUnlockAll,
	handleOpenDesktopApp,
} from "./native-messaging";
import {
	handlePasskeyCancel,
	handlePasskeyCreate,
	handlePasskeyGet,
} from "./passkey-handlers";
import {
	handleCaptureTabScreenshot,
	handleUpdateItemTotp,
} from "./qr-scan-handlers";
import {
	handleClearPendingSavePrompt,
	handleGetPendingSavePrompt,
	handleSetPendingSavePrompt,
} from "./save-prompt-handlers";
import { refreshAutoLockTimeout } from "./session-manager";
import {
	cleanupSync,
	connect as connectSync,
	disconnect as disconnectSync,
	getClientId as getSyncClientId,
	getStatus as getSyncStatus,
	initializeSync,
} from "./sync-manager";
import {
	handleGetVaultItem,
	handleGetVaultItems,
	handleGetWritableVaults,
} from "./vault-handlers";

type RuntimeMessage = {
	type: string;
	payload?: unknown;
};

type PasskeyRouteOverrides = Partial<{
	handlePasskeyCreate: typeof handlePasskeyCreate;
	handlePasskeyGet: typeof handlePasskeyGet;
	handlePasskeyCancel: typeof handlePasskeyCancel;
}>;

function getPayload<TPayload>(message: RuntimeMessage): TPayload {
	return message.payload as TPayload;
}

function ensureSyncInitialized(_reason: string): void {
	const status = getSyncStatus();
	if (status === "connected" || status === "connecting") {
		return;
	}

	initializeSync().catch((error) => {
		console.error("[Background router] Failed to initialize sync:", error);
	});
}

export async function routeRuntimeMessage(
	message: RuntimeMessage,
	overrides?: PasskeyRouteOverrides,
): Promise<unknown> {
	const passkeyHandlers = {
		handlePasskeyCreate,
		handlePasskeyGet,
		handlePasskeyCancel,
		...overrides,
	};

	switch (message.type) {
		// Authentication
		case "LOGIN": {
			const result = await handleLogin(
				getPayload<{ email: string; password: string; secretKey: string }>(
					message,
				),
			);
			if (result.success) {
				ensureSyncInitialized("LOGIN");
			}
			return result;
		}

		case "QUICK_UNLOCK": {
			const result = await handleQuickUnlock(
				getPayload<{ password: string }>(message),
			);
			if (result.success) {
				ensureSyncInitialized("QUICK_UNLOCK");
			}
			return result;
		}

		case "QUICK_UNLOCK_ALL": {
			const result = await handleQuickUnlockAll(
				getPayload<{ password: string }>(message),
			);
			if (result.success) {
				ensureSyncInitialized("QUICK_UNLOCK_ALL");
			}
			return result;
		}

		case "CHECK_AUTH": {
			const result = await handleCheckAuth();
			if (result.success && result.authenticated) {
				ensureSyncInitialized("CHECK_AUTH");
			}
			return result;
		}

		case "CAN_QUICK_UNLOCK": {
			return handleCanQuickUnlock();
		}

		case "GET_AUTH_TOKEN": {
			return handleGetAuthToken();
		}

		case "GET_SESSION_DATA": {
			return handleGetSessionData();
		}

		case "LOGOUT": {
			await cleanupSync();
			return handleLogout();
		}

		case "LOCK": {
			disconnectSync("manual lock");
			return handleLock();
		}

		// Sync operations
		case "SYNC_CONNECT": {
			await connectSync();
			return { success: true };
		}

		case "SYNC_DISCONNECT": {
			disconnectSync("SYNC_DISCONNECT");
			return { success: true };
		}

		case "GET_SYNC_STATUS": {
			const status = getSyncStatus();
			return { success: true, status };
		}

		case "GET_SYNC_CLIENT_ID": {
			const clientId = await getSyncClientId();
			return { success: true, clientId };
		}

		// Vault operations
		case "GET_VAULT_ITEMS": {
			return handleGetVaultItems();
		}

		case "GET_VAULT_ITEM": {
			return handleGetVaultItem(getPayload<{ itemId: string }>(message));
		}

		case "GET_WRITABLE_VAULTS": {
			return handleGetWritableVaults();
		}

		// Credential management
		case "CHECK_EXISTING_CREDENTIALS": {
			return handleCheckExistingCredentials(
				getPayload<{ url: string; username?: string; password?: string }>(
					message,
				),
			);
		}

		case "SAVE_NEW_CREDENTIAL": {
			return handleSaveNewCredential(
				getPayload<{
					vaultId: string;
					username: string;
					password: string;
					url: string;
				}>(message),
			);
		}

		case "UPDATE_EXISTING_CREDENTIAL": {
			return handleUpdateExistingCredential(
				getPayload<{
					itemId: string;
					vaultId: string;
					username: string;
					password: string;
					url: string;
				}>(message),
			);
		}

		case "SET_PENDING_SAVE_PROMPT": {
			return handleSetPendingSavePrompt(
				getPayload<{
					username: string;
					password: string;
					url: string;
					hostname: string;
				}>(message),
			);
		}

		case "GET_PENDING_SAVE_PROMPT": {
			return handleGetPendingSavePrompt();
		}

		case "CLEAR_PENDING_SAVE_PROMPT": {
			return handleClearPendingSavePrompt();
		}

		// Autofill
		case "CHECK_AUTOFILL_AUTH": {
			return handleCheckAutofillAuth();
		}

		case "UPDATE_AUTOFILL_TIMESTAMP": {
			return handleUpdateAutofillTimestamp();
		}

		case "GET_AUTOFILL_ITEMS": {
			return handleGetAutofillItems(getPayload<{ hostname: string }>(message));
		}

		case "GET_AUTOFILL_CREDIT_CARDS": {
			return handleGetAutofillCreditCards();
		}

		case "GET_AUTOFILL_IDENTITIES": {
			return handleGetAutofillIdentities();
		}

		// Passkeys
		case "PASSKEY_CREATE": {
			return passkeyHandlers.handlePasskeyCreate(
				getPayload<PasskeyCreateHandlerPayload>(message),
			);
		}

		case "PASSKEY_GET": {
			return passkeyHandlers.handlePasskeyGet(
				getPayload<PasskeyGetHandlerPayload>(message),
			);
		}

		case "PASSKEY_CANCEL": {
			return passkeyHandlers.handlePasskeyCancel(
				getPayload<{ requestId?: string }>(message),
			);
		}

		// Native messaging (biometric unlock)
		case "CHECK_NATIVE_BIOMETRIC": {
			return handleCheckNativeBiometric();
		}

		case "NATIVE_BIOMETRIC_UNLOCK": {
			const result = await handleNativeBiometricUnlock();
			if (result.success) {
				ensureSyncInitialized("NATIVE_BIOMETRIC_UNLOCK");
			}
			return result;
		}

		case "NATIVE_BIOMETRIC_UNLOCK_ALL": {
			const result = await handleNativeBiometricUnlockAll();
			if (result.success) {
				ensureSyncInitialized("NATIVE_BIOMETRIC_UNLOCK_ALL");
			}
			return result;
		}

		case "OPEN_DESKTOP_APP": {
			return handleOpenDesktopApp();
		}

		// QR code scanning
		case "CAPTURE_TAB_SCREENSHOT": {
			return handleCaptureTabScreenshot();
		}

		case "UPDATE_ITEM_TOTP": {
			return handleUpdateItemTotp(
				getPayload<{
					itemId: string;
					totp: {
						totpSecret: string;
						totpIssuer?: string;
						totpAccountName?: string;
						totpAlgorithm?: "SHA1" | "SHA256" | "SHA512";
						totpDigits?: 6 | 7 | 8;
						totpPeriod?: number;
					};
				}>(message),
			);
		}

		// Settings
		case "SETTINGS_CHANGED": {
			await refreshAutoLockTimeout();
			return { success: true };
		}

		// Desktop sync
		case "CHECK_DESKTOP_STATUS": {
			const status =
				desktopSync.getLastStatus() ?? (await desktopSync.checkDesktopStatus());
			return {
				success: true,
				available: desktopSync.isDesktopAvailable(),
				...status,
			};
		}

		default: {
			console.warn("[Background router] Unknown message type:", message);
			return {
				success: false,
				error: "Unknown message type",
			};
		}
	}
}

export function registerBackgroundMessageRouter(): void {
	chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
		const runtimeMessage = message as RuntimeMessage;
		void (async () => {
			try {
				const response = await routeRuntimeMessage(runtimeMessage);
				sendResponse(response);
			} catch (error) {
				console.error("[Background router] Handler error:", error);
				sendResponse({
					success: false,
					error: String(error),
				});
			}
		})();

		return true; // Keep channel open for async response.
	});
}
