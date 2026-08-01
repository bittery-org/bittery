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
let nativeResponse: Record<string, unknown> = {};

mock.module(path.join(libDir, "storage.ts"), () => ({
	storage: {
		getActiveAccount: async () => ({
			type: "single" as const,
			accountId: ACCOUNT_ID,
		}),
		// `setBiometricEnabled` is total on `AccountStore`.
		setBiometricEnabled: async (accountId: string, enabled: boolean) => {
			setBiometricEnabledCalls.push([accountId, enabled]);
		},
		getAuthToken: async () => "token",
		storeAuthToken: async () => {},
		getVaultKeys: async () => [{ vaultId: "v1" }],
		storeVaultKeys: async () => {},
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
		verifyForUnlock: async () => {},
		filterVaultKeys: (_accountId: string, keys: unknown[]) => keys,
	}),
}));

const { handleNativeBiometricUnlock, STALE_DESKTOP_UNLOCK_RESPONSE } =
	await import(path.join(bgDir, "native-messaging.ts"));

beforeEach(() => {
	setBiometricEnabledCalls.length = 0;
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
});
