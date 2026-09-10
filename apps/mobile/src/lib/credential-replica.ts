/**
 * The Android credential replica, as the app publishes to it.
 *
 * Autofill runs in a **separate Android process** that cannot see React, React Query
 * or the vault repository. It can only answer from the replica, so the app projects
 * what it knows into it. This module is the whole of that projection: what leaves the
 * app, how it is serialized, and when it is sent again.
 *
 * **The replica is disposable, never authoritative.** TypeScript stays the owner of
 * server sync, outbound mutations, optimistic projections, conflict handling, account
 * lifecycle, SSE and query invalidation. {@link CredentialReplica} has no read method
 * for a reason: there is no shape of this file in which native item state can flow
 * back into `VaultRepository`. Losing the replica costs autofill and nothing else.
 *
 * **One exception, and it runs the other way.** A passkey created inside the provider
 * is a real user write that the app never saw. It is queued natively and flushed to
 * the server through the *outbound sync queue* — see
 * {@link CredentialProjection.flushQueuedVaultWrites}. That is native-originated
 * outbound work, not replica authority: the write leaves through the same queue any
 * app-side edit uses, and the server's answer comes back through normal sync.
 *
 * **Identity is resolved before the seam.** Every call names an `accountId` (the local
 * account, which keys the live unlock state) and a `userId` (the server id, which keys
 * the native rows). There is no `"default"` and no placeholder.
 *
 * Extracted from `use-credential-provider-sync.ts` in Phase 5, line for line. The
 * signature functions, the guard ordering, the payload shape, the queued-write policy
 * and the log messages are unchanged: this code decides what key material reaches
 * another process, so a behaviour change here is a security change.
 */

import { getTravelModeEnforcer } from "@bittery/core/services/travel-mode-enforcer";
import type { KdfProfile } from "@bittery/crypto-port";
import { createNativeItemSyncCommand } from "@bittery/sync";
import {
	credentialProvider as CredentialProvider,
	type PendingPasskeyMutation,
	type SyncVaultDataResult,
} from "./credential-provider";
import { prepareCredentialProviderAfterUnlock } from "./credential-provider-password-unlock";
import { itemCache, storage } from "./storage";

export type { PendingPasskeyMutation };

/** Attempts a queued native write gets before the app stops trying. */
export const MAX_QUEUED_VAULT_WRITE_ATTEMPTS = 5;
/** How long a queued native write may wait for the server before it is dropped. */
export const MAX_QUEUED_VAULT_WRITE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Expo gated its logs on `__DEV__ && EXPO_PUBLIC_CREDENTIAL_SYNC_DEBUG === "true"`.
 * Vite has no `__DEV__`, and `import.meta.env.DEV` is false in the `--debug` APK, so
 * the `&&` would make these unreachable on a device. The opt-in half is what mattered.
 */
const CREDENTIAL_SYNC_DEBUG =
	import.meta.env.VITE_CREDENTIAL_SYNC_DEBUG === "true";

/**
 * The one credential-sync debug switch, for this module and the hook that drives it.
 * Off unless someone builds with the flag; it never prints a payload field.
 */
export function credentialSyncDebugLog(message: string, payload?: unknown) {
	if (!CREDENTIAL_SYNC_DEBUG) {
		return;
	}
	if (typeof payload === "undefined") {
		console.log(message);
		return;
	}
	console.log(message, payload);
}

// ---------------------------------------------------------------------------
// What one account's projection is made of
// ---------------------------------------------------------------------------

/** A local account, with both ids already resolved. */
export interface ProjectionAccount {
	/** Local account id. Keys the live unlock state. */
	accountId: string;
	/** Server user id. Keys the native rows. */
	userId: string;
	email: string;
}

/**
 * The travel-mode policy the replica may serve under.
 *
 * `verified` has no server field: it is the enforcer's own answer, and the native
 * side treats a missing or unverified policy as "serve nothing".
 */
export interface ReplicaTravelModePolicy {
	verified: boolean;
	enabled: boolean;
	hiddenVaultIds: string[];
	updatedAt: number | null;
}

/** A vault key as `AccountStore` holds it. The wrapping is unwrapped at the seam. */
export interface ReplicaVaultKeySource {
	vaultId: string;
	vaultName: string;
	vaultType: string;
	encryptedVaultKey: string;
	role: string;
}

