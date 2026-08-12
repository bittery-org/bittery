/**
 * `AccountStore` — the deep module above the platform seam.
 *
 * Everything lives here exactly once: accountId namespacing, tier routing, JSON, encryption
 * via `CryptoPort`, session expiry, the in-memory master-unlock-key cache, biometric
 * grace, master-password re-entry, the unlock-state broadcast and the native-host projection.
 *
 * Two rules make this reviewable:
 *
 *   1. **Zero optional members.** Every method on `AccountStore` is total, so the compiler
 *      verifies that an implementation satisfies the contract and callers never need `?.`
 *      guards or capability probes.
 *   2. **Exactly one read/write/delete triple touches the port** (`readValue` / `writeValue` /
 *      `deleteValue`, below). Nothing else in this file calls `port.kvGet` / `port.secretGet`
 *      / etc. That triple is the only place the tier table is consulted.
 *
 * `AccountStore` performs **no IPC and no `invoke`**. The desktop app subscribes to
 * `onUnlockStateChanged` once at startup and does its own `broadcast_unlock_event`.
 */

import type { CryptoPort, KdfProfile, KeyRef } from "@bittery/crypto-port";
import {
	arrayBufferToBase64,
	base64ToArrayBuffer,
} from "@bittery/shared/crypto";
import {
	findAccountById,
	findAccountByServerUser,
	generateAccountId,
} from "./account-id";
import { parseStoredKdfProfile } from "./kdf-profile";
import {
	ACCOUNT_VALUES,
	type AccountValueName,
	accountKey,
	type GlobalValueName,
	globalKey,
	metaCollection,
} from "./keys";
import type { BiometricPortResult, PlatformPort } from "./platform-port";
import {
	assertTiersHonoured,
	deriveScope,
	STORAGE_TIERS,
	type StorageScope,
	type StorageTier,
	type StoredValueName,
} from "./tiers";
import {
	type AccountMetadata,
	type ActiveAccountId,
	BIOMETRIC_GRACE_PERIOD_MS,
	type BiometricAuthResult,
	type BiometricErrorType,
	DEFAULT_AUTO_LOCK_TIMEOUT_MS,
	DEFAULT_SESSION_EXPIRY_MS,
	MASTER_PASSWORD_REENTRY_PERIOD_MS,
	type Platform,
	type SessionExpiryInput,
	type StoredSessionData,
	type TravelModeConfig,
	type VaultKeyData,
} from "./types";

// ============================================================================
// Native-host projection
// ============================================================================

/** Schema version of {@link NativeHostView}. Bump when the shape changes. */
export const NATIVE_VIEW_VERSION = 3 as const;

/**
 * A key plus which store it lives in, so the native host never has to know the tier table.
 * `"secret"` means the OS keychain on desktop; `"plain"` means `store.json`.
 *
 * Unrelated to `CryptoPort`'s `KeyRef`: this names a *storage* key, never key material.
 */
export interface NativeKeyRef {
	key: string;
	store: "secret" | "plain";
}

/**
 * The complete, published view the Rust native host reads.
 *
 * Rust must never re-derive the key scheme and never re-decide policy: every key it needs
 * is named here, and every value it used to default is written resolved. `biometricEnabled`
 * kills Rust's `unwrap_or(true)`; `autoLockTimeoutMs` kills its hardcoded `unwrap_or(600000)`.
 */
export interface NativeHostView {
	v: typeof NATIVE_VIEW_VERSION;
	activeAccountId: string | null;
	unlockedAccountIds: string[];
	autoLockTimeoutMs: number;
	deviceKey: NativeKeyRef;
	accounts: Array<{
		/**
		 * The displayable half of {@link AccountMetadata}, republished verbatim.
		 *
		 * The native host hands this straight to the browser extension, which stores it as
		 * an `AccountMetadata` of its own. Anything omitted here would have to be defaulted
		 * or re-derived by a consumer that has no way to know the real value, so the
		 * projection carries it rather than leaving a hole. `serverUrl` is deliberately not
		 * published: no native-host consumer reads it, and it is per-install, not per-account
		 * identity.
		 */
		accountId: string;
		email: string;
		/**
		 * Published rather than left to be dug out of the account's session document: a
		 * known-but-signed-out account has no session document, and `AccountMetadata.userId`
		 * is required, so sourcing it from the session would produce accounts with a missing
		 * id. The accounts list is the authority for the metadata a consumer stores as
		 * metadata; the session document remains the authority for the live session.
		 */
		userId: string;
		name: string;
		secretKeyHint: string;
		/** Optional in `AccountMetadata`; absent here means absent there, never `""`. */
		teamName?: string;
		teamAvatarUrl?: string | null;
		addedAt: number;
		lastActiveAt: number;
		/** Resolved, never defaulted downstream. */
		biometricEnabled: boolean;
		token: NativeKeyRef;
		sessionData: NativeKeyRef;
		vaultKeys: NativeKeyRef;
		encryptedPrivateKey: NativeKeyRef;
		/**
		 * The single ItemCache metadata record. It contains the active generation's fully
		 * resolved item and vault prefixes, so a native host follows an atomic promotion
		 * without `AccountStore` reaching across its sibling boundary into `ItemCache`.
		 */
		itemCacheState: NativeKeyRef;
	}>;
}

// ============================================================================
// Public surface
// ============================================================================

export interface AccountStoreOptions {
	port: PlatformPort;
	crypto: CryptoPort;
}

export interface AccountStore {
	readonly platform: Platform;

	initialize(): Promise<void>;

	// --- accounts ---
	getActiveAccount(): Promise<ActiveAccountId>;
	setActiveAccount(accountId: ActiveAccountId): Promise<void>;
	getActiveAccountUserId(): Promise<string | null>;
	getAccountsList(): Promise<AccountMetadata[]>;
	getAccountMetadata(accountId: string): Promise<AccountMetadata | null>;
	addAccount(metadata: AccountMetadata): Promise<void>;
	setInsecureTransportConfirmed(
		accountId: string,
		confirmed: boolean,
	): Promise<void>;
	removeAccount(accountId: string): Promise<void>;

	// --- session ---
	/** `muk` stays the caller's to destroy; the store wraps it and keeps no reference. */
	storeSessionData(
		muk: KeyRef,
		accountId: string,
		email: string,
		userId: string,
		expiresAt?: SessionExpiryInput,
		sessionId?: string,
	): Promise<void>;
	getStoredSessionData(accountId?: string): Promise<StoredSessionData | null>;
	updateStoredSessionMetadata(
		accountId: string,
		metadata: { sessionId?: string; expiresAt: SessionExpiryInput },
	): Promise<void>;
	isSessionValid(accountId?: string): Promise<boolean>;
	tryRestoreSession(
		skipBiometric?: boolean,
		accountId?: string,
	): Promise<boolean>;
	/**
	 * Restore the session only where that needs no user interaction: inside the biometric
	 * grace period, or on an account with biometric unlock off. `false` means the account
	 * is still locked and an unlock flow — with its prompt or its password field — has to
	 * run. This is what an app boot calls; nothing else may unlock on a read.
	 */
	tryRestoreSessionWithoutPrompt(accountId?: string): Promise<boolean>;
	isAuthenticated(accountId?: string): Promise<boolean>;
	canQuickUnlock(accountId?: string): Promise<boolean>;
	/**
	 * Lock. Drops the session-bound secrets (`jwt_token`, `vault_keys`,
	 * `encrypted_private_key`) and the in-memory MUK, but **keeps `session_data`** so
	 * quick-unlock still works.
	 */
	clearSession(accountId?: string): Promise<void>;
	/**
	 * Sign out of this account. Everything `clearSession` does, plus deleting
	 * `session_data` — quick-unlock is gone and the master password is required.
	 */
	forgetSession(accountId?: string): Promise<void>;
	clearAllStoredData(accountId?: string): Promise<void>;

