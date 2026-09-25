import { expect, mock, spyOn, test } from "bun:test";
import path from "node:path";
import {
	lockAccount,
	NO_CREDENTIAL_MIRROR,
} from "@bittery/core/services/account-lifecycle";
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
import {
	NativeMessagingClient,
	nativeMessagingClient,
} from "../../src/background/native-messaging-client";

const background = path.resolve(import.meta.dir, "../../src/background");
const lib = path.resolve(import.meta.dir, "../../src/lib");
const target = "direct-c1-target";
const other = "direct-c1-other";

async function fixture(delivery: NativeMessagingClient) {
	const { store, crypto } = await createTestAccountStore();
	const { cache } = await createTestItemCache();
	for (const accountId of [target, other]) {
		await store.addAccount(accountMetadata({ accountId }));
		await getTravelModeEnforcer(store, cache).applyConfig(accountId, {
			enabled: false,
			hiddenVaultIds: [],
		});
		await store.setMasterUnlockKey(
			await mukRefFor(crypto, accountId),
			accountId,
		);
	}
	await store.setActiveAccount(target);
	const repository = new VaultRepository(
		crypto,
		createVaultCrypto({ crypto, storage: store }),
		store,
		cache,
	);
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
	await runtime.accounts.initializeLocalVaultState();
	runtime.start();
	await runtime.accounts.refresh();
	for (let i = 0; i < 50 && runtime.vaultRuntime.getSnapshot().isLoading; i++)
		await Bun.sleep(0);
	expect(runtime.accounts.getUnlockedAccountIds()).toEqual([target, other]);
	expect(runtime.vaultRuntime.getSnapshot().isLoading).toBe(false);
	expect(
		runtime.vaultRuntime.getSnapshot().accounts.map((a) => a.accountId),
	).toEqual([target]);
	return { store, cache, repository, runtime };
}

const signedOut = await fixture(nativeMessagingClient);
mock.module(path.join(lib, "storage.ts"), () => ({
	storage: signedOut.store,
	itemCache: signedOut.cache,
}));
mock.module(path.join(lib, "vault-runtime.ts"), () => ({
	vaultRepository: signedOut.repository,
}));
mock.module(path.join(background, "vault-runtime.ts"), () => ({
	backgroundClientRuntime: signedOut.runtime,
	reconcileClientRuntime: async (runtime: ClientRuntime) => {
		await runtime.accounts.refresh();
		await runtime.vaultRuntime.retry();
	},
}));
mock.module(path.join(background, "session-manager.ts"), () => ({
	isUnlocked: () => false,
	setDesktopModeSentinel: () => {},
	setMasterUnlockKey: () => {},
	updateActivity: () => {},
}));
const { handleLogout } = await import(
	path.join(background, "auth-handlers.ts")
);
const { vaultSession } = await import(
	path.join(background, "vault-session/index.ts")
);
const { configureDesktopSync, DesktopSyncService } = await import(
	path.join(background, "desktop-sync.ts")
);
configureDesktopSync(new DesktopSyncService(signedOut.runtime.accounts));

test("ownerless incomplete Sign out retires only its real shared Account projection", async () => {
	expect(vaultSession.getSnapshot().owner).toBe("none");
	const actualAccounts = signedOut.store.getAccountsList.bind(signedOut.store);
	let failedRead = false;
	spyOn(signedOut.store, "getAccountsList").mockImplementation(async () => {
		if (!failedRead) {
			failedRead = true;
			throw new Error("bounded Account list read failure");
		}
		return actualAccounts();
	});
	expect(await handleLogout(signedOut.runtime)).toEqual({ success: false });
	expect(failedRead).toBe(true);
	for (let i = 0; i < 20; i++) await Promise.resolve();
	expect(signedOut.runtime.accounts.getUnlockedAccountIds()).toEqual([other]);
	expect(signedOut.runtime.vaultRuntime.getSnapshot().accounts).toEqual([]);
	expect(signedOut.repository.isAccountHydrated(target)).toBe(false);
	await expect(
		nativeMessagingClient.captureDeliveryGeneration(),
	).rejects.toThrow("did not complete safely");
});

test("direct per-Account failure cleanup retires its scope and preserves the other Account", async () => {
	const delivery = new NativeMessagingClient();
	const { store, cache, repository, runtime } = await fixture(delivery);
	// The production background composition connects this same transport seam to
	// the shared runtime.
	delivery.configureProjectionRetirement((ids) =>
		runtime.accounts.retireUnlockedProjection(ids),
	);
	spyOn(store, "getAuthToken").mockImplementation(async () => {
		throw new Error("bounded account storage read failure");
	});
	const generation = await delivery.captureDeliveryGeneration();
	const cleanup = delivery.captureMaterialFailureCleanup(generation, target);
	await expect(
		cleanup.run(() =>
			lockAccount(target, {
				storage: store,
				itemCache: cache,
				credentialMirror: NO_CREDENTIAL_MIRROR,
			}),
		),
	).rejects.toThrow("did not complete safely");
	for (let i = 0; i < 20; i++) await Promise.resolve();
	expect(runtime.accounts.getUnlockedAccountIds()).toEqual([other]);
	expect(runtime.vaultRuntime.getSnapshot().accounts).toEqual([]);
	expect(repository.isAccountHydrated(target)).toBe(false);
	await expect(delivery.captureDeliveryGeneration()).rejects.toThrow(
		"did not complete safely",
	);
});
