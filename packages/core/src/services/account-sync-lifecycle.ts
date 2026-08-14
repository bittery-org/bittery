import type { ActiveAccountId } from "@bittery/storage/types";

type Subscribe = (listener: () => void) => () => void;

export interface AccountSyncLifecycleSnapshot<Assembly> {
	clientId: string;
	assembly: Assembly | null;
	initialized: boolean;
	ready: boolean;
	error: Error | null;
}

export interface AccountSyncLifecycleOptions<Assembly> {
	resolveClientId(): Promise<string>;
	getActiveAccountId(): ActiveAccountId;
	subscribeAccountChanges: Subscribe;
	subscribeVaultChanges: Subscribe;
	assemble(input: {
		clientId: string;
		activeAccountId: ActiveAccountId;
	}): Promise<Assembly | null>;
}

const INITIAL_SNAPSHOT: AccountSyncLifecycleSnapshot<never> = {
	clientId: "",
	assembly: null,
	initialized: false,
	ready: false,
	error: null,
};

/** Owns client readiness and race-safe account-scoped Sync assembly. */
export class AccountSyncLifecycle<Assembly> {
	private snapshot: AccountSyncLifecycleSnapshot<Assembly> = INITIAL_SNAPSHOT;
	private readonly listeners = new Set<() => void>();
	private unsubscribers: (() => void)[] = [];
	private generation = 0;
	private started = false;

	constructor(
		private readonly options: AccountSyncLifecycleOptions<Assembly>,
	) {}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.unsubscribers = [
			this.options.subscribeAccountChanges(() => this.rebuild()),
			this.options.subscribeVaultChanges(() => this.rebuild()),
		];
		const generation = ++this.generation;
		void this.options.resolveClientId().then(
			(clientId) => {
				if (!this.isCurrent(generation)) return;
				if (!clientId) {
					this.publish({
						clientId: "",
						assembly: null,
						initialized: true,
						ready: false,
						error: null,
					});
					return;
				}
				this.rebuild(clientId);
			},
			(error) => this.fail(generation, error),
		);
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getSnapshot = (): AccountSyncLifecycleSnapshot<Assembly> => this.snapshot;

	clear(): void {
		this.generation++;
		this.publish({
			...this.snapshot,
			assembly: null,
			initialized: false,
			ready: false,
			error: null,
		});
	}

	dispose(): void {
		this.generation++;
		for (const unsubscribe of this.unsubscribers) unsubscribe();
		this.unsubscribers = [];
		this.started = false;
	}

	private rebuild(clientId = this.snapshot.clientId): void {
		if (!this.started || !clientId) return;
		const generation = ++this.generation;
		this.publish({
			clientId,
			assembly: null,
			initialized: false,
			ready: false,
			error: null,
		});
		void this.options
			.assemble({
				clientId,
				activeAccountId: this.options.getActiveAccountId(),
			})
			.then(
				(assembly) => {
					if (!this.isCurrent(generation)) return;
					this.publish({
						clientId,
						assembly,
						initialized: true,
						ready: assembly !== null,
						error: null,
					});
				},
				(error) => this.fail(generation, error),
			);
	}

	private isCurrent(generation: number): boolean {
		return this.started && generation === this.generation;
	}

	private fail(generation: number, value: unknown): void {
		if (!this.isCurrent(generation)) return;
		this.publish({
			...this.snapshot,
			assembly: null,
			initialized: true,
			ready: false,
			error: value instanceof Error ? value : new Error(String(value)),
		});
	}

	private publish(snapshot: AccountSyncLifecycleSnapshot<Assembly>): void {
		this.snapshot = snapshot;
		for (const listener of this.listeners) listener();
	}
}
