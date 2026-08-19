/**
 * Runtime Message Contract
 *
 * One entry per `message.type` the background router serves, pairing a route's
 * request payload with the response it answers. Everything else is derived from
 * this map — the sender helper (`lib/messaging`), the registry's handler
 * signatures, and the discriminated union the service worker narrows into — so
 * a route can never exist on only one side of the protocol.
 *
 * The `type` strings are wire protocol, not implementation detail: content
 * scripts, the popup and the desktop bridge ship on independent schedules, so
 * renaming a key here is a breaking change. Adding one is not.
 *
 * Types only — no runtime values. Content scripts import this, and an
 * `import type` graph costs them nothing at bundle time.
 */

import type { UnlockFailure } from "@bittery/core/services/unlock";
import type { DecryptedItemWithContext } from "@bittery/shared/types";
import type { ConnectionStatus, SyncCommandSummary } from "@bittery/sync";
import type { ItemSyncCommand } from "@bittery/types";
import type {
	PasskeyBackgroundResponse,
	PasskeyCreateHandlerPayload,
	PasskeyGetHandlerPayload,
	PasskeyWritableVaultOption,
} from "../../passkey/types";
import type { CredentialErrorType } from "../credential-error";
import type {
	DesktopStatus,
	PENDING_DESKTOP_UNLOCK,
} from "../desktop-protocol";
import type { RefusalCode, VaultSessionSnapshot } from "../vault-session/types";

/* -------------------------------------------------------------------------- */
/* Envelopes                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the dispatcher answers with when a handler throws or the `type` is not
 * a known route. Every route response admits it, because every route can hit
 * it — see `registerBackgroundMessageRouter`.
 */
export interface RouteFailure {
	success: false;
	error?: string;
}

/**
 * A route that only reports whether it worked. Deliberately flat rather than a
 * `success` union: there is no success-only data to narrow towards, and every
 * caller reads `error` on the failure path anyway.
 */
export interface Acknowledgement {
	success: boolean;
	error?: string;
}

/** The desktop app owns the unlock; nothing was unlocked here. */
type PendingDesktopUnlock = typeof PENDING_DESKTOP_UNLOCK;

/* -------------------------------------------------------------------------- */
/* Payloads that are genuinely extension-local                                */
/* -------------------------------------------------------------------------- */

export interface LoginPayload {
	email: string;
	password: string;
	secretKey: string;
	serverUrl?: string;
	insecureTransportConfirmed?: boolean;
}

export interface PasswordPayload {
	password: string;
}

/** Identifies one staged outbound command and the popup lease holding it. */
export interface OutboundCommandClaim {
	accountId: string;
	operationId: string;
	claimId: string;
}

export interface CredentialCapture {
	vaultId: string;
	username: string;
	password: string;
	url: string;
}

export interface PendingSavePrompt {
	username: string;
	password: string;
	url: string;
	hostname: string;
}

export interface TotpUpdate {
	totpSecret: string;
	totpIssuer?: string;
	totpAccountName?: string;
	totpAlgorithm?: "SHA1" | "SHA256" | "SHA512";
	totpDigits?: 6 | 7 | 8;
	totpPeriod?: number;
}

export interface OpenDesktopAppPayload {
	intent?: "create_item" | "view_item";
	url?: string;
	itemId?: string;
	vaultId?: string;
}

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

/** An unlock that a locked desktop app took over instead of performing here. */
export type DesktopHandoff = {
	status?: PendingDesktopUnlock;
	desktopReachable?: boolean;
};

export type UnlockResponse =
	| ({ success: true } & DesktopHandoff)
	| RouteFailure;

export type PasswordUnlockAllResponse =
	| ({
			success: true;
			result?: { unlocked: string[]; failed: UnlockFailure[] };
	  } & DesktopHandoff)
	| RouteFailure;

/** The biometric path reports its own failure shape, not `UnlockFailure`. */
export interface BiometricUnlockFailure {
	accountId: string;
	email: string;
	error: string;
}

