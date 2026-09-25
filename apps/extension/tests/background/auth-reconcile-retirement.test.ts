import { expect, mock, spyOn, test } from "bun:test";
import path from "node:path";
import {
	lockAllAccounts,
	NO_CREDENTIAL_MIRROR,
} from "@bittery/core/services/account-lifecycle";
import { ClientRuntime } from "@bittery/core/services/client-runtime";
import type { MaterialPublication } from "@bittery/core/services/material-publication";
import { getTravelModeEnforcer } from "@bittery/core/services/travel-mode-enforcer";
import { createVaultCrypto } from "@bittery/core/services/vault-crypto";
import { VaultRepository } from "@bittery/core/services/vault-repository";
import {
	accountMetadata,
	createTestAccountStore,
	createTestItemCache,
	mukRefFor,
} from "../../../../packages/core/src/testing/account-store-harness";

const background = path.resolve(import.meta.dir, "../../src/background");
const lib = path.resolve(import.meta.dir, "../../src/lib");
const accountId = "auth-handoff-account";
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
mock.module(path.join(lib, "storage.ts"), () => ({
	storage: store,
	itemCache: cache,
}));
mock.module(path.join(lib, "crypto.ts"), () => ({ crypto }));
mock.module(path.join(lib, "vault-runtime.ts"), () => ({
	vaultRepository: repository,
}));
mock.module(path.join(background, "session-manager.ts"), () => ({
	setMasterUnlockKey: () => {},
	setDesktopModeSentinel: () => {},
	isUnlocked: () => false,
	updateActivity: () => {},
}));
mock.module("@bittery/shared/api-client-factory", () => ({
	createApiClientForServer: () => ({}),
}));
let delivery: typeof import("../../src/background/native-messaging-client")["nativeMessagingClient"];
let freshPublication: MaterialPublication;
mock.module("@bittery/core/services/auth-service", () => ({
	isSRPCredentialRejectedError: () => false,
	performSRPLogin: async () => ({
		masterUnlockKey: await mukRefFor(crypto, accountId),
	}),
	performSRPUnlock: async () => {
		throw new Error("unused");
	},
	storeUnlockSessionOwned: async () => {
		throw new Error("unused");
	},
	storeLoginSessionOwned: async (
		_result: unknown,
		_secret: unknown,
		_storage: unknown,
		_cache: unknown,
		_crypto: unknown,
		_email: unknown,
		options: {
			materialPublication: typeof freshPublication;
			onSessionStored: () => Promise<void>;
		},
	) => {
		await options.materialPublication.run(accountId, async () => {
			await store.setMasterUnlockKey(
				await mukRefFor(crypto, accountId),
				accountId,
			);
		});
		await delivery.retireObservedStatus({ locked: true, timestamp: 1 });
		freshPublication = await (
			await import(path.join(background, "local-material-publication.ts"))
		).localMaterialPublication.capture();
		await freshPublication.run(accountId, async () => {
			await store.setMasterUnlockKey(
				await mukRefFor(crypto, accountId),
				accountId,
			);
		});
		try {
			await options.onSessionStored();
		} catch {
			// The real auth service logs this reconciliation failure and keeps the stored Session.
		}
		return accountId;
	},
}));
const { nativeMessagingClient } = await import(
	path.join(background, "native-messaging-client.ts")
);
delivery = nativeMessagingClient;
const { handleLogin } = await import(path.join(background, "auth-handlers.ts"));
const { reconcileClientRuntime } = await import(
	path.join(background, "vault-runtime.ts")
);
let policyChecks = 0;
const runtime = new ClientRuntime({
	storage: store,
	itemCache: cache,
	vaultRepository: repository,
	materialPublication: (
		await import(path.join(background, "local-material-publication.ts"))
	).localMaterialPublication,
	verifyUnlockPolicy: async () => {
		policyChecks++;
	},
});
delivery.configureRetirementCleanup(async () => {
	await lockAllAccounts({
		storage: store,
		itemCache: cache,
		credentialMirror: NO_CREDENTIAL_MIRROR,
	});
	runtime.accounts.retireUnlockedProjection();
});

test("Login's old onSessionStored reconciliation cannot borrow a fresh successor delivery", async () => {
	await expect(
		handleLogin(
			{
				email: "auth-handoff-account@test.com",
				password: "password",
				secretKey: "secret",
				serverUrl: "https://app.bittery.io",
			},
			runtime,
		),
	).rejects.toThrow("Native delivery retired");
	expect(policyChecks).toBe(0);
	expect(runtime.accounts.getUnlockedAccountIds()).toEqual([]);

	await reconcileClientRuntime(runtime);
	expect(policyChecks).toBe(1);
	expect(runtime.accounts.getUnlockedAccountIds()).toEqual([accountId]);

	let releaseHydration!: () => void;
	let hydrationEntered!: () => void;
	const heldHydration = new Promise<void>((resolve) => {
		releaseHydration = resolve;
	});
	const entered = new Promise<void>((resolve) => {
		hydrationEntered = resolve;
	});
	const actualHydrate = repository.hydrateLocalAccounts.bind(repository);
	spyOn(repository, "hydrateLocalAccounts").mockImplementation(
		async (accounts) => {
			if (accounts.length > 0) {
				hydrationEntered();
				await heldHydration;
			}
			await actualHydrate(accounts);
		},
	);
	const current = await (
		await import(path.join(background, "local-material-publication.ts"))
	).localMaterialPublication.capture();
	const oldReconcile = reconcileClientRuntime(runtime, current);
	await entered;
	await delivery.retireObservedStatus({ locked: true, timestamp: 2 });
	releaseHydration();
	await expect(oldReconcile).rejects.toThrow("Native delivery retired");
	expect(runtime.vaultRuntime.getSnapshot().accounts).toEqual([]);
});
