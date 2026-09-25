import { beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { selectActiveAccountAfterUnlock } from "@bittery/core/services/select-active-account";
import type { ActiveAccountId } from "@bittery/storage/types";

// Regression coverage for the "Unlock All" password flow in the single-account
// case. The bug: the handler treated the stable IDs in `unlocked` as email
// addresses, so a UUID accountId was discarded and the handler threw
// "No unlocked accounts found".

const bgDir = path.resolve(import.meta.dir, "../../src/background");
const libDir = path.resolve(import.meta.dir, "../../src/lib");

interface StoredAccount {
	accountId: string;
	email: string;
}

let accounts: StoredAccount[] = [];
let activeAccount: ActiveAccountId = null;
/** `null` unlocks every account; otherwise only the listed accountIds unlock. */
let unlockableAccountIds: string[] | null = null;
const setActiveAccountCalls: unknown[] = [];
const getMasterUnlockKeyCalls: (string | undefined)[] = [];
const setMasterUnlockKeyCalls: unknown[] = [];
const forgetSessionCalls: (string | undefined)[] = [];
const clearItemCacheCalls: (string | undefined)[] = [];
let forgetSessionError: Error | null = null;
let canQuickUnlock = true;
let storedAuthToken: string | null = null;
let holdTokenWrite: Promise<void> | null = null;
let tokenWriteEntered: (() => void) | null = null;
let holdForgetSession: Promise<void> | null = null;
let forgetSessionEntered: (() => void) | null = null;

mock.module(path.join(bgDir, "services/account-resolution.ts"), () => ({
	resolveEmailFromAccountId: async (accountId: string) =>
		accounts.find((a) => a.accountId === accountId)?.email,
}));

const storageMock = {
	getAccountsList: async () => accounts,
	hasStoredSecretKey: async () => true,
	canQuickUnlock: async () => canQuickUnlock,
	getAuthToken: async () => storedAuthToken,
	getAccountMetadata: async (accountId: string) =>
		accounts.find((account) => account.accountId === accountId) ?? null,
	getVaultKeys: async () => [{ vaultId: "existing" }],
	storeAuthToken: async (token: string) => {
		tokenWriteEntered?.();
		await holdTokenWrite;
		storedAuthToken = token;
	},
	tryRestoreSession: async () => {},
	getServerUrl: async () => "http://localhost:3000",
	getActiveAccount: async () => activeAccount,
	setActiveAccount: async (value: unknown) => {
		setActiveAccountCalls.push(value);
	},
	getMasterUnlockKey: async (accountId?: string) => {
		getMasterUnlockKeyCalls.push(accountId);
		return new Uint8Array([9]);
	},
	forgetSession: async (accountId?: string) => {
		forgetSessionEntered?.();
		await holdForgetSession;
		if (forgetSessionError) {
			throw forgetSessionError;
		}
		forgetSessionCalls.push(accountId);
		storedAuthToken = null;
	},
};

mock.module(path.join(libDir, "storage.ts"), () => ({
	storage: storageMock,
	// Sibling of `storage`; the handlers now sequence both (packages/storage/CONTEXT.md §4.2).
	itemCache: {
		clearItemCache: async (accountId?: string) => {
			clearItemCacheCalls.push(accountId);
		},
	},
}));

// Stands in for the SRP/network half of `unlockAllWithPassword` only. The active-account
// selection and the write it performs are the real ones, because that is the
// part of the contract the handler leans on.
mock.module("@bittery/core/services/unlock", () => ({
	unlockAllWithPassword: async () => {
		const previousActive = activeAccount;
		const unlocked = accounts
			.map((account) => account.accountId)
			.filter((accountId) => unlockableAccountIds?.includes(accountId) ?? true);
		const failed = accounts
			.filter((account) => !unlocked.includes(account.accountId))
			.map((account) => ({
				accountId: account.accountId,
				email: account.email,
				reason: "credential_rejected" as const,
			}));

		if (unlocked.length === 0) {
			return { activeAccountId: undefined, unlocked, failed };
		}

		const activeAccountId = selectActiveAccountAfterUnlock({
			previousActive,
			unlockedAccountIds: unlocked,
			accounts,
		});
		if (activeAccountId) {
			await storageMock.setActiveAccount(activeAccountId);
		}
		return { activeAccountId, unlocked, failed };
	},
}));

mock.module(path.join(libDir, "crypto.ts"), () => ({
	crypto: {},
}));

mock.module(path.join(bgDir, "api-client.ts"), () => ({
	apiClient: {},
}));

let desktopStatus: {
	available: boolean;
	locked: boolean;
	unlockedAccounts?: string[];
} | null = null;

mock.module(path.join(bgDir, "desktop-sync.ts"), () => ({
	getDesktopSync: () => ({
		getLastStatus: () => desktopStatus,
		checkDesktopStatus: async () => desktopStatus,
	}),
}));

let triggerDesktopUnlockResult = true;
let triggerDesktopUnlockCalls = 0;

mock.module(path.join(bgDir, "desktop-client.ts"), () => ({
	desktopClient: {
		triggerDesktopUnlock: async () => {
			triggerDesktopUnlockCalls++;
			return triggerDesktopUnlockResult;
		},
		getAuthToken: async () => "desktop-token",
	},
}));

mock.module(path.join(bgDir, "session-manager.ts"), () => ({
	getAutoLockTimeoutCached: () => -1,
	getLastActivityTimestamp: () => Date.now(),
	isDesktopMode: () => false,
	isUnlocked: () => false,
	setDesktopModeSentinel: () => {},
	setMasterUnlockKey: (value: unknown) => {
		setMasterUnlockKeyCalls.push(value);
	},
	updateActivity: () => {},
}));

mock.module("@bittery/core/services/auth-service", () => ({
	performSRPUnlock: async () => ({ masterUnlockKey: new Uint8Array([1]) }),
	storeUnlockSession: async () => {},
	storeUnlockSessionOwned: async (
		result: { masterUnlockKey: Uint8Array },
		_storage: unknown,
		_itemCache: unknown,
		_crypto: unknown,
		accountId: string,
		options: {
			materialPublication?: {
				run: <T>(id: string, write: () => Promise<T>) => Promise<T>;
			};
			onMasterUnlockKeyTransferred?: () => void;
		},
	) => {
		await options.materialPublication?.run(accountId, async () => {
			await storageMock.storeAuthToken("local-unlock-token");
			options.onMasterUnlockKeyTransferred?.();
			return result.masterUnlockKey;
		});
	},
	performSRPLogin: async () => ({ masterUnlockKey: new Uint8Array([2]) }),
	storeLoginSessionOwned: async (
		_result: { masterUnlockKey: Uint8Array },
		_secret: string,
		_storage: unknown,
		_itemCache: unknown,
		_crypto: unknown,
		_email: string,
		options: {
			materialPublication?: {
				run: <T>(id: string, write: () => Promise<T>) => Promise<T>;
			};
			onMasterUnlockKeyTransferred?: () => void;
		},
	) => {
		await options.materialPublication?.run("acc-uuid-1", async () => {
			await storageMock.storeAuthToken("local-login-token");
			options.onMasterUnlockKeyTransferred?.();
		});
		return "acc-uuid-1";
	},
}));

const runtime = { accounts: {}, vaultRuntime: {} };
let reconciledRuntime: unknown;
mock.module(path.join(bgDir, "vault-runtime.ts"), () => ({
	backgroundClientRuntime: { accounts: { retireUnlockedProjection: () => {} } },
	reconcileClientRuntime: async (supplied: unknown) => {
		reconciledRuntime = supplied;
	},
}));

mock.module("@bittery/shared/api-client-factory", () => ({
	createAccountApiClient: () => ({}),
	createApiClientForServer: () => ({}),
	getDefaultServerUrl: () => "http://localhost:3000",
}));

const {
	handleCanQuickUnlock,
	handleLogin,
	handleLogout,
	handleQuickUnlock,
	handleQuickUnlockAll,
} = await import(path.join(bgDir, "auth-handlers.ts"));
const { hydrateDesktopAccountMaterial } = await import(
	path.join(bgDir, "desktop-key-material.ts")
);
const { nativeMessagingClient } = await import(
	path.join(bgDir, "native-messaging-client.ts")
);

beforeEach(() => {
	accounts = [];
	activeAccount = null;
	unlockableAccountIds = null;
	setActiveAccountCalls.length = 0;
	getMasterUnlockKeyCalls.length = 0;
	setMasterUnlockKeyCalls.length = 0;
	forgetSessionCalls.length = 0;
	reconciledRuntime = undefined;
	clearItemCacheCalls.length = 0;
	forgetSessionError = null;
	canQuickUnlock = true;
	storedAuthToken = null;
	holdTokenWrite = null;
	tokenWriteEntered = null;
	holdForgetSession = null;
	forgetSessionEntered = null;
	desktopStatus = null;
	triggerDesktopUnlockResult = true;
	triggerDesktopUnlockCalls = 0;
});

describe("handleCanQuickUnlock", () => {
	test("uses the shared Device-bound material availability rule", async () => {
		accounts = [{ accountId: "acc-uuid-1", email: "a@example.com" }];
		activeAccount = "acc-uuid-1";

		expect(await handleCanQuickUnlock()).toEqual({
			success: true,
			canQuickUnlock: true,
		});

		canQuickUnlock = false;
		expect(await handleCanQuickUnlock()).toEqual({
			success: true,
			canQuickUnlock: false,
		});
	});
});

describe("handleQuickUnlockAll", () => {
	test("single account: sets active account by accountId, not email round-trip", async () => {
		accounts = [{ accountId: "acc-uuid-1", email: "a@example.com" }];

		const response = await handleQuickUnlockAll(
			{ password: "pw" },
			runtime as never,
		);

		expect(response.success).toBe(true);
		expect(response.result).toEqual({
			unlocked: ["acc-uuid-1"],
			failed: [],
		});
		expect(reconciledRuntime).toBe(runtime);
		// The active account must be the unlocked accountId, not undefined.
		expect(setActiveAccountCalls).toEqual(["acc-uuid-1"]);
		// MUK lookup must use the accountId directly.
		expect(getMasterUnlockKeyCalls).toEqual(["acc-uuid-1"]);
		expect(setMasterUnlockKeyCalls.length).toBe(1);
	});

	test("multiple accounts: falls back to the first unlocked account as active", async () => {
		accounts = [
			{ accountId: "acc-uuid-1", email: "a@example.com" },
			{ accountId: "acc-uuid-2", email: "b@example.com" },
		];

		const response = await handleQuickUnlockAll(
			{ password: "pw" },
			runtime as never,
		);

		expect(response.success).toBe(true);
		// All accounts stay unlocked, but the active pointer is a single account.
		expect(setActiveAccountCalls).toEqual(["acc-uuid-1"]);
		// MUK is seeded from the first unlocked accountId.
		expect(getMasterUnlockKeyCalls).toEqual(["acc-uuid-1"]);
	});

	test("multiple accounts: returns the user to the account they were last using", async () => {
		accounts = [
			{ accountId: "acc-uuid-1", email: "a@example.com" },
			{ accountId: "acc-uuid-2", email: "b@example.com" },
		];
		activeAccount = "acc-uuid-2";

		await handleQuickUnlockAll({ password: "pw" }, runtime as never);

		expect(setActiveAccountCalls).toEqual(["acc-uuid-2"]);
		expect(getMasterUnlockKeyCalls).toEqual(["acc-uuid-2"]);
	});

	test("skips a previously active account that did not unlock", async () => {
		accounts = [
			{ accountId: "acc-uuid-1", email: "a@example.com" },
			{ accountId: "acc-uuid-2", email: "b@example.com" },
		];
		activeAccount = "acc-uuid-2";
		unlockableAccountIds = ["acc-uuid-1"];

		const response = await handleQuickUnlockAll(
			{ password: "pw" },
			runtime as never,
		);

		expect(response.result).toEqual({
			unlocked: ["acc-uuid-1"],
			failed: [
				{
					accountId: "acc-uuid-2",
					email: "b@example.com",
					reason: "credential_rejected",
				},
			],
		});
		expect(setActiveAccountCalls).toEqual(["acc-uuid-1"]);
	});

	test("fails when no account unlocks", async () => {
		accounts = [{ accountId: "acc-uuid-1", email: "a@example.com" }];
		unlockableAccountIds = [];

		await expect(
			handleQuickUnlockAll({ password: "pw" }, runtime as never),
		).rejects.toThrow("Failed to unlock any accounts");
		expect(setActiveAccountCalls).toEqual([]);
	});
});

describe("handleLogout", () => {
	test("drains an actual held desktop token write before forgetting the Session", async () => {
		accounts = [{ accountId: "acc-uuid-1", email: "a@example.com" }];
		activeAccount = "acc-uuid-1";
		desktopStatus = {
			available: true,
			locked: false,
			unlockedAccounts: ["acc-uuid-1"],
		};
		let releaseWrite!: () => void;
		holdTokenWrite = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			tokenWriteEntered = resolve;
		});
		let releaseForget!: () => void;
		holdForgetSession = new Promise<void>((resolve) => {
			releaseForget = resolve;
		});
		let forgetBegan = false;
		const forgetting = new Promise<void>((resolve) => {
			forgetSessionEntered = () => {
				forgetBegan = true;
				resolve();
			};
		});
		const hydration = hydrateDesktopAccountMaterial("acc-uuid-1");
		await entered;

		const signOut = handleLogout(runtime as never);
		await Bun.sleep(1);
		let successorAdmitted = false;
		const successor = nativeMessagingClient
			.captureDeliveryGeneration()
			.then(() => {
				successorAdmitted = true;
			});
		await Bun.sleep(10);
		expect(forgetBegan).toBe(false);
		expect(forgetSessionCalls).toEqual([]);
		expect(successorAdmitted).toBe(false);
		releaseWrite();
		await expect(hydration).rejects.toThrow("Native delivery retired");
		await forgetting;
		expect(successorAdmitted).toBe(false);
		releaseForget();
		expect(await signOut).toEqual({ success: true });
		await successor;
		expect(successorAdmitted).toBe(true);
		expect(forgetSessionCalls).toEqual(["acc-uuid-1"]);
		expect(storedAuthToken).toBeNull();
	});

	test("drops the session and its item cache together", async () => {
		accounts = [{ accountId: "acc-uuid-1", email: "a@example.com" }];
		activeAccount = "acc-uuid-1";

		const response = await handleLogout(runtime as never);

		expect(response).toEqual({ success: true });
		expect(clearItemCacheCalls).toEqual(["acc-uuid-1"]);
		expect(forgetSessionCalls).toEqual(["acc-uuid-1"]);
	});
});

