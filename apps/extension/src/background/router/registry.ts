/**
 * Background Message Router Registry
 *
 * Declarative `message.type -> RouteDefinition` table. Runtime message types
 * are preserved for popup/content-script compatibility; see `index.ts` for
 * the dispatcher that looks routes up here.
 */

import type {
	PasskeyCreateHandlerPayload,
	PasskeyGetHandlerPayload,
} from "../../passkey/types";
import {
	handleCanQuickUnlock,
	handleCheckAuth,
	handleGetAuthToken,
	handleGetSessionData,
	handleGetSessionStatus,
	handleLock,
	handleLogin,
	handleLogout,
	handleQuickUnlock,
	handleQuickUnlockAll,
} from "../auth-handlers";
import {
	handleCheckAutofillAuth,
	handleGetAutofillCreditCards,
	handleGetAutofillIdentities,
	handleGetAutofillItems,
	handleUpdateAutofillTimestamp,
} from "../autofill-handlers";
import {
	handleCheckExistingCredentials,
	handleSaveNewCredential,
	handleUpdateExistingCredential,
} from "../credential-handlers";
import { desktopClient } from "../desktop-client";
import { PENDING_DESKTOP_UNLOCK } from "../desktop-protocol";
import { getDesktopStatus } from "../desktop-status";
import { desktopSync } from "../desktop-sync";
import {
	handleCheckNativeBiometric,
	handleNativeBiometricUnlock,
	handleNativeBiometricUnlockAll,
	handleOpenDesktopApp,
} from "../native-messaging";
import {
	handleCaptureTabScreenshot,
	handleUpdateItemTotp,
} from "../qr-scan-handlers";
import {
	handleClearPendingSavePrompt,
	handleGetPendingSavePrompt,
	handleSetPendingSavePrompt,
} from "../save-prompt-handlers";
import { refreshAutoLockTimeout } from "../session-manager";
import type { MessageResponse } from "../types";
import {
	handleGetVaultItem,
	handleGetVaultItems,
	handleGetWritableVaults,
} from "../vault-handlers";
import {
	cleanupSync,
	connectSync,
	disconnectSync,
	getSyncClientId,
	getSyncStatus,
} from "./sync-effects";
import type { RouteRegistry } from "./types";

/**
 * An unlock route can succeed without unlocking anything: when a locked desktop
 * app takes over the unlock, the vault is still closed and there is nothing to
 * sync yet. Sync starts on the pushed `unlock` event instead.
 */
const didUnlock = (response: MessageResponse) =>
	Boolean(response.success && response.status !== PENDING_DESKTOP_UNLOCK);

