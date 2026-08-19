import type { AccountMetadata, ActiveAccountId } from "@bittery/storage/types";
import type { LocalVaultAccount, VaultRepository } from "./vault-repository";

export interface AccountVaultStateSource {
	initializeLocalVaultState(): Promise<void>;
	subscribe(listener: () => void): () => void;
	getActiveAccount(): ActiveAccountId;
	getAccounts(): AccountMetadata[];
	getUnlockedAccountIds(): string[];
}

export interface AccountVaultRuntimeState {
	revision: number;
	accounts: LocalVaultAccount[];
	unlockedAccounts: LocalVaultAccount[];
	isLoading: boolean;
	error: Error | null;
}

function sameAccounts(
	left: LocalVaultAccount[],
	right: LocalVaultAccount[],
): boolean {
	return (
		left.length === right.length &&
		left.every((account, index) => {
			const candidate = right[index];
			return (
				candidate !== undefined &&
				account.accountId === candidate.accountId &&
				account.email === candidate.email &&
				account.userId === candidate.userId &&
				account.name === candidate.name &&
				account.serverUrl === candidate.serverUrl &&
				account.teamName === candidate.teamName &&
				account.teamAvatarUrl === candidate.teamAvatarUrl
			);
		})
	);
}

/**
 * Owns the process-local Vault read lifetime. Account changes immediately define
 * the visible scope; cache opening then completes asynchronously for that scope.
 */
export class AccountVaultRuntime {
	private generation = 0;
	private state: AccountVaultRuntimeState = {
		revision: 0,
		accounts: [],
		unlockedAccounts: [],
		isLoading: true,
		error: null,
	};
	private readonly listeners = new Set<() => void>();
	private unsubscribe: (() => void) | null = null;
	private started = false;

	constructor(
		private readonly source: AccountVaultStateSource,
		readonly repository: VaultRepository,
	) {}

	/** Starts durable account observation. Explicit so SSR can render an inert snapshot. */
	start(): void {
		if (this.started) return;
		this.started = true;
		this.unsubscribe = this.source.subscribe(() => void this.reconcile());
		const initializationGeneration = this.generation;
		void this.source.initializeLocalVaultState().then(
			() => {
				if (this.started && initializationGeneration === this.generation) {
					void this.reconcile();
				}
			},
			(error) => this.fail(initializationGeneration, error),
		);
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getSnapshot = (): AccountVaultRuntimeState => this.state;

	retry = async (): Promise<void> => {
		this.start();
		await this.reconcile(true);
	};

	dispose(): void {
		this.generation++;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.started = false;
		this.listeners.clear();
	}

	private publish(next: Omit<AccountVaultRuntimeState, "revision">): void {
		this.state = { ...next, revision: this.state.revision + 1 };
		for (const listener of this.listeners) listener();
	}

	private fail(generation: number, value: unknown): void {
		if (generation !== this.generation) return;
		const error = value instanceof Error ? value : new Error(String(value));
		this.publish({ ...this.state, isLoading: false, error });
	}

	private async reconcile(force = false): Promise<void> {
		const generation = ++this.generation;
		const activeId = this.source.getActiveAccount();
		const all = this.source.getAccounts();
		const unlocked = new Set(this.source.getUnlockedAccountIds());
		const local = (account: AccountMetadata): LocalVaultAccount => ({
			accountId: account.accountId,
			email: account.email,
			userId: account.userId,
			name: account.name,
			serverUrl: account.serverUrl,
			teamName: account.teamName,
			teamAvatarUrl: account.teamAvatarUrl,
		});
		const activeAccounts =
			activeId && unlocked.has(activeId)
				? all.filter((account) => account.accountId === activeId).map(local)
				: [];
		const unlockedAccounts = all
			.filter((account) => unlocked.has(account.accountId))
			.map(local);
		// Desktop route guards can reaffirm the same unlocked account on child
		// navigation. Reopening its durable cache would hide the live projection.
		if (
			!force &&
			!this.state.isLoading &&
			this.state.error === null &&
			sameAccounts(this.state.accounts, activeAccounts) &&
			sameAccounts(this.state.unlockedAccounts, unlockedAccounts)
		) {
			return;
		}
		// Scope is changed synchronously before any durable read can yield.
		this.repository.setLocalActiveAccounts(activeAccounts);
		this.publish({
			accounts: activeAccounts,
			unlockedAccounts,
			isLoading: true,
			error: null,
		});
		try {
			await this.repository.hydrateLocalAccounts(unlockedAccounts);
			if (generation !== this.generation) return;
			this.publish({
				accounts: activeAccounts,
				unlockedAccounts,
				isLoading: false,
				error: null,
			});
		} catch (error) {
			this.fail(generation, error);
		}
	}
}
