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

mock.module(path.join(bgDir, "desktop-client.ts"), () => ({
	desktopClient: {
		triggerDesktopUnlock: async () => {
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
	storeUnlockSessionOwned: async () => {},
	performSRPLogin: async () => ({}),
	storeLoginSessionOwned: async () => {},
}));

const runtime = { accounts: {}, vaultRuntime: {} };
mock.module(path.join(bgDir, "vault-runtime.ts"), () => ({
	backgroundClientRuntime: { accounts: { retireUnlockedProjection: () => {} } },
	reconcileClientRuntime: async () => {},
}));

mock.module("@bittery/shared/api-client-factory", () => ({
	createAccountApiClient: () => ({}),
	createApiClientForServer: () => ({}),
	getDefaultServerUrl: () => "http://localhost:3000",
}));

const { handleLogout } = await import(path.join(bgDir, "auth-handlers.ts"));
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
});

describe("handleLogout overlapping event retirement", () => {
	test("event-owned retirement stays fenced after overlapping incomplete Sign out", async () => {
		for (const partial of [false, true]) {
			accounts = [{ accountId: "acc-uuid-1", email: "a@example.com" }];
			activeAccount = "acc-uuid-1";
			forgetSessionError = partial
				? new Error("chrome.storage unavailable")
				: null;
			let releaseForget: (() => void) | null = null;
			let forgetStarted: Promise<void> | null = null;
			if (partial) {
				holdForgetSession = new Promise<void>((resolve) => {
					releaseForget = resolve;
				});
				forgetStarted = new Promise<void>((resolve) => {
					forgetSessionEntered = resolve;
				});
			}
			let releaseEvent!: () => void;
			const eventCleanup = new Promise<void>((resolve) => {
				releaseEvent = resolve;
			});
			let eventEntered!: () => void;
			const eventStarted = new Promise<void>((resolve) => {
				eventEntered = resolve;
			});
			nativeMessagingClient.configureRetirementCleanup(async () => {
				eventEntered();
				await eventCleanup;
			});
			const retirement = nativeMessagingClient.retireObservedStatus({
				locked: true,
				timestamp: 1,
			});
			void retirement.catch(() => {});
			await eventStarted;
			const signOut = handleLogout(runtime as never);
			let queuedCleanup: Promise<void> | null = null;
			let queuedRan = false;
			if (forgetStarted) {
				await forgetStarted;
				queuedCleanup = nativeMessagingClient.withLifecycleCleanup(async () => {
					queuedRan = true;
				});
				releaseForget?.();
			}
			const response = await Promise.race([
				signOut,
				Bun.sleep(1000).then(() => {
					throw new Error("Sign out waited for its own event retirement");
				}),
			]);
			expect(response).toEqual({ success: !partial });
			if (queuedCleanup) {
				await queuedCleanup;
				expect(queuedRan).toBe(true);
			}
			let successorAdmitted = false;
			const successor = nativeMessagingClient
				.captureDeliveryGeneration()
				.then(() => {
					successorAdmitted = true;
				});
			void successor.catch(() => {});
			await Bun.sleep(1);
			expect(successorAdmitted).toBe(false);
			releaseEvent();
			if (partial) {
				await expect(retirement).rejects.toThrow(
					"Extension signOutAccount did not complete safely",
				);
				await expect(successor).rejects.toThrow(
					"Extension signOutAccount did not complete safely",
				);
				await expect(
					hydrateDesktopAccountMaterial("acc-uuid-1"),
				).rejects.toThrow("Extension signOutAccount did not complete safely");
			} else {
				await retirement;
				await successor;
				expect(successorAdmitted).toBe(true);
			}
		}
	});
});
