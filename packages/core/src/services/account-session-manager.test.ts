import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { IStorageAdapter } from "@bittery/storage/adapter";
import type { AccountMetadata, ActiveAccount } from "@bittery/storage/types";
import {
	AccountSessionManager,
	resetAccountSessionManagerForTests,
} from "./account-session-manager";

function createMockStorage(
	overrides: Partial<IStorageAdapter> = {},
): IStorageAdapter {
	const accounts: AccountMetadata[] = [
		{
			accountId: "acc-1",
			email: "a@test.com",
			userId: "user-1",
			name: "A",
			secretKeyHint: "ABCD••••",
			addedAt: 1,
			lastActiveAt: 1,
			biometricEnabled: false,
			serverUrl: "https://app.bittery.io",
		},
		{
			accountId: "acc-2",
			email: "b@test.com",
			userId: "user-2",
			name: "B",
			secretKeyHint: "EFGH••••",
			addedAt: 2,
			lastActiveAt: 2,
			biometricEnabled: false,
			serverUrl: "https://app.bittery.io",
		},
	];

	let active: ActiveAccount = { type: "single", accountId: "acc-1" };
	const unlocked = new Set(["acc-1"]);

	return {
		platform: "desktop",
		supportsMultiAccount: true,
		supportsBiometric: false,
		supportsItemCache: true,
		initialize: mock(async () => {}),
		getMasterUnlockKey: mock(async () => null),
		setMasterUnlockKey: mock(async () => {}),
		clearMasterUnlockKey: mock(async () => {}),
		storeSessionData: mock(async () => {}),
		tryRestoreSession: mock(async () => true),
		isSessionValid: mock(async () => true),
		storeSecretKey: mock(async () => {}),
		getStoredSecretKey: mock(async () => null),
		storeAuthToken: mock(async () => {}),
		getAuthToken: mock(async () => "token"),
		storeVaultKeys: mock(async () => {}),
		getVaultKeys: mock(async () => null),
		storeEncryptedPrivateKey: mock(async () => {}),
		getEncryptedPrivateKey: mock(async () => null),
		storePinnedKdfParams: mock(async () => {}),
		getPinnedKdfParams: mock(async () => null),
		getActiveAccount: mock(async () => active),
		getActiveAccountUserId: mock(async () => "user-1"),
		setActiveAccount: mock(async (account: ActiveAccount) => {
			active = account;
		}),
		getAccountsList: mock(async () => accounts),
		addAccount: mock(async () => {}),
		removeAccount: mock(async (accountId: string) => {
			const idx = accounts.findIndex((a) => a.accountId === accountId);
			if (idx >= 0) accounts.splice(idx, 1);
		}),
		storeAutoLockTimeout: mock(async () => {}),
		getAutoLockTimeout: mock(async () => null),
		getAutoLockTimeoutOrDefault: mock(async () => 600_000),
		storeServerUrl: mock(async () => {}),
		getServerUrl: mock(async () => "https://app.bittery.io"),
		isAuthenticated: mock(async () => true),
		canQuickUnlock: mock(async () => true),
		clearSession: mock(async (accountId?: string) => {
			if (accountId) unlocked.delete(accountId);
		}),
		clearAllStoredData: mock(async () => {}),
		lockAllAccounts: mock(async () => {
			unlocked.clear();
		}),
		getUnlockedAccounts: mock(async () => Array.from(unlocked)),
		...overrides,
	} as IStorageAdapter;
}

