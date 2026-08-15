import { describe, expect, test } from "bun:test";
import {
	refreshAfterVaultDeletion,
	refreshAfterVaultMutation,
} from "./mutation-utils";

/**
 * Records every step the refresh takes so a test can assert on what it did
 * *not* do. `refreshFromServer` re-downloads and re-stages every item of every
 * vault; on the desktop per-record store that is ~1500 IPC round trips, which
 * froze the create and delete dialogs.
 */
function createRecordingCore() {
	const calls: string[] = [];
	return {
		calls,
		core: {
			vaults: {
				refreshVaultKeys: async (accountId: string) => {
					calls.push(`refreshVaultKeys:${accountId}`);
				},
			},
			vaultRepository: {
				removeCachedVault: async (vaultId: string, accountId: string) => {
					calls.push(`removeCachedVault:${vaultId}:${accountId}`);
				},
				refreshFromServer: async () => {
					calls.push("refreshFromServer");
				},
			},
			accounts: {
				resolveAccounts: async () => {
					calls.push("resolveAccounts");
					return { accountsInfo: [{ id: "account_1" }] };
				},
			},
		},
		invalidator: {
			invalidateVaultKeys: async () => {
				calls.push("invalidateVaultKeys");
			},
		},
	};
}

describe("refreshAfterVaultMutation", () => {
	test("re-pulls the vault keys without re-bootstrapping the repositories", async () => {
		const { calls, core, invalidator } = createRecordingCore();

		await refreshAfterVaultMutation(core, invalidator, "account_1");

		expect(calls).toEqual([
			"refreshVaultKeys:account_1",
			"invalidateVaultKeys",
		]);
	});
});

describe("refreshAfterVaultDeletion", () => {
	test("evicts the deleted vault locally instead of re-bootstrapping", async () => {
		const { calls, core, invalidator } = createRecordingCore();

		await refreshAfterVaultDeletion(core, invalidator, {
			vaultId: "vault_1",
			accountId: "account_1",
		});

		expect(calls).toEqual([
			"removeCachedVault:vault_1:account_1",
			"refreshVaultKeys:account_1",
			"invalidateVaultKeys",
		]);
	});
});
