/**
 * AccountSessionManager — single source of truth for multi-account state.
 * Framework-agnostic; platform specifics injected via callbacks.
 *
 * The destructive sequences themselves live in `./account-lifecycle`, which owns
 * durable state (account records, item cache segments, the stored active
 * pointer). What stays here is the volatile half: lock state, the in-memory
 * account list, and the notifications that tell the app both changed.
 */

import type { AccountStore, ItemCache } from "@bittery/storage";
import {
	findAccountById,
	resolveActiveAccountId,
	resolveOrCreateAccountId,
} from "@bittery/storage/account-id";
import type { AccountMetadata, ActiveAccountId } from "@bittery/storage/types";
import {
	type CredentialMirror,
	type LifecycleDeps,
	type LifecycleOutcome,
	lockAccount as lifecycleLockAccount,
	lockAllAccounts as lifecycleLockAllAccounts,
	removeAccount as lifecycleRemoveAccount,
	NO_CREDENTIAL_MIRROR,
} from "./account-lifecycle";
import { createStoredAccountApiClient } from "./api-client";
import { getTravelModeEnforcer } from "./travel-mode-enforcer";

export interface AccountSessionManagerOptions {
	storage: AccountStore;
	/**
	 * Sibling of `storage`. Required because `removeAccount` has to wipe the account's
	 * cached ciphertext, and `AccountStore` cannot reach it. See packages/storage/CONTEXT.md §4.2.
	 */
	itemCache: ItemCache;
	/**
	 * Optional here, unlike in `LifecycleDeps`: the manager is constructed once per
	 * app, so a platform that mirrors nothing cannot silently forget to answer twice.
	 */
	credentialMirror?: CredentialMirror;
	onActiveChanged?: (active: ActiveAccountId) => void | Promise<void>;
	onLockBroadcast?: (reason: string) => void | Promise<void>;
	invalidateQueries?: (keys: string[][]) => void | Promise<void>;
	verifyUnlockPolicy?: (accountId: string) => void | Promise<void>;
}

export interface LoginSessionInput {
	email: string;
	userId: string;
	name: string;
	serverUrl: string;
	teamName?: string;
	teamAvatarUrl?: string | null;
	secretKeyHint: string;
}

type LockState = "locked" | "unlocked";

export class AccountSessionManager {
	private accounts: AccountMetadata[] = [];
	private lockState = new Map<string, LockState>();
	private active: ActiveAccountId = null;
	private initialized = false;
	private initialization: Promise<void> | null = null;
	private snapshot = 0;
	private readonly listeners = new Set<() => void>();
	private readonly lifecycle: LifecycleDeps;

	constructor(private readonly options: AccountSessionManagerOptions) {
		this.lifecycle = {
			storage: options.storage,
			itemCache: options.itemCache,
			credentialMirror: options.credentialMirror ?? NO_CREDENTIAL_MIRROR,
		};
	}

	get storage(): AccountStore {
		return this.options.storage;
	}

