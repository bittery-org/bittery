/**
 * Authentication Handlers
 * Handles LOGIN, QUICK_UNLOCK, CHECK_AUTH, and related authentication messages
 *
 * Uses shared auth utilities from @bittery/core for SRP login/unlock logic.
 */

import {
	IncompleteLifecycleOutcomeError,
	requireCompleteLifecycleOutcome,
	signOutAccount,
} from "@bittery/core/services/account-lifecycle";
import {
	performSRPLogin,
	performSRPUnlock,
	storeLoginSessionOwned,
	storeUnlockSessionOwned,
} from "@bittery/core/services/auth-service";
import type { ClientRuntime } from "@bittery/core/services/client-runtime";
import { unlockAllWithPassword } from "@bittery/core/services/unlock";
import { createApiClientForServer } from "@bittery/shared/api-client-factory";
import { crypto } from "../lib/crypto";
import { itemCache, storage } from "../lib/storage";
import { PENDING_DESKTOP_UNLOCK } from "./desktop-protocol";
import { isDesktopUnlockedNow } from "./desktop-status";
import { requireDesktopUnlock } from "./desktop-unlock";
import { lifecycleDeps } from "./lifecycle";
import { localMaterialPublication } from "./local-material-publication";
import { nativeMessagingClient } from "./native-messaging-client";
import type {
	Acknowledgement,
	AuthTokenResponse,
	CanQuickUnlockResponse,
	CheckAuthResponse,
	LockResponse,
	LoginPayload,
	PasswordPayload,
	PasswordUnlockAllResponse,
	SessionDataResponse,
	SessionStatusResponse,
	UnlockResponse,
} from "./router/contract";
import { resolveEmailFromAccountId } from "./services/account-resolution";
import { restoreUnlockedSessions } from "./services/session-restore";
import {
	isUnlocked,
	setDesktopModeSentinel,
	setMasterUnlockKey,
	updateActivity,
} from "./session-manager";
import { reconcileClientRuntime } from "./vault-runtime";
import { vaultSession } from "./vault-session";

const DEFAULT_SERVER_URL = "http://localhost:3000";

/**
 * Handle LOGIN message - Full SRP authentication
 */
export async function handleLogin(
	payload: LoginPayload,
	runtime: ClientRuntime,
): Promise<Acknowledgement> {
	const publication = await localMaterialPublication.capture();
	const { email, password, secretKey } = payload;
	const serverUrl = payload.serverUrl ?? DEFAULT_SERVER_URL;

	// Perform SRP login using shared utility
	const loginApiClient = createApiClientForServer(serverUrl, undefined, {
		clientPlatform: "extension",
		insecureTransportConfirmed: payload.insecureTransportConfirmed === true,
	});
	const result = await performSRPLogin(
		{
			email,
			password,
			secretKey,
			serverUrl,
			insecureTransportConfirmed: payload.insecureTransportConfirmed === true,
		},
		{ apiClient: loginApiClient, crypto, storage },
	);

	// Store session data using shared utility
	await storeLoginSessionOwned(
		result,
		secretKey,
		storage,
		itemCache,
		crypto,
		email,
		{
			materialPublication: publication,
			serverUrl,
			insecureTransportConfirmed: payload.insecureTransportConfirmed === true,
			onMasterUnlockKeyTransferred: () => {
				publication.check();
				setMasterUnlockKey(result.masterUnlockKey);
			},
			onSessionStored: () => reconcileClientRuntime(runtime, publication),
		},
	);
	publication.check();

	// Start activity tracking
	updateActivity();

	return { success: true };
}

/**
 * Handle QUICK_UNLOCK message - Fast unlock using stored secret key
 */
export async function handleQuickUnlock(
	payload: PasswordPayload,
	runtime: ClientRuntime,
): Promise<UnlockResponse> {
	const publication = await localMaterialPublication.capture();
	const { password } = payload;

	// A connected-but-locked desktop owns the unlock; unlocking locally here
	// would leave the desktop behind. See `desktop-unlock.ts`.
	const desktopUnlock = await requireDesktopUnlock();
	if (desktopUnlock.required) {
		return {
			success: true,
			status: PENDING_DESKTOP_UNLOCK,
			desktopReachable: desktopUnlock.triggered,
		};
	}

	// Get stored email for multi-account support
	const activeAccount = await storage.getActiveAccount();

	if (!activeAccount) {
		throw new Error("Quick unlock not available - no active account");
	}

	// Perform SRP unlock using shared utility (retrieves stored secret key internally)
	const result = await performSRPUnlock(
		{ accountId: activeAccount, password },
		{ crypto, storage },
	);

	// Store session data using shared utility
	await storeUnlockSessionOwned(
		result,
		storage,
		itemCache,
		crypto,
		activeAccount,
		{
			setActive: true,
			materialPublication: publication,
			onMasterUnlockKeyTransferred: () => {
				publication.check();
				setMasterUnlockKey(result.masterUnlockKey);
			},
		},
	);
	publication.check();
	await reconcileClientRuntime(runtime, publication);
	publication.check();

	// Start activity tracking
	updateActivity();

	return { success: true };
}