export type BiometricUnlockAllResponse =
	| ({
			success: true;
			message?: string;
			result?: {
				unlocked: string[];
				failed: BiometricUnlockFailure[];
				mode?: "desktop";
			};
	  } & DesktopHandoff)
	| RouteFailure;

export type CheckAuthResponse =
	| { success: true; authenticated: boolean; unlocked: boolean }
	| RouteFailure;

export type CanQuickUnlockResponse =
	| { success: true; canQuickUnlock: boolean }
	| RouteFailure;

export type AuthTokenResponse =
	| {
			success: true;
			accountId: string | null;
			token: string | null;
			serverUrl: string | null;
	  }
	| RouteFailure;

export interface SessionDataSnapshot {
	email: string;
	userId: string;
	isValid: boolean;
}

export type SessionDataResponse =
	| { success: true; sessionData: SessionDataSnapshot | null }
	| RouteFailure;

export type SessionStatusResponse =
	| ({ success: true } & VaultSessionSnapshot)
	| RouteFailure;

/** A refused lock travels as a machine-readable `code`, never as prose. */
export type LockResponse =
	| { success: true }
	| { success: false; code?: RefusalCode; error?: string };

export type SyncStatusResponse =
	| { success: true; status: ConnectionStatus }
	| RouteFailure;

export type SyncClientIdResponse =
	| { success: true; clientId: string }
	| RouteFailure;

export type SyncCommandSummaryResponse =
	| { success: true; summary: SyncCommandSummary }
	| RouteFailure;

export type ClaimStagedCommandsResponse =
	| { success: true; commands: ItemSyncCommand[]; nextClaimAt?: number }
	| RouteFailure;

export type EnqueueItemCommandResponse =
	| { success: true }
	| { success: false; code?: "ALREADY_EXISTS"; error?: string };

export type OutboundClaimResponse =
	| { success: true }
	| { success: false; code?: "CLAIM_LOST"; error?: string };

export type VaultItemsResponse =
	| { success: true; items: DecryptedItemWithContext[] }
	| RouteFailure;

export type VaultItemResponse =
	| { success: true; item: DecryptedItemWithContext | null }
	| RouteFailure;

/**
 * Same option shape the passkey sub-protocol already publishes for its
 * save-target picker — one vocabulary for "a vault the user may write to".
 */
export type WritableVaultOption = PasskeyWritableVaultOption;

export type WritableVaultsResponse =
	| { success: true; vaults: WritableVaultOption[] }
	| RouteFailure;

export interface ExistingCredential {
	id: string;
	vaultId: string;
	username: string;
	url: string;
}

export type CheckExistingCredentialsResponse =
	| {
			success: true;
			existingCredentials: ExistingCredential[];
			hasDuplicates: boolean;
			hasChanges: boolean;
	  }
	| RouteFailure;

/**
 * The save prompt maps a stable code to a localized string (strict i18n), so
 * the classifier's codes travel alongside the route's own refusals.
 */
export type CredentialWriteErrorType =
	| CredentialErrorType
	| "validation"
	| "locked"
	| "vault_key";

export interface CredentialWriteFailure {
	success: false;
	error?: string;
	errorType?: CredentialWriteErrorType;
}

export type SaveNewCredentialResponse =
	| { success: true; itemId: string }
	| CredentialWriteFailure;

export type UpdateExistingCredentialResponse =
	| { success: true }
	| CredentialWriteFailure;

export type PendingSavePromptResponse =
	| { success: true; data: PendingSavePrompt | null }
	| RouteFailure;

export type CheckAutofillAuthResponse =
	| {
			success: true;
			authenticated: boolean;
			unlocked: boolean;
			needsReauth?: boolean;
			/** A connected-but-locked desktop app; only it can resolve the lock. */
			desktopLocked?: boolean;
	  }
	| RouteFailure;

export type NativeBiometricStatusResponse =
	| {
			success: true;
			available: boolean;
			enabled: boolean;
			appRunning: boolean;
	  }
	| RouteFailure;

