/**
 * Auth service utilities for SRP login/unlock flows.
 * These functions are framework-agnostic and can be used in React apps,
 * extensions, or any other runtime.
 */

import { m } from "@bittery/i18n/paraglide/messages";
import { validateKdfProfileOrThrow } from "@bittery/shared/kdf-policy";
import {
	createAccountRpcClient,
	getDefaultServerUrl,
} from "@bittery/shared/rpc-client-factory";
import {
	type ServerVaultListEntry,
	toVaultKeyEntry,
} from "@bittery/shared/vault-mapping";
import type { AccountStore, ItemCache, VaultKeyData } from "@bittery/storage";
import {
	findAccountById,
	findAccountByServerEmail,
	normalizeAccountServerUrl,
	resolveOrCreateAccountId,
} from "@bittery/storage/account-id";
import type { EncryptedData, ICrypto, KdfProfile } from "@bittery/types";
import { peekAccountSessionManager } from "./account-session-manager";
import { createStoredAccountRpcClient } from "./rpc-client";
import {
	getTravelModeEnforcer,
	TravelModeVerificationError,
} from "./travel-mode-enforcer";
import type { TravelModeRpcClient } from "./travel-mode-service";

export interface StoreAuthSessionOptions {
	travelModeRpcClient?: TravelModeRpcClient;
	/**
	 * Builds the travel mode client from the token the flow just obtained.
	 * Overridable for tests; defaults to a plain account-scoped client.
	 */
	createTravelModeRpcClient?: (
		token: string,
		serverUrl: string,
	) => TravelModeRpcClient;
	serverUrl?: string;
	/**
	 * Whether this session should claim the active account. Defaults to `true`;
	 * multi-account loops pass `false` so the last account unlocked cannot
	 * overwrite the account the user was last using.
	 */
	setActive?: boolean;
}

async function resolveAccountIdForLogin(
	storage: AccountStore,
	_email: string,
	userId: string,
	serverUrl: string,
): Promise<string> {
	const accounts = await storage.getAccountsList();
	return resolveOrCreateAccountId(accounts, serverUrl, userId);
}

async function prepareTravelModeForSession(
	accountId: string,
	storage: AccountStore,
	itemCache: ItemCache,
	travelModeRpcClient?: TravelModeRpcClient,
): Promise<void> {
	const travelMode = getTravelModeEnforcer(storage, itemCache);
	try {
		await travelMode.verifyForUnlock(accountId, travelModeRpcClient);
	} catch (error) {
		throw new TravelModeVerificationError(
			m.auth_error_travel_mode_verify_failed(),
			{ cause: error },
		);
	}
}

/**
 * Travel mode is verified before the session token is committed to storage, so
 * a client that reads its token from storage would still be unauthenticated
 * here. Build the client from the token this flow just obtained instead.
 */
function resolveTravelModeRpcClientForToken(
	token: string,
	serverUrl: string,
	options?: StoreAuthSessionOptions,
): TravelModeRpcClient {
	if (options?.travelModeRpcClient) {
		return options.travelModeRpcClient;
	}
	const factory = options?.createTravelModeRpcClient;
	if (factory) {
		return factory(token, serverUrl);
	}
	return createAccountRpcClient(
		token,
		serverUrl,
	) as unknown as TravelModeRpcClient;
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
	kdfParams: KdfProfile;
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
	kdfParams?: KdfProfile;
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
	kdfParams: {
		schemaVersion: number;
		algorithm: string;
		iterations: number;
	};
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

type VaultListEntry = ServerVaultListEntry;

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
	storage: AccountStore;
	createAuthenticatedClient?: (token: string, serverUrl: string) => IAuthClient;
}

/**
 * Dependencies required for SRP unlock.
 */