/**
 * Handle CHECK_AUTH message - Check if extension is authenticated and unlocked
 */
export async function handleCheckAuth(
	runtime: ClientRuntime,
): Promise<CheckAuthResponse> {
	// Check if we have a valid session
	const localAuthenticated = await storage.isAuthenticated();

	// Ensure an active account is set if accounts exist but none is active
	// This handles the case where the first account is added but not set as active
	await ensureActiveAccountSet(runtime);

	// Try to restore sessions from storage if not already unlocked.
	//
	// The service-worker startup routine already does this once per wake
	// (`restoreUnlockedSessions`); this covers the case where the worker stayed alive
	// through a lock and the popup is asking again.
	if (localAuthenticated && !isUnlocked()) {
		const restored = await restoreUnlockedSessions(runtime.accounts);
		const muk = restored.muk;
		if (muk) {
			const accountId = restored.accountIds[0];
			if (!accountId || !restored.publication)
				throw new Error("Restored key has no publication owner");
			await restored.publication.run(
				accountId,
				async (check) => {
					check();
					setMasterUnlockKey(muk);
				},
				() => false,
			);
		}
	}

	const desktopUnlocked = await isDesktopUnlockedNow();
	let unlocked = isUnlocked();

	// Service worker restart can lose sentinel MUK; recover desktop mode eagerly.
	if (!unlocked && desktopUnlocked) {
		setDesktopModeSentinel();
		unlocked = true;
	}

	// In desktop mode, local tokens may not be restored yet, but API auth still works
	// through desktop token bridging.
	const authenticated = localAuthenticated || desktopUnlocked;

	if (authenticated && unlocked) {
		await updateActivity();
	}

	return { success: true, authenticated, unlocked };
}

/**
 * Ensure an active account is set if accounts exist but none is active
 * This handles the case where the first account is added but no active account is set
 */
async function ensureActiveAccountSet(runtime: ClientRuntime): Promise<void> {
	try {
		const accounts = await storage.getAccountsList();
		if (accounts.length === 0) return;

		const activeAccount = await storage.getActiveAccount();
		if (activeAccount) return; // Already have an active account

		// No active account but we have accounts - set the first one as active
		if (accounts.length === 1) {
			// Single account - set it as active
			const firstAccount = accounts[0];
			if (!firstAccount) return; // Should never happen but satisfies TS
			await storage.setActiveAccount(firstAccount.accountId);
			await reconcileClientRuntime(runtime);
		} else {
			// Multiple accounts - check if any are unlocked
			const unlockedAccountIds = await storage.getUnlockedAccounts();

			if (unlockedAccountIds.length >= 1) {
				// One or more unlocked - use the first unlocked account as active
				const unlockedAccountId = unlockedAccountIds[0];
				if (!unlockedAccountId) return; // Should never happen but satisfies TS
				await storage.setActiveAccount(unlockedAccountId);
				await reconcileClientRuntime(runtime);
			} else {
				// None unlocked - default to first account
				const firstAccount = accounts[0];
				if (!firstAccount) return; // Should never happen but satisfies TS
				await storage.setActiveAccount(firstAccount.accountId);
				await reconcileClientRuntime(runtime);
			}
		}
	} catch (error) {
		console.error("[Auth] Failed to ensure active account:", error);
	}
}

/**
 * Handle CAN_QUICK_UNLOCK message - Check if quick unlock is available
 *
 * The shared store asks whether the Device-bound Secret Key and pinned KDF profile can
 * start a fresh online SRP ceremony. It deliberately ignores the previous Server Session.
 */
export async function handleCanQuickUnlock(): Promise<CanQuickUnlockResponse> {
	const activeAccount = await storage.getActiveAccount();
	if (!activeAccount) {
		return { success: true, canQuickUnlock: false };
	}

	return {
		success: true,
		canQuickUnlock: await storage.canQuickUnlock(activeAccount),
	};
}

/**
 * Handle GET_AUTH_TOKEN message - Get the auth token
 */
export async function handleGetAuthToken(): Promise<AuthTokenResponse> {
	const accountId = await storage.getActiveAccount();
	if (!accountId) {
		return { success: true, accountId: null, token: null, serverUrl: null };
	}
	const [token, serverUrl] = await Promise.all([
		storage.getAuthToken(accountId),
		storage.getServerUrl(accountId),
	]);
	return { success: true, accountId, token, serverUrl };
}

/**
 * Handle GET_SESSION_DATA message - Get stored session data
 */
