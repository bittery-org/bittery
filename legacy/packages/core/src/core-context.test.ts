import { describe, expect, it, mock } from "bun:test";
import type { CryptoPort } from "@bittery/crypto-port";
import type { AccountStore, ItemCache } from "@bittery/storage";
import { createCoreContext } from "./core-context";
import type { AccountVaultRuntime } from "./services/account-vault-runtime";
import type { VaultCrypto } from "./services/vault-crypto";
import type { VaultRepository } from "./services/vault-repository";

describe("CoreContext Vault refresh", () => {
	it("retries local runtime hydration before resolving a remote refresh", async () => {
		const retry = mock(async () => {});
		const repository = {} as VaultRepository;
		const storage = {
			getActiveAccount: mock(async () => null),
		} as unknown as AccountStore;
		const context = createCoreContext({
			storage,
			itemCache: {} as ItemCache,
			crypto: {} as CryptoPort,
			vaultCrypto: {} as VaultCrypto,
			vaultRuntime: { retry, repository } as unknown as AccountVaultRuntime,
			commandQueue: { enqueue: async () => {} },
		});

		await context.refreshActiveVaults();

		expect(retry).toHaveBeenCalledTimes(1);
		expect(storage.getActiveAccount).toHaveBeenCalledTimes(1);
	});

	it("does not resolve remote account state when the local retry still fails", async () => {
		const storage = {
			getActiveAccount: mock(async () => null),
		} as unknown as AccountStore;
		const context = createCoreContext({
			storage,
			itemCache: {} as ItemCache,
			crypto: {} as CryptoPort,
			vaultCrypto: {} as VaultCrypto,
			vaultRuntime: {
				retry: async () => {
					throw new Error("local cache unavailable");
				},
				repository: {} as VaultRepository,
			} as unknown as AccountVaultRuntime,
			commandQueue: { enqueue: async () => {} },
		});

		await expect(context.refreshActiveVaults()).rejects.toThrow(
			"local cache unavailable",
		);
		expect(storage.getActiveAccount).not.toHaveBeenCalled();
	});
});
