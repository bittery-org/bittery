import { describe, expect, it } from "bun:test";
import { AccountSyncLifecycle } from "./account-sync-lifecycle";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function source() {
	const listeners = new Set<() => void>();
	return {
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit() {
			for (const listener of listeners) listener();
		},
		get size() {
			return listeners.size;
		},
	};
}

const settle = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

describe("AccountSyncLifecycle", () => {
	it("never publishes a stale rapid A to B to A assembly", async () => {
		const accountChanges = source();
		const vaultChanges = source();
		let accountId: string | null = "a";
		const builds = [deferred<string>(), deferred<string>(), deferred<string>()];
		let build = 0;
		const lifecycle = new AccountSyncLifecycle({
			resolveClientId: async () => "client",
			getActiveAccountId: () => accountId,
			subscribeAccountChanges: accountChanges.subscribe,
			subscribeVaultChanges: vaultChanges.subscribe,
			assemble: () => builds[build++]?.promise ?? Promise.resolve("unexpected"),
		});

		lifecycle.start();
		await settle();
		accountId = "b";
		accountChanges.emit();
		accountId = "a";
		accountChanges.emit();

		builds[0]?.resolve("old-a");
		builds[1]?.resolve("b");
		await settle();
		expect(lifecycle.getSnapshot().assembly).toBeNull();
		builds[2]?.resolve("new-a");
		await settle();
		expect(lifecycle.getSnapshot()).toMatchObject({
			clientId: "client",
			assembly: "new-a",
			initialized: true,
			ready: true,
		});
	});

	it("starts idempotently and keeps an unchanged snapshot stable", async () => {
		const accountChanges = source();
		const vaultChanges = source();
		let builds = 0;
		const lifecycle = new AccountSyncLifecycle({
			resolveClientId: async () => "client",
			getActiveAccountId: () => "a",
			subscribeAccountChanges: accountChanges.subscribe,
			subscribeVaultChanges: vaultChanges.subscribe,
			assemble: async () => {
				builds++;
				return "assembly";
			},
		});

		const initial = lifecycle.getSnapshot();
		expect(lifecycle.getSnapshot()).toBe(initial);
		lifecycle.start();
		lifecycle.start();
		await settle();
		expect(builds).toBe(1);
		expect(accountChanges.size).toBe(1);
		expect(vaultChanges.size).toBe(1);
		const ready = lifecycle.getSnapshot();
		expect(lifecycle.getSnapshot()).toBe(ready);
	});

	it("dispose unsubscribes and cancels pending assembly", async () => {
		const accountChanges = source();
		const vaultChanges = source();
		const pending = deferred<string>();
		const lifecycle = new AccountSyncLifecycle({
			resolveClientId: async () => "client",
			getActiveAccountId: () => "a",
			subscribeAccountChanges: accountChanges.subscribe,
			subscribeVaultChanges: vaultChanges.subscribe,
			assemble: () => pending.promise,
		});

		lifecycle.start();
		await settle();
		lifecycle.dispose();
		expect(accountChanges.size).toBe(0);
		expect(vaultChanges.size).toBe(0);
		pending.resolve("stale");
		await settle();
		expect(lifecycle.getSnapshot().assembly).toBeNull();
	});

	it("does not republish the previous assembly when restarted", async () => {
		const accountChanges = source();
		const vaultChanges = source();
		let accountId: string | null = "a";
		const lifecycle = new AccountSyncLifecycle({
			resolveClientId: async () => "client",
			getActiveAccountId: () => accountId,
			subscribeAccountChanges: accountChanges.subscribe,
			subscribeVaultChanges: vaultChanges.subscribe,
			assemble: async ({ activeAccountId }) => activeAccountId,
		});

		lifecycle.start();
		await settle();
		expect(lifecycle.getSnapshot().assembly).toBe("a");
		lifecycle.dispose();
		accountId = "b";
		const observed: (string | null)[] = [];
		const unsubscribe = lifecycle.subscribe(() => {
			observed.push(lifecycle.getSnapshot().assembly);
		});
		lifecycle.start();
		await settle();

		expect(observed).not.toContain("a");
		expect(lifecycle.getSnapshot().assembly).toBe("b");
		unsubscribe();
	});

	it("clear hides the assembly until a revision rebuilds it", async () => {
		const accountChanges = source();
		const vaultChanges = source();
		let assembly = "first";
		const lifecycle = new AccountSyncLifecycle({
			resolveClientId: async () => "client",
			getActiveAccountId: () => "a",
			subscribeAccountChanges: accountChanges.subscribe,
			subscribeVaultChanges: vaultChanges.subscribe,
			assemble: async () => assembly,
		});

		lifecycle.start();
		await settle();
		lifecycle.clear();
		expect(lifecycle.getSnapshot()).toMatchObject({
			assembly: null,
			initialized: false,
			ready: false,
		});
		assembly = "second";
		vaultChanges.emit();
		await settle();
		expect(lifecycle.getSnapshot().assembly).toBe("second");
	});
});
