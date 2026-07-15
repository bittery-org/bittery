/**
 * Auth service utilities for SRP login/unlock flows.
 * These functions are framework-agnostic and can be used in React apps,
 * extensions, or any other runtime.
 */

import { m } from "@bittery/i18n/paraglide/messages";
import { validateServerKdfParamsOrThrow } from "@bittery/shared/kdf-policy";
import {
	createAccountRpcClient,
	getDefaultServerUrl,
} from "@bittery/shared/rpc-client-factory";
import type { IStorageAdapter, VaultKeyData } from "@bittery/storage";
import {
	findAccountById,
	resolveOrCreateAccountId,
} from "@bittery/storage/account-id";
import type { EncryptedData, ICrypto, KdfParams } from "@bittery/types";
import { getTravelModeEnforcer } from "./travel-mode-enforcer";
import type { TravelModeRpcClient } from "./travel-mode-service";
import { createStoredAccountRpcClient } from "./account-resolver";
import { peekAccountSessionManager } from "./account-session-manager";

export interface StoreAuthSessionOptions {
	travelModeRpcClient?: TravelModeRpcClient;
	serverUrl?: string;
}

async function resolveAccountIdForLogin(
	storage: IStorageAdapter,
	_email: string,
	userId: string,
	serverUrl: string,
): Promise<string> {
	const accounts = (await storage.getAccountsList?.()) ?? [];
	return resolveOrCreateAccountId(accounts, serverUrl, userId);
}

async function prepareTravelModeForSession(
	accountId: string,
	storage: IStorageAdapter,
	travelModeRpcClient?: TravelModeRpcClient,
): Promise<void> {
	const travelMode = getTravelModeEnforcer(storage);
	try {
		await travelMode.verifyForUnlock(accountId, travelModeRpcClient);
	} catch {
		throw new Error(m.auth_error_travel_mode_verify_failed());
	}
}

/**
 * Input for SRP login (full login with password + secret key)
 */
export interface SRPLoginInput {
	email: string;
	password: string;
	secretKey: string;
	serverUrl: string;
}

/**
 * Input for SRP unlock (password unlock with stored secret key)
 */
export interface SRPUnlockInput {
	accountId: string;
	password: string;
}

export interface SrpLoginProof {
	attemptId: string;
	clientPublicKey: string;
	clientProof: string;
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
	kdfParams: KdfParams;
	serverUrl: string;
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
	kdfParams?: KdfParams;
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
	createAuthenticatedClient?: (token: string, serverUrl: string) => IAuthClient;
}

/**
 * Dependencies required for SRP unlock.
 */
export interface SRPUnlockDeps {
	crypto: ICrypto;
	authClient?: IAuthClient;
	rpcClient?: IAuthClient;
	storage: IStorageAdapter;
	createAuthClientForAccount?: (accountId: string) => Promise<IAuthClient>;
	createAuthenticatedClient?: (token: string, serverUrl: string) => IAuthClient;
}