	// --- master unlock key ---
	/**
	 * The cached key, or `null` on a locked account. A read never unlocks and never
	 * prompts — `null` is the answer to "is this account unlocked?", and restoring is
	 * `tryRestoreSession`/`tryRestoreSessionWithoutPrompt`/`unlockWithBiometric`.
	 *
	 * The store owns the returned ref for as long as the account stays unlocked, so a caller
	 * must never destroy it — `clearMasterUnlockKey`, `clearSession`, `lockAllAccounts` and
	 * `removeAccount` are what end its life, and every one of them destroys it for real.
	 */
	getMasterUnlockKey(accountId?: string): Promise<KeyRef | null>;
	/** Hands the store ownership of `key`: it is destroyed when the account locks. */
	setMasterUnlockKey(key: KeyRef, accountId?: string): Promise<void>;
	clearMasterUnlockKey(accountId?: string): Promise<void>;
	/**
	 * Unwrap the stored MUK **without** unlocking the account. The fresh ref belongs to the
	 * caller, who must destroy it; this is the one MUK getter that does not hand back the
	 * store's own cached key.
	 *
	 * `reason` is the already-translated prompt shown by the OS if this call has to fall
	 * through to a biometric prompt. See {@link AccountStore.unlockAllAccountsWithBiometric}
	 * for why every prompting method takes one.
	 */
	decryptStoredMasterUnlockKey(
		accountId?: string,
		skipBiometric?: boolean,
		reason?: string,
	): Promise<KeyRef | null>;
	lockAllAccounts(): Promise<void>;
	getUnlockedAccounts(): Promise<string[]>;
	/** Fires on every change to the unlocked-account set. Returns an unsubscribe fn. */
	onUnlockStateChanged(
		listener: (unlockedAccountIds: string[]) => void,
	): () => void;

	// --- per-account secrets ---
	storeSecretKey(key: string, accountId?: string): Promise<void>;
	getStoredSecretKey(accountId?: string): Promise<string | null>;
	hasStoredSecretKey(accountId?: string): Promise<boolean>;
	storeAuthToken(token: string, accountId?: string): Promise<void>;
	getAuthToken(accountId?: string): Promise<string | null>;
	storeVaultKeys(keys: VaultKeyData[], accountId?: string): Promise<void>;
	getVaultKeys(accountId?: string): Promise<VaultKeyData[] | null>;
	storeEncryptedPrivateKey(key: string, accountId?: string): Promise<void>;
	getEncryptedPrivateKey(accountId?: string): Promise<string | null>;
	storePinnedKdfProfile(profile: KdfProfile, accountId: string): Promise<void>;
	getPinnedKdfProfile(accountId: string): Promise<KdfProfile | null>;

	// --- settings ---
	storeAutoLockTimeout(ms: number, accountId?: string): Promise<void>;
	getAutoLockTimeout(accountId?: string): Promise<number | null>;
	getAutoLockTimeoutOrDefault(accountId?: string): Promise<number>;
	storeServerUrl(url: string, accountId?: string): Promise<void>;
	getServerUrl(accountId?: string): Promise<string | null>;
	storeMasterPasswordReentryPeriodMs(periodMs: number): Promise<void>;
	getMasterPasswordReentryPeriodMs(): Promise<number>;
	isMasterPasswordReentryRequired(accountId?: string): Promise<boolean>;
	updateLastMasterPasswordEntry(accountId?: string): Promise<void>;
	storeTravelModeCache(
		config: TravelModeConfig,
		accountId?: string,
	): Promise<void>;
	getTravelModeCache(accountId?: string): Promise<TravelModeConfig | null>;

	// --- background timestamp (mobile autolock reads these; total on all platforms) ---
	storeBackgroundTimestamp(accountId?: string): Promise<void>;
	getBackgroundTimestamp(accountId?: string): Promise<number | null>;
	clearBackgroundTimestamp(accountId?: string): Promise<void>;

	// --- biometric (total: real on desktop/mobile, honest no-ops elsewhere) ---
	isBiometricAvailable(): Promise<boolean>;
	getBiometricAvailabilityDetails(): Promise<{
		hasHardware: boolean;
		isEnrolled: boolean;
	}>;
	getBiometricType(): Promise<string | null>;
	isBiometricEnabled(accountId?: string): Promise<boolean>;
	setBiometricEnabled(accountId: string, enabled: boolean): Promise<void>;
	enableBiometric(accountId?: string): Promise<void>;
	disableBiometric(accountId?: string): Promise<void>;
	authenticateWithBiometric(
		reason?: string,
		accountId?: string,
	): Promise<boolean>;
	authenticateWithBiometricEnhanced(
		reason?: string,
		accountId?: string,
	): Promise<BiometricAuthResult>;
	/** A pure probe — it never shows an OS prompt, so it needs no `reason`. */
	canBiometricUnlock(accountId?: string): Promise<boolean>;
	unlockWithBiometric(accountId?: string, reason?: string): Promise<boolean>;
	/**
	 * `reason` is the prompt the OS shows, so it is user-facing copy and the caller must
	 * supply it already translated — `CLAUDE.md` forbids this package from authoring any.
	 * The English defaults on this and the other prompting methods are a last-resort
	 * fallback for a caller that has no translation available, never the intended path.
	 */
	unlockAllAccountsWithBiometric(reason?: string): Promise<{
		unlocked: string[];
		failed: Array<{ accountId: string; error: string }>;
	}>;
}

// ============================================================================
// Internal helpers that need no closure state
// ============================================================================

interface AccountsListDocument {
	version?: number;
	accounts: AccountMetadata[];
}

const ACCOUNTS_LIST_VERSION = 2;

/**
 * The single session-expiry rule, moved out of `session.ts` so it lives with the only
 * module that applies it. `SessionExpiryInput` itself lives in `types.ts`, with the rest
 * of the vocabulary.
 *
 * A bare number below the year-2001 epoch boundary is a *relative* duration; anything larger
 * is an absolute timestamp. Unparseable or absent input falls back to the 14-day default.
 */
