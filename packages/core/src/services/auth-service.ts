/**
 * Auth service utilities for SRP login/unlock flows.
 * These functions are framework-agnostic and can be used in React apps,
 * extensions, or any other runtime.
 */

import type {
	ApiClient,
	FinishLoginResponse,
	LoginAttempt,
} from "@bittery/api-contract";
import type {
	CryptoPort,
	EncryptedData,
	KdfProfile,
	KeyRef,
} from "@bittery/crypto-port";
import { m } from "@bittery/i18n/paraglide/messages";
import {
	createAccountApiClient,
	getDefaultServerUrl,
} from "@bittery/shared/api-client-factory";
import { validateKdfProfileOrThrow } from "@bittery/shared/kdf-policy";
import {
	type ServerAuthVaultKeyEntry,
	toAuthVaultKeyEntry,
} from "@bittery/shared/vault-mapping";
import type { AccountStore, ItemCache, VaultKeyData } from "@bittery/storage";
import {
	findAccountById,
	findAccountByServerEmail,
	normalizeAccountServerUrl,
	resolveOrCreateAccountId,
} from "@bittery/storage/account-id";
import {
	createStoredAccountApiClient,
	createStoredAccountUnlockApiClient,
} from "./api-client";
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
	insecureTransportConfirmed?: boolean;
	/**
	 * Whether this session should claim the active account. Defaults to `true`;
	 * multi-account loops pass `false` so the last account unlocked cannot
	 * overwrite the account the user was last using.
	 */
	setActive?: boolean;
	/** Called at the exact point `AccountStore` takes ownership of the login MUK. */
	onMasterUnlockKeyTransferred?: () => void;
	/** Reconciles an explicitly owned account runtime after direct storage writes. */
	onSessionStored?: () => void | Promise<void>;
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
	return createAccountApiClient(token, serverUrl, undefined, undefined, {
		insecureTransportConfirmed: options?.insecureTransportConfirmed === true,
	}) as unknown as TravelModeApiClient;
}

/**
 * Input for SRP login (full login with password + secret key)
 */
export interface SRPLoginInput {
	email: string;
	password: string;
	secretKey: string;
	serverUrl: string;
	insecureTransportConfirmed?: boolean;
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
	token: string;
	sessionId?: string;
	expiresAt?: string | Date;
	user: LoginUserData;
	vaultKeys: VaultKeyData[];
	/** Ownership transfers to the store on `storeUnlockSessionOwned`, as with {@link LoginResult}. */
	masterUnlockKey: KeyRef;
	kdfParams: KdfProfile;
}

/**
 * Session state information
 */