// Regression coverage for the extension and the desktop app drifting apart.
// The bug: with the desktop app connected but locked, a password unlock in the
// popup ran a plain SRP unlock and seeded a real MUK. The extension came up
// unlocked while the desktop stayed locked, and nothing ever reconciled them —
// the protocol has no extension -> desktop unlock message.
describe("handleQuickUnlockAll with a connected desktop app", () => {
	test("hands the unlock to a locked desktop instead of unlocking locally", async () => {
		accounts = [{ accountId: "acc-uuid-1", email: "a@example.com" }];
		desktopStatus = { available: true, locked: true };

		const response = await handleQuickUnlockAll(
			{ password: "pw" },
			runtime as never,
		);

		expect(response).toEqual({
			success: true,
			status: "pending-desktop-unlock",
			desktopReachable: true,
		});
		expect(triggerDesktopUnlockCalls).toBe(1);
		// Nothing was unlocked on this side, so no session was seeded.
		expect(setMasterUnlockKeyCalls.length).toBe(0);
		expect(setActiveAccountCalls.length).toBe(0);
	});

	test("still refuses to unlock locally when the desktop is wedged", async () => {
		accounts = [{ accountId: "acc-uuid-1", email: "a@example.com" }];
		desktopStatus = { available: true, locked: true };
		triggerDesktopUnlockResult = false;

		const response = await handleQuickUnlockAll(
			{ password: "pw" },
			runtime as never,
		);

		// Falling back to a local unlock here is exactly the divergence bug: the
		// desktop is still reachable and still locked. Report it instead.
		expect(response).toEqual({
			success: true,
			status: "pending-desktop-unlock",
			desktopReachable: false,
		});
		expect(setMasterUnlockKeyCalls.length).toBe(0);
	});

	test("unlocks locally when the connected desktop is already unlocked", async () => {
		accounts = [{ accountId: "acc-uuid-1", email: "a@example.com" }];
		desktopStatus = {
			available: true,
			locked: false,
			unlockedAccounts: ["acc-uuid-1"],
		};

		const response = await handleQuickUnlockAll(
			{ password: "pw" },
			runtime as never,
		);

		expect(triggerDesktopUnlockCalls).toBe(0);
		expect(response.success).toBe(true);
		expect(setMasterUnlockKeyCalls.length).toBe(1);
	});
});

