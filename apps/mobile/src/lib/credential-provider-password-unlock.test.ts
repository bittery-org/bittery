/// <reference types="bun" />
/**
 * After unlock the Android autofill process needs a wrapped MUK. Without it,
 * "Unlock Bittery" in Chrome opens the full app instead of a system prompt.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { StoredSessionData } from "@bittery/storage";

mock.module("./storage", () => ({
	storage: {},
}));
mock.module("./credential-provider", () => ({
	credentialProvider: {},
}));
mock.module("./credential-provider-master-unlock-key", () => ({
	mirrorBorrowedMasterUnlockKeysToCredentialProvider: async () => {},
}));

const DAY_MS = 24 * 60 * 60 * 1000;

function session(
	overrides: Partial<StoredSessionData> = {},
): StoredSessionData {
	return {
		encryptedMasterUnlockKey: {
			algorithm: "AES-GCM",
			ciphertext: "x",
			iv: "y",
		},
		email: "ada@example.com",
		userId: "user-1",
		expiresAt: Date.now() + DAY_MS,
		createdAt: Date.now(),
		biometricEnabled: true,
		...overrides,
	};
}

const calls: {
	lastPasswordUpdates: number;
	stampShouldFail: boolean;
	escrows: Array<{
		email: string;
		accountId?: string;
		userId?: string;
		timeoutMs?: number;
	}>;
	mirrored: string[][];
	biometricByAccount: Record<string, boolean>;
	sessionByAccount: Record<string, StoredSessionData | null>;
	reentryPeriodMs: number;
	escrowShouldFail: boolean;
} = {
	lastPasswordUpdates: 0,
	stampShouldFail: false,
	escrows: [],
	mirrored: [],
	biometricByAccount: {},
	sessionByAccount: {},
	reentryPeriodMs: 30 * DAY_MS,
	escrowShouldFail: false,
};

const {
	prepareCredentialProviderAfterPasswordUnlock,
	prepareCredentialProviderAfterUnlock,
	shouldEscrowAfterUnlock,
} = await import("./credential-provider-password-unlock");

beforeEach(() => {
	calls.lastPasswordUpdates = 0;
	calls.stampShouldFail = false;
	calls.escrows = [];
	calls.mirrored = [];
	calls.biometricByAccount = { a: true };
	calls.sessionByAccount = { a: session() };
	calls.reentryPeriodMs = 30 * DAY_MS;
	calls.escrowShouldFail = false;
});

const deps = {
	mirror: async (accountIds: readonly string[]) => {
		calls.mirrored.push([...accountIds]);
	},
	provider: {
		updateLastMasterPasswordEntry: async () => {
			if (calls.stampShouldFail) {
				throw new Error("plugin unavailable");
			}
			calls.lastPasswordUpdates += 1;
			return true;
		},
		escrowMukWithBiometric: async (params: {
			email: string;
			accountId?: string;
			userId?: string;
			timeoutMs?: number;
		}) => {
			if (calls.escrowShouldFail) {
				throw new Error("user cancelled");
			}
			calls.escrows.push(params);
			return true;
		},
	},
	storage: {
		isBiometricEnabled: async (accountId: string) =>
			calls.biometricByAccount[accountId] ?? false,
		getStoredSessionData: async (accountId: string) =>
			calls.sessionByAccount[accountId] ?? null,
		getMasterPasswordReentryPeriodMs: async () => calls.reentryPeriodMs,
	},
};

describe("shouldEscrowAfterUnlock", () => {
	test("escrows when biometric is on and the account has an identity", () => {
		expect(
			shouldEscrowAfterUnlock({
				biometricEnabled: true,
				email: "ada@example.com",
				userId: "user-1",
			}),
		).toBe(true);
		expect(
			shouldEscrowAfterUnlock({
				biometricEnabled: false,
				email: "ada@example.com",
				userId: "user-1",
			}),
		).toBe(false);
		expect(
			shouldEscrowAfterUnlock({
				biometricEnabled: true,
				email: "",
				userId: "user-1",
			}),
		).toBe(false);
	});
});

describe("prepareCredentialProviderAfterPasswordUnlock", () => {
	test("mirrors keys, stamps the native password clock, and escrows for 30 days", async () => {
		await prepareCredentialProviderAfterPasswordUnlock(["a"], deps);

		expect(calls.mirrored).toEqual([["a"]]);
		expect(calls.lastPasswordUpdates).toBe(1);
		expect(calls.escrows).toEqual([
			{
				email: "ada@example.com",
				// Both ids travel: the escrow restores into live state keyed by
				// `accountId`, and stamps native cache rows with the server `userId`.
				accountId: "a",
				userId: "user-1",
				timeoutMs: 30 * DAY_MS,
			},
		]);
	});

	test("still escrows when the native password stamp cannot be written", async () => {
		calls.stampShouldFail = true;
		await prepareCredentialProviderAfterPasswordUnlock(["a"], deps);
		expect(calls.mirrored).toEqual([["a"]]);
		expect(calls.lastPasswordUpdates).toBe(0);
		expect(calls.escrows).toHaveLength(1);
	});

	test("does not escrow when biometric unlock is off", async () => {
		calls.biometricByAccount = { a: false };
		await prepareCredentialProviderAfterPasswordUnlock(["a"], deps);
		expect(calls.lastPasswordUpdates).toBe(1);
		expect(calls.escrows).toEqual([]);
	});

	test("does not fail the unlock when escrow throws", async () => {
		calls.escrowShouldFail = true;
		await prepareCredentialProviderAfterPasswordUnlock(["a"], deps);
		expect(calls.lastPasswordUpdates).toBe(1);
		expect(calls.escrows).toEqual([]);
	});
});

describe("prepareCredentialProviderAfterUnlock", () => {
	test("a biometric unlock wraps the key without stamping the password clock", async () => {
		await prepareCredentialProviderAfterUnlock(["a"], {
			...deps,
			recordPasswordEntry: false,
		});
		expect(calls.mirrored).toEqual([["a"]]);
		expect(calls.lastPasswordUpdates).toBe(0);
		expect(calls.escrows).toHaveLength(1);
	});
});
