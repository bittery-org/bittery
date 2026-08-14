import { describe, expect, it, mock } from "bun:test";
import type { AccountSessionManager } from "@bittery/core/services/account-session-manager";
import type { AccountStore } from "@bittery/storage";
import { resolveVaultRouteAccess } from "./vault-route-access";

describe("resolveVaultRouteAccess", () => {
	it("does no storage or unlock work for an already-unlocked account", async () => {
		const getStoredSecretKey = mock(async () => "secret");
		const isSessionValid = mock(async () => true);
		const unlockAccount = mock(async () => true);
		const manager = {
			getActiveAccount: () => "account-a",
			isInitialized: () => true,
			isUnlocked: () => true,
			unlockAccount,
		} as unknown as AccountSessionManager;
		const storage = {
			getStoredSecretKey,
			isSessionValid,
		} as unknown as AccountStore;

		expect(await resolveVaultRouteAccess(manager, storage)).toBe("ready");
		expect(getStoredSecretKey).not.toHaveBeenCalled();
		expect(isSessionValid).not.toHaveBeenCalled();
		expect(unlockAccount).not.toHaveBeenCalled();
	});

	it("does not trust a local-only unlock before full policy initialization", async () => {
		const getStoredSecretKey = mock(async () => "secret");
		const isSessionValid = mock(async () => true);
		const unlockAccount = mock(async () => true);
		const manager = {
			getActiveAccount: () => "account-a",
			isInitialized: () => false,
			isUnlocked: () => true,
			unlockAccount,
		} as unknown as AccountSessionManager;
		const storage = {
			getStoredSecretKey,
			isSessionValid,
		} as unknown as AccountStore;

		expect(await resolveVaultRouteAccess(manager, storage)).toBe("ready");
		expect(getStoredSecretKey).toHaveBeenCalledWith("account-a");
		expect(isSessionValid).toHaveBeenCalledWith("account-a");
		expect(unlockAccount).toHaveBeenCalledWith("account-a", true);
	});
});
