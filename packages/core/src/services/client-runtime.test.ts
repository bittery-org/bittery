import { describe, expect, it } from "bun:test";
import {
	accountMetadata,
	createTestAccountStore,
	createTestItemCache,
} from "../testing/account-store-harness";
import { ClientRuntime } from "./client-runtime";
import type { LocalVaultAccount, VaultRepository } from "./vault-repository";

async function createRuntime() {
	const [{ store }, { cache }] = await Promise.all([
		createTestAccountStore(),
		createTestItemCache(),
	]);
	let hydrations = 0;
	const repository = {
		setLocalActiveAccounts: (_accounts: LocalVaultAccount[]) => {},
		hydrateLocalAccounts: async () => {
			hydrations++;
		},
	} as unknown as VaultRepository;
	const runtime = new ClientRuntime({
		storage: store,
		itemCache: cache,
		vaultRepository: repository,
		verifyUnlockPolicy: async () => {},
	});
	return { runtime, store, hydrations: () => hydrations };
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("ClientRuntime", () => {
	it("owns independent account managers and Vault runtimes", async () => {
		const first = await createRuntime();
		const second = await createRuntime();

		expect(first.runtime.accounts).not.toBe(second.runtime.accounts);
		expect(first.runtime.vaultRuntime).not.toBe(second.runtime.vaultRuntime);

		await first.runtime.accounts.addAccount(
			accountMetadata({ accountId: "first" }),
		);
		expect(first.runtime.accounts.getAccounts()).toHaveLength(1);
		expect(second.runtime.accounts.getAccounts()).toHaveLength(0);
	});

	it("starts and disposes its Vault subscription idempotently", async () => {
		const owned = await createRuntime();
		const subscribe = owned.runtime.accounts.subscribe;
		let subscriptions = 0;
		let unsubscriptions = 0;
		owned.runtime.accounts.subscribe = (listener) => {
			subscriptions++;
			const unsubscribe = subscribe(listener);
			return () => {
				unsubscriptions++;
				unsubscribe();
			};
		};
		owned.runtime.start();
		owned.runtime.start();
		expect(subscriptions).toBe(1);

		owned.runtime.dispose();
		owned.runtime.dispose();
		expect(unsubscriptions).toBe(1);
		const revision = owned.runtime.vaultRuntime.getSnapshot().revision;
		await owned.runtime.accounts.addAccount(
			accountMetadata({ accountId: "later" }),
		);
		await settle();
		expect(owned.runtime.vaultRuntime.getSnapshot().revision).toBe(revision);
	});
});
