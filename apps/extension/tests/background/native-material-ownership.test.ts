import { expect, mock, test } from "bun:test";
import path from "node:path";

const background = path.resolve(import.meta.dir, "../../src/background");
const lib = path.resolve(import.meta.dir, "../../src/lib");
const accountId = "native-account";
const localAccountId = "local-account";
let token: string | null = "old-token";
let vaultKeys: unknown[] | null = null;
let muk: Uint8Array | null = null;
let localMuk = true;
let failSetter = true;
let failClearSession = false;
let failBiometricPreference = false;
let restoreSucceeds = false;
let clearSessionCount = 0;
let lockAllCount = 0;
let restoreCount = 0;
let hydratedVaultKeys: string | null = null;
let setterEntered!: () => void;
let releaseSetter!: () => void;
let setterStarted!: Promise<void>;
let setterGate!: Promise<void>;
function holdNextSetter(): void {
	setterStarted = new Promise<void>((resolve) => (setterEntered = resolve));
	setterGate = new Promise<void>((resolve) => (releaseSetter = resolve));
}
holdNextSetter();

mock.module(path.join(lib, "storage.ts"), () => ({
	storage: {
		getAccountsList: async () => [
			{ accountId, email: "native@example.test" },
			{ accountId: localAccountId, email: "local@example.test" },
		],
		getActiveAccount: async () => accountId,
		getAccountMetadata: async (id: string) => ({ accountId: id }),
		getAuthToken: async (id: string) =>
			id === accountId ? token : "local-token",
		getServerUrl: async () => "https://example.test",
		storeAuthToken: async (value: string, id: string) => {
			if (id === accountId) token = value;
		},
		getVaultKeys: async () => vaultKeys,
		storeVaultKeys: async (value: unknown[], id: string) => {
			if (failSetter && id === accountId) {
				setterEntered();
				await setterGate;
				throw new Error("setter failed after token publication");
			}
			vaultKeys = value;
		},
		getMasterUnlockKey: async () => muk,
		setMasterUnlockKey: async (value: Uint8Array, id: string) => {
			if (id === accountId) muk = value;
			else localMuk = true;
		},
		setBiometricEnabled: async () => {
			if (failBiometricPreference) throw new Error("preference write failed");
		},
		tryRestoreSession: async () => {
			restoreCount += 1;
			return restoreSucceeds;
		},
		clearSession: async () => {
			clearSessionCount += 1;
			if (failClearSession) throw new Error("clearSession failed");
			token = null;
			vaultKeys = null;
			muk = null;
		},
		lockAllAccounts: async () => {
			lockAllCount += 1;
			muk = null;
			localMuk = false;
		},
	},
	itemCache: { clearItemCache: async () => {} },
}));
mock.module(path.join(lib, "crypto.ts"), () => ({
	crypto: {
		importKey: async (value: Uint8Array) => value,
		decrypt: async () => btoa("muk"),
		destroyKey: async () => {},
	},
}));
mock.module(path.join(background, "biometric-transfer.ts"), () => ({
	requestSingleBiometricTransfer: async () => ({
		ok: true,
		material: {
			accountId,
			email: "native@example.test",
			deviceKey: new Uint8Array([1]),
			encryptedMuk: { algorithm: "AES-GCM", ciphertext: "x", iv: "iv" },
			authToken: "native-token",
			vaultKeys: [{ vaultId: "native", encryptedVaultKey: "key" }],
		},
	}),
	requestAllBiometricTransfer: async () => ({
		ok: true,
		materials: [accountId, localAccountId].map((id) => ({
			accountId: id,
			email: `${id}@example.test`,
			deviceKey: new Uint8Array([1]),
			encryptedMuk: { algorithm: "AES-GCM", ciphertext: "x", iv: "iv" },
			authToken: "native-token",
			vaultKeys: [{ vaultId: id, encryptedVaultKey: "key" }],
		})),
	}),
	STALE_DESKTOP_UNLOCK_RESPONSE: "stale",
}));
mock.module(path.join(background, "desktop-client.ts"), () => ({
	desktopClient: {
		getAuthToken: async () => null,
		getVaultKeys: async () =>
			hydratedVaultKeys ? { vaultKeys: hydratedVaultKeys } : null,
	},
}));
mock.module(path.join(background, "desktop-status.ts"), () => ({
	isDesktopUnlockedNow: async () => true,
	isDesktopLockedNow: async () => false,
	isDesktopReadAvailable: async () => true,
	getDesktopStatus: async () => null,
}));
mock.module(path.join(background, "desktop-sync.ts"), () => ({
	getDesktopSync: () => ({ getLastStatus: () => null }),
}));
mock.module("@bittery/core/services/account-resolver", () => ({
	createStoredAccountApiClient: async () => ({}),
}));
mock.module("@bittery/core/services/travel-mode-enforcer", () => ({
	getTravelModeEnforcer: () => ({
		verifyOrClear: async () => true,
		filterVaultKeys: (_id: string, keys: unknown[]) => keys,
	}),
}));
mock.module(path.join(background, "session-manager.ts"), () => ({
	setDesktopModeSentinel: () => {},
	setMasterUnlockKey: () => {},
	updateActivity: async () => {},
}));
(globalThis as { chrome?: typeof chrome }).chrome = {
	runtime: { id: "extension-id" },
} as typeof chrome;

const { nativeMessagingClient } = await import(
	path.join(background, "native-messaging-client.ts")
);
const { handleNativeBiometricUnlock, handleNativeBiometricUnlockAll } =
	await import(path.join(background, "native-messaging.ts"));