export interface SRPUnlockDeps {
	crypto: ICrypto;
	authClient?: IAuthClient;
	rpcClient?: IAuthClient;
	storage: AccountStore;
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
	return ((await createStoredAccountRpcClient(deps.storage, accountId)) ??
		resolveAuthClient(deps)) as IAuthClient;
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
		profile: KdfProfile,
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

async function fetchVaultKeys(
	authClient: IAuthClient,
): Promise<VaultKeyData[]> {
	const vaults = await authClient.vault.list.query();
	return vaults.map(toVaultKeyEntry);
}

async function validateDerivedUnlockKey(input: {
	crypto: ICrypto;
	storage: AccountStore;
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

async function validateKdfProfileForAccount(
	accountId: string | undefined,
	serverProfile: StartLoginResponse["kdfParams"],
	deps: SRPLoginDeps | SRPUnlockDeps,
): Promise<KdfProfile> {
	const pinnedProfile = accountId
		? await deps.storage.getPinnedKdfProfile(accountId)
		: null;
	validateKdfProfileOrThrow(serverProfile, pinnedProfile);

	if (deps.crypto.validateKdfProfile) {
		await deps.crypto.validateKdfProfile(serverProfile, pinnedProfile);
	}
	return serverProfile;
}

async function persistPinnedKdfProfileIfNeeded(
	accountId: string,
	profile: KdfProfile,
	storage: AccountStore,
): Promise<void> {
	const pinned = await storage.getPinnedKdfProfile(accountId);
	if (
		!pinned ||
		pinned.schemaVersion !== profile.schemaVersion ||
		pinned.algorithm !== profile.algorithm ||
		pinned.iterations !== profile.iterations
	) {
		await storage.storePinnedKdfProfile(profile, accountId);
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
	const serverUrl = normalizeAccountServerUrl(input.serverUrl);
	const { crypto } = deps;
	const authClient = resolveAuthClient(deps);

	const isValid = await crypto.validateSecretKey(secretKey);
	if (!isValid) {
		throw new Error("Invalid Secret Key format");
	}

	const handleCrypto = asHandleCapableCrypto(crypto);
	let masterUnlockKey: Uint8Array | undefined;
	let masterUnlockKeyHandle: number | undefined;

	const clientEphemeral = await crypto.generateClientEphemeral();

	const startResult = await authClient.auth.startLogin.mutate({
		email,
		clientPublicKey: clientEphemeral.publicKey,
	});
	const matchingAccount = findAccountByServerEmail(
		await deps.storage.getAccountsList(),
		serverUrl,
		email,
	);

	// Validate the server-provided login KDF profile against local policy and any
	// pinned values BEFORE running the account KDF, then derive keys with those
	// negotiated params so the KDF stays agile (issue #32).
	const validatedProfile = await validateKdfProfileForAccount(
		matchingAccount?.accountId,
		startResult.kdfParams,
		deps,
	);

	let srpPassword: string;

	if (handleCrypto) {
		const handles = await handleCrypto.deriveKeyHandles(
			password,
			secretKey,
			email,
			validatedProfile,
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
		const derived = await crypto.deriveKeys(
			password,
			secretKey,
			email,
			validatedProfile,
		);
		masterUnlockKey = derived.masterUnlockKey;
		srpPassword = new TextDecoder().decode(derived.authKey);
	}

	try {
		const clientSession = await crypto.deriveClientSession(
			clientEphemeral.secret,
			{
				salt: startResult.salt,
				serverPublicKey: startResult.serverPublicKey,
				kdfParams: validatedProfile,
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
			kdfParams: validatedProfile,
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
	storage: AccountStore,
	itemCache: ItemCache,
	email?: string,
	options?: StoreAuthSessionOptions,
): Promise<string> {
	const resolvedEmail = email ?? result.user.email;
	const serverUrl = normalizeAccountServerUrl(
		options?.serverUrl ?? result.serverUrl,
	);
	const accountId = await resolveAccountIdForLogin(
		storage,
		resolvedEmail,
		result.user.id,
		serverUrl,
	);

	// `resolveOrCreateAccountId` reuses an existing id for the same (serverUrl, userId)
	// pair, so a fresh login can land on an accountId whose collections still hold the
	// previous session's ciphertext. Drop it before anything writes the new session.
	// `AccountStore` cannot do this itself — it holds only a `PlatformPort`, and the
	// cache lives behind a `RecordPort`. See packages/storage/CONTEXT.md §4.2.
	await itemCache.clearItemCache(accountId);

	await prepareTravelModeForSession(
		accountId,
		storage,
		itemCache,
		resolveTravelModeRpcClientForToken(result.token, serverUrl, options),
	);

	const travelMode = getTravelModeEnforcer(storage, itemCache);

	await storage.storeAuthToken(result.token, accountId);
	await storage.storeServerUrl(serverUrl, accountId);
	await persistPinnedKdfProfileIfNeeded(accountId, result.kdfParams, storage);
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

	if (result.masterUnlockKeyHandle) {
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
		biometricEnabled: await storage.isBiometricEnabled(accountId),
	});

	await storage.setActiveAccount(accountId);

	await peekAccountSessionManager()?.refresh();
	return accountId;
}

async function resolveUnlockAccount(
	accountId: string,
	storage: AccountStore,
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
	storage: AccountStore,
	profile: KdfProfile,
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
			profile,
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

	const derived = await crypto.deriveKeys(
		password,
		storedSecretKey,
		email,
		profile,
	);
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
	const clientEphemeral = await crypto.generateClientEphemeral();
	const startResult = await authClient.auth.startLogin.mutate({
		email,
		clientPublicKey: clientEphemeral.publicKey,
	});
	// Validate the server login params against local policy + pin BEFORE running
	// the account KDF, then derive with the negotiated params so an account keyed
	// at an older iteration count still authenticates (issue #32).
	const validatedProfile = await validateKdfProfileForAccount(
		accountId,
		startResult.kdfParams,
		deps,
	);
	const srpPassword = await deriveSrpPasswordForAccount(
		accountId,
		email,
		password,
		crypto,
		storage,
		validatedProfile,
	);
	const clientSession = await crypto.deriveClientSession(
		clientEphemeral.secret,
		{
			salt: startResult.salt,
			serverPublicKey: startResult.serverPublicKey,
			kdfParams: validatedProfile,
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

	// Unlock derives the account keys before it knows whether it can short-circuit
	// on a locally valid session (offline) or must re-auth against the server, so
	// it can't negotiate a profile from startLogin the way full login does. Derive
	// with the profile pinned after login. A missing pin fails closed and requires
	// a full sign-in; an implicit current-profile fallback could corrupt access to
	// an account created with a different valid work factor.
	const pinnedKdfProfile = await storage.getPinnedKdfProfile(accountId);
	if (!pinnedKdfProfile) {
		throw new Error(m.auth_error_kdf_profile_missing());
	}
	validateKdfProfileOrThrow(pinnedKdfProfile);

	const handleCrypto = asHandleCapableCrypto(crypto);
	let masterUnlockKey: Uint8Array | undefined;
	let masterUnlockKeyHandle: number | undefined;
	let srpPassword: string;

	if (handleCrypto) {
		const handles = await handleCrypto.deriveKeyHandles(
			password,
			storedSecretKey,
			email,
			pinnedKdfProfile,
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
		const derived = await crypto.deriveKeys(
			password,
			storedSecretKey,
			email,
			pinnedKdfProfile,
		);
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
				storage.getStoredSessionData(accountId),
				storage.getAuthToken(accountId),
				storage.getVaultKeys(accountId),
				storage.getEncryptedPrivateKey(accountId),
			]);

		if (
			storedSessionData &&
			storedToken &&
			(await storage.isSessionValid(accountId))
		) {
			const accountMetadata = await storage.getAccountMetadata(accountId);

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

		const validatedProfile = await validateKdfProfileForAccount(
			accountId,
			startResult.kdfParams,
			deps,
		);

		const clientSession = await crypto.deriveClientSession(
			clientEphemeral.secret,
			{
				salt: startResult.salt,
				serverPublicKey: startResult.serverPublicKey,
				kdfParams: validatedProfile,
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
			kdfParams: validatedProfile,
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
	storage: AccountStore,
	itemCache: ItemCache,
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
		itemCache,
		options?.travelModeRpcClient,
	);

	const travelMode = getTravelModeEnforcer(storage, itemCache);

	if (result.mode === "reauth") {
		await storage.storeAuthToken(result.token, accountId);
		await storage.storeServerUrl(serverUrl, accountId);
		if (result.kdfParams) {
			await persistPinnedKdfProfileIfNeeded(
				accountId,
				result.kdfParams,
				storage,
			);
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

		if (result.masterUnlockKeyHandle) {
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
	} else if (result.masterUnlockKeyHandle) {
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

	if (options?.setActive ?? true) {
		const currentActive = await storage.getActiveAccount();
		if (currentActive !== accountId) {
			await storage.setActiveAccount(accountId);
		}
	}

	await storage.updateLastMasterPasswordEntry(accountId);
}

/**
 * Get the current session state for an account.
 */
export async function getSessionState(
	storage: AccountStore,
	accountId?: string,
): Promise<SessionState> {
	const active = accountId ? null : await storage.getActiveAccount();
	const resolvedAccountId = accountId ?? active ?? undefined;

	const [
		metadata,
		sessionData,
		isValid,
		canQuickUnlock,
		canBiometricUnlock,
		requiresPasswordReentry,
	] = await Promise.all([
		resolvedAccountId ? storage.getAccountMetadata(resolvedAccountId) : null,
		storage.getStoredSessionData(resolvedAccountId),
		storage.isSessionValid(resolvedAccountId),
		storage.canQuickUnlock(resolvedAccountId),
		storage.canBiometricUnlock(resolvedAccountId),
		storage.isMasterPasswordReentryRequired(resolvedAccountId),
	]);

	return {
		isValid,
		canQuickUnlock,
		canBiometricUnlock,
		requiresPasswordReentry,
		email: metadata?.email ?? sessionData?.email ?? null,
		userId: sessionData?.userId ?? null,
		expiresAt: sessionData?.expiresAt ?? null,
	};
}

export interface BiometricUnlockAvailability {
	canUnlock: boolean;
	requiresPasswordReentry: boolean;
}

/** Aggregate biometric unlock availability across the requested accounts. */
export async function getBiometricUnlockAvailability(
	storage: AccountStore,
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
 * Check if an email has an existing account on the server.
 */
export async function checkEmailExists(
	authClient: Pick<IAuthClient, "auth">,
	email: string,
): Promise<CheckEmailResult> {
	return authClient.auth.checkEmail.query({ email });
}