export type CaptureTabScreenshotResponse =
	| { success: true; dataUrl: string }
	| RouteFailure;

export type TotpUpdateErrorType =
	| CredentialErrorType
	| "validation"
	| "locked"
	| "invalid_category"
	| "vault_key";

export type UpdateItemTotpResponse =
	| { success: true; message?: string }
	| { success: false; error?: string; errorType?: TotpUpdateErrorType };

/**
 * `available` is always answered; the rest of `DesktopStatus` is only present
 * when the native host actually replied, so the remainder stays partial.
 */
export type DesktopStatusResponse =
	| ({ success: true; available: boolean } & Partial<DesktopStatus>)
	| RouteFailure;

/* -------------------------------------------------------------------------- */
/* The contract                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `payload: undefined` means the route takes none; a payload type that admits
 * `undefined` means the route takes an optional one. Both are reflected in the
 * message union below, so senders get the right optionality for free.
 */
export interface RouteContract {
	// -- Authentication --
	LOGIN: { payload: LoginPayload; response: Acknowledgement };
	QUICK_UNLOCK: { payload: PasswordPayload; response: UnlockResponse };
	QUICK_UNLOCK_ALL: {
		payload: PasswordPayload;
		response: PasswordUnlockAllResponse;
	};
	CHECK_AUTH: { payload: undefined; response: CheckAuthResponse };
	CAN_QUICK_UNLOCK: { payload: undefined; response: CanQuickUnlockResponse };
	GET_AUTH_TOKEN: { payload: undefined; response: AuthTokenResponse };
	GET_SESSION_DATA: { payload: undefined; response: SessionDataResponse };
	GET_SESSION_STATUS: { payload: undefined; response: SessionStatusResponse };
	LOGOUT: { payload: undefined; response: Acknowledgement };
	LOCK: { payload: undefined; response: LockResponse };

	// -- Sync lifecycle --
	SYNC_CONNECT: { payload: undefined; response: Acknowledgement };
	SYNC_DISCONNECT: { payload: undefined; response: Acknowledgement };
	RECONCILE_ACCOUNT_SCOPE: {
		payload: undefined;
		response: Acknowledgement;
	};
	GET_SYNC_STATUS: { payload: undefined; response: SyncStatusResponse };
	GET_SYNC_CLIENT_ID: { payload: undefined; response: SyncClientIdResponse };
	GET_SYNC_COMMAND_SUMMARY: {
		payload: undefined;
		response: SyncCommandSummaryResponse;
	};

	// -- Worker-owned outbound queue --
	CLAIM_STAGED_ITEM_COMMANDS: {
		payload: { claimId: string };
		response: ClaimStagedCommandsResponse;
	};
	ENQUEUE_ITEM_COMMAND: {
		payload: { command: ItemSyncCommand; claimId: string };
		response: EnqueueItemCommandResponse;
	};
	CANCEL_STAGED_ITEM_COMMAND: {
		payload: OutboundCommandClaim;
		response: OutboundClaimResponse;
	};
	/** No claim drains everything the worker holds; a claim drains just that one. */
	DRAIN_OUTBOUND_QUEUE: {
		payload: Partial<OutboundCommandClaim> | undefined;
		response: OutboundClaimResponse;
	};

	// -- Vault reads --
	GET_VAULT_ITEMS: { payload: undefined; response: VaultItemsResponse };
	GET_VAULT_ITEM: {
		payload: { itemId: string };
		response: VaultItemResponse;
	};
	GET_WRITABLE_VAULTS: {
		payload: undefined;
		response: WritableVaultsResponse;
	};

	// -- Credential capture --
	CHECK_EXISTING_CREDENTIALS: {
		payload: { url: string; username?: string; password?: string };
		response: CheckExistingCredentialsResponse;
	};
	SAVE_NEW_CREDENTIAL: {
		payload: CredentialCapture;
		response: SaveNewCredentialResponse;
	};
	UPDATE_EXISTING_CREDENTIAL: {
		payload: CredentialCapture & { itemId: string };
		response: UpdateExistingCredentialResponse;
	};
	SET_PENDING_SAVE_PROMPT: {
		payload: PendingSavePrompt;
		response: Acknowledgement;
	};
	GET_PENDING_SAVE_PROMPT: {
		payload: undefined;
		response: PendingSavePromptResponse;
	};
	CLEAR_PENDING_SAVE_PROMPT: {
		payload: undefined;
		response: Acknowledgement;
	};