export async function handleGetSessionData(): Promise<SessionDataResponse> {
	const activeAccount = await storage.getActiveAccount();
	if (!activeAccount) {
		return { success: true, sessionData: null };
	}
	const [sessionData, sessionValid, email] = await Promise.all([
		storage.getStoredSessionData(activeAccount),
		storage.isSessionValid(activeAccount),
		resolveEmailFromAccountId(activeAccount),
	]);

	return {
		success: true,
		sessionData:
			email && sessionData?.userId
				? { email, userId: sessionData.userId, isValid: sessionValid }
				: null,
	};
}

/**
 * Handle LOGOUT message - Sign out of the active account and lock
 */
export async function handleLogout(
	runtime: ClientRuntime,
): Promise<Acknowledgement> {
	const accountId = await storage.getActiveAccount();
	let incomplete: IncompleteLifecycleOutcomeError | null = null;
	let signedOut = false;
	if (accountId) {
		try {
			await nativeMessagingClient.withLifecycleCleanup(
				async () => {
					const outcome = await signOutAccount(accountId, lifecycleDeps);
					return requireCompleteLifecycleOutcome(outcome, {
						operation: "Extension signOutAccount",
					});
				},
				(outcome) => outcome.affected.map((account) => account.accountId),
				accountId,
			);
			signedOut = true;
		} catch (error) {
			if (!(error instanceof IncompleteLifecycleOutcomeError)) throw error;
			incomplete = error;
		}
	}
	// `source: "logout"` never refuses: signing out must lock even next to a desktop app.
	try {
		await vaultSession.dispatch({
			type: "LOCK_REQUESTED",
			source: "logout",
			at: Date.now(),
		});
	} catch (error) {
		// A partial Sign out already holds the material fence closed. Preserve the
		// caller's failed acknowledgement after the lock's remaining effects run.
		if (!incomplete) throw error;
	}

	// The module reports instead of throwing, so a genuinely failed storage step
	// has to be surfaced here or the popup would call a partial wipe a success.
	if (incomplete) {
		console.error("[Auth] Sign-out steps failed:", incomplete.outcome.failures);
		return { success: false };
	}
	if (signedOut) await reconcileClientRuntime(runtime);
	return { success: true };
}

/**
 * Handle GET_SESSION_STATUS message - the whole vault-session snapshot, so lock
 * state and ownership reach the popup as one consistent value. Reading it also
 * re-evaluates the desktop and the auto-lock deadline (fail-closed by design).
 */
export async function handleGetSessionStatus(): Promise<SessionStatusResponse> {
	return { success: true, ...vaultSession.getSnapshot() };
}

/**
 * Handle LOCK message - Manual lock (clears MUK but keeps vault keys)
 *
 * Refusals travel as a machine-readable `code`, never as prose: the popup owns
 * the translated string (strict i18n).
 */
export async function handleLock(): Promise<LockResponse> {
	await vaultSession.dispatch({
		type: "LOCK_REQUESTED",
		source: "popup",
		at: Date.now(),
	});

	const refusal = vaultSession.consumeRefusal();
	if (refusal) {
		return { success: false, code: refusal };
	}

	return { success: true };
}

/**
 * Handle QUICK_UNLOCK_ALL message - Unlock all accounts with password
 */
export async function handleQuickUnlockAll(
	payload: PasswordPayload,
	runtime: ClientRuntime,
): Promise<PasswordUnlockAllResponse> {
	const publication = await localMaterialPublication.capture();
	const { password } = payload;

	// A connected-but-locked desktop owns the unlock; unlocking locally here
	// would leave the desktop behind. See `desktop-unlock.ts`.
	const desktopUnlock = await requireDesktopUnlock();
	if (desktopUnlock.required) {
		return {
			success: true,
			status: PENDING_DESKTOP_UNLOCK,
			desktopReachable: desktopUnlock.triggered,
		};
	}

	const accounts = await storage.getAccountsList();

	if (accounts.length === 0) {
		throw new Error("No accounts found");
	}

	const { activeAccountId, unlocked, failed } = await unlockAllWithPassword(
		{ password },
		{
			storage,
			itemCache,
			crypto,
			credentialMirror: lifecycleDeps.credentialMirror,
			materialPublication: publication,
		},
	);
	publication.check();

	if (!activeAccountId) {
		throw new Error("Failed to unlock any accounts");
	}

	// The other accounts stay unlocked in the background; only the active one
	// gets its MUK seeded into the in-memory session manager for auto-lock.
	const activeMuk = await storage.getMasterUnlockKey(activeAccountId);
	publication.check();
	if (activeMuk) {
		await publication.run(
			activeAccountId,
			async (check) => {
				check();
				setMasterUnlockKey(activeMuk);
			},
			() => false,
		);
	}

	updateActivity();
	await reconcileClientRuntime(runtime, publication);
	publication.check();

	return {
		success: true,
		result: { unlocked, failed },
	};
}
