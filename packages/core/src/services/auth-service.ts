/**
 * Auth service utilities for SRP login/unlock flows.
 * These functions are framework-agnostic and can be used in React apps,
 * extensions, or any other runtime.
 */

import { validateServerKdfParamsOrThrow } from "@bittery/shared/kdf-policy";
import type { IStorageAdapter, VaultKeyData } from "@bittery/storage";
import type { ICrypto, KdfParams } from "@bittery/types";

/**
 * Input for SRP login (full login with password + secret key)
 */
export interface SRPLoginInput {
	email: string;
	password: string;
	secretKey: string;
}

/**
 * Input for SRP unlock (password unlock with stored secret key)
 */
export interface SRPUnlockInput {
	email: string;
	password: string;
}

/**
 * User data returned from login
 */
export interface LoginUserData {
	id: string;
	email: string;
	name?: string;
	teamName?: string;
	teamAvatarUrl?: string | null;
	encryptedPrivateKey?: string;
}

/**
 * Result from successful login
 */
export interface LoginResult {
	token: string;
	sessionId?: string;
	user: LoginUserData;
	vaultKeys: VaultKeyData[];
	masterUnlockKey: Uint8Array;
}

/**
 * Result from successful unlock
 */
export interface UnlockResult {
	token: string;
	sessionId?: string;
	user: LoginUserData;
	vaultKeys: VaultKeyData[];
	masterUnlockKey: Uint8Array;
}

/**
 * Result from email check
 */
export interface CheckEmailResult {
	exists: boolean;
	secretKeyHint?: string | null;
}

/**
 * Session state information
 */
export interface SessionState {
	/** Whether the session is valid (not expired) */
	isValid: boolean;
	/** Whether quick unlock is available (has stored secret key + valid session) */
	canQuickUnlock: boolean;
	/** Whether biometric unlock is available */
	canBiometricUnlock: boolean;
	/** Whether master password re-entry is required by security policy */
	requiresPasswordReentry: boolean;
	/** Email of the active account */
	email: string | null;
	/** User ID of the active account */
	userId: string | null;
	/** Session expiry timestamp */
	expiresAt: number | null;
}

/**
 * Start login response (SRP challenge)
 */
export interface StartLoginResponse {
	userId: string;
	salt: string;
	serverPublicKey: string;
	kdfParams: KdfParams;
	serverSecret: string;
}

/**
 * Finish login response (session data)
 */
export interface FinishLoginResponse {
	token: string;
	serverProof?: string;
	user: LoginUserData;
	vaultKeys: VaultKeyData[];
	sessionId?: string;
}

/**
 * tRPC client interface for auth operations.
 * This is the minimal interface needed by auth utilities.
 */
export interface IAuthTRPCClient {
	auth: {
		checkEmail: {
			query(input: { email: string }): Promise<CheckEmailResult>;
		};
		startLogin: {
			mutate(input: {
				email: string;
				clientPublicKey: string;
			}): Promise<StartLoginResponse>;
		};
		finishLogin: {
			mutate(input: {
				userId: string;
				serverSecret: string;
				clientPublicKey: string;
				clientProof: string;
			}): Promise<FinishLoginResponse>;
		};
		/**
		 * Quick unlock - same as finishLogin but includes email for tracking.
		 * Used for password-only unlock when secret key is stored locally.
		 */
		quickUnlock: {
			mutate(input: {
				email: string;
				userId: string;
				serverSecret: string;
				clientPublicKey: string;
				clientProof: string;
			}): Promise<FinishLoginResponse>;
		};
		logout: {
			mutate(input: { sessionId: string }): Promise<{ success: boolean }>;
		};
	};
}

/**
 * Dependencies required for SRP login.
 */
export interface SRPLoginDeps {
	crypto: ICrypto;
	trpcClient: IAuthTRPCClient;
	storage: IStorageAdapter;
}

/**
 * Dependencies required for SRP unlock.
 */
export interface SRPUnlockDeps {
	crypto: ICrypto;
	trpcClient: IAuthTRPCClient;
	storage: IStorageAdapter;
}

async function validateAndPinServerKdfParams(
	email: string,
	serverParams: KdfParams,
	deps: SRPLoginDeps | SRPUnlockDeps,
): Promise<void> {
	const pinnedParams = await deps.storage.getPinnedKdfParams(email);

	if (deps.crypto.validateServerKdfParams) {
		await deps.crypto.validateServerKdfParams(serverParams, pinnedParams);
	} else {
		validateServerKdfParamsOrThrow(serverParams, pinnedParams);
	}
}

