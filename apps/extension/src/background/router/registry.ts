/**
 * Background Message Router Registry
 *
 * Declarative `message.type -> RouteDefinition` table. Runtime message types
 * are preserved for popup/content-script compatibility; see `index.ts` for the
 * dispatcher that looks routes up here.
 *
 * Payload and response types are contextual: `RouteRegistry` is a total map
 * over `RouteContract`, so each `handle` gets its payload typed from the
 * contract and has its return value checked against it. Handlers therefore
 * carry no payload annotations of their own — the contract is the only place
 * a route's shape is written down.
 */

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
	activateAndDrainOutboundCommand,
	cancelStagedOutboundCommand,
	claimStagedOutboundCommands,
	drainOutboundQueue,
	getOutboundCommandSummary,
	stageOutboundCommand,
} from "../outbound-drain";
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
import {
	handleGetVaultItem,
	handleGetVaultItems,
	handleGetWritableVaults,
} from "../vault-handlers";
import type { PasswordUnlockAllResponse, UnlockResponse } from "./contract";
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
const didUnlock = (response: UnlockResponse | PasswordUnlockAllResponse) =>
	Boolean(response.success && response.status !== PENDING_DESKTOP_UNLOCK);

export const routeRegistry: RouteRegistry = {
	// Authentication
	LOGIN: {
		handle: (payload) => handleLogin(payload),
		syncInitOnSuccess: true,
	},

	QUICK_UNLOCK: {
		handle: (payload) => handleQuickUnlock(payload),
		syncInitOnSuccess: didUnlock,
	},

	QUICK_UNLOCK_ALL: {
		handle: (payload) => handleQuickUnlockAll(payload),
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

	GET_SYNC_COMMAND_SUMMARY: {
		handle: async () => ({
			success: true,
			summary: await getOutboundCommandSummary(),
		}),
	},

	CLAIM_STAGED_ITEM_COMMANDS: {
		handle: async (payload) => {
			const claim = await claimStagedOutboundCommands(payload.claimId);
			return { success: true, ...claim };
		},
	},

	ENQUEUE_ITEM_COMMAND: {
		handle: async (payload) => {
			try {
				if (!(await stageOutboundCommand(payload.command, payload.claimId))) {
					return {
						success: false,
						code: "ALREADY_EXISTS",
						error: "Item command already exists",
					};
				}
				return { success: true };
			} catch (error) {
				return { success: false, error: String(error) };
			}
		},
	},

	CANCEL_STAGED_ITEM_COMMAND: {
		handle: async (payload) => {
			try {
				if (
					!(await cancelStagedOutboundCommand(
						payload.accountId,
						payload.operationId,
						payload.claimId,
					))
				) {
					return {
						success: false,
						code: "CLAIM_LOST",
						error: "Staged Item command claim was lost",
					};
				}
				return { success: true };
			} catch (error) {
				return { success: false, error: String(error) };
			}
		},
	},

	/**
	 * Sent by the popup after it queues a mutation. The push runs here because
	 * only the worker can authenticate as the account that produced it.
	 */
	DRAIN_OUTBOUND_QUEUE: {
		handle: async (payload) => {
			try {
				if (payload?.accountId && payload.operationId && payload.claimId) {
					if (
						!(await activateAndDrainOutboundCommand(
							payload.accountId,
							payload.operationId,
							payload.claimId,
						))
					) {
						return {
							success: false,
							code: "CLAIM_LOST",
							error: "Staged Item command claim was lost",
						};
					}
				} else {
					await drainOutboundQueue();
				}
				return { success: true };
			} catch (error) {
				console.error("[Background router] Outbound drain failed:", error);
				return { success: false, error: String(error) };
			}
		},
	},

	// Vault operations
	GET_VAULT_ITEMS: {
		handle: () => handleGetVaultItems(),
	},

	GET_VAULT_ITEM: {
		handle: (payload) => handleGetVaultItem(payload),
	},

	GET_WRITABLE_VAULTS: {
		handle: () => handleGetWritableVaults(),
	},

	// Credential management
	CHECK_EXISTING_CREDENTIALS: {
		handle: (payload) => handleCheckExistingCredentials(payload),
	},

	SAVE_NEW_CREDENTIAL: {
		handle: (payload) => handleSaveNewCredential(payload),
	},

	UPDATE_EXISTING_CREDENTIAL: {
		handle: (payload) => handleUpdateExistingCredential(payload),
	},

	SET_PENDING_SAVE_PROMPT: {
		handle: (payload) => handleSetPendingSavePrompt(payload),
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
		handle: (payload) => handleGetAutofillItems(payload),
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
		handle: (payload, ctx) => ctx.passkeyHandlers.handlePasskeyCreate(payload),
	},

	PASSKEY_GET: {
		handle: (payload, ctx) => ctx.passkeyHandlers.handlePasskeyGet(payload),
	},

	PASSKEY_CANCEL: {
		handle: (payload, ctx) => ctx.passkeyHandlers.handlePasskeyCancel(payload),
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
		handle: (payload) => handleOpenDesktopApp(payload),
	},

	// QR code scanning
	CAPTURE_TAB_SCREENSHOT: {
		handle: () => handleCaptureTabScreenshot(),
	},

	UPDATE_ITEM_TOTP: {
		handle: (payload) => handleUpdateItemTotp(payload),
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
