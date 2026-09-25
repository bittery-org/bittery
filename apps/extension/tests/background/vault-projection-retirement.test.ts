import { expect, spyOn, test } from "bun:test";
import { NO_CREDENTIAL_MIRROR } from "@bittery/core/services/account-lifecycle";
import { ClientRuntime } from "@bittery/core/services/client-runtime";
import { getTravelModeEnforcer } from "@bittery/core/services/travel-mode-enforcer";
import { createVaultCrypto } from "@bittery/core/services/vault-crypto";
import { VaultRepository } from "@bittery/core/services/vault-repository";
import {
	accountMetadata,
	createTestAccountStore,
	createTestItemCache,
	mukRefFor,
} from "../../../../packages/core/src/testing/account-store-harness";
import { NativeMessagingClient } from "../../src/background/native-messaging-client";
import { createLifecycleAdapter } from "../../src/background/vault-session/adapters/lifecycle-adapter";

const accountId = "projection-account";

function deferred() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => (release = resolve));
	return { promise, release };
}

async function settle() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function setup() {
	const { store, crypto } = await createTestAccountStore();
	const { cache } = await createTestItemCache();
	await store.addAccount(accountMetadata({ accountId }));
	await store.setActiveAccount(accountId);
	await getTravelModeEnforcer(store, cache).applyConfig(accountId, {
		enabled: false,
		hiddenVaultIds: [],
	});
	const repository = new VaultRepository(
		crypto,
		createVaultCrypto({ crypto, storage: store }),
		store,
		cache,
	);
	const delivery = new NativeMessagingClient();
	const runtime = new ClientRuntime({
		storage: store,
		itemCache: cache,
		vaultRepository: repository,
		verifyUnlockPolicy: async () => {},
		materialPublication: {
			async capture() {
				const generation = await delivery.captureDeliveryGeneration();
				return {
					check: () => delivery.assertCurrentDelivery(generation),
					isCurrent: () => delivery.isCurrentDelivery(generation),
					run: (id, publish, installed) =>
						delivery.withLocalMaterialMutation(
							generation,
							id,
							publish,
							installed,
						),
				};
			},
		},
	});
	delivery.configureProjectionRetirement((accountIds) =>
		runtime.accounts.retireUnlockedProjection(accountIds),
	);
	await runtime.accounts.initializeLocalVaultState();
	runtime.start();
	await settle();
	const scopes: string[][] = [];
	const actualSetScope = repository.setLocalActiveAccounts.bind(repository);
	spyOn(repository, "setLocalActiveAccounts").mockImplementation((accounts) => {
		scopes.push(accounts.map((account) => account.accountId));
		actualSetScope(accounts);
	});
	const lifecycle = createLifecycleAdapter({
		deps: {
			storage: store,
			itemCache: cache,
			credentialMirror: NO_CREDENTIAL_MIRROR,
		},
		delivery,
	});
	delivery.configureRetirementCleanup(async () => lifecycle.lockAll());
	return { store, crypto, repository, runtime, delivery, lifecycle, scopes };
}

async function publishUnlock(owned: Awaited<ReturnType<typeof setup>>) {
	await owned.store.setMasterUnlockKey(
		await mukRefFor(owned.crypto, accountId),
		accountId,
	);
	await owned.runtime.accounts.refresh();
	for (
		let attempt = 0;
		attempt < 50 && owned.runtime.vaultRuntime.getSnapshot().isLoading;
		attempt++
	) {
		await Bun.sleep(0);
	}
	expect(owned.runtime.accounts.isUnlocked(accountId)).toBe(true);
	expect(
		owned.runtime.vaultRuntime.getSnapshot().accounts.map((a) => a.accountId),
	).toEqual([accountId]);
	expect(owned.runtime.vaultRuntime.getSnapshot().isLoading).toBe(false);
	expect(owned.repository.isAccountHydrated(accountId)).toBe(true);
}

test("ordinary C1 Lock and ownerless native retirement close an already emitted shared Vault projection", async () => {
	const owned = await setup();
	await publishUnlock(owned);
	await owned.lifecycle.lockAll();
	await settle();
	expect(owned.runtime.accounts.getUnlockedAccountIds()).toEqual([]);
	expect(owned.runtime.vaultRuntime.getSnapshot().accounts).toEqual([]);
	expect(owned.scopes.at(-1)).toEqual([]);
	expect(owned.repository.isAccountHydrated(accountId)).toBe(false);

	await publishUnlock(owned);
	await owned.delivery.retireObservedStatus({ locked: true, timestamp: 1 });
	await settle();
	expect(owned.runtime.accounts.getUnlockedAccountIds()).toEqual([]);
	expect(owned.runtime.vaultRuntime.getSnapshot().unlockedAccounts).toEqual([]);
	expect(owned.scopes.at(-1)).toEqual([]);

	const generation = await owned.delivery.captureDeliveryGeneration();
	await owned.delivery.withMaterialMutation(
		generation,
		accountId,
		async (check, markMaterialWrite) => {
			markMaterialWrite();
			await owned.store.setMasterUnlockKey(
				await mukRefFor(owned.crypto, accountId),
				accountId,
			);
			check();
		},
	);
	await owned.runtime.accounts.refresh();
	await settle();
	expect(owned.runtime.accounts.isUnlocked(accountId)).toBe(true);
	expect(
		owned.runtime.vaultRuntime.getSnapshot().accounts.map((a) => a.accountId),
	).toEqual([accountId]);
});

test("C1 acknowledgement revokes held real listener hydration before it may publish", async () => {
	const owned = await setup();
	const entered = deferred();
	const held = deferred();
	const actualHydrate = owned.repository.hydrateLocalAccounts.bind(
		owned.repository,
	);
	spyOn(owned.repository, "hydrateLocalAccounts").mockImplementation(
		async (accounts) => {
			if (accounts.length > 0) {
				entered.release();
				await held.promise;
			}
			await actualHydrate(accounts);
		},
	);
	await owned.store.setMasterUnlockKey(
		await mukRefFor(owned.crypto, accountId),
		accountId,
	);
	await owned.runtime.accounts.refresh();
	await entered.promise;
	expect(owned.runtime.vaultRuntime.getSnapshot().isLoading).toBe(true);
	await owned.delivery.retireObservedStatus({ locked: true, timestamp: 2 });
	expect(owned.runtime.accounts.getUnlockedAccountIds()).toEqual([]);
	expect(owned.runtime.vaultRuntime.getSnapshot().accounts).toEqual([]);
	expect(owned.scopes.at(-1)).toEqual([]);
	held.release();
	await settle();
	expect(owned.runtime.vaultRuntime.getSnapshot().accounts).toEqual([]);
});

test("incomplete C1 closes the public descriptor and keeps fresh admission fenced", async () => {
	const owned = await setup();
	await publishUnlock(owned);
	spyOn(owned.store, "lockAllAccounts").mockImplementation(async () => {
		throw new Error("storage lock failed");
	});
	await expect(owned.lifecycle.lockAll()).rejects.toThrow(
		"did not complete safely",
	);
	await settle();
	expect(owned.runtime.accounts.getUnlockedAccountIds()).toEqual([]);
	expect(owned.runtime.vaultRuntime.getSnapshot().accounts).toEqual([]);
	await expect(owned.delivery.captureDeliveryGeneration()).rejects.toThrow(
		"did not complete safely",
	);
});
