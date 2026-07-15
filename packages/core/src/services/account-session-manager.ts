/**
 * AccountSessionManager — single source of truth for multi-account state.
 * Framework-agnostic; platform specifics injected via callbacks.
 */

import {
	findAccountById,
	resolveOrCreateAccountId,
} from "@bittery/storage/account-id";
import type { IStorageAdapter } from "@bittery/storage/adapter";
import type { AccountMetadata, ActiveAccount } from "@bittery/storage/types";
import { createStoredAccountRpcClient } from "./account-resolver";
import { getTravelModeEnforcer } from "./travel-mode-enforcer";

export interface AccountSessionManagerOptions {
	storage: IStorageAdapter;
	onActiveChanged?: (active: ActiveAccount) => void | Promise<void>;
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
	private active: ActiveAccount = null;
	private snapshot = 0;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly options: AccountSessionManagerOptions) {}

	get storage(): IStorageAdapter {
		return this.options.storage;
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
			} else {
				const enforcer = getTravelModeEnforcer(this.storage);
				if (!enforcer.isVerified(accountId)) {
					const client = await createStoredAccountRpcClient(
						this.storage,
						accountId,
					).catch(() => null);
					await enforcer.verifyForUnlock(accountId, client);
				}
			}
			return true;
		} catch {
			await this.storage.clearSession(accountId);
			return false;
		}
	}

	async initialize(): Promise<void> {
		await this.refresh();
	}

	async refresh(): Promise<void> {
		const [accounts, active, unlocked] = await Promise.all([
			this.storage.getAccountsList(),
			this.storage.getActiveAccount(),
			this.storage.getUnlockedAccounts?.() ?? Promise.resolve([]),
		]);

		this.accounts = accounts;
		this.active = active;
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
		this.emit();
	}

	getAccounts(): AccountMetadata[] {
		return this.accounts;
	}

	getActiveAccount(): ActiveAccount {
		return this.active;
	}

	getActiveAccountMetadata(): AccountMetadata | null {
		if (this.active?.type !== "single") {
			return null;
		}
		return findAccountById(this.accounts, this.active.accountId) ?? null;
	}

	getUnlockedAccountIds(): string[] {
		return Array.from(this.lockState.entries())
			.filter(([, state]) => state === "unlocked")
			.map(([id]) => id);
	}

	isUnlocked(accountId: string): boolean {
		return this.lockState.get(accountId) === "unlocked";
	}

	async switchAccount(account: ActiveAccount): Promise<void> {
		await this.storage.setActiveAccount(account);
		this.active = account;

		if (account?.type === "single") {
			const meta = findAccountById(this.accounts, account.accountId);
			if (meta) {
				meta.lastActiveAt = Date.now();
			}
			if (!this.isUnlocked(account.accountId)) {
				let restored = await this.storage.tryRestoreSession(
					true,
					account.accountId,
				);
				if (restored) restored = await this.verifyUnlockPolicy(account.accountId);
				this.lockState.set(
					account.accountId,
					restored ? "unlocked" : "locked",
				);
			}
		}

		await this.options.onActiveChanged?.(account);
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
			biometricEnabled: this.storage.isBiometricEnabled
				? await this.storage.isBiometricEnabled(accountId)
				: false,
		};

		await this.storage.addAccount(metadata);
		await this.storage.setActiveAccount({ type: "single", accountId });
		await this.refresh();
		return accountId;
	}

	async lockAccount(accountId: string): Promise<void> {
		await this.storage.clearSession(accountId);
		this.lockState.set(accountId, "locked");
		await this.options.invalidateQueries?.([
			["accounts", "unlocked"],
			["auth", "sessionState"],
			["items"],
		]);
		this.emit();
	}

	async lockAll(reason = "manual"): Promise<void> {
		if (this.storage.lockAllAccounts) {
			await this.storage.lockAllAccounts();
		}
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

	async removeAccount(accountId: string): Promise<void> {
		const wasActive =
			this.active?.type === "single" && this.active.accountId === accountId;
		const nextAccount = wasActive
			? this.accounts.find((account) => account.accountId !== accountId)
			: undefined;

		if (wasActive) {
			await this.storage.setActiveAccount(null);
			this.active = null;
		}

		await this.storage.removeAccount(accountId);

		if (wasActive) {
			if (nextAccount) {
				this.accounts = this.accounts.filter(
					(account) => account.accountId !== accountId,
				);
				this.lockState.delete(accountId);
				await this.switchAccount({
					type: "single",
					accountId: nextAccount.accountId,
				});
			} else {
				await this.refresh();
			}
		} else {
			await this.refresh();
		}
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

export function getAccountSessionManager(
	options?: AccountSessionManagerOptions,
): AccountSessionManager {
	if (!sharedManager && options) {
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
