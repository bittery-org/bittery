import { expect, spyOn, test } from "bun:test";
import {
	lockAllAccounts,
	NO_CREDENTIAL_MIRROR,
	requireCompleteLifecycleOutcome,
} from "@bittery/core/services/account-lifecycle";
import { AccountSessionManager } from "@bittery/core/services/account-session-manager";
import type { MaterialPublicationSource } from "@bittery/core/services/material-publication";
import { getTravelModeEnforcer } from "@bittery/core/services/travel-mode-enforcer";
import { unlockAllWithPassword } from "@bittery/core/services/unlock";
import type { KdfProfile } from "@bittery/crypto-port";
import { createInMemoryCryptoPort } from "@bittery/crypto-port/testing";
import {
	accountMetadata,
	createTestAccountStore,
	createTestItemCache,
	mukRefFor,
} from "../../../../packages/core/src/testing/account-store-harness";
import { NativeMessagingClient } from "../../src/background/native-messaging-client";

function deferred() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => (release = resolve));
	return { promise, release };
}

function fixture() {
	const client = new NativeMessagingClient();
	const accountId = "account-a";
	const account = {
		accountId,
		email: "a@example.test",
		userId: "user-a",
		name: "A",
		serverUrl: "https://example.test",
		secretKeyHint: "A3",
		addedAt: 1,
		lastActiveAt: 1,
		biometricEnabled: false,
		insecureTransportConfirmed: false,
	};
	let material = true;
	let retireProjection: (() => void) | null = null;
	let clearHeld: ReturnType<typeof deferred> | null = null;
	const clearEntered = deferred();
	const storage = {
		getAccountsList: async () => [account],
		getActiveAccount: async () => accountId,
		getUnlockedAccounts: async () => (material ? [accountId] : []),
		getMasterUnlockKey: async () => (material ? new Uint8Array([1]) : null),
		tryRestoreSession: async () => material,
		tryRestoreSessionWithoutPrompt: async () => material,
		getAuthToken: async () => "token",
		getServerUrl: async () => account.serverUrl,
		getTravelModeCache: async () => null,
		clearSession: async () => {
			clearEntered.release();
			if (clearHeld) await clearHeld.promise;
			material = false;
		},
		lockAllAccounts: async () => {
			material = false;
		},
	};
	const publication: MaterialPublicationSource = {
		async capture() {
			const generation = await client.captureDeliveryGeneration();
			return {
				check: () => client.assertCurrentDelivery(generation),
				isCurrent: () => client.isCurrentDelivery(generation),
				captureCleanup: (id) =>
					client.captureMaterialFailureCleanup(generation, id),
				run: (id, write, installed) =>
					client.withLocalMaterialMutation(generation, id, write, installed),
			};
		},
	};
	client.configureRetirementCleanup(async () => {
		await client.withLifecycleCleanup(async () => {
			await storage.lockAllAccounts();
		}, "all");
		retireProjection?.();
	});
	return {
		client,
		storage,
		publication,
		accountId,
		clearEntered,
		holdClear() {
			clearHeld = deferred();
			return clearHeld;
		},
		setMaterial(value: boolean) {
			material = value;
		},
		onProjectionRetired(callback: () => void) {
			retireProjection = callback;
		},
		get material() {
			return material;
		},
	};
}

test("actual AccountSessionManager Travel cleanup drains before C1 admits a successor", async () => {
	const f = fixture();
	const held = f.holdClear();
	const manager = new AccountSessionManager({
		storage: f.storage as never,
		itemCache: {} as never,
		materialPublication: f.publication,
		verifyUnlockPolicy: async () => {
			throw new Error("Travel verification failed");
		},
	});
	const unlock = manager.unlockAccount(f.accountId);
	await f.clearEntered.promise;
	let retired = false;
	const retirement = f.client
		.retireObservedStatus({ locked: true, timestamp: 1 })
		.then(() => (retired = true));
	await new Promise((resolve) => setTimeout(resolve, 0));
	try {
		expect(retired).toBe(false);
	} finally {
		held.release();
	}
	await Promise.allSettled([unlock, retirement]);
	const fresh = await f.client.captureDeliveryGeneration();
	await f.client.withLocalMaterialMutation(fresh, f.accountId, async () => {
		f.setMaterial(true);
	});
	expect(f.material).toBe(true);
});