const { hydrateDesktopAccountMaterial } = await import(
	path.join(background, "desktop-key-material.ts")
);
const { createLifecycleAdapter } = await import(
	path.join(background, "vault-session/adapters/lifecycle-adapter.ts")
);

test("nonmaterial preference failure and already-present MUK do not claim native material", async () => {
	failBiometricPreference = true;
	expect((await handleNativeBiometricUnlock()).success).toBe(false);
	failBiometricPreference = false;
	expect(nativeMessagingClient.needsMaterialCleanup()).toBe(false);
	muk = new Uint8Array([9]);
	restoreSucceeds = true;
	await hydrateDesktopAccountMaterial(accountId);
	expect(nativeMessagingClient.needsMaterialCleanup()).toBe(false);
	muk = null;
	restoreSucceeds = false;
});

test("a queued no-op hydration cannot supersede a partially failed biometric writer", async () => {
	const failingInstall = handleNativeBiometricUnlock();
	await setterStarted;
	const noOpHydration = hydrateDesktopAccountMaterial(accountId);
	await Promise.resolve();
	releaseSetter();
	await noOpHydration;
	expect((await failingInstall).success).toBe(false);
	expect(restoreCount).toBe(2);
	expect(clearSessionCount).toBe(1);
	expect(token).toBeNull();
	await nativeMessagingClient.captureDeliveryGeneration();

	// The successful successor is an actual hydration caller. Observe its
	// public lease admission so A's catch cannot race ahead of B's publication.
	holdNextSetter();
	failSetter = true;
	hydratedVaultKeys = JSON.stringify([
		{ vaultId: "successor", encryptedVaultKey: "new-key" },
	]);
	const oldInstall = handleNativeBiometricUnlock();
	await setterStarted;
	let successorQueued!: () => void;
	const queued = new Promise<void>((resolve) => (successorQueued = resolve));
	const originalMutation = nativeMessagingClient.withMaterialMutation;
	nativeMessagingClient.withMaterialMutation = function (...args) {
		const result = originalMutation.apply(this, args);
		if (args[3] === undefined) successorQueued();
		return result;
	};
	const successor = hydrateDesktopAccountMaterial(accountId);
	await queued;
	nativeMessagingClient.withMaterialMutation = originalMutation;
	failSetter = false;
	releaseSetter();
	expect((await oldInstall).success).toBe(false);
	await successor;
	expect(clearSessionCount).toBe(1);
	expect(token).toBe("native-token");
	expect(vaultKeys).toEqual([
		{ vaultId: "successor", encryptedVaultKey: "new-key" },
	]);
	hydratedVaultKeys = null;
});

test("completed account C1 discharges native ownership before unrelated retirement", async () => {
	failSetter = false;
	expect((await handleNativeBiometricUnlock()).success).toBe(true);
	const lifecycle = createLifecycleAdapter();
	await lifecycle.invalidateSession({ accountId });
	expect(clearSessionCount).toBe(2);
	expect(token).toBeNull();
	localMuk = true; // Independent Extension-local Account unlocked after A's C1.
	nativeMessagingClient.configureRetirementCleanup(async () => {
		if (nativeMessagingClient.needsMaterialCleanup()) await lifecycle.lockAll();
	});
	await nativeMessagingClient.retireObservedStatus(null);
	expect(lockAllCount).toBe(0);
	expect(localMuk).toBe(true);
});

test("all-account biometric failure cleans the failed Account and continues its sibling", async () => {
	failSetter = true;
	const result = await handleNativeBiometricUnlockAll({
		forceLocalUnlock: true,
		preserveActiveAccount: true,
	});
	expect(result.success).toBe(true);
	expect(result.result?.unlocked).toEqual([localAccountId]);
	expect(result.result?.failed.map((entry) => entry.accountId)).toEqual([
		accountId,
	]);
	expect(clearSessionCount).toBe(3);
	expect(token).toBeNull();
	expect(localMuk).toBe(true);
});

const partialCase =
	process.env.NATIVE_MATERIAL_ALL_PARTIAL === "1" ? test : test.skip;
partialCase(
	"all-account partial C1 refuses the sibling's later publication",
	async () => {
		failSetter = false;
		expect((await handleNativeBiometricUnlock()).success).toBe(true);
		failSetter = true;
		failClearSession = true;
		const result = await handleNativeBiometricUnlockAll({
			forceLocalUnlock: true,
			preserveActiveAccount: true,
		});
		expect(result.success).toBe(false);
		expect(clearSessionCount).toBe(4);
		expect(token).toBe("native-token");
		await expect(
			nativeMessagingClient.captureDeliveryGeneration(),
		).rejects.toThrow("did not complete safely");
		await expect(hydrateDesktopAccountMaterial(accountId)).rejects.toThrow(
			"did not complete safely",
		);
	},
);

const singlePartialCase =
	process.env.NATIVE_MATERIAL_ALL_PARTIAL === "1" ? test.skip : test;
singlePartialCase(
	"a partial returned C1 cleanup keeps later material acquisition fenced",
	async () => {
		failSetter = false;
		expect((await handleNativeBiometricUnlock()).success).toBe(true);
		failSetter = true;
		failClearSession = true;
		const result = await handleNativeBiometricUnlock();
		expect(result.success).toBe(false);
		expect(clearSessionCount).toBe(4);
		expect(token).toBe("native-token");
		await expect(
			nativeMessagingClient.captureDeliveryGeneration(),
		).rejects.toThrow("did not complete safely");
		await expect(hydrateDesktopAccountMaterial(accountId)).rejects.toThrow(
			"did not complete safely",
		);
	},
);