describe("AccountSessionManager", () => {
	beforeEach(() => {
		resetAccountSessionManagerForTests();
	});

	it("switching A to B leaves A unlocked", async () => {
		const storage = createMockStorage();
		const onActiveChanged = mock(async () => {});
		const manager = new AccountSessionManager({ storage, onActiveChanged });

		await manager.initialize();
		await manager.switchAccount({ type: "single", accountId: "acc-2" });

		expect(storage.clearSession).not.toHaveBeenCalled();
		expect(storage.setActiveAccount).toHaveBeenCalledWith({
			type: "single",
			accountId: "acc-2",
		});
		expect(onActiveChanged).toHaveBeenCalledWith({
			type: "single",
			accountId: "acc-2",
		});
		expect(manager.getActiveAccount()).toEqual({
			type: "single",
			accountId: "acc-2",
		});
		expect(manager.isUnlocked("acc-1")).toBe(true);
		expect(manager.isUnlocked("acc-2")).toBe(true);
	});

	it("switching to an already-unlocked account does not restore it again", async () => {
		const storage = createMockStorage({
			getUnlockedAccounts: mock(async () => ["acc-1", "acc-2"]),
		});
		const manager = new AccountSessionManager({ storage });

		await manager.initialize();
		await manager.switchAccount({ type: "single", accountId: "acc-2" });

		expect(storage.tryRestoreSession).not.toHaveBeenCalled();
		expect(manager.getUnlockedAccountIds().sort()).toEqual(["acc-1", "acc-2"]);
	});

	it("switching to a locked account restores only the target", async () => {
		const storage = createMockStorage({
			tryRestoreSession: mock(async (_skip, accountId) => accountId === "acc-2"),
		});
		const manager = new AccountSessionManager({ storage });

		await manager.initialize();
		await manager.switchAccount({ type: "single", accountId: "acc-2" });

		expect(storage.tryRestoreSession).toHaveBeenCalledWith(true, "acc-2");
		expect(storage.clearSession).not.toHaveBeenCalled();
		expect(manager.isUnlocked("acc-1")).toBe(true);
		expect(manager.isUnlocked("acc-2")).toBe(true);
	});

	it("lockAll clears unlocked state for all accounts", async () => {
		const storage = createMockStorage();
		const manager = new AccountSessionManager({ storage });

		await manager.initialize();
		await manager.lockAll("manual");

		expect(storage.lockAllAccounts).toHaveBeenCalled();
		expect(manager.getUnlockedAccountIds()).toEqual([]);
	});

	it("removeAccount switches to remaining account when active is removed", async () => {
		const storage = createMockStorage();
		const manager = new AccountSessionManager({ storage });

		await manager.initialize();
		await manager.removeAccount("acc-1");

		expect(storage.removeAccount).toHaveBeenCalledWith("acc-1");
		expect(storage.setActiveAccount).toHaveBeenNthCalledWith(1, null);
		expect(storage.setActiveAccount).toHaveBeenNthCalledWith(2, {
			type: "single",
			accountId: "acc-2",
		});
		expect(manager.getActiveAccount()).toEqual({
			type: "single",
			accountId: "acc-2",
		});
	});

	it("removing the only active account persists null", async () => {
		const storage = createMockStorage();
		await storage.removeAccount("acc-2");
		const manager = new AccountSessionManager({ storage });

		await manager.initialize();
		await manager.removeAccount("acc-1");

		expect(storage.setActiveAccount).toHaveBeenLastCalledWith(null);
		expect(await storage.getActiveAccount()).toBeNull();
		expect(manager.getActiveAccount()).toBeNull();
	});

	it("reconstruction after final-account removal does not restore a stale ID", async () => {
		const storage = createMockStorage();
		await storage.removeAccount("acc-2");
		const manager = new AccountSessionManager({ storage });
		await manager.initialize();
		await manager.removeAccount("acc-1");

		const reconstructed = new AccountSessionManager({ storage });
		await reconstructed.initialize();

		expect(reconstructed.getAccounts()).toEqual([]);
		expect(reconstructed.getActiveAccount()).toBeNull();
	});

	it("removing a non-active account does not alter the active account", async () => {
		const storage = createMockStorage();
		const manager = new AccountSessionManager({ storage });

		await manager.initialize();
		await manager.removeAccount("acc-2");

		expect(storage.setActiveAccount).not.toHaveBeenCalled();
		expect(manager.getActiveAccount()).toEqual({
			type: "single",
			accountId: "acc-1",
		});
	});
});