async function persistPinnedKdfParamsIfNeeded(
	email: string,
	params: KdfParams,
	storage: IStorageAdapter,
): Promise<void> {
	const pinned = await storage.getPinnedKdfParams(email);
	if (
		!pinned ||
		pinned.schemaVersion !== params.schemaVersion ||
		pinned.algorithm !== params.algorithm ||
		pinned.iterations !== params.iterations ||
		pinned.salt !== params.salt
	) {
		console.log("storing pinned kdf params", pinned);
		await storage.storePinnedKdfParams(params, email);
	}
}

/**
 * Performs a complete SRP login handshake.
 */
export async function performSRPLogin(
	input: SRPLoginInput,
	deps: SRPLoginDeps,
): Promise<LoginResult> {
	const { email, password, secretKey } = input;
	const { crypto, trpcClient } = deps;

	const isValid = await crypto.validateSecretKey(secretKey);
	if (!isValid) {
		throw new Error("Invalid Secret Key format");
	}

	const { authKey, masterUnlockKey } = await crypto.deriveKeys(
		password,
		secretKey,
		email,
	);
	const srpPassword = new TextDecoder().decode(authKey);
	const clientEphemeral = await crypto.generateClientEphemeral();

	const startResult = await trpcClient.auth.startLogin.mutate({
		email,
		clientPublicKey: clientEphemeral.publicKey,
	});

	await validateAndPinServerKdfParams(email, startResult.kdfParams, deps);

	const clientSession = await crypto.deriveClientSession(
		clientEphemeral.secret,
		{
			salt: startResult.salt,
			serverPublicKey: startResult.serverPublicKey,
			kdfParams: startResult.kdfParams,
		},
		srpPassword,
	);

	const finishResult = await trpcClient.auth.finishLogin.mutate({
		userId: startResult.userId,
		serverSecret: startResult.serverSecret,
		clientPublicKey: clientEphemeral.publicKey,
		clientProof: clientSession.proof,
	});

	// serverProof is optional for backwards compatibility with quickUnlock.
	if (finishResult.serverProof) {
		await crypto.verifyServerSession(
			clientEphemeral.publicKey,
			clientSession,
			finishResult.serverProof,
		);
	}

	await persistPinnedKdfParamsIfNeeded(
		email,
		startResult.kdfParams,
		deps.storage,
	);

	return {
		token: finishResult.token,
		sessionId: finishResult.sessionId,
		user: finishResult.user,
		vaultKeys: finishResult.vaultKeys,
		masterUnlockKey,
	};
}

/**
 * Store login session data after successful login.
 */
export async function storeLoginSession(
	result: LoginResult,
	secretKey: string,
	storage: IStorageAdapter,
	email?: string,
): Promise<void> {
	const resolvedEmail = email ?? result.user.email;

	// Clear stale cached data from a previous account with the same email.
	if (storage.clearItemCache) {
		await storage.clearItemCache(resolvedEmail);
	}

	await storage.storeAuthToken(result.token, resolvedEmail);
	await storage.storeVaultKeys(result.vaultKeys, resolvedEmail);

	if (result.user.encryptedPrivateKey) {
		await storage.storeEncryptedPrivateKey(
			result.user.encryptedPrivateKey,
			resolvedEmail,
		);
	}

	await storage.storeSecretKey(secretKey, resolvedEmail);

	await storage.storeSessionData(
		result.masterUnlockKey,
		resolvedEmail,
		result.user.id,
		undefined,
		result.sessionId,
	);

	await storage.setMasterUnlockKey(result.masterUnlockKey, resolvedEmail);

	if (storage.supportsMultiAccount && storage.addAccount) {
		await storage.addAccount({
			email: resolvedEmail,
			userId: result.user.id,
			name: result.user.name || resolvedEmail.split("@")[0] || "User",
			teamName: result.user.teamName,
			teamAvatarUrl: result.user.teamAvatarUrl,
			addedAt: Date.now(),
			lastActiveAt: Date.now(),
			secretKeyHint: `${secretKey.slice(0, 4)}••••`,
			biometricEnabled: storage.isBiometricEnabled
				? await storage.isBiometricEnabled(resolvedEmail)
				: false,
		});

		await storage.setActiveAccount({ type: "single", email: resolvedEmail });
	}
}

/**
 * Performs a password unlock using stored secret key.
 */
