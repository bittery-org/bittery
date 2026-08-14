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
	private localInitialization: Promise<void> | null = null;
	private stateTransitionTail: Promise<void> = Promise.resolve();
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

	/** Serializes every operation that can change durable or projected account state. */
	private runStateTransition<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.stateTransitionTail
			.catch(() => undefined)
			.then(operation);
		this.stateTransitionTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
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
		this.initialization ??= (async () => {
			await this.initializeLocalVaultState();
			if (!this.initialized) await this.refresh();
		})().finally(() => {
			this.initialization = null;
		});
		await this.initialization;
	}

	/**
	 * Restores prompt-free local sessions, then loads the account selection and lock
	 * descriptors used to open the local Vault runtime. Travel Mode is restored
	 * independently from its durable cache there; the full session initialize still
	 * performs remote-first verification.
	 */
	async initializeLocalVaultState(): Promise<void> {
		if (this.localInitialization) {
			await this.localInitialization;
			return;
		}
		const attempt = this.runStateTransition(() => this.loadLocalVaultState());
		this.localInitialization = attempt;
		try {
			await attempt;
		} catch (error) {
			if (this.localInitialization === attempt) {
				this.localInitialization = null;
			}
			throw error;
		}
	}

	private async loadLocalVaultState(): Promise<void> {
		const accounts = await this.storage.getAccountsList();
		await Promise.all(
			accounts.map((account) =>
				this.storage.tryRestoreSessionWithoutPrompt(account.accountId),
			),
		);
		const [active, unlocked] = await Promise.all([
			this.storage.getActiveAccount(),
			this.storage.getUnlockedAccounts(),
		]);
		this.accounts = accounts;
		this.active =
			active && !resolveActiveAccountId(active, accounts) ? null : active;
		const locallyUnlocked = new Set(unlocked);
		this.lockState.clear();
		for (const account of accounts) {
			this.lockState.set(
				account.accountId,
				locallyUnlocked.has(account.accountId) ? "unlocked" : "locked",
			);
		}
	}

	async refresh(): Promise<void> {
		await this.runStateTransition(() => this.refreshState());
	}

	private async refreshState(): Promise<void> {
		const [accounts, active, unlocked] = await Promise.all([
			this.storage.getAccountsList(),
			this.storage.getActiveAccount(),
			this.storage.getUnlockedAccounts(),
		]);

		this.accounts = accounts;
		// An account may have been removed by another surface. Treat an unknown
		// pointer as "no active account" so the normal selection path takes over.
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
		await this.runStateTransition(() => this.switchAccountState(accountId));
	}

	private async switchAccountState(accountId: ActiveAccountId): Promise<void> {
		await this.storage.setActiveAccount(accountId);
		this.active = accountId;
		// Selection changes the visible Vault scope before restore or policy checks
		// can yield to storage, crypto, network, or platform callbacks.
		this.emit();

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

		this.emit();
		await this.options.onActiveChanged?.(accountId);
		await this.options.invalidateQueries?.([
			["accounts"],
			["auth"],
			["vaults"],
			["items"],
		]);
	}

	async addAccount(metadata: AccountMetadata): Promise<void> {
		await this.runStateTransition(async () => {
			await this.storage.addAccount(metadata);
			await this.refreshState();
		});
	}

	async registerLoginAccount(input: LoginSessionInput): Promise<string> {
		return this.runStateTransition(() => this.registerLoginAccountState(input));
	}

	private async registerLoginAccountState(
		input: LoginSessionInput,
	): Promise<string> {
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
			insecureTransportConfirmed: false,
		};

		await this.storage.addAccount(metadata);
		await this.storage.setActiveAccount(accountId);
		await this.refreshState();
		return accountId;
	}

	async lockAccount(accountId: string): Promise<void> {
		await this.runStateTransition(() => this.lockAccountState(accountId));
	}

	private async lockAccountState(accountId: string): Promise<void> {
		await lifecycleLockAccount(accountId, this.lifecycle);
		this.lockState.set(accountId, "locked");
		this.emit();
		await this.options.invalidateQueries?.([
			["accounts", "unlocked"],
			["auth", "sessionState"],
			["items"],
		]);
	}

	async lockAll(reason = "manual"): Promise<void> {
		await this.runStateTransition(() => this.lockAllState(reason));
	}

	private async lockAllState(reason: string): Promise<void> {
		// `reason` is broadcast metadata for the app, not part of the sequence, so it
		// stops here rather than travelling into the lifecycle module.
		await lifecycleLockAllAccounts(this.lifecycle);
		for (const account of this.accounts) {
			this.lockState.set(account.accountId, "locked");
		}
		this.emit();
		await this.options.onLockBroadcast?.(reason);
		await this.options.invalidateQueries?.([
			["accounts", "unlocked"],
			["auth", "sessionState"],
			["items"],
		]);
	}

	async removeAccount(accountId: string): Promise<LifecycleOutcome> {
		return this.runStateTransition(() => this.removeAccountState(accountId));
	}

	private async removeAccountState(
		accountId: string,
	): Promise<LifecycleOutcome> {
		const outcome = await lifecycleRemoveAccount(accountId, this.lifecycle);
		// Re-reads the list, the pointer the module may have moved, and the lock
		// states, then emits — so nothing in-memory has to be patched by hand here.
		await this.refreshState();

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
		return this.runStateTransition(() =>
			this.unlockAccountState(accountId, skipBiometric),
		);
	}

	private async unlockAccountState(
		accountId: string,
		skipBiometric: boolean,
	): Promise<boolean> {
		// Route guards may reaffirm access while navigating inside an open Vault. Once
		// full initialization has verified policy, restoring and publishing again would
		// turn a read-only navigation into an account-state transition. Local-only boot
		// restoration is deliberately excluded because it has not verified policy yet.
		if (this.initialized && this.isUnlocked(accountId)) {
			return true;
		}
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
