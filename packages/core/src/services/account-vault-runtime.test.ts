import { describe, expect, it } from "bun:test";
import type { AccountMetadata, ActiveAccountId } from "@bittery/storage/types";
import {
	AccountVaultRuntime,
	type AccountVaultStateSource,
} from "./account-vault-runtime";
import type { LocalVaultAccount, VaultRepository } from "./vault-repository";

const account = (accountId: string): AccountMetadata => ({
	accountId,
	email: `${accountId}@example.test`,
	userId: `user-${accountId}`,
	name: accountId,
	serverUrl: "https://example.test",
	secretKeyHint: "hint",
	addedAt: 1,
	lastActiveAt: 1,
	biometricEnabled: false,
	insecureTransportConfirmed: false,
});

class Source implements AccountVaultStateSource {
	active: ActiveAccountId = null;
	accounts: AccountMetadata[] = [];
	unlocked: string[] = [];
	private listener?: () => void;
	initializeLocalVaultState = async () => {};
	subscribe = (listener: () => void) => {
		this.listener = listener;
		return () => {
			this.listener = undefined;
		};
	};
	getActiveAccount = () => this.active;
	getAccounts = () => this.accounts;
	getUnlockedAccountIds = () => this.unlocked;
	emit(): void {
		this.listener?.();
	}
}

const deferred = () => {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
};

function startRuntime(
	source: AccountVaultStateSource,
	repository: VaultRepository,
): AccountVaultRuntime {
	const runtime = new AccountVaultRuntime(source, repository);
	runtime.start();
	return runtime;
}

describe("AccountVaultRuntime", () => {
	it("ignores initialization from a disposed lifetime after restart", async () => {
		const source = new Source();
		const first = deferred();
		const second = deferred();
		let initialization = 0;
		source.initializeLocalVaultState = () =>
			initialization++ === 0 ? first.promise : second.promise;
		let hydrations = 0;
		const repository = {
			setLocalActiveAccounts: () => {},
			hydrateLocalAccounts: async () => {
				hydrations++;
			},
		} as unknown as VaultRepository;
		const runtime = new AccountVaultRuntime(source, repository);

		runtime.start();
		runtime.dispose();
		runtime.start();
		first.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(hydrations).toBe(0);
		expect(runtime.getSnapshot().revision).toBe(0);

		second.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(hydrations).toBe(1);
		expect(runtime.getSnapshot().revision).toBe(2);
	});

	it("ignores a late local initialization failure after a successful retry", async () => {
		const source = new Source();
		const initialization = deferred();
		source.initializeLocalVaultState = () => initialization.promise;
		const repository = {
			setLocalActiveAccounts: () => {},
			hydrateLocalAccounts: async () => {},
		} as unknown as VaultRepository;
		const runtime = startRuntime(source, repository);
		await runtime.retry();
		expect(runtime.getSnapshot().error).toBeNull();
		initialization.reject(new Error("late initialization failure"));
		await Promise.resolve();
		expect(runtime.getSnapshot().error).toBeNull();
	});

	it("excludes a locked active account from the read scope immediately", async () => {
		const source = new Source();
		source.active = "a";
		source.accounts = [account("a")];
		source.unlocked = ["a"];
		let scope: LocalVaultAccount[] = [];
		const repository = {
			setLocalActiveAccounts: (accounts: LocalVaultAccount[]) => {
				scope = accounts;
			},
			hydrateLocalAccounts: async () => {},
		} as unknown as VaultRepository;
		const runtime = startRuntime(source, repository);
		await runtime.retry();
		expect(scope.map((entry) => entry.accountId)).toEqual(["a"]);
		source.unlocked = [];
		source.emit();
		expect(scope).toEqual([]);
		expect(runtime.getSnapshot().accounts).toEqual([]);
	});
	it("opens from local state without invoking remote session initialization", async () => {
		const source = new Source();
		source.active = "a";
		source.accounts = [account("a")];
		source.unlocked = ["a"];
		let localInitializations = 0;
		source.initializeLocalVaultState = async () => {
			localInitializations++;
		};
		const repository = {
			setLocalActiveAccounts: () => {},
			hydrateLocalAccounts: async () => {},
		} as unknown as VaultRepository;
		const runtime = startRuntime(source, repository);
		await Promise.resolve();
		await Promise.resolve();
		expect(localInitializations).toBe(1);
		expect(runtime.getSnapshot().accounts[0]?.accountId).toBe("a");
	});

	it("publishes an empty scope without waiting for cache opening", async () => {
		const source = new Source();
		let active: LocalVaultAccount[] = [account("old")];
		const repository = {
			setLocalActiveAccounts: (next: LocalVaultAccount[]) => {
				active = next;
			},
			hydrateLocalAccounts: async () => {},
		} as unknown as VaultRepository;
		const runtime = startRuntime(source, repository);
		await runtime.retry();
		expect(active).toEqual([]);
		expect(runtime.getSnapshot().accounts).toEqual([]);
		expect(runtime.getSnapshot().isLoading).toBe(false);
	});

	it("opens unlocked local accounts without an auth or client descriptor", async () => {
		const source = new Source();
		source.active = "a";
		source.accounts = [account("a"), account("b")];
		source.unlocked = ["a", "b"];
		let opened: LocalVaultAccount[] = [];
		const repository = {
			setLocalActiveAccounts: () => {},
			hydrateLocalAccounts: async (unlocked: LocalVaultAccount[]) => {
				opened = unlocked;
			},
		} as unknown as VaultRepository;
		const runtime = startRuntime(source, repository);
		await runtime.retry();
		expect(opened.map((entry) => entry.accountId)).toEqual(["a", "b"]);
		expect(
			runtime.getSnapshot().unlockedAccounts.map((entry) => entry.accountId),
		).toEqual(["a", "b"]);
		expect(Object.keys(opened[0] ?? {})).not.toContain("apiClient");
		expect(Object.keys(opened[0] ?? {})).not.toContain("authToken");
	});

	it("exposes failures and clears them on retry", async () => {
		const source = new Source();
		source.active = "a";
		source.accounts = [account("a")];
		source.unlocked = ["a"];
		let fail = true;
		const repository = {
			setLocalActiveAccounts: () => {},
			hydrateLocalAccounts: async () => {
				if (fail) throw new Error("cache unavailable");
			},
		} as unknown as VaultRepository;
		const runtime = startRuntime(source, repository);
		await runtime.retry();
		expect(runtime.getSnapshot().error?.message).toBe("cache unavailable");
		fail = false;
		await runtime.retry();
		expect(runtime.getSnapshot().error).toBeNull();
		expect(runtime.getSnapshot().isLoading).toBe(false);
	});

	it("ignores completion from a stale account generation", async () => {
		const source = new Source();
		source.active = "a";
		source.accounts = [account("a"), account("b")];
		source.unlocked = ["a", "b"];
		const first = deferred();
		let calls = 0;
		const repository = {
			setLocalActiveAccounts: () => {},
			hydrateLocalAccounts: async () => {
				if (++calls === 1) await first.promise;
			},
		} as unknown as VaultRepository;
		const runtime = startRuntime(source, repository);
		await Promise.resolve();
		source.active = "b";
		source.emit();
		await runtime.retry();
		first.resolve();
		await Promise.resolve();
		expect(
			runtime.getSnapshot().accounts.map((entry) => entry.accountId),
		).toEqual(["b"]);
		expect(runtime.getSnapshot().isLoading).toBe(false);
	});
});
