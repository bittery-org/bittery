/**
 * Auth service utilities for SRP login/unlock flows.
 * These functions are framework-agnostic and can be used in React apps,
 * extensions, or any other runtime.
 */

import { validateServerKdfParamsOrThrow } from "@bittery/shared/kdf-policy";
import type { IStorageAdapter, VaultKeyData } from "@bittery/storage";
import type { EncryptedData, ICrypto, KdfParams } from "@bittery/types";

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
	expiresAt?: string | Date;
	user: LoginUserData;
	vaultKeys: VaultKeyData[];
	masterUnlockKey?: Uint8Array;
	masterUnlockKeyHandle?: number;
}

/**
 * Result from successful unlock
 */
export interface UnlockResult {
	mode: "local" | "reauth";
	token: string;
	sessionId?: string;
	expiresAt?: string | Date;
	user: LoginUserData;
	vaultKeys: VaultKeyData[];
	masterUnlockKey?: Uint8Array;
	masterUnlockKeyHandle?: number;
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
	attemptId: string;
	salt: string;
	serverPublicKey: string;
	kdfParams: KdfParams;
}

/**
 * Finish login response (session data)
 */
export interface FinishLoginResponse {
	token: string;
	serverProof: string;
	user: LoginUserData;
	sessionId?: string;
	expiresAt: string | Date;
}

interface VaultListEntry {
	id: string;
	name: string;
	vaultType: string;
	icon: string | null;
	imageUrl: string | null;
	encryptedVaultKey: string;
	role: string;
}

/**
 * RPC client interface for auth operations.
 * This is the minimal interface needed by auth utilities.
 */
export interface IAuthClient {
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
				attemptId: string;
				clientPublicKey: string;
				clientProof: string;
			}): Promise<FinishLoginResponse>;
		};
		logout: {
			mutate(): Promise<{ success: boolean }>;
		};
		refreshSession: {
			mutate(): Promise<{
				token: string;
				sessionId: string;
				expiresAt: string | Date;
			}>;
		};
	};
	vault: {
		list: {
			query(): Promise<VaultListEntry[]>;
		};
	};
}

/**
 * Dependencies required for SRP login.
 */
export interface SRPLoginDeps {
	crypto: ICrypto;
	authClient?: IAuthClient;
	rpcClient?: IAuthClient;
	storage: IStorageAdapter;
}

/**
 * Dependencies required for SRP unlock.
 */
export interface SRPUnlockDeps {
	crypto: ICrypto;
	authClient?: IAuthClient;
	rpcClient?: IAuthClient;
	storage: IStorageAdapter;
}

function resolveAuthClient(deps: {
	authClient?: IAuthClient;
	rpcClient?: IAuthClient;
}): IAuthClient {
	const client = deps.authClient ?? deps.rpcClient;
	if (!client) {
		throw new Error("Auth client is required");
	}
	return client;
}

interface HandleCapableCrypto extends ICrypto {
	deriveKeyHandles: (
		password: string,
		secretKey: string,
		email: string,
	) => Promise<{ authKeyHandle: number; masterUnlockKeyHandle: number }>;
	deriveSrpPasswordFromHandle: (authKeyHandle: number) => Promise<string>;
	exportKeyHandle?: (keyHandle: number) => Promise<Uint8Array>;
	// biome-ignore lint/suspicious/noConfusingVoidType: wasm needs this
	destroyKeyHandle?: (keyHandle: number) => Promise<void | boolean>;
}

function asHandleCapableCrypto(crypto: ICrypto): HandleCapableCrypto | null {
	const candidate = crypto as Partial<HandleCapableCrypto>;
	if (
		typeof candidate.deriveKeyHandles === "function" &&
		typeof candidate.deriveSrpPasswordFromHandle === "function"
	) {
		return candidate as HandleCapableCrypto;
	}
	return null;
}

function parseEncryptedData(serialized: string | null): EncryptedData | null {
	if (!serialized) {
		return null;
	}

	try {
		return JSON.parse(serialized) as EncryptedData;
	} catch {
		return null;
	}
}

function normalizeVaultType(vaultType: string): VaultKeyData["vaultType"] {
	return vaultType === "team" ? "team" : "personal";
}

function normalizeVaultRole(role: string): VaultKeyData["role"] {
	switch (role) {
		case "owner":
		case "admin":
		case "member":
		case "read-only":
			return role;
		default:
			return "member";
	}
}

async function fetchVaultKeys(authClient: IAuthClient): Promise<VaultKeyData[]> {
	const vaults = await authClient.vault.list.query();
	return vaults.map((vault) => ({
		vaultId: vault.id,
		vaultName: vault.name,
		vaultType: normalizeVaultType(vault.vaultType),
		vaultIcon: vault.icon,
		vaultImageUrl: vault.imageUrl,
		encryptedVaultKey: vault.encryptedVaultKey,
		role: normalizeVaultRole(vault.role),
	}));
}