function resolveStoredSessionExpiryTimestamp(
	expiresAt: SessionExpiryInput | undefined,
	createdAt: number,
): number {
	if (expiresAt === undefined) {
		return createdAt + DEFAULT_SESSION_EXPIRY_MS;
	}

	if (typeof expiresAt === "number") {
		return expiresAt > 1_000_000_000_000 ? expiresAt : createdAt + expiresAt;
	}

	const parsed =
		typeof expiresAt === "string"
			? new Date(expiresAt).getTime()
			: expiresAt.getTime();

	return Number.isFinite(parsed)
		? parsed
		: createdAt + DEFAULT_SESSION_EXPIRY_MS;
}

/**
 * Which expiry actually governs a stored session.
 *
 * Web's `serverExpiresAt`-preferred check is now the universal rule: the server's opinion
 * wins when it has one, otherwise the locally-minted device expiry applies.
 */
function effectiveSessionExpiry(session: StoredSessionData): number {
	return session.serverExpiresAt ?? session.expiresAt;
}

function parseJson<T>(raw: string | null): T | null {
	if (!raw) {
		return null;
	}
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

function parseStoredNumber(raw: string | null): number | null {
	if (raw === null) {
		return null;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Translate the port's raw outcome into the domain error the UI branches on.
 *
 * The port reports what the platform said; naming the *consequence* is policy, so it happens
 * here. `user_cancelled` and `lockout` survive the trip — collapsing them into
 * `authentication_failed` is the regression this mapping exists to prevent.
 */
function toBiometricAuthResult(
	result: BiometricPortResult,
): BiometricAuthResult {
	const fallbackMessages: Record<
		NonNullable<BiometricPortResult["error"]>,
		{ error: BiometricErrorType; message: string }
	> = {
		user_cancelled: {
			error: "user_cancelled",
			message: "Authentication was cancelled",
		},
		lockout: {
			error: "lockout",
			message: "Too many failed attempts. Please use your password to unlock",
		},
		not_enrolled: {
			error: "not_enrolled",
			message:
				"No biometrics enrolled. Please set up Face ID or Touch ID in your device settings",
		},
		not_available: {
			error: "not_available",
			message: "Biometric authentication not available",
		},
		failed: {
			error: "authentication_failed",
			message: "Biometric authentication failed. Please try again",
		},
	};

	const mapped = fallbackMessages[result.error ?? "failed"];
	return {
		success: false,
		error: mapped.error,
		message: result.message ?? mapped.message,
	};
}

// ============================================================================
// Factory
// ============================================================================

export function createAccountStore(options: AccountStoreOptions): AccountStore {
	const { port } = options;
	const cryptoPort = options.crypto;

	/**
	 * The in-memory master-unlock-key cache. **Never persisted on any platform** — that is
	 * why `STORAGE_TIERS` has no row for it. Entries are opaque `KeyRef`s: the key material
	 * itself stays behind the crypto port, so this map holds nothing readable and the store
	 * owns each ref's lifetime.
	 */
	const mukCache = new Map<string, KeyRef>();

	const unlockListeners = new Set<(unlockedAccountIds: string[]) => void>();

	let deviceKeyCache: KeyRef | null = null;
	let deviceKeyPromise: Promise<KeyRef> | null = null;

	// ------------------------------------------------------------------
	// THE routing triple — the only code in this package that touches the port
	// ------------------------------------------------------------------

	/**
	 * The one place `STORAGE_TIERS` is consulted.
	 *
	 * `deriveScope` turns the universal `class` into the single platform-dependent decision.
	 * `secretGet/secretSet/secretDelete` take no scope argument, and that is correct: a
	 * platform with a real keychain is exactly a platform whose session survives restart.
	 */
	function route(name: StoredValueName): {
		scope: StorageScope;
		tier: StorageTier;
	} {
		const entry = STORAGE_TIERS[name];
		return {
			scope: deriveScope(entry.class, port.sessionSurvivesRestart),
			tier: entry.tier,
		};
	}

	async function readValue(
		name: StoredValueName,
		key: string,
	): Promise<string | null> {
		const { scope, tier } = route(name);

		if (scope === "session") {
			// Ephemeral store. Only ever reached on web and the extension, where
			// sessionStorage / chrome.storage.session are strictly no weaker at rest than
			// localStorage / chrome.storage.local — those platforms have no secret store, so
			// routing a secret-tier value here costs nothing and buys the dies-with-the-session
			// property the tier table promises.
			return port.kvGet(key, "session");
		}
		if (tier === "secret") {
			// Desktop and mobile only, in practice: their sessions survive restart, so a
			// session-bound value derives scope "device" and lands in the real keychain.
			return port.secretGet(key);
		}
		return port.kvGet(key, "device");
	}

	async function writeValue(
		name: StoredValueName,
		key: string,
		value: string,
	): Promise<void> {
		const { scope, tier } = route(name);

		if (scope === "session") {
			return port.kvSet(key, value, "session");
		}
		if (tier === "secret") {
			return port.secretSet(key, value);
		}
		return port.kvSet(key, value, "device");
	}

	async function deleteValue(
		name: StoredValueName,
		key: string,
	): Promise<void> {
		const { scope, tier } = route(name);

		if (scope === "session") {
			return port.kvDelete(key, "session");
		}
		if (tier === "secret") {
			return port.secretDelete(key);
		}
		return port.kvDelete(key, "device");
	}

	/**
	 * Where the native host will find a value. Mirrors `route` exactly — it must, because
	 * Rust opens the key we publish and never decides which store to look in.
	 */
	function keyRefFor(name: StoredValueName, key: string): NativeKeyRef {
		const { scope, tier } = route(name);
		return {
			key,
			store: scope === "device" && tier === "secret" ? "secret" : "plain",
		};
	}

	/**
	 * Where the native host will find a collection's records.
	 *
	 * The port owns the prefix (`"record:"` on desktop, `""` everywhere else) and `keys.ts`
	 * owns the collection name; concatenating them here is the only place the two meet, so
	 * Rust never rebuilds either half.
	 */
	function recordKeyFor(collection: string, id: string): string {
		return `${port.recordKeyPrefix}${collection}:${id}`;
	}

	// ------------------------------------------------------------------
	// Key-scheme convenience wrappers (still only reach the port via the triple)
	// ------------------------------------------------------------------

	const readGlobal = (name: GlobalValueName): Promise<string | null> =>
		readValue(name, globalKey(name));
	const writeGlobal = (name: GlobalValueName, value: string): Promise<void> =>
		writeValue(name, globalKey(name), value);
	const deleteGlobal = (name: GlobalValueName): Promise<void> =>
		deleteValue(name, globalKey(name));

	const readAccount = (
		name: AccountValueName,
		accountId: string,
	): Promise<string | null> => readValue(name, accountKey(accountId, name));
	const writeAccount = (
		name: AccountValueName,
		accountId: string,
		value: string,
	): Promise<void> => writeValue(name, accountKey(accountId, name), value);
	const deleteAccount = (
		name: AccountValueName,
		accountId: string,
	): Promise<void> => deleteValue(name, accountKey(accountId, name));

	// ------------------------------------------------------------------
	// accountId resolution
	// ------------------------------------------------------------------

	async function resolveAccountId(accountId?: string): Promise<string | null> {
		if (accountId) {
			return accountId;
		}
		return await getActiveAccount();
	}

	/** For operations that cannot proceed without an account. */
	async function requireAccountId(accountId?: string): Promise<string> {
		const resolved = await resolveAccountId(accountId);
		if (!resolved) {
			throw new Error("No account specified");
		}
		return resolved;
	}

	// ------------------------------------------------------------------
	// Device key — global, secret-tier, generated on first use
	// ------------------------------------------------------------------

	/**
	 * The device key is the one key this package persists in the clear, because nothing on
	 * the device can wrap it — which is why `CryptoPort.exportKey` exists at all. It crosses
	 * that boundary exactly once per device, when it is first minted; from then on it is
	 * imported straight back behind a `KeyRef` and its bytes never reappear in JS.
	 */
	async function loadDeviceKey(): Promise<KeyRef> {
		const stored = await readGlobal("device_key");
		if (stored) {
			return cryptoPort.importKey(base64ToArrayBuffer(stored));
		}
		const generated = await cryptoPort.generateEncryptionKey();
		let exported: Uint8Array | undefined;
		try {
			exported = await cryptoPort.exportKey(generated);
			await writeGlobal("device_key", arrayBufferToBase64(exported));
			return generated;
		} catch (error) {
			await destroyKey(generated);
			throw error;
		} finally {
			exported?.fill(0);
		}
	}

	async function getDeviceKey(): Promise<KeyRef> {
		if (deviceKeyCache) {
			return deviceKeyCache;
		}
		if (deviceKeyPromise) {
			return deviceKeyPromise;
		}
		deviceKeyPromise = loadDeviceKey();
		try {
			deviceKeyCache = await deviceKeyPromise;
			return deviceKeyCache;
		} finally {
			deviceKeyPromise = null;
		}
	}

	// ------------------------------------------------------------------
	// Native-host projection + unlock broadcast
	// ------------------------------------------------------------------

	/**
	 * Rewrite the published projection.
	 *
	 * Called from every mutation of the five things Rust reads: accounts list, active
	 * account, biometric-enabled, the unlocked set and the auto-lock timeout. It is one
	 * function rather than five hand-written call sites precisely so those cannot drift.
	 */
	async function refreshNativeView(
		unlockedAccountIds: string[] = [...mukCache.keys()],
	): Promise<void> {
		const accounts = await readAccountsList();
		const active = await getActiveAccount();
		const autoLockTimeoutMs = await getAutoLockTimeoutOrDefault(
			active ?? undefined,
		);

		const projected: NativeHostView["accounts"] = [];
		for (const account of accounts) {
			projected.push({
				accountId: account.accountId,
				email: account.email,
				userId: account.userId,
				name: account.name,
				secretKeyHint: account.secretKeyHint,
				// Optional in AccountMetadata and optional here. `JSON.stringify` drops an
				// `undefined` value, so an absent field stays absent through the projection
				// instead of being flattened into `null` or `""`.
				teamName: account.teamName,
				teamAvatarUrl: account.teamAvatarUrl,
				addedAt: account.addedAt,
				lastActiveAt: account.lastActiveAt,
				biometricEnabled: await isBiometricEnabled(account.accountId),
				token: keyRefFor(
					"jwt_token",
					accountKey(account.accountId, "jwt_token"),
				),
				sessionData: keyRefFor(
					"session_data",
					accountKey(account.accountId, "session_data"),
				),
				vaultKeys: keyRefFor(
					"vault_keys",
					accountKey(account.accountId, "vault_keys"),
				),
				encryptedPrivateKey: keyRefFor(
					"encrypted_private_key",
					accountKey(account.accountId, "encrypted_private_key"),
				),
				itemCacheState: {
					key: recordKeyFor(metaCollection(account.accountId), "meta"),
					store: "plain",
				},
			});
		}

		const view: NativeHostView = {
			v: NATIVE_VIEW_VERSION,
			activeAccountId: active,
			unlockedAccountIds,
			autoLockTimeoutMs,
			deviceKey: keyRefFor("device_key", globalKey("device_key")),
			accounts: projected,
		};

		await writeGlobal("native_view", JSON.stringify(view));
	}

	/** Listener errors must never break the operation that triggered the notification. */
	function notifyUnlockListeners(): void {
		const unlocked = [...mukCache.keys()];
		for (const listener of unlockListeners) {
			try {
				listener([...unlocked]);
			} catch (error) {
				console.error("[account-store] unlock listener failed:", error);
			}
		}
	}

	/** Zeroizing a key must never be able to break the lock that requested it. */
	async function destroyKey(key: KeyRef | undefined): Promise<void> {
		if (!key) {
			return;
		}
		try {
			await cryptoPort.destroyKey(key);
		} catch (error) {
			console.error("[account-store] failed to destroy key:", error);
		}
	}

	/**
	 * The single mutation point for the unlocked set: projection -> cache -> listeners.
	 * No IPC happens here; the desktop app owns `broadcast_unlock_event`.
	 */
	async function setUnlockEntry(
		accountId: string,
		entry: KeyRef | null,
	): Promise<void> {
		const previous = mukCache.get(accountId);
		const nextUnlocked = new Set(mukCache.keys());
		if (entry === null) nextUnlocked.delete(accountId);
		else nextUnlocked.add(accountId);

		// Publish before taking ownership so a failed native-view write cannot leave the
		// caller's ref cached and then destroyed by its ownership wrapper.
		await refreshNativeView([...nextUnlocked]);
		// Destruction is best-effort and cannot reject, leaving no fallible work after the
		// cache accepts the incoming ref.
		if (previous !== entry) await destroyKey(previous);
		if (entry === null) mukCache.delete(accountId);
		else mukCache.set(accountId, entry);
		notifyUnlockListeners();
	}

	// ------------------------------------------------------------------
	// Accounts list
	// ------------------------------------------------------------------

	async function readAccountsList(): Promise<AccountMetadata[]> {
		const parsed = parseJson<AccountsListDocument>(
			await readGlobal("accounts_list"),
		);
		if (
			!parsed ||
			parsed.version !== ACCOUNTS_LIST_VERSION ||
			parsed.accounts.some(
				(account) =>
					!account.serverUrl ||
					typeof account.insecureTransportConfirmed !== "boolean",
			)
		) {
			return [];
		}
		return parsed.accounts;
	}

	/** Every accounts-list write goes through here so the projection stays fresh. */
	async function writeAccountsList(accounts: AccountMetadata[]): Promise<void> {
		await writeGlobal(
			"accounts_list",
			JSON.stringify({
				version: ACCOUNTS_LIST_VERSION,
				accounts,
			} satisfies AccountsListDocument),
		);
		await refreshNativeView();
	}

	/** `active_account` is stored as a plain accountId string, or absent. */
	async function getActiveAccount(): Promise<ActiveAccountId> {
		return (await readGlobal("active_account")) || null;
	}

	/** Every active-account write goes through here so the projection stays fresh. */
	async function writeActiveAccount(accountId: ActiveAccountId): Promise<void> {
		if (accountId) {
			await writeGlobal("active_account", accountId);
		} else {
			await deleteGlobal("active_account");
		}
		await refreshNativeView();
	}

	// ------------------------------------------------------------------
	// Sessions
	// ------------------------------------------------------------------

	async function getStoredSessionData(
		accountId?: string,
	): Promise<StoredSessionData | null> {
		const resolved = await resolveAccountId(accountId);
		if (!resolved) {
			return null;
		}

		const parsed = parseJson<StoredSessionData>(
			await readAccount("session_data", resolved),
		);
		if (!parsed) {
			return null;
		}

		return {
			...parsed,
			expiresAt: resolveStoredSessionExpiryTimestamp(
				parsed.expiresAt,
				parsed.createdAt,
			),
			serverExpiresAt:
				parsed.serverExpiresAt !== undefined
					? resolveStoredSessionExpiryTimestamp(
							parsed.serverExpiresAt,
							parsed.createdAt,
						)
					: undefined,
		};
	}

	async function writeSessionData(
		accountId: string,
		session: StoredSessionData,
	): Promise<void> {
		await writeAccount("session_data", accountId, JSON.stringify(session));
	}

	async function isSessionValid(accountId?: string): Promise<boolean> {
		const resolved = await resolveAccountId(accountId);
		if (!resolved) {
			return false;
		}

		const session = await getStoredSessionData(resolved);
		const token = await getAuthToken(resolved);
		if (!session || !token) {
			return false;
		}
		return Date.now() < effectiveSessionExpiry(session);
	}

	// ------------------------------------------------------------------
	// Settings
	// ------------------------------------------------------------------

	async function getAutoLockTimeout(
		accountId?: string,
	): Promise<number | null> {
		const resolved = await resolveAccountId(accountId);
		if (!resolved) {
			return null;
		}
		return parseStoredNumber(await readAccount("auto_lock_timeout", resolved));
	}

	async function getAutoLockTimeoutOrDefault(
		accountId?: string,
	): Promise<number> {
		return (
			(await getAutoLockTimeout(accountId)) ?? DEFAULT_AUTO_LOCK_TIMEOUT_MS
		);
	}

	async function getMasterPasswordReentryPeriodMs(): Promise<number> {
		return (
			parseStoredNumber(
				await readGlobal("master_password_reentry_period_ms"),
			) ?? MASTER_PASSWORD_REENTRY_PERIOD_MS
		);
	}

	async function getAuthToken(accountId?: string): Promise<string | null> {
		const resolved = await resolveAccountId(accountId);
		if (!resolved) {
			return null;
		}
		return readAccount("jwt_token", resolved);
	}

	// ------------------------------------------------------------------
	// Biometric
	// ------------------------------------------------------------------

	async function isBiometricEnabled(accountId?: string): Promise<boolean> {
		const resolved = await resolveAccountId(accountId);
		if (!resolved) {
			return false;
		}
		return (await readAccount("biometric_enabled", resolved)) === "true";
	}

	/**
	 * The single writer of biometric-enabled state.
	 *
	 * The stored `biometric_enabled` value is the authority (tauri/react-native semantics);
	 * `AccountMetadata.biometricEnabled` and `StoredSessionData.biometricEnabled` are public
	 * mirrors kept in sync here so the extension's metadata-derived reads (chrome's old
	 * `updateBiometricEnabled`) stay correct.
	 */
	async function setBiometricEnabled(
		accountId: string,
		enabled: boolean,
	): Promise<void> {
		await writeAccount(
			"biometric_enabled",
			accountId,
			enabled ? "true" : "false",
		);

		const accounts = await readAccountsList();
		const account = findAccountById(accounts, accountId);
		if (account && account.biometricEnabled !== enabled) {
			account.biometricEnabled = enabled;
			await writeAccountsList(accounts);
		}

		const session = await getStoredSessionData(accountId);
		if (session && session.biometricEnabled !== enabled) {
			await writeSessionData(accountId, {
				...session,
				biometricEnabled: enabled,
			});
		}

		await refreshNativeView();
	}

	/** `BIOMETRIC_GRACE_PERIOD_MS` against `last_biometric_auth`. One implementation. */
	async function isBiometricAuthRequired(accountId: string): Promise<boolean> {
		const session = await getStoredSessionData(accountId);
		if (!session?.biometricEnabled) {
			return false;
		}

		const lastAuth = parseStoredNumber(
			await readAccount("last_biometric_auth", accountId),
		);
		if (lastAuth === null) {
			return true;
		}
		return Date.now() - lastAuth > BIOMETRIC_GRACE_PERIOD_MS;
	}

	async function authenticateWithBiometric(
		reason = "Unlock Bittery",
		accountId?: string,
	): Promise<boolean> {
		try {
			const resolved = await resolveAccountId(accountId);
			if (!resolved) {
				return false;
			}

			const result = await port.biometric.authenticate(reason);
			if (!result.success) {
				return false;
			}

			await writeAccount(
				"last_biometric_auth",
				resolved,
				Date.now().toString(),
			);
			return true;
		} catch (error) {
			console.error("[account-store] biometric authentication failed:", error);
			return false;
		}
	}

	async function isMasterPasswordReentryRequired(
		accountId?: string,
	): Promise<boolean> {
		const resolved = await resolveAccountId(accountId);
		if (!resolved) {
			return false;
		}

		const session = await getStoredSessionData(resolved);
		if (!session) {
			return false;
		}
		// Re-entry exists to periodically re-verify the master password behind biometric
		// unlock; with biometric off there is nothing to re-verify.
		if (!session.biometricEnabled) {
			return false;
		}

		const periodMs = await getMasterPasswordReentryPeriodMs();
		if (periodMs < 0) {
			return false;
		}
		const lastEntry = session.lastMasterPasswordEntry ?? session.createdAt;
		// Inclusive: the period has elapsed the moment it is reached, so a period of 0 demands
		// re-entry on every unlock even when both reads land in the same millisecond.
		return Date.now() - lastEntry >= periodMs;
	}

	async function canBiometricUnlock(accountId?: string): Promise<boolean> {
		const available = await port.biometric.isAvailable();
		const enabled = await isBiometricEnabled(accountId);
		const sessionValid = await isSessionValid(accountId);
		return available && enabled && sessionValid;
	}

	// ------------------------------------------------------------------
	// Master unlock key
	// ------------------------------------------------------------------

	async function decryptStoredMasterUnlockKey(
		accountId?: string,
		skipBiometric = false,
		reason = "Unlock your vault",
	): Promise<KeyRef | null> {
		const resolved = await resolveAccountId(accountId);
		if (!resolved) {
			return null;
		}

		const session = await getStoredSessionData(resolved);
		if (!session) {
			return null;
		}

		if (await isMasterPasswordReentryRequired(resolved)) {
			return null;
		}

		if (!skipBiometric && session.biometricEnabled) {
			if (await isBiometricAuthRequired(resolved)) {
				const authenticated = await authenticateWithBiometric(reason, resolved);
				if (!authenticated) {
					return null;
				}
			}
		}

		try {
			const deviceKey = await getDeviceKey();
			return await cryptoPort.unwrapKey(
				session.encryptedMasterUnlockKey,
				deviceKey,
				null,
			);
		} catch (error) {
			console.error(
				"[account-store] failed to decrypt master unlock key:",
				error,
			);
			return null;
		}
	}

	async function removeAccountInternal(accountId: string): Promise<void> {
		const active = await getActiveAccount();
		if (active === accountId) {
			await writeActiveAccount(null);
		}

		for (const name of ACCOUNT_VALUES) {
			await deleteAccount(name, accountId);
		}

		const wasUnlocked = mukCache.has(accountId);
		await destroyKey(mukCache.get(accountId));
		mukCache.delete(accountId);

		const accounts = (await readAccountsList()).filter(
			(account) => account.accountId !== accountId,
		);
		await writeAccountsList(accounts);

		if (wasUnlocked) {
			notifyUnlockListeners();
		}
	}

	// ==================================================================
	// The store
	// ==================================================================

	const store: AccountStore = {
		platform: port.platform,

		async initialize(): Promise<void> {
			// Fail loudly at startup rather than silently demoting stored values.
			assertTiersHonoured(port);
			await port.initialize();
			await refreshNativeView();
		},

		// --- accounts ---

		getActiveAccount,

		async setActiveAccount(accountId: ActiveAccountId): Promise<void> {
			await writeActiveAccount(accountId);

			if (accountId) {
				const accounts = await readAccountsList();
				const metadata = findAccountById(accounts, accountId);
				if (metadata) {
					metadata.lastActiveAt = Date.now();
					await writeAccountsList(accounts);
				}
			}
		},

		async getActiveAccountUserId(): Promise<string | null> {
			const active = await getActiveAccount();
			if (!active) {
				return null;
			}
			const session = await getStoredSessionData(active);
			if (session?.userId) {
				return session.userId;
			}
			const metadata = findAccountById(await readAccountsList(), active);
			return metadata?.userId ?? null;
		},

		getAccountsList: readAccountsList,

		async getAccountMetadata(
			accountId: string,
		): Promise<AccountMetadata | null> {
			return findAccountById(await readAccountsList(), accountId) ?? null;
		},

		async addAccount(metadata: AccountMetadata): Promise<void> {
			const accounts = await readAccountsList();

			const withId: AccountMetadata = metadata.accountId
				? metadata
				: { ...metadata, accountId: generateAccountId() };

			const existingById = findAccountById(accounts, withId.accountId);
			const existingByServerUser =
				withId.serverUrl && withId.userId
					? findAccountByServerUser(accounts, withId.serverUrl, withId.userId)
					: undefined;
			const existing = existingById ?? existingByServerUser;

			const accountId = existing?.accountId ?? withId.accountId;

			// The stored `biometric_enabled` value is the authority. Seed it from the
			// supplied metadata for a brand-new account; otherwise reflect the stored value
			// back into the metadata so the two never disagree.
			const stored = await readAccount("biometric_enabled", accountId);
			const biometricEnabled =
				stored === null ? withId.biometricEnabled : stored === "true";
			if (stored === null) {
				await writeAccount(
					"biometric_enabled",
					accountId,
					biometricEnabled ? "true" : "false",
				);
			}

			const next: AccountMetadata = {
				...withId,
				accountId,
				biometricEnabled,
				insecureTransportConfirmed: withId.insecureTransportConfirmed,
			};

			if (existing) {
				const index = accounts.findIndex((a) => a.accountId === accountId);
				accounts[index] = next;
			} else {
				accounts.push(next);
			}

			await writeAccountsList(accounts);
		},

		async setInsecureTransportConfirmed(
			accountId: string,
			confirmed: boolean,
		): Promise<void> {
			const accounts = await readAccountsList();
			const index = accounts.findIndex(
				(account) => account.accountId === accountId,
			);
			if (index < 0) {
				throw new Error("Account not found");
			}
			accounts[index] = {
				...accounts[index],
				insecureTransportConfirmed: confirmed,
			} as AccountMetadata;
			await writeAccountsList(accounts);
		},

		removeAccount: removeAccountInternal,

		// --- session ---

		async storeSessionData(
			muk: KeyRef,
			accountId: string,
			email: string,
			userId: string,
			expiresAt?: SessionExpiryInput,
			sessionId?: string,
		): Promise<void> {
			const resolved = await requireAccountId(accountId);
			const deviceKey = await getDeviceKey();
			const now = Date.now();

			const encryptedMasterUnlockKey = await cryptoPort.wrapKey(muk, deviceKey);

			await writeSessionData(resolved, {
				encryptedMasterUnlockKey,
				email: email.toLowerCase(),
				userId,
				sessionId,
				// Two expiries, one rule: the device-local lifetime and the server's opinion.
				// `effectiveSessionExpiry` prefers the latter.
				expiresAt: now + DEFAULT_SESSION_EXPIRY_MS,
				serverExpiresAt: resolveStoredSessionExpiryTimestamp(expiresAt, now),
				createdAt: now,
				biometricEnabled: await isBiometricEnabled(resolved),
				lastMasterPasswordEntry: now,
			});
		},

		getStoredSessionData,

		async updateStoredSessionMetadata(
			accountId: string,
			metadata: { sessionId?: string; expiresAt: SessionExpiryInput },
		): Promise<void> {
			const existing = await getStoredSessionData(accountId);
			if (!existing) {
				return;
			}

			await writeSessionData(accountId, {
				...existing,
				sessionId: metadata.sessionId ?? existing.sessionId,
				serverExpiresAt: resolveStoredSessionExpiryTimestamp(
					metadata.expiresAt,
					existing.createdAt,
				),
			});
		},

		isSessionValid,

		async tryRestoreSession(
			skipBiometric = false,
			accountId?: string,
		): Promise<boolean> {
			const resolved = await resolveAccountId(accountId);
			if (!resolved) {
				return false;
			}
			if (!(await isSessionValid(resolved))) {
				return false;
			}
			if (mukCache.has(resolved)) {
				return true;
			}

			const muk = await decryptStoredMasterUnlockKey(resolved, skipBiometric);
			if (!muk) {
				return false;
			}
			await setUnlockEntry(resolved, muk);
			return true;
		},

		async tryRestoreSessionWithoutPrompt(accountId?: string): Promise<boolean> {
			const resolved = await resolveAccountId(accountId);
			if (!resolved) {
				return false;
			}
			if (mukCache.has(resolved)) {
				return true;
			}
			// Without this the `skipBiometric` below would walk past a due prompt and unlock
			// with no authentication at all.
			if (await isBiometricAuthRequired(resolved)) {
				return false;
			}
			return store.tryRestoreSession(true, resolved);
		},

		async isAuthenticated(accountId?: string): Promise<boolean> {
			return (await getAuthToken(accountId)) !== null;
		},

		/**
		 * Whether the password alone can unlock: the secret key is stored and the session
		 * has not expired.
		 *
		 * Deliberately not `isSessionValid` — that also demands a live auth token, and the
		 * token is session-bound, so on web it dies with the tab. A missing token is exactly
		 * the state quick unlock exists for: the password re-runs SRP and mints a new one.
		 */
		async canQuickUnlock(accountId?: string): Promise<boolean> {
			if ((await store.getStoredSecretKey(accountId)) === null) {
				return false;
			}
			const session = await getStoredSessionData(accountId);
			return session !== null && Date.now() < effectiveSessionExpiry(session);
		},

		/**
		 * Lock. `session_data` deliberately survives: it holds the MUK encrypted under the
		 * device key, which is exactly what quick-unlock needs. Use `forgetSession` to sign
		 * out.
		 */
		async clearSession(accountId?: string): Promise<void> {
			const resolved = await resolveAccountId(accountId);
			if (!resolved) {
				return;
			}

			await deleteAccount("jwt_token", resolved);
			await deleteAccount("vault_keys", resolved);
			await deleteAccount("encrypted_private_key", resolved);
			// Force a fresh biometric prompt on the next unlock.
			await deleteAccount("last_biometric_auth", resolved);

			if (mukCache.has(resolved)) {
				await setUnlockEntry(resolved, null);
			}
		},

		/** Sign out: lock, then destroy the quick-unlock material as well. */
		async forgetSession(accountId?: string): Promise<void> {
			const resolved = await resolveAccountId(accountId);
			if (!resolved) {
				return;
			}

			await store.clearSession(resolved);
			await deleteAccount("session_data", resolved);
		},

		async clearAllStoredData(accountId?: string): Promise<void> {
			const resolved = await resolveAccountId(accountId);
			if (resolved) {
				await removeAccountInternal(resolved);
			}

			// The device key unwraps every account's stored MUK, so it may only be dropped
			// once no account is left to unwrap.
			if ((await readAccountsList()).length === 0) {
				await deleteGlobal("device_key");
				await destroyKey(deviceKeyCache ?? undefined);
				deviceKeyCache = null;
				await writeActiveAccount(null);
			}
		},

		// --- master unlock key ---

		async getMasterUnlockKey(accountId?: string): Promise<KeyRef | null> {
			const resolved = await resolveAccountId(accountId);
			if (!resolved) {
				return null;
			}

			// Reading is not unlocking: a locked account reports `null` and stays locked.
			// Restoring here made every vault-key unwrap a potential unlock, so a locked
			// account with cached items raised one OS biometric prompt per item.
			return mukCache.get(resolved) ?? null;
		},

		async setMasterUnlockKey(key: KeyRef, accountId?: string): Promise<void> {
			const resolved = await requireAccountId(accountId);
			await setUnlockEntry(resolved, key);
		},

		async clearMasterUnlockKey(accountId?: string): Promise<void> {
			const resolved = await resolveAccountId(accountId);
			if (!resolved) {
				return;
			}
			await setUnlockEntry(resolved, null);
		},

		decryptStoredMasterUnlockKey,

		async lockAllAccounts(): Promise<void> {
			for (const entry of mukCache.values()) {
				await destroyKey(entry);
			}
			mukCache.clear();

			// Force fresh biometric authentication on the next unlock. JWTs are NOT deleted:
			// they authenticate to the server, they are not lock state.
			for (const account of await readAccountsList()) {
				await deleteAccount("last_biometric_auth", account.accountId);
			}

			await refreshNativeView();
			notifyUnlockListeners();
		},

		async getUnlockedAccounts(): Promise<string[]> {
			return [...mukCache.keys()];
		},

		onUnlockStateChanged(
			listener: (unlockedAccountIds: string[]) => void,
		): () => void {
			unlockListeners.add(listener);
			return () => {
				unlockListeners.delete(listener);
			};
		},

		// --- per-account secrets ---

		async storeSecretKey(key: string, accountId?: string): Promise<void> {
			await writeAccount("secret_key", await requireAccountId(accountId), key);
		},

		async getStoredSecretKey(accountId?: string): Promise<string | null> {
			const resolved = await resolveAccountId(accountId);
			return resolved ? readAccount("secret_key", resolved) : null;
		},

		async hasStoredSecretKey(accountId?: string): Promise<boolean> {
			return (await store.getStoredSecretKey(accountId)) !== null;
		},

		async storeAuthToken(token: string, accountId?: string): Promise<void> {
			await writeAccount("jwt_token", await requireAccountId(accountId), token);
		},

		getAuthToken,

		async storeVaultKeys(
			keys: VaultKeyData[],
			accountId?: string,
		): Promise<void> {
			await writeAccount(
				"vault_keys",
				await requireAccountId(accountId),
				JSON.stringify(keys),
			);
		},

		async getVaultKeys(accountId?: string): Promise<VaultKeyData[] | null> {
			const resolved = await resolveAccountId(accountId);
			if (!resolved) {
				return null;
			}
			return parseJson<VaultKeyData[]>(
				await readAccount("vault_keys", resolved),
			);
		},

		async storeEncryptedPrivateKey(
			key: string,
			accountId?: string,
		): Promise<void> {
			await writeAccount(
				"encrypted_private_key",
				await requireAccountId(accountId),
				key,
			);
		},

		async getEncryptedPrivateKey(accountId?: string): Promise<string | null> {
			const resolved = await resolveAccountId(accountId);
			return resolved ? readAccount("encrypted_private_key", resolved) : null;
		},

		async storePinnedKdfProfile(
			profile: KdfProfile,
			accountId: string,
		): Promise<void> {
			await writeAccount(
				"pinned_kdf_params",
				accountId,
				JSON.stringify(profile),
			);
		},

		async getPinnedKdfProfile(accountId: string): Promise<KdfProfile | null> {
			// The one call site of `parseStoredKdfProfile` in the package.
			return parseStoredKdfProfile(
				await readAccount("pinned_kdf_params", accountId),
			);
		},

		// --- settings ---

		async storeAutoLockTimeout(ms: number, accountId?: string): Promise<void> {
			await writeAccount(
				"auto_lock_timeout",
				await requireAccountId(accountId),
				ms.toString(),
			);
			await refreshNativeView();
		},

		getAutoLockTimeout,
		getAutoLockTimeoutOrDefault,

		async storeServerUrl(url: string, accountId?: string): Promise<void> {
			await writeAccount("server_url", await requireAccountId(accountId), url);
		},

		async getServerUrl(accountId?: string): Promise<string | null> {
			const resolved = await resolveAccountId(accountId);
			return resolved ? readAccount("server_url", resolved) : null;
		},

		async storeMasterPasswordReentryPeriodMs(periodMs: number): Promise<void> {
			await writeGlobal(
				"master_password_reentry_period_ms",
				periodMs.toString(),
			);
		},

		getMasterPasswordReentryPeriodMs,
		isMasterPasswordReentryRequired,

		async updateLastMasterPasswordEntry(accountId?: string): Promise<void> {
			const resolved = await resolveAccountId(accountId);
			if (!resolved) {
				return;
			}
			const session = await getStoredSessionData(resolved);
			if (!session) {
				return;
			}
			await writeSessionData(resolved, {
				...session,
				lastMasterPasswordEntry: Date.now(),
			});
		},

		async storeTravelModeCache(
			config: TravelModeConfig,
			accountId?: string,
		): Promise<void> {
			await writeAccount(
				"travel_mode_cache",
				await requireAccountId(accountId),
				JSON.stringify(config),
			);
		},

		async getTravelModeCache(
			accountId?: string,
		): Promise<TravelModeConfig | null> {
			const resolved = await resolveAccountId(accountId);
			if (!resolved) {
				return null;
			}
			return parseJson<TravelModeConfig>(
				await readAccount("travel_mode_cache", resolved),
			);
		},

		// --- background timestamp ---
		// These run from app-lifecycle handlers that can fire while logged out, so they
		// no-op rather than throw when there is no account (react-native's behaviour).

		async storeBackgroundTimestamp(accountId?: string): Promise<void> {
			const resolved = await resolveAccountId(accountId);
			if (!resolved) {
				return;
			}
			await writeAccount(
				"background_timestamp",
				resolved,
				Date.now().toString(),
			);
		},

		async getBackgroundTimestamp(accountId?: string): Promise<number | null> {
			const resolved = await resolveAccountId(accountId);
			if (!resolved) {
				return null;
			}
			return parseStoredNumber(
				await readAccount("background_timestamp", resolved),
			);
		},

		async clearBackgroundTimestamp(accountId?: string): Promise<void> {
			const resolved = await resolveAccountId(accountId);
			if (!resolved) {
				return;
			}
			await deleteAccount("background_timestamp", resolved);
		},

		// --- biometric ---

		async isBiometricAvailable(): Promise<boolean> {
			return port.biometric.isAvailable();
		},

		async getBiometricAvailabilityDetails(): Promise<{
			hasHardware: boolean;
			isEnrolled: boolean;
		}> {
			return port.biometric.getDetails();
		},

		async getBiometricType(): Promise<string | null> {
			return port.biometric.getType();
		},

		isBiometricEnabled,
		setBiometricEnabled,

		/**
		 * Turning biometric on is a no-op where there is no biometric hardware. It never
		 * records a flag it cannot honour. `setBiometricEnabled` bypasses the probe on
		 * purpose: it is the sync channel the extension uses to mirror the desktop app's
		 * setting.
		 */
		async enableBiometric(accountId?: string): Promise<void> {
			const resolved = await requireAccountId(accountId);
			if (!(await port.biometric.isAvailable())) {
				return;
			}
			await setBiometricEnabled(resolved, true);
		},

		/** Turning it off always works, hardware or not. */
		async disableBiometric(accountId?: string): Promise<void> {
			await setBiometricEnabled(await requireAccountId(accountId), false);
		},

		authenticateWithBiometric,

		async authenticateWithBiometricEnhanced(
			reason = "Unlock Bittery",
			accountId?: string,
		): Promise<BiometricAuthResult> {
			try {
				const resolved = await resolveAccountId(accountId);
				if (!resolved) {
					return {
						success: false,
						error: "unknown",
						message: "No account specified",
					};
				}

				const details = await port.biometric.getDetails();
				if (!details.hasHardware) {
					return {
						success: false,
						error: "not_available",
						message: "This device does not support biometric authentication",
					};
				}
				if (!details.isEnrolled) {
					return {
						success: false,
						error: "not_enrolled",
						message:
							"No biometrics enrolled. Please set up Face ID or Touch ID in your device settings",
					};
				}

				if (!(await isBiometricEnabled(resolved))) {
					return {
						success: false,
						error: "not_enabled",
						message: "Biometric authentication is not enabled for this account",
					};
				}

				if (!(await isSessionValid(resolved))) {
					return {
						success: false,
						error: "session_expired",
						message: "Your session has expired. Please log in again",
					};
				}

				if (await isMasterPasswordReentryRequired(resolved)) {
					// Structured, not formatted. Storage publishes how long the period is;
					// the UI owns the sentence, the plural rules and the translation.
					return {
						success: false,
						error: "master_password_required",
						masterPasswordReentryPeriodMs:
							await getMasterPasswordReentryPeriodMs(),
					};
				}

				const result = await port.biometric.authenticate(reason);
				if (!result.success) {
					return toBiometricAuthResult(result);
				}

				await writeAccount(
					"last_biometric_auth",
					resolved,
					Date.now().toString(),
				);
				await deleteAccount("background_timestamp", resolved);
				return { success: true };
			} catch (error) {
				console.error("[account-store] biometric authentication error:", error);
				return {
					success: false,
					error: "unknown",
					message:
						error instanceof Error ? error.message : "Unknown error occurred",
				};
			}
		},

		canBiometricUnlock,

		async unlockWithBiometric(
			accountId?: string,
			reason?: string,
		): Promise<boolean> {
			try {
				const resolved = await resolveAccountId(accountId);
				if (!resolved) {
					return false;
				}
				if (!(await canBiometricUnlock(resolved))) {
					return false;
				}

				const muk = await decryptStoredMasterUnlockKey(resolved, false, reason);
				if (!muk) {
					return false;
				}
				await setUnlockEntry(resolved, muk);
				return true;
			} catch (error) {
				console.error("[account-store] biometric unlock failed:", error);
				return false;
			}
		},

		async unlockAllAccountsWithBiometric(
			reason = "Unlock all accounts",
		): Promise<{
			unlocked: string[];
			failed: Array<{ accountId: string; error: string }>;
		}> {
			const accounts = await readAccountsList();
			const unlocked: string[] = [];
			const failed: Array<{ accountId: string; error: string }> = [];

			if (accounts.length === 0) {
				return { unlocked, failed };
			}

			let firstAccountId: string | null = null;
			for (const account of accounts) {
				if (await canBiometricUnlock(account.accountId)) {
					firstAccountId = account.accountId;
					break;
				}
			}

			if (!firstAccountId) {
				for (const account of accounts) {
					failed.push({
						accountId: account.accountId,
						error: "Biometric authentication not available",
					});
				}
				return { unlocked, failed };
			}

			// One prompt, forced: this path always shows the prompt regardless of grace.
			const authenticated = await authenticateWithBiometric(
				reason,
				firstAccountId,
			);
			if (!authenticated) {
				for (const account of accounts) {
					failed.push({
						accountId: account.accountId,
						error: "Biometric authentication failed or cancelled",
					});
				}
				return { unlocked, failed };
			}

			for (const account of accounts) {
				try {
					// skipBiometric: we just authenticated above.
					const muk = await decryptStoredMasterUnlockKey(
						account.accountId,
						true,
					);
					if (muk) {
						await setUnlockEntry(account.accountId, muk);
						unlocked.push(account.accountId);
					} else {
						failed.push({
							accountId: account.accountId,
							error: "Could not decrypt session data",
						});
					}
				} catch (error) {
					failed.push({
						accountId: account.accountId,
						error: error instanceof Error ? error.message : "Unknown error",
					});
				}
			}

			return { unlocked, failed };
		},
	};

	return store;
}