test("actual refresh cannot emit an unlocked snapshot after native retirement", async () => {
	const f = fixture();
	const verificationEntered = deferred();
	const verificationHeld = deferred();
	const manager = new AccountSessionManager({
		storage: f.storage as never,
		itemCache: {} as never,
		materialPublication: f.publication,
		verifyUnlockPolicy: async () => {
			verificationEntered.release();
			await verificationHeld.promise;
		},
	});
	const observed: string[][] = [];
	manager.subscribe(() => observed.push(manager.getUnlockedAccountIds()));
	const refresh = manager.refresh();
	await verificationEntered.promise;
	await f.client.retireObservedStatus({ locked: true, timestamp: 1 });
	verificationHeld.release();
	await Promise.allSettled([refresh]);
	expect(manager.getUnlockedAccountIds()).toEqual([]);
	expect(observed).not.toContainEqual([f.accountId]);
});

test("startup's local unlocked projection is cleared when its verified refresh retires", async () => {
	const f = fixture();
	const verificationEntered = deferred();
	const verificationHeld = deferred();
	const manager = new AccountSessionManager({
		storage: f.storage as never,
		itemCache: {} as never,
		materialPublication: f.publication,
		verifyUnlockPolicy: async () => {
			verificationEntered.release();
			await verificationHeld.promise;
		},
	});
	f.onProjectionRetired(() => manager.retireUnlockedProjection());
	const initialized = manager.initialize();
	await verificationEntered.promise;
	expect(manager.getUnlockedAccountIds()).toEqual([f.accountId]);
	await f.client.retireObservedStatus({ locked: true, timestamp: 1 });
	verificationHeld.release();
	await Promise.allSettled([initialized]);
	expect(manager.getUnlockedAccountIds()).toEqual([]);
});

test("refresh refuses a same-generation replacement during its final storage read", async () => {
	const f = fixture();
	const finalReadEntered = deferred();
	const finalReadHeld = deferred();
	const readUnlocked = f.storage.getUnlockedAccounts;
	let reads = 0;
	f.storage.getUnlockedAccounts = async () => {
		reads += 1;
		if (reads === 2) {
			finalReadEntered.release();
			await finalReadHeld.promise;
		}
		return readUnlocked();
	};
	const manager = new AccountSessionManager({
		storage: f.storage as never,
		itemCache: {} as never,
		materialPublication: f.publication,
		verifyUnlockPolicy: async () => {},
	});
	const observed: string[][] = [];
	manager.subscribe(() => observed.push(manager.getUnlockedAccountIds()));
	const refresh = manager.refresh();
	await finalReadEntered.promise;
	const generation = await f.client.captureDeliveryGeneration();
	await f.client.withLocalMaterialMutation(
		generation,
		f.accountId,
		async () => {
			f.setMaterial(true);
		},
	);
	finalReadHeld.release();
	await expect(refresh).rejects.toThrow(
		"Account material publication superseded",
	);
	expect(observed).not.toContainEqual([f.accountId]);
});

test("same-generation local publication supersedes an older Travel failure cleanup", async () => {
	const f = fixture();
	const verificationEntered = deferred();
	const verificationHeld = deferred();
	const manager = new AccountSessionManager({
		storage: f.storage as never,
		itemCache: {} as never,
		materialPublication: f.publication,
		verifyUnlockPolicy: async () => {
			verificationEntered.release();
			await verificationHeld.promise;
			throw new Error("old Travel verification failed");
		},
	});
	await manager.initializeLocalVaultState();
	expect(manager.isUnlocked(f.accountId)).toBe(true);
	const unlock = manager.unlockAccount(f.accountId);
	await verificationEntered.promise;
	const generation = await f.client.captureDeliveryGeneration();
	await f.client.withLocalMaterialMutation(
		generation,
		f.accountId,
		async () => {
			f.setMaterial(true);
		},
	);
	verificationHeld.release();
	await expect(unlock).rejects.toThrow(
		"Account material publication superseded",
	);
	expect(f.material).toBe(true);
	expect(manager.isUnlocked(f.accountId)).toBe(true);
});