test("Login, Quick Unlock and password Unlock All wait for held C1 before local publication", async () => {
	for (const [kind, call] of [
		[
			"login",
			() =>
				handleLogin(
					{ email: "a@example.com", password: "pw", secretKey: "A3" },
					runtime as never,
				),
		],
		["quick", () => handleQuickUnlock({ password: "pw" }, runtime as never)],
		["all", () => handleQuickUnlockAll({ password: "pw" }, runtime as never)],
	] as const) {
		accounts = [{ accountId: "acc-uuid-1", email: "a@example.com" }];
		activeAccount = "acc-uuid-1";
		storedAuthToken = null;
		setMasterUnlockKeyCalls.length = 0;
		let release!: () => void;
		let entered!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		const started = new Promise<void>((resolve) => (entered = resolve));
		nativeMessagingClient.configureRetirementCleanup(async () => {
			entered();
			await held;
		});
		const retirement = nativeMessagingClient.retireObservedStatus({
			locked: true,
			timestamp: 1,
		});
		await started;
		let settled = false;
		const operation = call().then((result) => {
			settled = true;
			return result;
		});
		await Promise.resolve();
		await Promise.resolve();
		try {
			expect(settled).toBe(false);
			expect(storedAuthToken).toBeNull();
			expect(setMasterUnlockKeyCalls).toEqual([]);
		} finally {
			release();
		}
		await retirement;
		expect((await operation).success).toBe(true);
		expect(setMasterUnlockKeyCalls.length).toBe(1);
		expect(nativeMessagingClient.needsMaterialCleanup()).toBe(false);
		expect(kind).toBeTruthy();
	}
});

// A failed C1 leaves this process's transport lifetime closed. Keep this last
// so later cases cannot accidentally rely on reopening an incomplete cleanup.
test("handleLogout reports a failed storage step instead of claiming success", async () => {
	accounts = [{ accountId: "acc-uuid-1", email: "a@example.com" }];
	activeAccount = "acc-uuid-1";
	forgetSessionError = new Error("chrome.storage unavailable");

	const response = await handleLogout(runtime as never);

	expect(response.success).toBe(false);
	expect(clearItemCacheCalls).toEqual(["acc-uuid-1"]);
	await expect(
		nativeMessagingClient.captureDeliveryGeneration(),
	).rejects.toThrow("Extension signOutAccount did not complete safely");
});