	// -- Autofill --
	CHECK_AUTOFILL_AUTH: {
		payload: undefined;
		response: CheckAutofillAuthResponse;
	};
	UPDATE_AUTOFILL_TIMESTAMP: { payload: undefined; response: Acknowledgement };
	GET_AUTOFILL_ITEMS: {
		payload: { hostname: string };
		response: VaultItemsResponse;
	};
	GET_AUTOFILL_CREDIT_CARDS: {
		payload: undefined;
		response: VaultItemsResponse;
	};
	GET_AUTOFILL_IDENTITIES: {
		payload: undefined;
		response: VaultItemsResponse;
	};

	// -- Passkeys (the sub-protocol in `passkey/types` owns these shapes) --
	PASSKEY_CREATE: {
		payload: PasskeyCreateHandlerPayload;
		response: PasskeyBackgroundResponse;
	};
	PASSKEY_GET: {
		payload: PasskeyGetHandlerPayload;
		response: PasskeyBackgroundResponse;
	};
	PASSKEY_CANCEL: {
		payload: { requestId?: string };
		response: PasskeyBackgroundResponse;
	};

	// -- Native messaging / desktop app --
	CHECK_NATIVE_BIOMETRIC: {
		payload: undefined;
		response: NativeBiometricStatusResponse;
	};
	NATIVE_BIOMETRIC_UNLOCK: {
		payload: undefined;
		response: Acknowledgement & { message?: string };
	};
	NATIVE_BIOMETRIC_UNLOCK_ALL: {
		payload: undefined;
		response: BiometricUnlockAllResponse;
	};
	OPEN_DESKTOP_APP: {
		payload: OpenDesktopAppPayload | undefined;
		response: Acknowledgement;
	};
	CHECK_DESKTOP_STATUS: {
		payload: undefined;
		response: DesktopStatusResponse;
	};
	TRIGGER_DESKTOP_UNLOCK: { payload: undefined; response: Acknowledgement };

	// -- QR scanning --
	CAPTURE_TAB_SCREENSHOT: {
		payload: undefined;
		response: CaptureTabScreenshotResponse;
	};
	UPDATE_ITEM_TOTP: {
		payload: { itemId: string; totp: TotpUpdate };
		response: UpdateItemTotpResponse;
	};

	// -- Popup / settings --
	OPEN_POPUP: { payload: undefined; response: Acknowledgement };
	SETTINGS_CHANGED: { payload: undefined; response: Acknowledgement };
}

/* -------------------------------------------------------------------------- */
/* Derived shapes                                                             */
/* -------------------------------------------------------------------------- */

export type RouteKey = keyof RouteContract;
export type RoutePayload<K extends RouteKey> = RouteContract[K]["payload"];
export type RouteResponse<K extends RouteKey> = RouteContract[K]["response"];

/** A route whose payload admits `undefined` may be sent without one. */
type MessageFor<K extends RouteKey> =
	undefined extends RoutePayload<K>
		? { type: K; payload?: RoutePayload<K> }
		: { type: K; payload: RoutePayload<K> };

/**
 * The discriminated union of every message the router accepts. Distributing the
 * contract keeps `type` and `payload` paired: `{ type: "LOGIN", payload: {…} }`
 * narrows to exactly one member, so a payload from the wrong route is an error
 * rather than a silent `unknown`.
 */
export type RuntimeMessage = { [K in RouteKey]: MessageFor<K> }[RouteKey];

/**
 * Every response carries a `success` flag; the dispatcher relies on it to decide
 * whether a route should kick off sync.
 */
export type AnyRouteResponse = RouteResponse<RouteKey>;