async function resolveAccountAuthClient(
	accountId: string,
	deps: SRPUnlockDeps,
): Promise<IAuthClient> {
	if (deps.createAuthClientForAccount) {
		return deps.createAuthClientForAccount(accountId);
	}
	return (
		(await createStoredAccountRpcClient(deps.storage, accountId)) ??
		resolveAuthClient(deps)
	) as IAuthClient;
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

async function fetchVaultKeys(
	authClient: IAuthClient,
): Promise<VaultKeyData[]> {
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
	accountId: string;
	masterUnlockKey?: Uint8Array;
	masterUnlockKeyHandle?: number;
	handleCrypto: HandleCapableCrypto | null;
}): Promise<void> {
	const encryptedPrivateKey = await input.storage.getEncryptedPrivateKey(
		input.accountId,
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

async function validateServerKdfParamsForAccount(
	accountId: string | undefined,
	serverParams: KdfParams,
	deps: SRPLoginDeps | SRPUnlockDeps,
): Promise<void> {
	const pinnedParams = accountId
		? await deps.storage.getPinnedKdfParams(accountId)
		: null;

	if (deps.crypto.validateServerKdfParams) {
		await deps.crypto.validateServerKdfParams(serverParams, pinnedParams);
	} else {
		validateServerKdfParamsOrThrow(serverParams, pinnedParams);
	}
}

async function persistPinnedKdfParamsIfNeeded(
	accountId: string,
	params: KdfParams,
	storage: IStorageAdapter,
): Promise<void> {
	const pinned = await storage.getPinnedKdfParams(accountId);
	if (
		!pinned ||
		pinned.schemaVersion !== params.schemaVersion ||
		pinned.algorithm !== params.algorithm ||
		pinned.iterations !== params.iterations ||
		pinned.salt !== params.salt
	) {
		console.log("storing pinned kdf params", pinned);
		await storage.storePinnedKdfParams(params, accountId);
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
	const serverUrl = input.serverUrl.replace(/\/$/, "");
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

		await validateServerKdfParamsForAccount(undefined, startResult.kdfParams, deps);

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

		await crypto.verifyServerSession(
			clientEphemeral.publicKey,
			clientSession,
			finishResult.serverProof,
		);

		const authenticatedClient = deps.createAuthenticatedClient
			? deps.createAuthenticatedClient(finishResult.token, serverUrl)
			: (createAccountRpcClient(
					finishResult.token,
					serverUrl,
				) as unknown as IAuthClient);
		const vaultKeys = await fetchVaultKeys(authenticatedClient);

		return {
			token: finishResult.token,
			sessionId: finishResult.sessionId,
			expiresAt: finishResult.expiresAt,
			user: finishResult.user,
			vaultKeys,
			masterUnlockKey,
			masterUnlockKeyHandle,
			kdfParams: startResult.kdfParams,
			serverUrl,
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
	options?: StoreAuthSessionOptions,
): Promise<string> {
	const resolvedEmail = email ?? result.user.email;
	const serverUrl = (options?.serverUrl ?? result.serverUrl).replace(/\/$/, "");
	const accountId = await resolveAccountIdForLogin(
		storage,
		resolvedEmail,
		result.user.id,
		serverUrl,
	);

	// Clear stale cached data from a previous account with the same identity.
	if (storage.clearItemCache) {
		await storage.clearItemCache(accountId);
	}

	await prepareTravelModeForSession(
		accountId,
		storage,
		options?.travelModeRpcClient,
	);

	const travelMode = getTravelModeEnforcer(storage);

	await storage.storeAuthToken(result.token, accountId);
	await storage.storeServerUrl(serverUrl, accountId);
	await persistPinnedKdfParamsIfNeeded(accountId, result.kdfParams, storage);
	const vaultKeys = await travelMode.stripVaultKeysIfActive(
		accountId,
		result.vaultKeys,
	);
	await storage.storeVaultKeys(vaultKeys, accountId);

	if (result.user.encryptedPrivateKey) {
		await storage.storeEncryptedPrivateKey(
			result.user.encryptedPrivateKey,
			accountId,
		);
	}

	await storage.storeSecretKey(secretKey, accountId);

	if (
		result.masterUnlockKeyHandle &&
		storage.storeSessionDataWithMasterUnlockKeyHandle &&
		storage.setMasterUnlockKeyHandle
	) {
		await storage.storeSessionDataWithMasterUnlockKeyHandle(
			result.masterUnlockKeyHandle,
			accountId,
			resolvedEmail,
			result.user.id,
			result.expiresAt,
			result.sessionId,
		);
		await storage.setMasterUnlockKeyHandle(
			result.masterUnlockKeyHandle,
			accountId,
		);
	} else if (result.masterUnlockKey) {
		await storage.storeSessionData(
			result.masterUnlockKey,
			accountId,
			resolvedEmail,
			result.user.id,
			result.expiresAt,
			result.sessionId,
		);

		await storage.setMasterUnlockKey(result.masterUnlockKey, accountId);
	} else {
		throw new Error(
			"Master Unlock Key unavailable for session storage on this platform.",
		);
	}

	if (storage.supportsMultiAccount && storage.addAccount) {
		await storage.addAccount({
			accountId,
			email: resolvedEmail,
			userId: result.user.id,
			name: result.user.name || resolvedEmail.split("@")[0] || "User",
			serverUrl,
			teamName: result.user.teamName,
			teamAvatarUrl: result.user.teamAvatarUrl,
			addedAt: Date.now(),
			lastActiveAt: Date.now(),
			secretKeyHint: `${secretKey.slice(0, 4)}••••`,
			biometricEnabled: storage.isBiometricEnabled
				? await storage.isBiometricEnabled(accountId)
				: false,
		});

		await storage.setActiveAccount({ type: "single", accountId });
	}

	await peekAccountSessionManager()?.refresh();
	return accountId;
}

async function resolveUnlockAccount(
	accountId: string,
	storage: IStorageAdapter,
): Promise<{ accountId: string; email: string }> {
	const account = findAccountById(await storage.getAccountsList(), accountId);
	if (!account) {
		throw new Error(m.auth_error_no_stored_secret_key());
	}
	return { accountId, email: account.email };
}

async function deriveSrpPasswordForAccount(
	accountId: string,
	email: string,
	password: string,
	crypto: ICrypto,
	storage: IStorageAdapter,
): Promise<string> {
	const storedSecretKey = await storage.getStoredSecretKey(accountId);
	if (!storedSecretKey) {
		throw new Error(m.auth_error_no_stored_secret_key());
	}

	const handleCrypto = asHandleCapableCrypto(crypto);
	if (handleCrypto) {
		const handles = await handleCrypto.deriveKeyHandles(
			password,
			storedSecretKey,
			email,
		);
		try {
			return await handleCrypto.deriveSrpPasswordFromHandle(
				handles.authKeyHandle,
			);
		} finally {
			if (handleCrypto.destroyKeyHandle) {
				await handleCrypto.destroyKeyHandle(handles.authKeyHandle);
			}
		}
	}

	const derived = await crypto.deriveKeys(password, storedSecretKey, email);
	return new TextDecoder().decode(derived.authKey);
}

/**
 * Derives an SRP login proof for sensitive mutations that require master-password
 * verification without creating a new session.
 */
export async function deriveSrpLoginProof(
	input: SRPUnlockInput,
	deps: SRPUnlockDeps,
): Promise<SrpLoginProof> {
	const { accountId, password } = input;
	const { crypto, storage } = deps;
	const { email } = await resolveUnlockAccount(accountId, storage);
	const authClient = await resolveAccountAuthClient(accountId, deps);
	const srpPassword = await deriveSrpPasswordForAccount(
		accountId,
		email,
		password,
		crypto,
		storage,
	);
	const clientEphemeral = await crypto.generateClientEphemeral();
	const startResult = await authClient.auth.startLogin.mutate({
		email,
		clientPublicKey: clientEphemeral.publicKey,
	});
	await validateServerKdfParamsForAccount(accountId, startResult.kdfParams, deps);
	const clientSession = await crypto.deriveClientSession(
		clientEphemeral.secret,
		{
			salt: startResult.salt,
			serverPublicKey: startResult.serverPublicKey,
			kdfParams: startResult.kdfParams,
		},
		srpPassword,
	);

	return {
		attemptId: startResult.attemptId,
		clientPublicKey: clientEphemeral.publicKey,
		clientProof: clientSession.proof,
	};
}

/**
 * Performs a password unlock using stored secret key.
 */
export async function performSRPUnlock(
	input: SRPUnlockInput,
	deps: SRPUnlockDeps,
): Promise<UnlockResult> {
	const { accountId, password } = input;
	const { crypto, storage } = deps;
	const { email } = await resolveUnlockAccount(accountId, storage);
	const authClient = await resolveAccountAuthClient(accountId, deps);

	const storedSecretKey = await storage.getStoredSecretKey(accountId);
	if (!storedSecretKey) {
		throw new Error(m.auth_error_no_stored_secret_key());
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
			accountId,
			masterUnlockKey,
			masterUnlockKeyHandle,
			handleCrypto,
		});

		const [storedSessionData, storedToken, storedVaultKeys, storedPrivateKey] =
			await Promise.all([
				storage.getStoredSessionData?.(accountId) ?? Promise.resolve(null),
				storage.getAuthToken(accountId),
				storage.getVaultKeys(accountId),
				storage.getEncryptedPrivateKey(accountId),
			]);

		if (
			storedSessionData &&
			storedToken &&
			(await storage.isSessionValid(accountId))
		) {
			const accountMetadata = await storage.getAccountMetadata?.(accountId);

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

		await validateServerKdfParamsForAccount(accountId, startResult.kdfParams, deps);

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

		const serverUrl =
			(await deps.storage.getServerUrl(accountId)) ?? getDefaultServerUrl();
		await crypto.verifyServerSession(
			clientEphemeral.publicKey,
			clientSession,
			finishResult.serverProof,
		);

		const authenticatedClient = deps.createAuthenticatedClient
			? deps.createAuthenticatedClient(finishResult.token, serverUrl)
			: (createAccountRpcClient(
					finishResult.token,
					serverUrl,
				) as unknown as IAuthClient);
		const vaultKeys = await fetchVaultKeys(authenticatedClient);

		return {
			mode: "reauth",
			token: finishResult.token,
			sessionId: finishResult.sessionId,
			expiresAt: finishResult.expiresAt,
			user: finishResult.user,
			vaultKeys,
			masterUnlockKey,
			masterUnlockKeyHandle,
			kdfParams: startResult.kdfParams,
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
	accountId: string,
	options?: StoreAuthSessionOptions,
): Promise<void> {
	const resolvedEmail = result.user.email;
	const serverUrl =
		options?.serverUrl ??
		(await storage.getServerUrl(accountId)) ??
		getDefaultServerUrl();

	await prepareTravelModeForSession(
		accountId,
		storage,
		options?.travelModeRpcClient,
	);

	const travelMode = getTravelModeEnforcer(storage);

	if (result.mode === "reauth") {
		await storage.storeAuthToken(result.token, accountId);
		await storage.storeServerUrl(serverUrl, accountId);
		if (result.kdfParams) {
			await persistPinnedKdfParamsIfNeeded(accountId, result.kdfParams, storage);
		}
		const vaultKeys = await travelMode.stripVaultKeysIfActive(
			accountId,
			result.vaultKeys,
		);
		await storage.storeVaultKeys(vaultKeys, accountId);

		if (result.user.encryptedPrivateKey) {
			await storage.storeEncryptedPrivateKey(
				result.user.encryptedPrivateKey,
				accountId,
			);
		}

		if (
			result.masterUnlockKeyHandle &&
			storage.storeSessionDataWithMasterUnlockKeyHandle &&
			storage.setMasterUnlockKeyHandle
		) {
			await storage.storeSessionDataWithMasterUnlockKeyHandle(
				result.masterUnlockKeyHandle,
				accountId,
				resolvedEmail,
				result.user.id,
				result.expiresAt,
				result.sessionId,
			);
			await storage.setMasterUnlockKeyHandle(
				result.masterUnlockKeyHandle,
				accountId,
			);
		} else if (result.masterUnlockKey) {
			await storage.storeSessionData(
				result.masterUnlockKey,
				accountId,
				resolvedEmail,
				result.user.id,
				result.expiresAt,
				result.sessionId,
			);

			await storage.setMasterUnlockKey(result.masterUnlockKey, accountId);
		} else {
			throw new Error(
				"Master Unlock Key unavailable for session storage on this platform.",
			);
		}
	} else if (result.masterUnlockKeyHandle && storage.setMasterUnlockKeyHandle) {
		await storage.setMasterUnlockKeyHandle(
			result.masterUnlockKeyHandle,
			accountId,
		);
	} else if (result.masterUnlockKey) {
		await storage.setMasterUnlockKey(result.masterUnlockKey, accountId);
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
			currentActive.accountId !== accountId
		) {
			await storage.setActiveAccount({ type: "single", accountId });
		}
	}

	if (storage.updateLastMasterPasswordEntry) {
		await storage.updateLastMasterPasswordEntry(accountId);
	}
}

/**
 * Get the current session state for an account.
 */
export async function getSessionState(
	storage: IStorageAdapter,
	accountId?: string,
): Promise<SessionState> {
	let resolvedAccountId = accountId;
	if (!resolvedAccountId) {
		const activeAccount = await storage.getActiveAccount();
		resolvedAccountId =
			activeAccount?.type === "single" ? activeAccount.accountId : undefined;
	}

	let resolvedEmail: string | null = null;
	if (resolvedAccountId) {
		const metadata = await storage.getAccountMetadata?.(resolvedAccountId);
		resolvedEmail = metadata?.email ?? null;
	}

	const isValid = await storage.isSessionValid(resolvedAccountId ?? undefined);
	const canQuickUnlock = await storage.canQuickUnlock(
		resolvedAccountId ?? undefined,
	);

	let canBiometricUnlock = false;
	if (storage.supportsBiometric && storage.canBiometricUnlock) {
		canBiometricUnlock = await storage.canBiometricUnlock(
			resolvedAccountId ?? undefined,
		);
	}

	let requiresPasswordReentry = false;
	if (storage.isMasterPasswordReentryRequired) {
		requiresPasswordReentry = await storage.isMasterPasswordReentryRequired(
			resolvedAccountId ?? undefined,
		);
	}

	let expiresAt: number | null = null;
	let userId: string | null = null;
	if (storage.getStoredSessionData) {
		const sessionData = await storage.getStoredSessionData(
			resolvedAccountId ?? undefined,
		);
		if (sessionData) {
			expiresAt = sessionData.expiresAt;
			userId = sessionData.userId;
			if (!resolvedEmail) {
				resolvedEmail = sessionData.email;
			}
		}
	}

	return {
		isValid,
		canQuickUnlock,
		canBiometricUnlock,
		requiresPasswordReentry,
		email: resolvedEmail,
		userId,
		expiresAt,
	};
}

export interface BiometricUnlockAvailability {
	canUnlock: boolean;
	requiresPasswordReentry: boolean;
}

/** Aggregate biometric unlock availability across the requested accounts. */
export async function getBiometricUnlockAvailability(
	storage: IStorageAdapter,
	accountIds: string[],
): Promise<BiometricUnlockAvailability> {
	let requiresPasswordReentry = false;
	for (const accountId of accountIds) {
		const state = await getSessionState(storage, accountId);
		if (state.canBiometricUnlock && !state.requiresPasswordReentry) {
			return { canUnlock: true, requiresPasswordReentry: false };
		}
		requiresPasswordReentry ||= state.requiresPasswordReentry;
	}
	return { canUnlock: false, requiresPasswordReentry };
}

/**
 * Clear session data for logout.
 */
export async function clearSession(
	storage: IStorageAdapter,
	accountId?: string,
	clearSecretKey = false,
): Promise<void> {
	if (clearSecretKey) {
		await storage.clearAllStoredData(accountId);
	} else {
		await storage.clearSession(accountId);
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