/** A login item as `VaultRepository` holds it. Only the fields the replica needs. */
export interface ProjectionLoginItem {
	id: string;
	accountId: string;
	vaultId: string;
	category: string;
	title?: string;
	url?: string;
	urls?: readonly string[];
	username?: string;
	email?: string;
	favorite?: boolean;
	createdAt: string | number | Date;
	updatedAt: string | number | Date;
	version: number;
	lastModifiedBy?: string | null;
	encryptionVersion: number;
	encryptedByUserId: string;
	passkeys?: unknown;
	_encrypted?: { data: string; iv: string; algorithm: string } | null;
}

/**
 * Everything one account may serve, as one generation.
 *
 * The policy travels with the data it governs. The native side commits it before it
 * writes a row, so no row is ever queryable under the policy that preceded it.
 */
export interface CredentialReplicaSnapshot {
	userId: string;
	email: string;
	secretKey: string;
	kdfProfile: KdfProfile;
	vaultKeys: readonly ReplicaVaultKeySource[];
	loginItems: readonly ProjectionLoginItem[];
	travelMode: ReplicaTravelModePolicy;
}

/** What one {@link CredentialReplica.replaceAccount} did. */
export type ReplicaUpdateResult =
	| {
			status: "published";
			vaultKeys: number;
			items: number;
			domains: number;
	  }
	/** The account already serves this exact generation, so nothing was sent. */
	| { status: "unchanged" };

/**
 * The one seam between the app and the Android credential replica.
 *
 * Three methods, all of them writes. There is deliberately **no `applyDelta`**: the
 * native side has one replica input, `sync_vault_data`, and it replaces an account's
 * rows wholesale in a single transaction. A delta method here would be a promise the
 * platform cannot keep, and the first caller to use it would silently half-apply a
 * change. When a native delta path exists, this interface grows a method that means
 * something.
 */
export interface CredentialReplica {
	/**
	 * Publish everything this account may serve, replacing what it served before.
	 *
	 * Sending an identical generation twice is a no-op, and the previous one keeps
	 * serving: a rejected publish leaves the last good generation in place, and is
	 * not recorded, so the next pass sends it again.
	 */
	replaceAccount(
		accountId: string,
		snapshot: CredentialReplicaSnapshot,
	): Promise<ReplicaUpdateResult>;

	/**
	 * Forget which generation this account serves, so the next snapshot is published
	 * even if it is identical.
	 *
	 * It does not delete native rows, and it does not claim to. The bridge has no
	 * per-account purge command: an account's rows are replaced by its next snapshot,
	 * and {@link clearAll} is what removes the keys that make any of them readable.
	 */
	forgetAccount(accountId: string): Promise<void>;

	/**
	 * Drop the whole projection: every live key the other process holds, and every
	 * published generation.
	 *
	 * The rows are ciphertext, so dropping the keys is what makes them unreadable —
	 * this is the sign-out path, beside `AccountStore` and `ItemCache` dropping the
	 * app's own copies (`@bittery/core/services/account-lifecycle`).
	 */
	clearAll(): Promise<void>;
}

