/**
 * Auth service utilities for SRP login/unlock flows.
 * These functions are framework-agnostic and can be used in React apps,
 * extensions, or any other runtime.
 */

import type { CryptoPort, KeyRef } from "@bittery/crypto-port";
import { m } from "@bittery/i18n/paraglide/messages";
import {
	createAccountApiClient,
	getDefaultServerUrl,
} from "@bittery/shared/api-client-factory";
import { validateKdfProfileOrThrow } from "@bittery/shared/kdf-policy";
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
import type { EncryptedData, KdfProfile } from "@bittery/types";
import { peekAccountSessionManager } from "./account-session-manager";
import { createStoredAccountApiClient } from "./api-client";
import {
	getTravelModeEnforcer,
	TravelModeVerificationError,
} from "./travel-mode-enforcer";
import type { TravelModeApiClient } from "./travel-mode-service";
import { createVaultCrypto, type VaultCrypto } from "./vault-crypto";

export interface StoreAuthSessionOptions {
	travelModeApiClient?: TravelModeApiClient;
	/**
	 * Builds the travel mode client from the token the flow just obtained.
	 * Overridable for tests; defaults to a plain account-scoped client.
	 */
	createTravelModeApiClient?: (
		token: string,
		serverUrl: string,
	) => TravelModeApiClient;
	serverUrl?: string;
	/**
	 * Whether this session should claim the active account. Defaults to `true`;
	 * multi-account loops pass `false` so the last account unlocked cannot
	 * overwrite the account the user was last using.
	 */
	setActive?: boolean;
	/** Called at the exact point `AccountStore` takes ownership of the login MUK. */
	onMasterUnlockKeyTransferred?: () => void;
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
	travelModeApiClient?: TravelModeApiClient,
): Promise<void> {
	const travelMode = getTravelModeEnforcer(storage, itemCache);
	try {
		await travelMode.verifyForUnlock(accountId, travelModeApiClient);
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
function resolveTravelModeApiClientForToken(
	token: string,
	serverUrl: string,
	options?: StoreAuthSessionOptions,
): TravelModeApiClient {
	if (options?.travelModeApiClient) {
		return options.travelModeApiClient;
	}
	const factory = options?.createTravelModeApiClient;
	if (factory) {
		return factory(token, serverUrl);
	}
	return createAccountApiClient(
		token,
		serverUrl,
	) as unknown as TravelModeApiClient;
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
	/**
	 * Caller-owned until `storeLoginSession` takes it: that call transfers the ref to the
	 * store, which destroys it on lock. A flow that abandons the result before storing it
	 * must `destroyKey` this itself.
	 */
	masterUnlockKey: KeyRef;
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
	/** Ownership transfers to the store on `storeUnlockSessionOwned`, as with {@link LoginResult}. */
	masterUnlockKey: KeyRef;
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

type VaultListEntry = Omit<ServerVaultListEntry, "icon" | "imageUrl"> & {
	icon?: string | null;
	imageUrl?: string | null;
};

type ApiResponse<T> = { data: T };

/** The React-free auth surface needed by login and unlock ceremonies. */
export interface IAuthClient {
	auth: {
		checkEmail(input: {
			email: string;
		}): Promise<ApiResponse<CheckEmailResult>>;
		startLogin(input: {
			email: string;
			clientPublicKey: string;
		}): Promise<ApiResponse<StartLoginResponse>>;
		finishLogin(
			attemptId: string,
			input: {
				clientPublicKey: string;
				clientProof: string;
			},
		): Promise<ApiResponse<FinishLoginResponse>>;
	};
	vaults: {
		list(): Promise<ApiResponse<readonly VaultListEntry[]>>;
	};
}

/**
 * Dependencies required for SRP login.
 */
export interface SRPLoginDeps {
	crypto: CryptoPort;
	authClient?: IAuthClient;
	apiClient?: IAuthClient;
	storage: AccountStore;
	createAuthenticatedClient?: (token: string, serverUrl: string) => IAuthClient;
}

/**
 * Dependencies required for SRP unlock.
 */
export interface SRPUnlockDeps {
	crypto: CryptoPort;
	authClient?: IAuthClient;
	apiClient?: IAuthClient;
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
	return ((await createStoredAccountApiClient(deps.storage, accountId)) ??
		resolveAuthClient(deps)) as IAuthClient;
}

function resolveAuthClient(deps: {
	authClient?: IAuthClient;
	apiClient?: IAuthClient;
}): IAuthClient {
	const client = deps.authClient ?? deps.apiClient;
	if (!client) {
		throw new Error("Auth client is required");
	}
	return client;
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
	const { data: vaults } = await authClient.vaults.list();
	return vaults.map((vault) =>
		toVaultKeyEntry({
			...vault,
			icon: vault.icon ?? null,
			imageUrl: vault.imageUrl ?? null,
		}),
	);
}

/**
 * Proves the derived key really is this account's, by opening the stored private key with
 * it. An account with no stored private key has nothing to check against and passes.
 */
async function validateDerivedUnlockKey(input: {
	vaultCrypto: VaultCrypto;
	storage: AccountStore;
	accountId: string;
	masterUnlockKey: KeyRef;
}): Promise<void> {
	const encryptedPrivateKey = await input.storage.getEncryptedPrivateKey(
		input.accountId,
	);
	if (!encryptedPrivateKey || !parseEncryptedData(encryptedPrivateKey)) {
		return;
	}

	await input.vaultCrypto.decryptPrivateKey(
		encryptedPrivateKey,
		input.masterUnlockKey,
	);
}

/**
 * Narrows the server's login params to a profile this client will key against.
 *
 * Kept here rather than delegated to `VaultCrypto.validateKdfProfile` because the wire
 * shape is `{ schemaVersion: number; algorithm: string }` and it is this assertion that
 * turns it into a `KdfProfile`.
 */
async function validateKdfProfileForAccount(
	accountId: string | undefined,
	serverProfile: StartLoginResponse["kdfParams"],
	storage: AccountStore,
): Promise<KdfProfile> {
	const pinnedProfile = accountId
		? await storage.getPinnedKdfProfile(accountId)
		: null;
	validateKdfProfileOrThrow(serverProfile, pinnedProfile);
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
	const vaultCrypto = createVaultCrypto({ crypto, storage: deps.storage });
	const authClient = resolveAuthClient(deps);

	const isValid = await crypto.validateSecretKey(secretKey);
	if (!isValid) {
		throw new Error("Invalid Secret Key format");
	}

	const clientEphemeral = await crypto.generateClientEphemeral();

	const { data: startResult } = await authClient.auth.startLogin({
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
		deps.storage,
	);

	const { srpPassword, masterUnlockKey } = await vaultCrypto.deriveAccountKeys({
		accountPassword: password,
		secretKey,
		email,
		profile: validatedProfile,
		accountId: matchingAccount?.accountId,
	});

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

		const { data: finishResult } = await authClient.auth.finishLogin(
			startResult.attemptId,
			{
				clientPublicKey: clientEphemeral.publicKey,
				clientProof: clientSession.proof,
			},
		);

		await crypto.verifyServerSession(
			clientEphemeral.publicKey,
			clientSession,
			finishResult.serverProof,
		);

		const authenticatedClient = deps.createAuthenticatedClient
			? deps.createAuthenticatedClient(finishResult.token, serverUrl)
			: (createAccountApiClient(
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
			kdfParams: validatedProfile,
			serverUrl,
		};
	} catch (error) {
		await crypto.destroyKey(masterUnlockKey);
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
		resolveTravelModeApiClientForToken(result.token, serverUrl, options),
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

	// `storeSessionData` borrows the ref; ownership transfers only after every other
	// fallible local write succeeds.
	await storage.storeSessionData(
		result.masterUnlockKey,
		accountId,
		resolvedEmail,
		result.user.id,
		result.expiresAt,
		result.sessionId,
	);
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
	await storage.setMasterUnlockKey(result.masterUnlockKey, accountId);
	options?.onMasterUnlockKeyTransferred?.();

	try {
		await peekAccountSessionManager()?.refresh();
	} catch (error) {
		console.error("[auth-service] session manager refresh failed:", error);
	}
	return accountId;
}

/**
 * Stores a login while taking responsibility for the caller-owned MUK immediately.
 * Before the store accepts it, a failure destroys it. Ownership transfer is the final
 * state-changing step, so a successful transfer is never reported as a failed login.
 */
export async function storeLoginSessionOwned(
	result: LoginResult,
	secretKey: string,
	storage: AccountStore,
	itemCache: ItemCache,
	crypto: CryptoPort,
	email?: string,
	options?: StoreAuthSessionOptions,
): Promise<string> {
	let owner: "caller" | "storage" = "caller";
	try {
		return await storeLoginSession(
			result,
			secretKey,
			storage,
			itemCache,
			email,
			{
				...options,
				onMasterUnlockKeyTransferred: () => {
					owner = "storage";
					try {
						options?.onMasterUnlockKeyTransferred?.();
					} catch (error) {
						console.error("[auth-service] transfer observer failed:", error);
					}
				},
			},
		);
	} catch (error) {
		if (owner === "caller") {
			await crypto.destroyKey(result.masterUnlockKey);
		}
		throw error;
	}
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

/** Proves the password to the server without unlocking, so the derived MUK is discarded. */
async function deriveSrpPasswordForAccount(
	accountId: string,
	email: string,
	password: string,
	crypto: CryptoPort,
	vaultCrypto: VaultCrypto,
	storage: AccountStore,
	profile: KdfProfile,
): Promise<string> {
	const storedSecretKey = await storage.getStoredSecretKey(accountId);
	if (!storedSecretKey) {
		throw new Error(m.auth_error_no_stored_secret_key());
	}

	const { srpPassword, masterUnlockKey } = await vaultCrypto.deriveAccountKeys({
		accountPassword: password,
		secretKey: storedSecretKey,
		email,
		profile,
		accountId,
	});
	await crypto.destroyKey(masterUnlockKey);
	return srpPassword;
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
	const vaultCrypto = createVaultCrypto({ crypto, storage });
	const { email } = await resolveUnlockAccount(accountId, storage);
	const authClient = await resolveAccountAuthClient(accountId, deps);
	const clientEphemeral = await crypto.generateClientEphemeral();
	const { data: startResult } = await authClient.auth.startLogin({
		email,
		clientPublicKey: clientEphemeral.publicKey,
	});
	// Validate the server login params against local policy + pin BEFORE running
	// the account KDF, then derive with the negotiated params so an account keyed
	// at an older iteration count still authenticates (issue #32).
	const validatedProfile = await validateKdfProfileForAccount(
		accountId,
		startResult.kdfParams,
		storage,
	);
	const srpPassword = await deriveSrpPasswordForAccount(
		accountId,
		email,
		password,
		crypto,
		vaultCrypto,
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
	const vaultCrypto = createVaultCrypto({ crypto, storage });
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

	const { srpPassword, masterUnlockKey } = await vaultCrypto.deriveAccountKeys({
		accountPassword: password,
		secretKey: storedSecretKey,
		email,
		profile: pinnedKdfProfile,
		accountId,
	});

	try {
		await validateDerivedUnlockKey({
			vaultCrypto,
			storage,
			accountId,
			masterUnlockKey,
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
			};
		}

		const clientEphemeral = await crypto.generateClientEphemeral();

		const { data: startResult } = await authClient.auth.startLogin({
			email,
			clientPublicKey: clientEphemeral.publicKey,
		});

		const validatedProfile = await validateKdfProfileForAccount(
			accountId,
			startResult.kdfParams,
			storage,
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

		const { data: finishResult } = await authClient.auth.finishLogin(
			startResult.attemptId,
			{
				clientPublicKey: clientEphemeral.publicKey,
				clientProof: clientSession.proof,
			},
		);

		const serverUrl =
			(await deps.storage.getServerUrl(accountId)) ?? getDefaultServerUrl();
		await crypto.verifyServerSession(
			clientEphemeral.publicKey,
			clientSession,
			finishResult.serverProof,
		);

		const authenticatedClient = deps.createAuthenticatedClient
			? deps.createAuthenticatedClient(finishResult.token, serverUrl)
			: (createAccountApiClient(
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
			kdfParams: validatedProfile,
		};
	} catch (error) {
		await crypto.destroyKey(masterUnlockKey);
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
		options?.travelModeApiClient,
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

		// Borrowed by `storeSessionData`; ownership transfers after the remaining writes.
		await storage.storeSessionData(
			result.masterUnlockKey,
			accountId,
			resolvedEmail,
			result.user.id,
			result.expiresAt,
			result.sessionId,
		);
	}

	if (options?.setActive ?? true) {
		const currentActive = await storage.getActiveAccount();
		if (currentActive !== accountId) {
			await storage.setActiveAccount(accountId);
		}
	}

	// `addAccount` replaces the record wholesale, so spread the stored one to keep the
	// fields an unlock never sees — `lastActiveAt` among them, which `setActiveAccount`
	// owns because an unlock-all runs this for every account.
	const storedAccount = await storage.getAccountMetadata(accountId);
	if (storedAccount) {
		await storage.addAccount({
			...storedAccount,
			// Keys the account de-dupe, and a `local` unlock only knows the session's copy.
			userId: storedAccount.userId || result.user.id,
			name: result.user.name || storedAccount.name,
			// Absent means "not reported" as often as "no team": the metadata sync corrects
			// a stale name, nothing recovers a blanked one.
			teamName: result.user.teamName ?? storedAccount.teamName,
			teamAvatarUrl: result.user.teamAvatarUrl ?? storedAccount.teamAvatarUrl,
		});
	}

	await storage.updateLastMasterPasswordEntry(accountId);
	await storage.setMasterUnlockKey(result.masterUnlockKey, accountId);
	options?.onMasterUnlockKeyTransferred?.();
}

/** Stores an unlock while retaining responsibility for its MUK until the store accepts it. */
export async function storeUnlockSessionOwned(
	result: UnlockResult,
	storage: AccountStore,
	itemCache: ItemCache,
	crypto: CryptoPort,
	accountId: string,
	options?: StoreAuthSessionOptions,
): Promise<void> {
	let owner: "caller" | "storage" = "caller";
	try {
		await storeUnlockSession(result, storage, itemCache, accountId, {
			...options,
			onMasterUnlockKeyTransferred: () => {
				owner = "storage";
				try {
					options?.onMasterUnlockKeyTransferred?.();
				} catch (error) {
					console.error("[auth-service] transfer observer failed:", error);
				}
			},
		});
	} catch (error) {
		if (owner === "caller") {
			await crypto.destroyKey(result.masterUnlockKey);
		}
		throw error;
	}
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
	return (await authClient.auth.checkEmail({ email })).data;
}
