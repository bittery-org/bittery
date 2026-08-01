import { describe, expect, it, mock } from "bun:test";
import type { AccountStore } from "@bittery/storage";
import type { ICrypto } from "@bittery/types";
import {
	accountMetadata,
	createTestAccountStore,
	createTestItemCache,
} from "../../testing/account-store-harness";

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

/**
 * A real `AccountStore`: two accounts, and a stored secret key for each id in
 * `withSecretKey`. `hasStoredSecretKey` then answers from actual storage rather than
 * from a stub, which is what the id/email contract under test depends on.
 */
async function createStorage(
	withSecretKey: string[] = ["acc-1", "acc-2"],
): Promise<AccountStore> {
	const { store } = await createTestAccountStore();
	for (const [accountId, email] of [
		["acc-1", "a@test.com"],
		["acc-2", "b@test.com"],
	] as const) {
		await store.addAccount(accountMetadata({ accountId, email }));
		await store.storeAuthToken(`token-${accountId}`, accountId);
		if (withSecretKey.includes(accountId)) {
			await store.storeSecretKey(`secret-${accountId}`, accountId);
		}
	}
	return store;
}

const crypto = {} as ICrypto;

const itemCache = (await createTestItemCache()).cache;

describe("quickUnlockAllAccounts", () => {
	it("returns account ids for unlocked accounts, not emails", async () => {
		const result = await quickUnlockAllAccounts(
			{ password: "pw" },
			{ crypto, storage: await createStorage(), itemCache },
		);

		expect(result.unlocked).toEqual(["acc-1", "acc-2"]);
		expect(result.failed).toEqual([]);
	});

	it("reports failures by email while still returning ids for successes", async () => {
		const storage = await createStorage(["acc-2"]);

		const result = await quickUnlockAllAccounts(
			{ password: "pw" },
			{ crypto, storage, itemCache },
		);

		expect(result.unlocked).toEqual(["acc-2"]);
		expect(result.failed.map((f) => f.email)).toEqual(["a@test.com"]);
	});

	it("filters to the requested emails but still returns their ids", async () => {
		const result = await quickUnlockAllAccounts(
			{ password: "pw", emails: ["b@test.com"] },
			{ crypto, storage: await createStorage(), itemCache },
		);

		expect(result.unlocked).toEqual(["acc-2"]);
	});
});