export async function performSRPUnlock(
	input: SRPUnlockInput,
	deps: SRPUnlockDeps,
): Promise<UnlockResult> {
	const { email, password } = input;
	const { crypto, trpcClient, storage } = deps;

	const storedSecretKey = await storage.getStoredSecretKey(email);
	if (!storedSecretKey) {
		throw new Error(
			"No stored Secret Key found. Please sign in with your full credentials.",
		);
	}

	const { authKey, masterUnlockKey } = await crypto.deriveKeys(
		password,
		storedSecretKey,
		email,
	);
	const srpPassword = new TextDecoder().decode(authKey);
	const clientEphemeral = await crypto.generateClientEphemeral();

	const startResult = await trpcClient.auth.startLogin.mutate({
		email,
		clientPublicKey: clientEphemeral.publicKey,
	});

	await validateAndPinServerKdfParams(email, startResult.kdfParams, deps);

	const clientSession = await crypto.deriveClientSession(
		clientEphemeral.secret,
		{
			salt: startResult.salt,
			serverPublicKey: startResult.serverPublicKey,
			kdfParams: startResult.kdfParams,
		},
		srpPassword,
	);

	const finishResult = await trpcClient.auth.quickUnlock.mutate({
		email,
		userId: startResult.userId,
		serverSecret: startResult.serverSecret,
		clientPublicKey: clientEphemeral.publicKey,
		clientProof: clientSession.proof,
	});

	// serverProof is optional for backwards compatibility with quickUnlock.
	if (finishResult.serverProof) {
		await crypto.verifyServerSession(
			clientEphemeral.publicKey,
			clientSession,
			finishResult.serverProof,
		);
	}

	await persistPinnedKdfParamsIfNeeded(
		email,
		startResult.kdfParams,
		deps.storage,
	);

	return {
		token: finishResult.token,
		sessionId: finishResult.sessionId,
		user: finishResult.user,
		vaultKeys: finishResult.vaultKeys,
		masterUnlockKey,
	};
}

/**
 * Store unlock session data after successful unlock.
 */
export async function storeUnlockSession(
	result: UnlockResult,
	storage: IStorageAdapter,
	email?: string,
): Promise<void> {
	const resolvedEmail = email ?? result.user.email;

	await storage.storeAuthToken(result.token, resolvedEmail);
	await storage.storeVaultKeys(result.vaultKeys, resolvedEmail);

	if (result.user.encryptedPrivateKey) {
		await storage.storeEncryptedPrivateKey(
			result.user.encryptedPrivateKey,
			resolvedEmail,
		);
	}

	await storage.storeSessionData(
		result.masterUnlockKey,
		resolvedEmail,
		result.user.id,
		undefined,
		result.sessionId,
	);

	await storage.setMasterUnlockKey(result.masterUnlockKey, resolvedEmail);

	if (storage.supportsMultiAccount && storage.setActiveAccount) {
		const currentActive = await storage.getActiveAccount();
		if (
			!currentActive ||
			currentActive.type !== "single" ||
			currentActive.email.toLowerCase() !== resolvedEmail.toLowerCase()
		) {
			await storage.setActiveAccount({ type: "single", email: resolvedEmail });
		}
	}

	if (storage.updateLastMasterPasswordEntry) {
		await storage.updateLastMasterPasswordEntry(resolvedEmail);
	}
}

/**
 * Get the current session state for an account.
 */
export async function getSessionState(
	storage: IStorageAdapter,
	email?: string,
): Promise<SessionState> {
	let resolvedEmail = email;
	if (!resolvedEmail) {
		const activeAccount = await storage.getActiveAccount();
		resolvedEmail =
			activeAccount?.type === "single" ? activeAccount.email : undefined;
	}

	const isValid = await storage.isSessionValid(resolvedEmail ?? undefined);
	const canQuickUnlock = await storage.canQuickUnlock(
		resolvedEmail ?? undefined,
	);

	let canBiometricUnlock = false;
	if (storage.supportsBiometric && storage.canBiometricUnlock) {
		canBiometricUnlock = await storage.canBiometricUnlock(
			resolvedEmail ?? undefined,
		);
	}

	let requiresPasswordReentry = false;
	if (storage.isMasterPasswordReentryRequired) {
		requiresPasswordReentry = await storage.isMasterPasswordReentryRequired(
			resolvedEmail ?? undefined,
		);
	}

	let expiresAt: number | null = null;
	let userId: string | null = null;
	if (storage.getStoredSessionData) {
		const sessionData = await storage.getStoredSessionData(
			resolvedEmail ?? undefined,
		);
		if (sessionData) {
			expiresAt = sessionData.expiresAt;
			userId = sessionData.userId;
		}
	}

	return {
		isValid,
		canQuickUnlock,
		canBiometricUnlock,
		requiresPasswordReentry,
		email: resolvedEmail ?? null,
		userId,
		expiresAt,
	};
}

/**
 * Clear session data for logout.
 */
export async function clearSession(
	storage: IStorageAdapter,
	email?: string,
	clearSecretKey = false,
): Promise<void> {
	if (clearSecretKey) {
		await storage.clearAllStoredData(email);
	} else {
		await storage.clearSession(email);
	}
}

/**
 * Check if an email has an existing account on the server.
 */
export async function checkEmailExists(
	trpcClient: Pick<IAuthTRPCClient, "auth">,
	email: string,
): Promise<CheckEmailResult> {
	return trpcClient.auth.checkEmail.query({ email });
}
