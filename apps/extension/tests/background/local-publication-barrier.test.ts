import { expect, mock, test } from "bun:test";
import path from "node:path";
import {
	lockAllAccounts,
	NO_CREDENTIAL_MIRROR,
	requireCompleteLifecycleOutcome,
} from "@bittery/core/services/account-lifecycle";
import { AccountSessionManager } from "@bittery/core/services/account-session-manager";

const background = path.resolve(import.meta.dir, "../../src/background");
const accountId = "local-account";
const account = {
	accountId,
	email: "local@example.test",
	userId: "user-1",
	name: "Local",
	serverUrl: "https://example.test",
	secretKeyHint: "A3",
	addedAt: 1,
	lastActiveAt: 1,
	biometricEnabled: false,
	insecureTransportConfirmed: false,
};
let muk: Uint8Array | null = null;
let restoreMode: "install" | "present" | "false" = "install";
let releaseLock!: () => void;
let lockEntered!: () => void;
const lockStarted = new Promise<void>((resolve) => (lockEntered = resolve));
const lockHeld = new Promise<void>((resolve) => (releaseLock = resolve));
const storage = {
	getAccountsList: async () => [account],
	getActiveAccount: async () => accountId,
	getAuthToken: async () => "token",
	getServerUrl: async () => "https://example.test",
	getUnlockedAccounts: async () => (muk ? [accountId] : []),
	getMasterUnlockKey: async () => muk,
	tryRestoreSession: async () => {
		if (restoreMode === "false") return false;
		if (restoreMode === "present") return muk !== null;
		muk = new Uint8Array([7]);
		return true;
	},
	lockAllAccounts: async () => {
		lockEntered();
		await lockHeld;
		muk = null;
	},
};
const itemCache = { clearItemCache: async () => {} };
mock.module(path.resolve(background, "../lib/storage.ts"), () => ({ storage }));
const { restoreUnlockedSessions } = await import(
	path.join(background, "services/session-restore.ts")
);
const { nativeMessagingClient } = await import(
	path.join(background, "native-messaging-client.ts")
);
const sessions = new AccountSessionManager({
	storage: storage as never,
	itemCache: itemCache as never,
	credentialMirror: NO_CREDENTIAL_MIRROR,
	verifyUnlockPolicy: async () => {},
});

test("actual no-op restore does not relabel native material as local", async () => {
	const generation = await nativeMessagingClient.captureDeliveryGeneration();
	await nativeMessagingClient.withMaterialMutation(
		generation,
		accountId,
		async (_check, markMaterialWrite) => {
			markMaterialWrite();
			return true;
		},
	);
	muk = new Uint8Array([8]);
	restoreMode = "present";
	const present = await restoreUnlockedSessions(sessions);
	expect(present.accountIds).toEqual([accountId]);
	expect(nativeMessagingClient.needsMaterialCleanup()).toBe(true);
	muk = null;
	restoreMode = "false";
	const absent = await restoreUnlockedSessions(sessions);
	expect(absent.accountIds).toEqual([]);
	expect(nativeMessagingClient.needsMaterialCleanup()).toBe(true);
});

test("actual restore waits for held native C1 before publishing the same Account", async () => {
	restoreMode = "install";
	muk = null;
	nativeMessagingClient.configureRetirementCleanup(async () => {
		await nativeMessagingClient.withLifecycleCleanup(async () => {
			requireCompleteLifecycleOutcome(
				await lockAllAccounts({
					storage: storage as never,
					itemCache: itemCache as never,
					credentialMirror: NO_CREDENTIAL_MIRROR,
				}),
				{ operation: "held native C1" },
			);
		}, "all");
	});
	const retirement = nativeMessagingClient.retireObservedStatus({
		locked: true,
		timestamp: 1,
	});
	await lockStarted;
	let restoreSettled = false;
	const restoring = restoreUnlockedSessions(sessions).then((value) => {
		restoreSettled = true;
		return value;
	});
	await Promise.resolve();
	await Promise.resolve();
	try {
		expect(restoreSettled).toBe(false);
		expect(muk).toBeNull();
	} finally {
		releaseLock();
	}
	await retirement;
	const restored = await restoring;
	expect(restored.accountIds).toEqual([accountId]);
	expect(muk).not.toBeNull();
});