/** The credential-provider commands the replica writes through. */
export interface ReplicaProviderBridge {
	syncVaultData(dataJson: string): Promise<SyncVaultDataResult>;
	isAvailable(): Promise<boolean>;
	clearAllMasterUnlockKeys(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Generations
// ---------------------------------------------------------------------------

function hashString(input: string): number {
	let hash = 0;
	for (let i = 0; i < input.length; i++) {
		hash = (hash * 31 + input.charCodeAt(i)) | 0;
	}
	return hash;
}

/** A fingerprint of the login items an account can serve, order-independent. */
export function fingerprintLoginItems(
	loginItems: ReadonlyArray<{
		id: string;
		vaultId: string;
		updatedAt: string | number | Date;
		version?: number;
	}>,
): string {
	let idHash = 0;
	let vaultHash = 0;
	let updatedAtHash = 0;
	let versionSum = 0;

	for (const item of loginItems) {
		idHash ^= hashString(item.id);
		vaultHash ^= hashString(item.vaultId);
		updatedAtHash ^= hashString(String(item.updatedAt));
		versionSum += item.version ?? 1;
	}

	return `${loginItems.length}:${idHash}:${vaultHash}:${updatedAtHash}:${versionSum}`;
}

function fingerprintVaultKeys(
	vaultKeys: readonly ReplicaVaultKeySource[],
): string {
	let vaultIdHash = 0;
	let keyHash = 0;
	let roleHash = 0;

	for (const vaultKey of vaultKeys) {
		vaultIdHash ^= hashString(vaultKey.vaultId);
		keyHash ^= hashString(vaultKey.encryptedVaultKey);
		roleHash ^= hashString(vaultKey.role);
	}

	return `${vaultKeys.length}:${vaultIdHash}:${keyHash}:${roleHash}`;
}

/**
 * A policy change alone has to force a republish.
 *
 * Turning travel mode on already purges vault keys, which moves the vault-key
 * fingerprint. Turning it *off* need not move anything else, and a policy that never
 * reached the native side is a replica serving under a stale one.
 */
function fingerprintTravelMode(policy: ReplicaTravelModePolicy): string {
	const hidden = [...policy.hiddenVaultIds].sort().join(",");
	return `${policy.verified}:${policy.enabled}:${hidden}:${policy.updatedAt}`;
}

/** The whole generation, as one string. Equal fingerprints mean equal projections. */
function fingerprintSnapshot(snapshot: CredentialReplicaSnapshot): string {
	const kdf = snapshot.kdfProfile;
	return [
		fingerprintVaultKeys(snapshot.vaultKeys),
		fingerprintLoginItems(snapshot.loginItems),
		`${kdf.schemaVersion}:${kdf.algorithm}:${kdf.iterations}`,
		fingerprintTravelMode(snapshot.travelMode),
	].join("|");
}

// ---------------------------------------------------------------------------
// Serialization — the only place that knows the wire shape
// ---------------------------------------------------------------------------

interface WireItem {
	id: string;
	vaultId: string;
	userId: string;
	category: string;
	displayTitle: string;
	encryptedData: string;
	encryptionIv: string;
	encryptionAlgorithm: string;
	username: string | null;
	urls: string[];
	iconUrl: string | null;
	lastUsedAt: number;
	createdAt: number;
	updatedAt: number;
	isFavorite: boolean;
	version: number;
	lastModifiedBy: string | null;
	encryptionVersion: number;
	encryptedByUserId: string;
}

interface WireVaultKey {
	vaultId: string;
	vaultName: string;
	vaultType: string;
	encryptedKey: string;
	encryptionIv: string;
	encryptionAlgorithm: string;
	role: string;
	keyVersion: number;
}

/** The URLs autofill can match this item on, including its passkeys' relying parties. */
function itemUrls(item: ProjectionLoginItem): string[] {
	const urlSet = new Set<string>();
	const addUrl = (value: unknown) => {
		if (typeof value === "string" && value.trim().length > 0) {
			urlSet.add(value.trim());
		}
	};
	addUrl(item.url);
	if (item.urls && Array.isArray(item.urls)) {
		for (const value of item.urls) {
			addUrl(value);
		}
	}
	// A passkey-only item may carry no url/urls field. Backfill the domains from the
	// stored relying-party ids, or the item can never be offered.
	const passkeys = item.passkeys;
	if (Array.isArray(passkeys)) {
		for (const passkey of passkeys) {
			const rpId =
				typeof passkey === "object" &&
				passkey !== null &&
				"rpId" in passkey &&
				typeof (passkey as { rpId?: unknown }).rpId === "string"
					? ((passkey as { rpId: string }).rpId || "").trim()
					: "";
			if (rpId) {
				addUrl(`https://${rpId}`);
			}
		}
	}
	return Array.from(urlSet);
}

function toWireItems(snapshot: CredentialReplicaSnapshot): WireItem[] {
	return snapshot.loginItems
		.filter((item) => item._encrypted)
		.map((item) => {
			const encrypted = item._encrypted as {
				data: string;
				iv: string;
				algorithm: string;
			};

			return {
				id: item.id,
				vaultId: item.vaultId,
				userId: snapshot.userId,
				category: item.category,
				displayTitle: item.title || "",
				encryptedData: encrypted.data,
				encryptionIv: encrypted.iv,
				encryptionAlgorithm: encrypted.algorithm,
				username: item.username || item.email || null,
				urls: itemUrls(item),
				iconUrl: null,
				lastUsedAt: 0,
				createdAt: new Date(item.createdAt).getTime(),
				updatedAt: new Date(item.updatedAt).getTime(),
				isFavorite: item.favorite || false,
				version: item.version,
				lastModifiedBy: item.lastModifiedBy ?? null,
				encryptionVersion: item.encryptionVersion,
				encryptedByUserId: item.encryptedByUserId,
			};
		});
}

/**
 * Vault keys, unwrapped from however they are stored.
 *
 * A key wrapped with AAD carries the context it was bound to. It is checked against
 * the account it claims to belong to and thrown out if it disagrees — a key that
 * decrypts under the wrong context is not a key this account may serve.
 */
function toWireVaultKeys(snapshot: CredentialReplicaSnapshot): WireVaultKey[] {
	return snapshot.vaultKeys.map((vaultKey) => {
		if (!vaultKey.encryptedVaultKey.startsWith("{")) {
			return {
				vaultId: vaultKey.vaultId,
				vaultName: vaultKey.vaultName,
				vaultType: vaultKey.vaultType,
				encryptedKey: vaultKey.encryptedVaultKey,
				encryptionIv: "",
				encryptionAlgorithm: "RSA-OAEP",
				role: vaultKey.role,
				keyVersion: 1,
			};
		}

		const parsed = JSON.parse(vaultKey.encryptedVaultKey) as {
			ciphertext?: unknown;
			iv?: unknown;
			algorithm?: unknown;
			context?: {
				vaultId?: unknown;
				userId?: unknown;
				keyVersion?: unknown;
				purpose?: unknown;
			};
		};
		if (
			typeof parsed.ciphertext !== "string" ||
			typeof parsed.iv !== "string" ||
			parsed.algorithm !== "AES-GCM-AAD-V1" ||
			parsed.context?.vaultId !== vaultKey.vaultId ||
			parsed.context.userId !== snapshot.userId ||
			parsed.context.purpose !== "vault-key-wrap" ||
			typeof parsed.context.keyVersion !== "number" ||
			!Number.isInteger(parsed.context.keyVersion) ||
			parsed.context.keyVersion < 1
		) {
			throw new Error(`Invalid wrapped vault key for ${vaultKey.vaultId}`);
		}

		return {
			vaultId: vaultKey.vaultId,
			vaultName: vaultKey.vaultName,
			vaultType: vaultKey.vaultType,
			encryptedKey: parsed.ciphertext,
			encryptionIv: parsed.iv,
			encryptionAlgorithm: parsed.algorithm,
			role: vaultKey.role,
			keyVersion: parsed.context.keyVersion,
		};
	});
}

// ---------------------------------------------------------------------------
// The replica
// ---------------------------------------------------------------------------

export function createCredentialReplica(deps: {
	provider: ReplicaProviderBridge;
}): CredentialReplica {
	/** The generation each account is serving right now, by local account id. */
	const publishedByAccount = new Map<string, string>();

	return {
		async replaceAccount(accountId, snapshot) {
			const generation = fingerprintSnapshot(snapshot);
			if (publishedByAccount.get(accountId) === generation) {
				return { status: "unchanged" };
			}

			const items = toWireItems(snapshot);
			const vaultKeys = toWireVaultKeys(snapshot);
			const payload = {
				// Both ids. `accountId` keys the native live unlock state;
				// `userId` stamps the rows this call writes.
				accountId,
				userId: snapshot.userId,
				email: snapshot.email,
				secretKey: snapshot.secretKey,
				kdfProfile: snapshot.kdfProfile,
				vaultKeys,
				items,
				// The policy rides with the data it governs. The native side commits
				// it before it writes a row, so no row is ever queryable under the
				// policy that preceded it.
				travelMode: snapshot.travelMode,
			};

			// The generation is recorded *after* this resolves, never before. An absent
			// plugin rejects here rather than fabricating `{vaultKeys: 0, items: 0}`,
			// and the throw must leave this account unrecorded so the next pass retries.
			const result = await deps.provider.syncVaultData(JSON.stringify(payload));
			publishedByAccount.set(accountId, generation);

			return {
				status: "published",
				vaultKeys: result?.vaultKeys ?? vaultKeys.length,
				items: result?.items ?? items.length,
				domains: result?.domains ?? 0,
			};
		},

		async forgetAccount(accountId) {
			publishedByAccount.delete(accountId);
		},

		async clearAll() {
			// Forget first: if the purge throws, the next pass must republish rather
			// than trust a generation whose keys may already be gone.
			publishedByAccount.clear();
			// `clearAllMasterUnlockKeys` is device-wide, not per-account. The lifecycle
			// port allows dropping more than asked — never less.
			if (await deps.provider.isAvailable()) {
				await deps.provider.clearAllMasterUnlockKeys();
			}
		},
	};
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

/** What one pass wrote, across every account. */
export interface ProjectionTotals {
	vaultKeys: number;
	items: number;
	domains: number;
}

/** What one queued-write flush did with the native queue. */
export interface QueuedVaultWriteFlush {
	applied: number;
	failed: number;
	discarded: number;
}

/**
 * The native queue of provider-made writes, exactly as the bridge exposes it.
 *
 * Named for what it is: **native-originated outbound work**. A passkey created inside
 * the credential provider is a user write the app never saw, and it leaves through the
 * app's outbound sync queue like any other. Nothing here is replica authority; no item
 * state from these records is ever written into `VaultRepository`.
 */
export interface QueuedVaultWriteBridge {
	getPendingPasskeyMutations(
		userId?: string,
	): Promise<PendingPasskeyMutation[]>;
	markPendingPasskeyMutationsApplied(ids: string[]): Promise<boolean>;
	markPendingPasskeyMutationsFailed(
		ids: string[],
		error: string,
	): Promise<boolean>;
}

/** The outbound sync queue, as this module needs it. */
export interface OutboundItemSync {
	outboundQueue: {
		enqueue(
			command: ReturnType<typeof createNativeItemSyncCommand>,
		): Promise<unknown>;
	};
}

/** The account facts the projection reads that do not come from the caller. */
export interface ProjectionStore {
	getUnlockedAccounts(): Promise<string[]>;
	getVaultKeys(accountId: string): Promise<ReplicaVaultKeySource[] | null>;
	getStoredSecretKey(accountId: string): Promise<string | null>;
	getPinnedKdfProfile(accountId: string): Promise<KdfProfile | null>;
}

export interface CredentialProjectionDeps {
	replica: CredentialReplica;
	queuedWrites: QueuedVaultWriteBridge;
	store: ProjectionStore;
	travelModePolicyFor(accountId: string): ReplicaTravelModePolicy;
	prepareNativeUnlock(accountIds: readonly string[]): Promise<void>;
	/** Wait for gestures and animations to settle before heavy work. */
	waitForIdle(): Promise<void>;
	now(): number;
}

export interface ProjectionPassInput {
	accounts: readonly ProjectionAccount[];
	loginItems: readonly ProjectionLoginItem[];
	outbound: OutboundItemSync | undefined;
	/** Called only when the server accepted at least one native-originated write. */
	onQueuedWritesApplied?: () => Promise<void> | void;
}

export interface ProjectionPassResult {
	queuedWrites: QueuedVaultWriteFlush;
	projected: ProjectionTotals | null;
}

/**
 * The app's side of the replica: what to project, and when to send it again.
 *
 * It owns no React state and no timers. A hook decides *when* to ask; this decides
 * what the answer is.
 */
export interface CredentialProjection {
	/** Settle, flush native-originated writes, then republish every account. */
	runPass(input: ProjectionPassInput): Promise<ProjectionPassResult>;

	/**
	 * Run a pass, or fold this request into the one already running.
	 *
	 * One pass at a time: two overlapping passes would race to replace the same
	 * account's rows. A request that arrives mid-pass is never dropped — the pass
	 * in flight repeats when it finishes. Both callers await the same answer.
	 */
	runLatestPass(input: ProjectionPassInput): Promise<ProjectionPassResult>;

	/** Republish every account whose generation moved. `null` when nothing could run. */
	projectAccounts(input: {
		accounts: readonly ProjectionAccount[];
		loginItems: readonly ProjectionLoginItem[];
	}): Promise<ProjectionTotals | null>;

	/** Hand provider-made writes to the outbound sync queue. See the bridge type. */
	flushQueuedVaultWrites(input: {
		accounts: readonly ProjectionAccount[];
		outbound: OutboundItemSync | undefined;
	}): Promise<QueuedVaultWriteFlush>;
}

function errorMessageOf(error: unknown): string {
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.message;
	if (error && typeof error === "object") {
		const maybe = error as {
			message?: string;
			data?: { code?: string };
			shape?: { message?: string };
		};
		return (
			maybe.shape?.message ||
			maybe.message ||
			maybe.data?.code ||
			"Unknown passkey mutation flush error"
		);
	}
	return "Unknown passkey mutation flush error";
}

/** A refusal the server will repeat, so retrying it only burns attempts. */
function isNonRetriableFailure(
	mutation: PendingPasskeyMutation,
	errorMessage: string,
): boolean {
	const normalized = errorMessage.toLowerCase();
	if (
		normalized.includes("item not found") ||
		normalized.includes("access denied") ||
		normalized.includes("read-only") ||
		normalized.includes("forbidden") ||
		normalized.includes("unauthorized") ||
		normalized.includes("unsupported passkey mutation operation")
	) {
		return true;
	}

	// A local placeholder id cannot be updated remotely; once it fails, drop it.
	if (
		mutation.operation === "update_item" &&
		mutation.itemId.startsWith("local_passkey_")
	) {
		return true;
	}
	return false;
}

export function createCredentialProjection(
	deps: CredentialProjectionDeps,
): CredentialProjection {
	/** The accounts this projection has published, so a vanished one is forgotten. */
	const projectedAccountIds = new Set<string>();

	/**
	 * Mirror the live unlock keys into the other process, and name the accounts that
	 * have one.
	 *
	 * Without a live key the replica is ciphertext nobody can read. A failure to mirror
	 * is not fatal: the rows are still worth publishing, and the next unlock mirrors
	 * again. The set is read before the mirroring, so a mirroring failure does not also
	 * strand the items of an account that is unlocked.
	 */
	async function mirrorLiveKeys(): Promise<ReadonlySet<string>> {
		let unlockedAccountIds: string[] = [];
		try {
			unlockedAccountIds = await deps.store.getUnlockedAccounts();
			credentialSyncDebugLog(
				"[CredentialProviderSync] ensureNativeMukSet: unlockedAccountIds=",
				unlockedAccountIds,
			);
			if (unlockedAccountIds.length === 0) {
				console.warn(
					"[CredentialProviderSync] ensureNativeMukSet: No unlocked accounts found in RN storage!",
				);
				return new Set();
			}

			await deps.prepareNativeUnlock(unlockedAccountIds);

			credentialSyncDebugLog(
				"[CredentialProviderSync] Native MUKs set from RN storage",
			);
		} catch (err) {
			console.warn("[CredentialProviderSync] Failed to set native MUK:", err);
		}
		return new Set(unlockedAccountIds);
	}

	async function projectAccounts(input: {
		accounts: readonly ProjectionAccount[];
		loginItems: readonly ProjectionLoginItem[];
	}): Promise<ProjectionTotals | null> {
		credentialSyncDebugLog("[CredentialProviderSync] syncVaultData() called");

		try {
			const unlockedAccountIds = await mirrorLiveKeys();

			if (input.accounts.length === 0) {
				console.warn(
					"[CredentialProviderSync] No accounts available, skipping vault sync",
				);
				return null;
			}

			const totals: ProjectionTotals = { vaultKeys: 0, items: 0, domains: 0 };
			const seenAccountIds = new Set<string>();

			for (const account of input.accounts) {
				seenAccountIds.add(account.accountId);

				// A locked account has no live key, so nobody in the other process can
				// read its rows anyway. Locking also empties `VaultRepository`, and a
				// snapshot is authoritative: publishing one here would replace every row
				// the account serves with nothing. Keep the last good generation instead.
				if (!unlockedAccountIds.has(account.accountId)) {
					await deps.replica.forgetAccount(account.accountId);
					projectedAccountIds.delete(account.accountId);
					continue;
				}

				const [vaultKeys, secretKey, kdfProfile] = await Promise.all([
					deps.store.getVaultKeys(account.accountId),
					deps.store.getStoredSecretKey(account.accountId),
					deps.store.getPinnedKdfProfile(account.accountId),
				]);
				if (!vaultKeys || vaultKeys.length === 0) {
					await deps.replica.forgetAccount(account.accountId);
					projectedAccountIds.delete(account.accountId);
					continue;
				}
				if (!secretKey || !kdfProfile) {
					throw new Error(
						`Credential-provider sync requires reauthentication for account ${account.accountId}`,
					);
				}

				// Fail closed, the same way `TravelModeEnforcer.verifyOrClear` does: an
				// account whose policy nobody verified mirrors nothing. The native side
				// refuses an unverified policy too; skipping here only keeps one such
				// account from throwing past the accounts behind it in this loop.
				const travelMode = deps.travelModePolicyFor(account.accountId);
				if (!travelMode.verified) {
					console.warn(
						"[CredentialProviderSync] Skipping an account with no verified travel mode policy:",
						account.accountId,
					);
					await deps.replica.forgetAccount(account.accountId);
					projectedAccountIds.delete(account.accountId);
					continue;
				}

				// An item in a vault this account has no key for cannot be decrypted by
				// anyone, so it is not part of what the account may serve.
				const vaultIdsWithKeys = new Set(vaultKeys.map((vk) => vk.vaultId));
				const accountLoginItems = input.loginItems.filter(
					(item) =>
						item.accountId === account.accountId &&
						vaultIdsWithKeys.has(item.vaultId),
				);

				const result = await deps.replica.replaceAccount(account.accountId, {
					userId: account.userId,
					email: account.email,
					secretKey,
					kdfProfile,
					vaultKeys,
					loginItems: accountLoginItems,
					travelMode,
				});

				projectedAccountIds.add(account.accountId);
				if (result.status === "published") {
					totals.vaultKeys += result.vaultKeys;
					totals.items += result.items;
					totals.domains += result.domains;
				}
			}

			// An account that is gone must not keep a generation behind it. It comes
			// back unlocked, with a fresh replica, and has to be published again.
			for (const accountId of [...projectedAccountIds]) {
				if (!seenAccountIds.has(accountId)) {
					await deps.replica.forgetAccount(accountId);
					projectedAccountIds.delete(accountId);
				}
			}

			credentialSyncDebugLog(
				"[CredentialProviderSync] Vault sync totals:",
				totals,
			);
			return totals;
		} catch (err) {
			console.error("[CredentialProviderSync] Vault sync failed:", err);
			return null;
		}
	}

	/**
	 * Hand every queued provider-made write to the outbound sync queue.
	 *
	 * This is the *only* path that runs native → app, and it carries no item state:
	 * the queue takes an `ItemSyncCommand` with the ciphertext the provider produced
	 * and the base version it wrote against, and the server decides. The native record
	 * is dropped only after the queue accepted it.
	 */
	async function flushQueuedVaultWrites(input: {
		accounts: readonly ProjectionAccount[];
		outbound: OutboundItemSync | undefined;
	}): Promise<QueuedVaultWriteFlush> {
		if (input.accounts.length === 0) {
			return { applied: 0, failed: 0, discarded: 0 };
		}

		const pending = await deps.queuedWrites.getPendingPasskeyMutations("");
		if (!pending || pending.length === 0) {
			return { applied: 0, failed: 0, discarded: 0 };
		}

		const accountByUserId = new Map(
			input.accounts.map((account) => [account.userId, account] as const),
		);

		const appliedIds: string[] = [];
		const discardedIds: string[] = [];
		const failedByError = new Map<string, string[]>();

		const recordFailure = (mutationId: string, error: unknown) => {
			const message = errorMessageOf(error);
			const ids = failedByError.get(message) ?? [];
			ids.push(mutationId);
			failedByError.set(message, ids);
		};

		for (const mutation of pending) {
			const ageMs = deps.now() - mutation.createdAt;
			if (
				mutation.attemptCount >= MAX_QUEUED_VAULT_WRITE_ATTEMPTS ||
				ageMs > MAX_QUEUED_VAULT_WRITE_AGE_MS
			) {
				discardedIds.push(mutation.id);
				continue;
			}

			const account = accountByUserId.get(mutation.userId);
			if (!account) {
				credentialSyncDebugLog(
					"[CredentialProviderSync] Skipping passkey mutation flush (account locked or missing):",
					mutation.id,
				);
				continue;
			}

			try {
				if (!input.outbound) {
					throw new Error("Item sync engine is unavailable");
				}
				const command = createNativeItemSyncCommand(mutation, {
					accountId: account.accountId,
					accountEmail: account.email,
				});
				await input.outbound.outboundQueue.enqueue(command);
				appliedIds.push(mutation.id);
			} catch (error) {
				const message = errorMessageOf(error);
				if (isNonRetriableFailure(mutation, message)) {
					discardedIds.push(mutation.id);
					console.warn(
						"[CredentialProviderSync] Discarding non-retriable passkey mutation:",
						{
							id: mutation.id,
							operation: mutation.operation,
							itemId: mutation.itemId,
							error: message,
						},
					);
				} else {
					recordFailure(mutation.id, message);
				}
			}
		}

		const idsToDelete = [...appliedIds, ...discardedIds];
		if (idsToDelete.length > 0) {
			await deps.queuedWrites.markPendingPasskeyMutationsApplied(idsToDelete);
		}

		for (const [errorMessage, ids] of failedByError) {
			await deps.queuedWrites.markPendingPasskeyMutationsFailed(
				ids,
				errorMessage,
			);
		}

		return {
			applied: appliedIds.length,
			failed: Array.from(failedByError.values()).reduce(
				(total, ids) => total + ids.length,
				0,
			),
			discarded: discardedIds.length,
		};
	}

	async function runPass(
		input: ProjectionPassInput,
	): Promise<ProjectionPassResult> {
		// Defer heavy work until gestures and animations settle.
		await deps.waitForIdle();

		// Provider-made writes go out first, so a pull cannot overwrite one that
		// the app has not seen yet.
		const queuedWrites = await flushQueuedVaultWrites({
			accounts: input.accounts,
			outbound: input.outbound,
		});
		if (queuedWrites.applied > 0 || queuedWrites.failed > 0) {
			credentialSyncDebugLog(
				"[CredentialProviderSync] Flushed pending passkey mutations:",
				queuedWrites,
			);
		}
		if (queuedWrites.applied > 0) {
			await input.onQueuedWritesApplied?.();
		}

		credentialSyncDebugLog(
			"[CredentialProviderSync] Starting vault data sync...",
		);
		const projected = await projectAccounts({
			accounts: input.accounts,
			loginItems: input.loginItems,
		});
		if (projected) {
			credentialSyncDebugLog(
				"[CredentialProviderSync] Vault sync complete:",
				projected,
			);
		}

		return { queuedWrites, projected };
	}

	/** The pass now running, so a request that arrives mid-pass can wait on it. */
	let passInFlight: Promise<ProjectionPassResult> | null = null;
	/**
	 * The newest request that arrived while a pass ran, input and all.
	 *
	 * Its input is what the repeat runs on. Replaying the running pass's own input
	 * would republish what is already published and strand the newer items: the
	 * hook advances its items fingerprint when it schedules the request, so nothing
	 * asks again until the items change once more.
	 */
	let pendingPassInput: ProjectionPassInput | null = null;

	async function runLatestPass(
		input: ProjectionPassInput,
	): Promise<ProjectionPassResult> {
		if (passInFlight) {
			pendingPassInput = input;
			return passInFlight;
		}

		const run = (async () => {
			try {
				let next: ProjectionPassInput | null = input;
				let result: ProjectionPassResult;
				do {
					// Taken before the pass, so a request that lands during it is seen.
					pendingPassInput = null;
					result = await runPass(next);
					next = pendingPassInput;
				} while (next);
				return result;
			} finally {
				passInFlight = null;
			}
		})();
		passInFlight = run;
		return run;
	}

	return {
		projectAccounts,
		flushQueuedVaultWrites,
		runPass,
		runLatestPass,
	};
}

// ---------------------------------------------------------------------------
// The app's instances
// ---------------------------------------------------------------------------

/**
 * `InteractionManager.runAfterInteractions` has no WebView equivalent;
 * `requestIdleCallback` carries the same intent — don't start heavy work while the
 * main thread is busy — and falls back to a macrotask where it is missing.
 */
function waitForIdle(): Promise<void> {
	return new Promise<void>((resolve) => {
		if (typeof requestIdleCallback === "function") {
			requestIdleCallback(() => resolve(), { timeout: 500 });
			return;
		}
		setTimeout(resolve, 0);
	});
}

export const credentialReplica: CredentialReplica = createCredentialReplica({
	provider: CredentialProvider,
});

export const credentialProjection: CredentialProjection =
	createCredentialProjection({
		replica: credentialReplica,
		queuedWrites: CredentialProvider,
		store: storage,
		travelModePolicyFor(accountId) {
			// `TravelModeConfig` is the client reading of the generated
			// `TravelModeResponse`. Nothing is restated here — this names the three
			// facts the native side needs and adds `verified`, which is the enforcer's
			// own answer and has no server field.
			const enforcer = getTravelModeEnforcer(storage, itemCache);
			const config = enforcer.getConfig(accountId);
			return {
				verified: enforcer.isVerified(accountId),
				enabled: config.enabled,
				hiddenVaultIds: config.hiddenVaultIds,
				updatedAt: config.updatedAt ?? null,
			};
		},
		prepareNativeUnlock: prepareCredentialProviderAfterUnlock,
		waitForIdle,
		now: Date.now,
	});