export interface SessionState {
	/** Stable ID of the selected account. */
	accountId: string | null;
	/** Whether the session is valid (not expired) */
	isValid: boolean;
	/** Whether Device-bound inputs can start password-only online reauthentication. */
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

/** The React-free auth surface needed by login and unlock ceremonies. */
type AuthClientMethods = Pick<
	ApiClient["auth"],
	"checkEmail" | "startLogin" | "finishLogin" | "drainVaultKeys"
>;

type ApiResponse<T> = { data: T };

export interface IAuthClient {
	auth: {
		checkEmail(
			input: Parameters<AuthClientMethods["checkEmail"]>[0],
		): Promise<ApiResponse<CheckEmailResult>>;
		startLogin(
			input: Parameters<AuthClientMethods["startLogin"]>[0],
		): Promise<ApiResponse<LoginAttempt>>;
		finishLogin(
			attemptId: Parameters<AuthClientMethods["finishLogin"]>[0],
			input: Parameters<AuthClientMethods["finishLogin"]>[1],
		): Promise<ApiResponse<FinishLoginResponse>>;
		drainVaultKeys(
			accessToken: Parameters<AuthClientMethods["drainVaultKeys"]>[0],
			initialPage: FinishLoginResponse["vaultKeys"],
			requestOrigin: Parameters<AuthClientMethods["drainVaultKeys"]>[2],
		): Promise<ApiResponse<readonly ServerAuthVaultKeyEntry[]>>;
	};
}

/** Result from email check. */
export interface CheckEmailResult {
	exists: boolean;
	secretKeyHint?: string | null;
}

/**
 * The user as a *ceremony result* carries them, which is not what any one endpoint sends.
 * Sign-in and Quick Unlock fill it from `FinishLoginResponse["user"]`, while signup uses
 * `SignupResponse["user"]` — so `name`, `teamName` and
 * `teamAvatarUrl` are optional because a source may not report them, not because a user may
 * lack a team. Every user has one; a stored account that predates the badge simply has none
 * recorded yet, which is why the unlock path merges rather than overwrites.
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
 * The wire spells an absent team name `null`; account metadata spells it `undefined`, and
 * `storeUnlockSession` reads that difference as "not reported" so it can keep a stored badge
 * instead of blanking it. Normalize once here rather than at each write.
 */
function toLoginUserData(user: FinishLoginResponse["user"]): LoginUserData {
	return {
		id: user.id,
		email: user.email,
		name: user.name,
		teamName: user.teamName ?? undefined,
		teamAvatarUrl: user.teamAvatarUrl,
		encryptedPrivateKey: user.encryptedPrivateKey,
	};
}

type StartLoginApiClient = {
	auth: Pick<IAuthClient["auth"], "startLogin">;
};

type AuthRequestOrigin = Parameters<AuthClientMethods["drainVaultKeys"]>[2];

/**
 * Dependencies required for SRP login.
 */
export interface SRPLoginDeps {
	crypto: CryptoPort;
	apiClient: IAuthClient;
	storage: AccountStore;
}

/**
 * Dependencies required for SRP unlock.
 */
export interface SRPUnlockDeps {
	crypto: CryptoPort;
	storage: AccountStore;
	/** Internal test/adapter seam; production resolves the persisted Account's own Server. */
	accountAuthClientFactory?: (
		storage: AccountStore,
		accountId: string,
	) => Promise<IAuthClient>;
}

export interface SrpLoginProofDeps {
	crypto: CryptoPort;
	apiClient: StartLoginApiClient;
	storage: AccountStore;
}

async function resolveStartLoginApiClient(
	accountId: string,
	deps: SrpLoginProofDeps,
): Promise<StartLoginApiClient> {
	return (
		(await createStoredAccountApiClient(deps.storage, accountId)) ??
		deps.apiClient
	);
}

async function resolveAccountAuthClient(
	accountId: string,
	deps: SRPUnlockDeps,
): Promise<IAuthClient> {
	return (deps.accountAuthClientFactory ?? createStoredAccountUnlockApiClient)(
		deps.storage,
		accountId,
	);
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

async function fetchIssuedVaultKeys(
	apiClient: IAuthClient,
	accessToken: string,
	initialPage: FinishLoginResponse["vaultKeys"],
	requestOrigin: AuthRequestOrigin,
): Promise<VaultKeyData[]> {
	const { data } = await apiClient.auth.drainVaultKeys(
		accessToken,
		initialPage,
		requestOrigin,
	);
	return data.map(toAuthVaultKeyEntry);
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
	serverProfile: LoginAttempt["kdfParams"],
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
	const { apiClient } = deps;

	const isValid = await crypto.validateSecretKey(secretKey);
	if (!isValid) {
		throw new Error("Invalid Secret Key format");
	}

	const clientEphemeral = await crypto.generateClientEphemeral();

	const { data: startResult } = await apiClient.auth.startLogin({
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
			},
			srpPassword,
		);

		const { data: finishResult } = await apiClient.auth.finishLogin(
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

		const vaultKeys = await fetchIssuedVaultKeys(
			apiClient,
			finishResult.token,
			finishResult.vaultKeys,
			{
				kind: "authCeremony",
				serverUrl,
				insecureTransportConfirmed: input.insecureTransportConfirmed === true,
			},
		);

		return {
			token: finishResult.token,
			sessionId: finishResult.sessionId,
			expiresAt: finishResult.expiresAt,
			user: toLoginUserData(finishResult.user),
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
		insecureTransportConfirmed: options?.insecureTransportConfirmed === true,
	});

	await storage.setActiveAccount(accountId);
	await storage.setMasterUnlockKey(result.masterUnlockKey, accountId);
	options?.onMasterUnlockKeyTransferred?.();

	try {
		await options?.onSessionStored?.();
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
	deps: SrpLoginProofDeps,
): Promise<SrpLoginProof> {
	const { accountId, password } = input;
	const { crypto, storage } = deps;
	const vaultCrypto = createVaultCrypto({ crypto, storage });
	const { email } = await resolveUnlockAccount(accountId, storage);
	const apiClient = await resolveStartLoginApiClient(accountId, deps);
	const clientEphemeral = await crypto.generateClientEphemeral();
	const { data: startResult } = await apiClient.auth.startLogin({
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
	const apiClient = await resolveAccountAuthClient(accountId, deps);

	const storedSecretKey = await storage.getStoredSecretKey(accountId);
	if (!storedSecretKey || !(await crypto.validateSecretKey(storedSecretKey))) {
		throw new Error(m.auth_error_no_stored_secret_key());
	}
	const pinnedKdfProfile = await storage.getPinnedKdfProfile(accountId);
	if (!pinnedKdfProfile) {
		throw new Error(m.auth_error_kdf_profile_missing());
	}
	validateKdfProfileOrThrow(pinnedKdfProfile);

	const clientEphemeral = await crypto.generateClientEphemeral();
	const { data: startResult } = await apiClient.auth.startLogin({
		email,
		clientPublicKey: clientEphemeral.publicKey,
	});
	const validatedProfile = await validateKdfProfileForAccount(
		accountId,
		startResult.kdfParams,
		storage,
	);

	const { srpPassword, masterUnlockKey } = await vaultCrypto.deriveAccountKeys({
		accountPassword: password,
		secretKey: storedSecretKey,
		email,
		profile: validatedProfile,
		accountId,
	});

	try {
		await validateDerivedUnlockKey({
			vaultCrypto,
			storage,
			accountId,
			masterUnlockKey,
		});

		const clientSession = await crypto.deriveClientSession(
			clientEphemeral.secret,
			{
				salt: startResult.salt,
				serverPublicKey: startResult.serverPublicKey,
			},
			srpPassword,
		);

		const { data: finishResult } = await apiClient.auth.finishLogin(
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

		const vaultKeys = await fetchIssuedVaultKeys(
			apiClient,
			finishResult.token,
			finishResult.vaultKeys,
			{ kind: "persistedAccount", accountId, serverUrl },
		);

		return {
			token: finishResult.token,
			sessionId: finishResult.sessionId,
			expiresAt: finishResult.expiresAt,
			user: toLoginUserData(finishResult.user),
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

	// Same reason as the login path: the token below is not in storage yet, and on an
	// unlock the stored one is typically absent (the lock dropped it) or dead. Verify
	// travel mode with the token this unlock just obtained.
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

	// Borrowed by `storeSessionData`; ownership transfers after the remaining writes.
	await storage.storeSessionData(
		result.masterUnlockKey,
		accountId,
		resolvedEmail,
		result.user.id,
		result.expiresAt,
		result.sessionId,
	);

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
			// Keys the account de-dupe; keep the stored identity if the response omits it.
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
		accountId: resolvedAccountId ?? null,
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
	apiClient: Pick<IAuthClient, "auth">,
	email: string,
): Promise<CheckEmailResult> {
	return (await apiClient.auth.checkEmail({ email })).data;
}