export const routeRegistry: RouteRegistry = {
	// Authentication
	LOGIN: {
		handle: (payload: {
			email: string;
			password: string;
			secretKey: string;
			serverUrl?: string;
			insecureTransportConfirmed?: boolean;
		}) => handleLogin(payload),
		syncInitOnSuccess: true,
	},

	QUICK_UNLOCK: {
		handle: (payload: { password: string }) => handleQuickUnlock(payload),
		syncInitOnSuccess: didUnlock,
	},

	QUICK_UNLOCK_ALL: {
		handle: (payload: { password: string }) => handleQuickUnlockAll(payload),
		syncInitOnSuccess: didUnlock,
	},

	CHECK_AUTH: {
		handle: () => handleCheckAuth(),
		syncInitOnSuccess: (response) =>
			Boolean(response.success && response.authenticated),
	},

	CAN_QUICK_UNLOCK: {
		handle: () => handleCanQuickUnlock(),
	},

	GET_AUTH_TOKEN: {
		handle: () => handleGetAuthToken(),
	},

	GET_SESSION_DATA: {
		handle: () => handleGetSessionData(),
	},

	GET_SESSION_STATUS: {
		handle: () => handleGetSessionStatus(),
	},

	LOGOUT: {
		before: () => cleanupSync(),
		handle: () => handleLogout(),
	},

	/**
	 * No `before` teardown: a refused lock must leave the SSE stream up. Sync is
	 * torn down by the reducer's `disconnect_sync` effect, which only fires when
	 * the vault actually transitions to locked.
	 */
	LOCK: {
		handle: () => handleLock(),
	},

	// Sync operations
	SYNC_CONNECT: {
		before: () => connectSync(),
		handle: () => ({ success: true }),
	},

	SYNC_DISCONNECT: {
		before: () => {
			disconnectSync("SYNC_DISCONNECT");
		},
		handle: () => ({ success: true }),
	},

	GET_SYNC_STATUS: {
		handle: () => ({ success: true, status: getSyncStatus() }),
	},

	GET_SYNC_CLIENT_ID: {
		handle: async () => ({ success: true, clientId: await getSyncClientId() }),
	},

	// Vault operations
	GET_VAULT_ITEMS: {
		handle: () => handleGetVaultItems(),
	},

	GET_VAULT_ITEM: {
		handle: (payload: { itemId: string }) => handleGetVaultItem(payload),
	},

	GET_WRITABLE_VAULTS: {
		handle: () => handleGetWritableVaults(),
	},

	// Credential management
	CHECK_EXISTING_CREDENTIALS: {
		handle: (payload: { url: string; username?: string; password?: string }) =>
			handleCheckExistingCredentials(payload),
	},

	SAVE_NEW_CREDENTIAL: {
		handle: (payload: {
			vaultId: string;
			username: string;
			password: string;
			url: string;
		}) => handleSaveNewCredential(payload),
	},

	UPDATE_EXISTING_CREDENTIAL: {
		handle: (payload: {
			itemId: string;
			vaultId: string;
			username: string;
			password: string;
			url: string;
		}) => handleUpdateExistingCredential(payload),
	},

	SET_PENDING_SAVE_PROMPT: {
		handle: (payload: {
			username: string;
			password: string;
			url: string;
			hostname: string;
		}) => handleSetPendingSavePrompt(payload),
	},

	GET_PENDING_SAVE_PROMPT: {
		handle: () => handleGetPendingSavePrompt(),
	},

	CLEAR_PENDING_SAVE_PROMPT: {
		handle: () => handleClearPendingSavePrompt(),
	},

	// Autofill
	CHECK_AUTOFILL_AUTH: {
		handle: () => handleCheckAutofillAuth(),
	},

	UPDATE_AUTOFILL_TIMESTAMP: {
		handle: () => handleUpdateAutofillTimestamp(),
	},

	GET_AUTOFILL_ITEMS: {
		handle: (payload: { hostname: string }) => handleGetAutofillItems(payload),
	},

	GET_AUTOFILL_CREDIT_CARDS: {
		handle: () => handleGetAutofillCreditCards(),
	},

	GET_AUTOFILL_IDENTITIES: {
		handle: () => handleGetAutofillIdentities(),
	},

	// Passkeys (dispatched through ctx.passkeyHandlers so tests can override
	// individual handlers without mocking the whole passkey-handlers module).
	PASSKEY_CREATE: {
		handle: (payload: PasskeyCreateHandlerPayload, ctx) =>
			ctx.passkeyHandlers.handlePasskeyCreate(payload),
	},

	PASSKEY_GET: {
		handle: (payload: PasskeyGetHandlerPayload, ctx) =>
			ctx.passkeyHandlers.handlePasskeyGet(payload),
	},

	PASSKEY_CANCEL: {
		handle: (payload: { requestId?: string }, ctx) =>
			ctx.passkeyHandlers.handlePasskeyCancel(payload),
	},

	// Native messaging (biometric unlock)
	CHECK_NATIVE_BIOMETRIC: {
		handle: () => handleCheckNativeBiometric(),
	},

	NATIVE_BIOMETRIC_UNLOCK: {
		handle: () => handleNativeBiometricUnlock(),
		syncInitOnSuccess: true,
	},

	NATIVE_BIOMETRIC_UNLOCK_ALL: {
		handle: () => handleNativeBiometricUnlockAll(),
		syncInitOnSuccess: didUnlock,
	},

	OPEN_DESKTOP_APP: {
		handle: (payload?: {
			intent?: "create_item" | "view_item";
			url?: string;
			itemId?: string;
			vaultId?: string;
		}) => handleOpenDesktopApp(payload),
	},

	// QR code scanning
	CAPTURE_TAB_SCREENSHOT: {
		handle: () => handleCaptureTabScreenshot(),
	},

	UPDATE_ITEM_TOTP: {
		handle: (payload: {
			itemId: string;
			totp: {
				totpSecret: string;
				totpIssuer?: string;
				totpAccountName?: string;
				totpAlgorithm?: "SHA1" | "SHA256" | "SHA512";
				totpDigits?: 6 | 7 | 8;
				totpPeriod?: number;
			};
		}) => handleUpdateItemTotp(payload),
	},

	/**
	 * Opened from an overlay's locked / re-auth state. `chrome.action.openPopup`
	 * is only available on newer Chrome builds and can be rejected when the
	 * gesture isn't attributed to the extension, so a failure is reported rather
	 * than thrown — the toolbar icon is always there as a fallback.
	 */
	OPEN_POPUP: {
		handle: async () => {
			try {
				await chrome.action.openPopup();
				return { success: true };
			} catch {
				return { success: false };
			}
		},
	},

	// Settings
	SETTINGS_CHANGED: {
		before: () => refreshAutoLockTimeout(),
		handle: () => ({ success: true }),
	},

	// Desktop sync
	CHECK_DESKTOP_STATUS: {
		handle: async () => {
			const status = await getDesktopStatus();
			return {
				success: true,
				available: desktopSync.isDesktopAvailable(),
				...status,
			};
		},
	},

	/**
	 * Asks the desktop app to raise its own unlock screen. Sent from an overlay's
	 * desktop-locked state and from the popup, so the user resolves the lock where
	 * it actually lives instead of unlocking only the extension.
	 */
	TRIGGER_DESKTOP_UNLOCK: {
		handle: async () => {
			const triggered = await desktopClient.triggerDesktopUnlock();
			return { success: triggered };
		},
	},
};
