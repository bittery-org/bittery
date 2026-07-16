import { describe, expect, it, mock } from "bun:test";
import type { IStorageAdapter } from "@bittery/storage/adapter";
import type { AccountMetadata } from "@bittery/storage/types";
import type { ICrypto } from "@bittery/types";

mock.module("../../auth", () => ({
	performSRPUnlock: mock(async () => ({
		masterUnlockKey: new Uint8Array([1]),
	})),
	storeUnlockSession: mock(async () => {}),
}));

mock.module("../../services/rpc-client", () => ({
	createStaticStoredAccountRpcClient: mock(async () => ({})),
}));

const { quickUnlockAllAccounts } = await import("./use-quick-unlock-all");

function account(accountId: string, email: string): AccountMetadata {
	return {
		accountId,
		email,
		userId: `user-${accountId}`,
		name: accountId,
		serverUrl: "https://app.bittery.io",
		secretKeyHint: "ABCD••••",
		addedAt: 1,
		lastActiveAt: 1,
		biometricEnabled: false,
	};
}

const accounts = [
	account("acc-1", "a@test.com"),
	account("acc-2", "b@test.com"),
];

function createStorage(
	overrides: Partial<IStorageAdapter> = {},
): IStorageAdapter {
	return {
		getAccountsList: mock(async () => accounts),
		hasStoredSecretKey: mock(async () => true),
		getServerUrl: mock(async () => "https://app.bittery.io"),
		...overrides,
	} as unknown as IStorageAdapter;
}

const crypto = {} as ICrypto;

describe("quickUnlockAllAccounts", () => {
	it("returns account ids for unlocked accounts, not emails", async () => {
		const result = await quickUnlockAllAccounts(
			{ password: "pw" },
			{ crypto, storage: createStorage() },
		);

		expect(result.unlocked).toEqual(["acc-1", "acc-2"]);
		expect(result.failed).toEqual([]);
	});

	it("reports failures by email while still returning ids for successes", async () => {
		const storage = createStorage({
			hasStoredSecretKey: mock(
				async (accountId: string) => accountId === "acc-2",
			),
		});

		const result = await quickUnlockAllAccounts(
			{ password: "pw" },
			{ crypto, storage },
		);

		expect(result.unlocked).toEqual(["acc-2"]);
		expect(result.failed.map((f) => f.email)).toEqual(["a@test.com"]);
	});

	it("filters to the requested emails but still returns their ids", async () => {
		const result = await quickUnlockAllAccounts(
			{ password: "pw", emails: ["b@test.com"] },
			{ crypto, storage: createStorage() },
		);

		expect(result.unlocked).toEqual(["acc-2"]);
	});
});
