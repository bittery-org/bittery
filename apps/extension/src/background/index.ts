/**
 * Background Service Worker - Main Entry Point
 * Routes messages to appropriate handlers and manages lifecycle
 */

import {
	handleCanQuickUnlock,
	handleCheckAuth,
	handleGetAuthToken,
	handleGetSessionData,
	handleLock,
	handleLogin,
	handleLogout,
	handleQuickUnlock,
} from "./auth-handlers";
import {
	handleCheckAutofillAuth,
	handleGetAutofillItems,
	handleUpdateAutofillTimestamp,
} from "./autofill-handlers";
import {
	handleCheckExistingCredentials,
	handleSaveNewCredential,
	handleUpdateExistingCredential,
} from "./credential-handlers";
import {
	handleCheckNativeBiometric,
	handleNativeBiometricUnlock,
	handleOpenDesktopApp,
} from "./native-messaging";
import {
	handleCaptureTabScreenshot,
	handleUpdateItemTotp,
} from "./qr-scan-handlers";
import {
	handleAutoLockAlarm,
	refreshAutoLockTimeout,
} from "./session-manager";
import {
	cleanupSync,
	connect as connectSync,
	disconnect as disconnectSync,
	getClientId as getSyncClientId,
	getStatus as getSyncStatus,
	handleSyncReconnectAlarm,
	initializeSync,
} from "./sync-manager";
import {
	handleGetVaultItem,
	handleGetVaultItems,
	handleGetWritableVaults,
} from "./vault-handlers";

console.log("Bittery background service worker loaded");

// Message handler
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	console.log("Background received message:", message.type);

	// Handle async operations
	(async () => {
		try {
			switch (message.type) {
				// Authentication
				case "LOGIN": {
					const result = await handleLogin(message.payload);
					// Initialize sync after successful login
					if (result.success) {
						initializeSync().catch(console.error);
					}
					sendResponse(result);
					break;
				}

				case "QUICK_UNLOCK": {
					const result = await handleQuickUnlock(message.payload);
					sendResponse(result);
					break;
				}

				case "CHECK_AUTH": {
					const result = await handleCheckAuth();
					sendResponse(result);
					break;
				}

				case "CAN_QUICK_UNLOCK": {
					const result = await handleCanQuickUnlock();
					sendResponse(result);
					break;
				}

				case "GET_AUTH_TOKEN": {
					const result = await handleGetAuthToken();
					sendResponse(result);
					break;
				}

				case "GET_SESSION_DATA": {
					const result = await handleGetSessionData();
					sendResponse(result);
					break;
				}

				case "LOGOUT": {
					// Cleanup sync before logout
					await cleanupSync();
					const result = await handleLogout();
					sendResponse(result);
					break;
				}

				case "LOCK": {
					// Disconnect sync when locking
					disconnectSync();
					const result = await handleLock();
					sendResponse(result);
					break;
				}

				// Sync operations
				case "SYNC_CONNECT": {
					await connectSync();
					sendResponse({ success: true });
					break;
				}

				case "SYNC_DISCONNECT": {
					disconnectSync();
					sendResponse({ success: true });
					break;
				}

				case "GET_SYNC_STATUS": {
					const status = getSyncStatus();
					sendResponse({ success: true, status });
					break;
				}

				case "GET_SYNC_CLIENT_ID": {
					const clientId = await getSyncClientId();
					sendResponse({ success: true, clientId });
					break;
				}

				// Vault operations
				case "GET_VAULT_ITEMS": {
					const result = await handleGetVaultItems();
					sendResponse(result);
					break;
				}

				case "GET_VAULT_ITEM": {
					const result = await handleGetVaultItem(message.payload);
					sendResponse(result);
					break;
				}

				case "GET_WRITABLE_VAULTS": {
					const result = await handleGetWritableVaults();
					sendResponse(result);
					break;
				}

				// Credential management
				case "CHECK_EXISTING_CREDENTIALS": {
					const result = await handleCheckExistingCredentials(message.payload);
					sendResponse(result);
					break;
				}

				case "SAVE_NEW_CREDENTIAL": {
					const result = await handleSaveNewCredential(message.payload);
					sendResponse(result);
					break;
				}

				case "UPDATE_EXISTING_CREDENTIAL": {
					const result = await handleUpdateExistingCredential(message.payload);
					sendResponse(result);
					break;
				}

				// Autofill
				case "CHECK_AUTOFILL_AUTH": {
					const result = await handleCheckAutofillAuth();
					sendResponse(result);
					break;
				}

				case "UPDATE_AUTOFILL_TIMESTAMP": {
					const result = await handleUpdateAutofillTimestamp();
					sendResponse(result);
					break;
				}

				case "GET_AUTOFILL_ITEMS": {
					const result = await handleGetAutofillItems(message.payload);
					sendResponse(result);
					break;
				}

				// Native messaging (biometric unlock)
				case "CHECK_NATIVE_BIOMETRIC": {
					const result = await handleCheckNativeBiometric();
					sendResponse(result);
					break;
				}

				case "NATIVE_BIOMETRIC_UNLOCK": {
					const result = await handleNativeBiometricUnlock();
					sendResponse(result);
					break;
				}

				case "OPEN_DESKTOP_APP": {
					const result = await handleOpenDesktopApp();
					sendResponse(result);
					break;
				}

				// QR Code scanning
				case "CAPTURE_TAB_SCREENSHOT": {
					const result = await handleCaptureTabScreenshot();
					sendResponse(result);
					break;
				}

				case "UPDATE_ITEM_TOTP": {
					const result = await handleUpdateItemTotp(message.payload);
					sendResponse(result);
					break;
				}

				// Settings
				case "SETTINGS_CHANGED": {
					// Refresh cached auto-lock timeout when settings change
					await refreshAutoLockTimeout();
					sendResponse({ success: true });
					break;
				}

				default:
					sendResponse({ success: false, error: "Unknown message type" });
			}
		} catch (error) {
			console.error("Background error:", error);
			sendResponse({ success: false, error: String(error) });
		}
	})();

	return true; // Keep channel open for async response
});

// Handle Chrome Alarms for auto-lock and sync reconnection
chrome.alarms.onAlarm.addListener((alarm) => {
	handleAutoLockAlarm(alarm);
	handleSyncReconnectAlarm(alarm);
});

// Keep service worker alive
chrome.runtime.onStartup.addListener(() => {
	console.log("Extension started");
});

chrome.runtime.onInstalled.addListener(() => {
	console.log("Extension installed");
});
