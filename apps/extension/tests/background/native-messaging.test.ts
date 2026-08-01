import { beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";

// Regression coverage for the challenge binding on biometric unlock. The bug:
// `biometricEnabled` was persisted before the response was checked against the
// issued challenge, so a stale or mismatched response left the account marked
// as biometric-enabled even though the unlock was rejected.

const bgDir = path.resolve(import.meta.dir, "../../src/background");
const libDir = path.resolve(import.meta.dir, "../../src/lib");

const CHALLENGE = "11111111-2222-3333-4444-555555555555";
const ACCOUNT_ID = "account-1";
const ENCRYPTED_SESSION = btoa(JSON.stringify({ ciphertext: "x" }));

const setBiometricEnabledCalls: Array<[string, boolean]> = [];
const setActiveAccountCalls: unknown[] = [];
const storeVaultKeysCalls: Array<[unknown, string | undefined]> = [];
const getMasterUnlockKeyCalls: (string | undefined)[] = [];
let nativeResponse: Record<string, unknown> = {};
let accounts: Array<{ accountId: string; email: string }> = [];
let activeAccount: { type: "single"; accountId: string } | null = null;
/** `null` verifies every account; otherwise only the listed accountIds pass. */
let verifiableAccountIds: string[] | null = null;

mock.module(path.join(libDir, "storage.ts"), () => ({
	storage: {
		getAccountsList: async () => accounts,
		getActiveAccount: async () => activeAccount,
		setActiveAccount: async (value: unknown) => {
			setActiveAccountCalls.push(value);
		},
		// `setBiometricEnabled` is total on `AccountStore`.
		setBiometricEnabled: async (accountId: string, enabled: boolean) => {
			setBiometricEnabledCalls.push([accountId, enabled]);
		},
		getAuthToken: async () => "token",
		storeAuthToken: async () => {},
		getVaultKeys: async () => [{ vaultId: "v1" }],
		storeVaultKeys: async (keys: unknown, accountId?: string) => {
			storeVaultKeysCalls.push([keys, accountId]);
		},
		getMasterUnlockKey: async (accountId?: string) => {
			getMasterUnlockKeyCalls.push(accountId);
			return new Uint8Array([9]);
		},
		setMasterUnlockKey: async () => {},
		clearSession: async () => {},
	},
	itemCache: {
		clearItemCache: async () => {},
	},
}));

mock.module(path.join(libDir, "wasm-crypto.ts"), () => ({
	decrypt: async () => btoa("muk"),
}));

mock.module(path.join(bgDir, "desktop-sync.ts"), () => ({
	desktopSync: { getLastStatus: () => null },
}));

mock.module(path.join(bgDir, "desktop-unlock.ts"), () => ({
	PENDING_DESKTOP_UNLOCK: "pending-desktop-unlock",
	requireDesktopUnlock: async () => ({ required: false, triggered: false }),
}));

mock.module(path.join(bgDir, "native-messaging-client.ts"), () => ({
	sendNativeMessage: async () => nativeResponse,
}));

mock.module(path.join(bgDir, "session-manager.ts"), () => ({
	setDesktopModeSentinel: () => {},
	setMasterUnlockKey: () => {},
	updateActivity: async () => {},
}));

mock.module("@bittery/core/services/account-resolver", () => ({
	createStoredAccountRpcClient: async () => ({}),
}));

mock.module("@bittery/core/services/travel-mode-enforcer", () => ({
	getTravelModeEnforcer: () => ({
		verifyOrClear: async (accountId: string) =>
			verifiableAccountIds?.includes(accountId) ?? true,
		filterVaultKeys: (_accountId: string, keys: unknown[]) => keys,
	}),
}));

const {
	handleNativeBiometricUnlock,
	handleNativeBiometricUnlockAll,
	STALE_DESKTOP_UNLOCK_RESPONSE,
	TRAVEL_MODE_UNVERIFIED,
} = await import(path.join(bgDir, "native-messaging.ts"));

beforeEach(() => {
	setBiometricEnabledCalls.length = 0;
	setActiveAccountCalls.length = 0;
	storeVaultKeysCalls.length = 0;
	getMasterUnlockKeyCalls.length = 0;
	accounts = [{ accountId: ACCOUNT_ID, email: "a@example.com" }];
	activeAccount = { type: "single", accountId: ACCOUNT_ID };
	verifiableAccountIds = null;
	// @ts-expect-error - minimal chrome stub for the background handler
	globalThis.chrome = { runtime: { id: "extension-id" } };
	crypto.randomUUID = () => CHALLENGE as ReturnType<typeof crypto.randomUUID>;
});

describe("handleNativeBiometricUnlock challenge binding", () => {
	test("does not persist biometric state when the response is stale", async () => {
		nativeResponse = {
			type: "BIOMETRIC_UNLOCK_SUCCESS",
			accountId: ACCOUNT_ID,
			encrypted_session: ENCRYPTED_SESSION,
			device_key: btoa("device-key"),
			// Bound to a different challenge - i.e. a replayed/stale response.
			signature: btoa(`other-challenge:${ENCRYPTED_SESSION}`),
		};

		const result = await handleNativeBiometricUnlock();

		expect(result.success).toBe(false);
		expect(result.error).toBe(STALE_DESKTOP_UNLOCK_RESPONSE);
		expect(setBiometricEnabledCalls).toEqual([]);
	});

	test("persists biometric state when the response is bound to the challenge", async () => {
		nativeResponse = {
			type: "BIOMETRIC_UNLOCK_SUCCESS",
			accountId: ACCOUNT_ID,
			encrypted_session: ENCRYPTED_SESSION,
			device_key: btoa("device-key"),
			signature: btoa(`${CHALLENGE}:${ENCRYPTED_SESSION}`),
		};

		const result = await handleNativeBiometricUnlock();

		expect(result.success).toBe(true);
		expect(setBiometricEnabledCalls).toEqual([[ACCOUNT_ID, true]]);
	});

	test("clears the session and reports a code when travel mode fails", async () => {
		verifiableAccountIds = [];
		nativeResponse = {
			type: "BIOMETRIC_UNLOCK_SUCCESS",
			accountId: ACCOUNT_ID,
			encrypted_session: ENCRYPTED_SESSION,
			device_key: btoa("device-key"),
			signature: btoa(`${CHALLENGE}:${ENCRYPTED_SESSION}`),
			vault_keys: JSON.stringify([{ vaultId: "v1" }]),
		};

		const result = await handleNativeBiometricUnlock();

		expect(result.success).toBe(false);
		expect(result.error).toBe(TRAVEL_MODE_UNVERIFIED);
		expect(storeVaultKeysCalls).toEqual([]);
	});
});

function biometricUnlockAllResponse(
	unlockAccounts: Array<{ accountId: string; email: string }>,
): Record<string, unknown> {
	return {
		type: "BIOMETRIC_UNLOCK_ALL_SUCCESS",
		device_key: btoa("device-key"),
		signature: btoa(`${CHALLENGE}:${unlockAccounts.length}`),
		accounts: unlockAccounts.map((account) => ({
			accountId: account.accountId,
			email: account.email,
			encrypted_session: ENCRYPTED_SESSION,
			auth_token: "token",
			vault_keys: JSON.stringify([{ vaultId: "v1" }]),
		})),
	};
}

describe("handleNativeBiometricUnlockAll active account", () => {
	beforeEach(() => {
		accounts = [
			{ accountId: "acc-1", email: "a@example.com" },
			{ accountId: "acc-2", email: "b@example.com" },
		];
		nativeResponse = biometricUnlockAllResponse(accounts);
	});

	test("returns the user to the account they were last using", async () => {
		activeAccount = { type: "single", accountId: "acc-2" };

		const result = await handleNativeBiometricUnlockAll();

		expect(result.success).toBe(true);
		expect(setActiveAccountCalls).toEqual([
			{ type: "single", accountId: "acc-2" },
		]);
		expect(getMasterUnlockKeyCalls).toEqual(["acc-2"]);
	});

	test("falls back to the first unlocked account when none was active", async () => {
		activeAccount = null;

		await handleNativeBiometricUnlockAll();

		expect(setActiveAccountCalls).toEqual([
			{ type: "single", accountId: "acc-1" },
		]);
	});

	test("preserveActiveAccount skips the active-account write", async () => {
		activeAccount = { type: "single", accountId: "acc-2" };

		const result = await handleNativeBiometricUnlockAll({
			forceLocalUnlock: true,
			preserveActiveAccount: true,
		});

		expect(result.success).toBe(true);
		expect(setActiveAccountCalls).toEqual([]);
		// The stored pointer is untouched, so the seeded MUK must be that account's.
		expect(getMasterUnlockKeyCalls).toEqual(["acc-2"]);
	});
});

describe("handleNativeBiometricUnlockAll travel mode", () => {
	test("stores no vault keys for an account that fails verification", async () => {
		accounts = [
			{ accountId: "acc-1", email: "a@example.com" },
			{ accountId: "acc-2", email: "b@example.com" },
		];
		activeAccount = null;
		nativeResponse = biometricUnlockAllResponse(accounts);
		verifiableAccountIds = ["acc-1"];

		const result = await handleNativeBiometricUnlockAll();

		expect(result.success).toBe(true);
		expect(result.result).toEqual({
			unlocked: ["acc-1"],
			failed: [
				{
					accountId: "acc-2",
					email: "b@example.com",
					error: TRAVEL_MODE_UNVERIFIED,
				},
			],
		});
		// Vault keys reach storage only for the account whose policy was verified.
		expect(storeVaultKeysCalls.map(([, accountId]) => accountId)).toEqual([
			"acc-1",
		]);
	});
});