test("actual password Unlock All Travel cleanup drains before native C1", async () => {
	const client = new NativeMessagingClient();
	const crypto = createInMemoryCryptoPort();
	crypto.verifyServerSession = async () => {};
	const { store: storage } = await createTestAccountStore({ crypto });
	const { cache: itemCache } = await createTestItemCache();
	const accountId = "account-a";
	const email = "a@example.test";
	const profile: KdfProfile = {
		schemaVersion: 1,
		algorithm: "pbkdf2-sha256",
		iterations: 600_000,
	};
	await storage.addAccount(accountMetadata({ accountId, email }));
	await storage.storeServerUrl("http://127.0.0.1:1", accountId);
	const sessionKey = await mukRefFor(crypto, accountId);
	await storage.storeSessionData(sessionKey, accountId, email, accountId);
	await crypto.destroyKey(sessionKey);
	await storage.storeAuthToken("old-token", accountId);
	await storage.storeSecretKey("A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2", accountId);
	await storage.storePinnedKdfProfile(profile, accountId);
	await storage.lockAllAccounts();
	const entered = deferred();
	const held = deferred();
	const clear = storage.clearSession.bind(storage);
	spyOn(storage, "clearSession").mockImplementation(async (id) => {
		entered.release();
		await held.promise;
		await clear(id);
	});
	const publication = await (async () => {
		const generation = await client.captureDeliveryGeneration();
		return {
			check: () => client.assertCurrentDelivery(generation),
			isCurrent: () => client.isCurrentDelivery(generation),
			captureCleanup: (id: string) =>
				client.captureMaterialFailureCleanup(generation, id),
			run: <T>(
				id: string,
				write: (check: () => void) => Promise<T>,
				installed?: (result: T) => boolean,
			) => client.withLocalMaterialMutation(generation, id, write, installed),
		};
	})();
	client.configureRetirementCleanup(async () => {
		await client.withLifecycleCleanup(async () => {
			requireCompleteLifecycleOutcome(
				await lockAllAccounts({
					storage,
					itemCache,
					credentialMirror: NO_CREDENTIAL_MIRROR,
				}),
				{ operation: "native C1" },
			);
		}, "all");
	});
	const unlock = unlockAllWithPassword(
		{ password: "pw", accountIds: [accountId] },
		{
			storage,
			itemCache,
			crypto,
			credentialMirror: NO_CREDENTIAL_MIRROR,
			materialPublication: publication,
			accountAuthClientFactory: async () => ({
				auth: {
					checkEmail: async () => ({ data: { exists: true } }),
					startLogin: async () => ({
						data: {
							attemptId: "attempt-a",
							salt: "srp-salt",
							serverPublicKey: "server-public",
							kdfParams: profile,
						},
					}),
					finishLogin: async () => ({
						data: {
							token: "fresh-token",
							sessionId: "fresh-session",
							serverProof: "server-proof",
							user: {
								id: "user-account-a",
								email,
								name: "A",
								secretKeyHint: "A3",
								publicKey: "public-key",
								encryptedPrivateKey: "encrypted-private-key",
								teamName: "Solo",
								teamAvatarUrl: null,
							},
							expiresAt: new Date(Date.now() + 60_000).toISOString(),
							vaultKeys: { items: [], hasMore: false },
						},
					}),
					drainVaultKeys: async (_token, initialPage) => ({
						data: initialPage.items,
					}),
				},
			}),
		},
	);
	await entered.promise;
	let retired = false;
	const retirement = client
		.retireObservedStatus({ locked: true, timestamp: 1 })
		.then(() => {
			retired = true;
		});
	await new Promise((resolve) => setTimeout(resolve, 0));
	try {
		expect(retired).toBe(false);
	} finally {
		held.release();
	}
	await Promise.allSettled([unlock, retirement]);
	const fresh = await client.captureDeliveryGeneration();
	await client.withLocalMaterialMutation(fresh, accountId, async () => {
		await storage.storeAuthToken("successor-token", accountId);
	});
	expect(await storage.getAuthToken(accountId)).toBe("successor-token");
});

test("actual Travel enforcer cleanup used by native biometric callers drains before C1", async () => {
	const f = fixture();
	const held = f.holdClear();
	const generation = await f.client.captureDeliveryGeneration();
	const cleanup = f.client.captureMaterialFailureCleanup(
		generation,
		f.accountId,
	);
	const enforcer = getTravelModeEnforcer(f.storage as never, {} as never);
	const verify = enforcer.verifyOrClear(
		f.accountId,
		null,
		NO_CREDENTIAL_MIRROR,
		cleanup,
	);
	await f.clearEntered.promise;
	let retired = false;
	const retirement = f.client
		.retireObservedStatus({ locked: true, timestamp: 1 })
		.then(() => (retired = true));
	await new Promise((resolve) => setTimeout(resolve, 0));
	try {
		expect(retired).toBe(false);
	} finally {
		held.release();
	}
	await Promise.allSettled([verify, retirement]);
	const fresh = await f.client.captureDeliveryGeneration();
	await f.client.withLocalMaterialMutation(fresh, f.accountId, async () => {
		f.setMaterial(true);
	});
	expect(f.material).toBe(true);
});