	get itemCache(): ItemCache {
		return this.options.itemCache;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getSnapshot = (): number => this.snapshot;

	private emit(): void {
		this.snapshot++;
		for (const listener of this.listeners) {
			listener();
		}
	}

	private async verifyUnlockPolicy(accountId: string): Promise<boolean> {
		try {
			if (this.options.verifyUnlockPolicy) {
				await this.options.verifyUnlockPolicy(accountId);
				return true;
			}

			const enforcer = getTravelModeEnforcer(this.storage, this.itemCache);
			if (!enforcer.isVerified(accountId)) {
				const client = await createStoredAccountApiClient(
					this.storage,
					accountId,
				).catch(() => null);
				await enforcer.verifyForUnlock(accountId, client);
			}
			return true;
		} catch (error) {
			const outcome = await lifecycleLockAccount(accountId, this.lifecycle);
			console.error(
				"[AccountSessionManager] Unlock policy verification failed:",
				accountId,
				error,
				outcome.failures,
			);
			return false;
		}
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		this.initialization ??= this.refresh().finally(() => {
			this.initialization = null;
		});
		await this.initialization;
	}

	async refresh(): Promise<void> {
		const [accounts, active, unlocked] = await Promise.all([
			this.storage.getAccountsList(),
			this.storage.getActiveAccount(),
			this.storage.getUnlockedAccounts(),
		]);

		this.accounts = accounts;
		// The stored id is not trustworthy on its own: older builds persisted an
		// email here, and an account may have been removed elsewhere. Anything
		// that does not resolve to a known account is treated as "no active
		// account" so the normal selection path takes over.
		this.active =
			active && !resolveActiveAccountId(active, accounts) ? null : active;
		this.lockState.clear();
		const verifiedUnlocked = new Set(
			(
				await Promise.all(
					unlocked.map(async (accountId) =>
						(await this.verifyUnlockPolicy(accountId)) ? accountId : null,
					),
				)
			).filter((accountId): accountId is string => accountId !== null),
		);
		for (const account of accounts) {
			this.lockState.set(
				account.accountId,
				verifiedUnlocked.has(account.accountId) ? "unlocked" : "locked",
			);
		}
		this.initialized = true;
		this.emit();
	}

	isInitialized(): boolean {
		return this.initialized;
	}

	getAccounts(): AccountMetadata[] {
		return this.accounts;
	}

	getActiveAccount(): ActiveAccountId {
		return this.active;
	}

	getActiveAccountMetadata(): AccountMetadata | null {
		if (!this.active) {
			return null;
		}
		return findAccountById(this.accounts, this.active) ?? null;
	}

	getUnlockedAccountIds(): string[] {
		return Array.from(this.lockState.entries())
			.filter(([, state]) => state === "unlocked")
			.map(([id]) => id);
	}

	isUnlocked(accountId: string): boolean {
		return this.lockState.get(accountId) === "unlocked";
	}

	async switchAccount(accountId: ActiveAccountId): Promise<void> {
		await this.storage.setActiveAccount(accountId);
		this.active = accountId;

		if (accountId) {
			const meta = findAccountById(this.accounts, accountId);
			if (meta) {
				meta.lastActiveAt = Date.now();
				// Persist so storage-backed sorting sees the real value after
				// reload. addAccount upserts an existing account by accountId.
				await this.storage.addAccount(meta);
			}
			if (!this.isUnlocked(accountId)) {
				let restored = await this.storage.tryRestoreSession(true, accountId);
				if (restored) restored = await this.verifyUnlockPolicy(accountId);
				this.lockState.set(accountId, restored ? "unlocked" : "locked");
			}
		}

		await this.options.onActiveChanged?.(accountId);
		await this.options.invalidateQueries?.([
			["accounts"],
			["auth"],
			["vaults"],
			["items"],
		]);
		this.emit();
	}

	async addAccount(metadata: AccountMetadata): Promise<void> {
		await this.storage.addAccount(metadata);
		await this.refresh();
	}

	async registerLoginAccount(input: LoginSessionInput): Promise<string> {
		const accounts = await this.storage.getAccountsList();
		const serverUrl = input.serverUrl.replace(/\/$/, "");
		const accountId = resolveOrCreateAccountId(
			accounts,
			serverUrl,
			input.userId,
		);

		const metadata: AccountMetadata = {
			accountId,
			email: input.email,
			userId: input.userId,
			name: input.name,
			serverUrl,
			teamName: input.teamName,
			teamAvatarUrl: input.teamAvatarUrl,
			secretKeyHint: input.secretKeyHint,
			addedAt: Date.now(),
			lastActiveAt: Date.now(),
			biometricEnabled: await this.storage.isBiometricEnabled(accountId),
		};

		await this.storage.addAccount(metadata);
		await this.storage.setActiveAccount(accountId);
		await this.refresh();
		return accountId;
	}

	async lockAccount(accountId: string): Promise<void> {
		await lifecycleLockAccount(accountId, this.lifecycle);
		this.lockState.set(accountId, "locked");
		await this.options.invalidateQueries?.([
			["accounts", "unlocked"],
			["auth", "sessionState"],
			["items"],
		]);
		this.emit();
	}

	async lockAll(reason = "manual"): Promise<void> {
		// `reason` is broadcast metadata for the app, not part of the sequence, so it
		// stops here rather than travelling into the lifecycle module.
		await lifecycleLockAllAccounts(this.lifecycle);
		for (const account of this.accounts) {
			this.lockState.set(account.accountId, "locked");
		}
		await this.options.onLockBroadcast?.(reason);
		await this.options.invalidateQueries?.([
			["accounts", "unlocked"],
			["auth", "sessionState"],
			["items"],
		]);
		this.emit();
	}

	async removeAccount(accountId: string): Promise<LifecycleOutcome> {
		const outcome = await lifecycleRemoveAccount(accountId, this.lifecycle);
		// Re-reads the list, the pointer the module may have moved, and the lock
		// states, then emits — so nothing in-memory has to be patched by hand here.
		await this.refresh();

		if (outcome.wasActive) {
			await this.options.onActiveChanged?.(this.active);
			await this.options.invalidateQueries?.([
				["accounts"],
				["auth"],
				["vaults"],
				["items"],
			]);
		}
		return outcome;
	}

	async unlockAccount(
		accountId: string,
		skipBiometric = false,
	): Promise<boolean> {
		let restored = await this.storage.tryRestoreSession(
			skipBiometric,
			accountId,
		);
		if (restored) restored = await this.verifyUnlockPolicy(accountId);
		this.lockState.set(accountId, restored ? "unlocked" : "locked");
		this.emit();
		return restored;
	}
}

let sharedManager: AccountSessionManager | null = null;

/**
 * Constructs the shared manager on the first call and returns it afterwards.
 *
 * Passing options to an already-constructed manager throws: the options carry the
 * platform callbacks (onActiveChanged, onLockBroadcast, …) and accepting them
 * silently would drop them, leaving account switches and lock broadcasts dead.
 * Callers that only need the instance must use `peekAccountSessionManager()`.
 */
export function getAccountSessionManager(
	options?: AccountSessionManagerOptions,
): AccountSessionManager {
	if (options) {
		if (sharedManager) {
			throw new Error(
				"AccountSessionManager is already constructed; these options (and any onActiveChanged/onLockBroadcast callbacks in them) would be silently dropped. Construct it exactly once at app startup and use peekAccountSessionManager() everywhere else.",
			);
		}
		sharedManager = new AccountSessionManager(options);
	}
	if (!sharedManager) {
		throw new Error(
			"AccountSessionManager not initialized. Pass options on first call.",
		);
	}
	return sharedManager;
}

/**
 * Returns the shared manager if it has been initialized, otherwise null.
 * Unlike getAccountSessionManager, this never throws and never constructs a
 * new instance. Use it from flows that write account state directly to storage
 * (e.g. login) and need to nudge the in-memory manager to re-read storage.
 */
export function peekAccountSessionManager(): AccountSessionManager | null {
	return sharedManager;
}

export function resetAccountSessionManagerForTests(): void {
	sharedManager = null;
}