async function validateDerivedUnlockKey(input: {
	crypto: ICrypto;
	storage: IStorageAdapter;
	email: string;
	masterUnlockKey?: Uint8Array;
	masterUnlockKeyHandle?: number;
	handleCrypto: HandleCapableCrypto | null;
}): Promise<void> {
	const encryptedPrivateKey = await input.storage.getEncryptedPrivateKey(
		input.email,
	);
	const parsedEncryptedPrivateKey = parseEncryptedData(encryptedPrivateKey);
	if (!parsedEncryptedPrivateKey) {
		return;
	}

	let validationKey = input.masterUnlockKey;
	if (
		!validationKey &&
		input.masterUnlockKeyHandle &&
		input.handleCrypto?.exportKeyHandle
	) {
		validationKey = await input.handleCrypto.exportKeyHandle(
			input.masterUnlockKeyHandle,
		);
	}

	if (!validationKey) {
		return;
	}

	await input.crypto.decrypt(parsedEncryptedPrivateKey, validationKey);
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
	const { crypto } = deps;
	const authClient = resolveAuthClient(deps);

	const isValid = await crypto.validateSecretKey(secretKey);
	if (!isValid) {
		throw new Error("Invalid Secret Key format");
	}

	const handleCrypto = asHandleCapableCrypto(crypto);
	let masterUnlockKey: Uint8Array | undefined;
	let masterUnlockKeyHandle: number | undefined;
	let srpPassword: string;

	if (handleCrypto) {
		const handles = await handleCrypto.deriveKeyHandles(
			password,
			secretKey,
			email,
		);
		masterUnlockKeyHandle = handles.masterUnlockKeyHandle;
		try {
			srpPassword = await handleCrypto.deriveSrpPasswordFromHandle(
				handles.authKeyHandle,
			);
		} finally {
			if (handleCrypto.destroyKeyHandle) {
				await handleCrypto.destroyKeyHandle(handles.authKeyHandle);
			}
		}
	} else {
		const derived = await crypto.deriveKeys(password, secretKey, email);
		masterUnlockKey = derived.masterUnlockKey;
		srpPassword = new TextDecoder().decode(derived.authKey);
	}

	try {
		const clientEphemeral = await crypto.generateClientEphemeral();

		const startResult = await authClient.auth.startLogin.mutate({
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

		const finishResult = await authClient.auth.finishLogin.mutate({
			attemptId: startResult.attemptId,
			clientPublicKey: clientEphemeral.publicKey,
			clientProof: clientSession.proof,
		});

		// Store token before fetchVaultKeys so the auth header is available
		await deps.storage.storeAuthToken(finishResult.token, email);

		const vaultKeys = await fetchVaultKeys(authClient);

		await crypto.verifyServerSession(
			clientEphemeral.publicKey,
			clientSession,
			finishResult.serverProof,
		);

		await persistPinnedKdfParamsIfNeeded(
			email,
			startResult.kdfParams,
			deps.storage,
		);

		return {
			token: finishResult.token,
			sessionId: finishResult.sessionId,
			expiresAt: finishResult.expiresAt,
			user: finishResult.user,
			vaultKeys,
			masterUnlockKey,
			masterUnlockKeyHandle,
		};
	} catch (error) {
		if (masterUnlockKeyHandle && handleCrypto?.destroyKeyHandle) {
			await handleCrypto.destroyKeyHandle(masterUnlockKeyHandle);
		}
		throw error;
	}
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

	if (
		result.masterUnlockKeyHandle &&
		storage.storeSessionDataWithMasterUnlockKeyHandle &&
		storage.setMasterUnlockKeyHandle
	) {
		await storage.storeSessionDataWithMasterUnlockKeyHandle(
			result.masterUnlockKeyHandle,
			resolvedEmail,
			result.user.id,
			result.expiresAt,
			result.sessionId,
		);
		await storage.setMasterUnlockKeyHandle(
			result.masterUnlockKeyHandle,
			resolvedEmail,
		);
	} else if (result.masterUnlockKey) {
		await storage.storeSessionData(
			result.masterUnlockKey,
			resolvedEmail,
			result.user.id,
			result.expiresAt,
			result.sessionId,
		);

		await storage.setMasterUnlockKey(result.masterUnlockKey, resolvedEmail);
	} else {
		throw new Error(
			"Master Unlock Key unavailable for session storage on this platform.",
		);
	}

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
	const { crypto, storage } = deps;
	const authClient = resolveAuthClient(deps);

	const storedSecretKey = await storage.getStoredSecretKey(email);
	if (!storedSecretKey) {
		throw new Error(
			"No stored Secret Key found. Please sign in with your full credentials.",
		);
	}

	const handleCrypto = asHandleCapableCrypto(crypto);
	let masterUnlockKey: Uint8Array | undefined;
	let masterUnlockKeyHandle: number | undefined;
	let srpPassword: string;

	if (handleCrypto) {
		const handles = await handleCrypto.deriveKeyHandles(
			password,
			storedSecretKey,
			email,
		);
		masterUnlockKeyHandle = handles.masterUnlockKeyHandle;
		try {
			srpPassword = await handleCrypto.deriveSrpPasswordFromHandle(
				handles.authKeyHandle,
			);
		} finally {
			if (handleCrypto.destroyKeyHandle) {
				await handleCrypto.destroyKeyHandle(handles.authKeyHandle);
			}
		}
	} else {
		const derived = await crypto.deriveKeys(password, storedSecretKey, email);
		masterUnlockKey = derived.masterUnlockKey;
		srpPassword = new TextDecoder().decode(derived.authKey);
	}

	try {
		await validateDerivedUnlockKey({
			crypto,
			storage,
			email,
			masterUnlockKey,
			masterUnlockKeyHandle,
			handleCrypto,
		});

		const [storedSessionData, storedToken, storedVaultKeys, storedPrivateKey] =
			await Promise.all([
				storage.getStoredSessionData?.(email) ?? Promise.resolve(null),
				storage.getAuthToken(email),
				storage.getVaultKeys(email),
				storage.getEncryptedPrivateKey(email),
			]);

		if (
			storedSessionData &&
			storedToken &&
			(await storage.isSessionValid(email))
		) {
			const accountMetadata = await storage.getAccountMetadata?.(email);

			return {
				mode: "local",
				token: storedToken,
				sessionId: storedSessionData.sessionId,
				expiresAt: new Date(storedSessionData.expiresAt),
				user: {
					id: storedSessionData.userId,
					email,
					name: accountMetadata?.name,
					teamName: accountMetadata?.teamName,
					teamAvatarUrl: accountMetadata?.teamAvatarUrl,
					encryptedPrivateKey: storedPrivateKey ?? undefined,
				},
				vaultKeys: storedVaultKeys ?? [],
				masterUnlockKey,
				masterUnlockKeyHandle,
			};
		}

		const clientEphemeral = await crypto.generateClientEphemeral();

		const startResult = await authClient.auth.startLogin.mutate({
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

		const finishResult = await authClient.auth.finishLogin.mutate({
			attemptId: startResult.attemptId,
			clientPublicKey: clientEphemeral.publicKey,
			clientProof: clientSession.proof,
		});

		// Store token before fetchVaultKeys so the auth header is available
		await deps.storage.storeAuthToken(finishResult.token, email);

		const vaultKeys = await fetchVaultKeys(authClient);

		await crypto.verifyServerSession(
			clientEphemeral.publicKey,
			clientSession,
			finishResult.serverProof,
		);

		await persistPinnedKdfParamsIfNeeded(
			email,
			startResult.kdfParams,
			deps.storage,
		);

		return {
			mode: "reauth",
			token: finishResult.token,
			sessionId: finishResult.sessionId,
			expiresAt: finishResult.expiresAt,
			user: finishResult.user,
			vaultKeys,
			masterUnlockKey,
			masterUnlockKeyHandle,
		};
	} catch (error) {
		if (masterUnlockKeyHandle && handleCrypto?.destroyKeyHandle) {
			await handleCrypto.destroyKeyHandle(masterUnlockKeyHandle);
		}
		throw error;
	}
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

	if (result.mode === "reauth") {
		await storage.storeAuthToken(result.token, resolvedEmail);
		await storage.storeVaultKeys(result.vaultKeys, resolvedEmail);

		if (result.user.encryptedPrivateKey) {
			await storage.storeEncryptedPrivateKey(
				result.user.encryptedPrivateKey,
				resolvedEmail,
			);
		}

		if (
			result.masterUnlockKeyHandle &&
			storage.storeSessionDataWithMasterUnlockKeyHandle &&
			storage.setMasterUnlockKeyHandle
		) {
			await storage.storeSessionDataWithMasterUnlockKeyHandle(
				result.masterUnlockKeyHandle,
				resolvedEmail,
				result.user.id,
				result.expiresAt,
				result.sessionId,
			);
			await storage.setMasterUnlockKeyHandle(
				result.masterUnlockKeyHandle,
				resolvedEmail,
			);
		} else if (result.masterUnlockKey) {
			await storage.storeSessionData(
				result.masterUnlockKey,
				resolvedEmail,
				result.user.id,
				result.expiresAt,
				result.sessionId,
			);

			await storage.setMasterUnlockKey(result.masterUnlockKey, resolvedEmail);
		} else {
			throw new Error(
				"Master Unlock Key unavailable for session storage on this platform.",
			);
		}
	} else if (result.masterUnlockKeyHandle && storage.setMasterUnlockKeyHandle) {
		await storage.setMasterUnlockKeyHandle(
			result.masterUnlockKeyHandle,
			resolvedEmail,
		);
	} else if (result.masterUnlockKey) {
		await storage.setMasterUnlockKey(result.masterUnlockKey, resolvedEmail);
	} else {
		throw new Error(
			"Master Unlock Key unavailable for session storage on this platform.",
		);
	}

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
	authClient: Pick<IAuthClient, "auth">,
	email: string,
): Promise<CheckEmailResult> {
	return authClient.auth.checkEmail.query({ email });
}
