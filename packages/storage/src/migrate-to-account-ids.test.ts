import { describe, expect, it } from "bun:test";
import { resolveOrCreateAccountId } from "./account-id";
import {
	ACCOUNT_ID_MIGRATION_FLAG,
	ACCOUNT_STORAGE_SUFFIXES,
	getAccountKey,
	getLegacyAccountKey,
} from "./account-keys";
import {
	type AccountIdMigrationContext,
	migrateEmailKeysToAccountIds,
} from "./migrate-to-account-ids";
import type { AccountMetadata } from "./types";

class FaultInjectingStore {
	readonly values = new Map<string, unknown>();
	readonly operations: string[] = [];
	failAfter: number | undefined;
	private operationCount = 0;

	async get<T>(key: string): Promise<T | undefined> {
		return this.values.get(key) as T | undefined;
	}

	async set(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
		this.afterMutation(`set:${key}`);
	}

	async delete(key: string): Promise<void> {
		this.values.delete(key);
		this.afterMutation(`delete:${key}`);
	}

	async save(): Promise<void> {
		this.afterMutation("save");
	}

	mutate(label: string, action: () => void): void {
		action();
		this.afterMutation(label);
	}

	private afterMutation(label: string): void {
		this.operations.push(label);
		this.operationCount++;
		if (this.failAfter === this.operationCount) {
			throw new Error(`Injected failure after ${label}`);
		}
	}
}

function legacyAccount(overrides: Partial<AccountMetadata> = {}): AccountMetadata {
	return {
		accountId: "",
		email: "same@example.com",
		userId: "user-1",
		name: "Legacy",
		secretKeyHint: "ABCD••••",
		addedAt: 1,
		lastActiveAt: 1,
		biometricEnabled: false,
		...overrides,
	};
}

function createMigrationFixture(active = "same@example.com") {
	const store = new FaultInjectingStore();
	const email = "same@example.com";
	const keychain = new Map<string, string>();
	store.values.set("accounts", JSON.stringify({ accounts: [legacyAccount()] }));
	store.values.set("active", active);
	for (const suffix of ACCOUNT_STORAGE_SUFFIXES) {
		store.values.set(getLegacyAccountKey(email, suffix), `value:${suffix}`);
	}
	keychain.set(getLegacyAccountKey(email, "jwt_token"), "keychain-token");

	const context: AccountIdMigrationContext = {
		store,
		activeAccountKey: "active",
		accountsListKey: "accounts",
		getAccountsList: async () => {
			const stored = await store.get<string>("accounts");
			return stored ? JSON.parse(stored).accounts : [];
		},
		saveAccountsList: async (accounts) => {
			await store.set("accounts", JSON.stringify({ accounts }));
		},
		copyKeychainKey: async (legacyEmail, accountId, suffix) => {
			const source = getLegacyAccountKey(legacyEmail, suffix);
			const destination = getAccountKey(accountId, suffix);
			const value = keychain.get(source);
			if (value !== undefined) {
				store.mutate(`keychain-copy:${destination}`, () => {
					keychain.set(destination, value);
				});
				if (keychain.get(destination) !== value) {
					throw new Error("Keychain copy verification failed");
				}
			}
		},
		deleteLegacyKeychainKey: async (legacyEmail, suffix) => {
			const source = getLegacyAccountKey(legacyEmail, suffix);
			store.mutate(`keychain-delete:${source}`, () => keychain.delete(source));
		},
	};

	return { store, keychain, context, email };
}

function readAccounts(store: FaultInjectingStore): AccountMetadata[] {
	return JSON.parse(store.values.get("accounts") as string).accounts;
}

function readOnlyAccount(store: FaultInjectingStore): AccountMetadata {
	const account = readAccounts(store)[0];
	if (!account) throw new Error("Expected one account");
	return account;
}

describe("migrateEmailKeysToAccountIds", () => {
	it("migrates every account suffix, backfills server metadata, and converts active", async () => {
		const { store, context, email } = createMigrationFixture();

		await migrateEmailKeysToAccountIds(context);

		const account = readOnlyAccount(store);
		expect(account.accountId).toBeTruthy();
		expect(account.serverUrl).toBe("value:server_url");
		expect(store.values.get("active")).toBe(account.accountId);
		for (const suffix of ACCOUNT_STORAGE_SUFFIXES) {
			expect(store.values.get(getAccountKey(account.accountId, suffix))).toBe(
				`value:${suffix}`,
			);
			expect(store.values.has(getLegacyAccountKey(email, suffix))).toBe(false);
		}
		expect(store.values.get(ACCOUNT_ID_MIGRATION_FLAG)).toBe(true);
	});

	it("preserves the all-accounts active pointer", async () => {
		const { store, context } = createMigrationFixture("all");
		await migrateEmailKeysToAccountIds(context);
		expect(store.values.get("active")).toBe("all");
	});

	it("copies keychain data before deleting its legacy key", async () => {
		const { store, keychain, context, email } = createMigrationFixture();
		await migrateEmailKeysToAccountIds(context);
		const account = readOnlyAccount(store);
		const copyIndex = store.operations.findIndex((entry) =>
			entry.startsWith("keychain-copy:"),
		);
		const deleteIndex = store.operations.findIndex((entry) =>
			entry.startsWith("keychain-delete:"),
		);
		expect(copyIndex).toBeGreaterThan(-1);
		expect(deleteIndex).toBeGreaterThan(copyIndex);
		expect(keychain.get(getAccountKey(account.accountId, "jwt_token"))).toBe(
			"keychain-token",
		);
		expect(keychain.has(getLegacyAccountKey(email, "jwt_token"))).toBe(false);
	});

	it("is idempotent", async () => {
		const { store, context } = createMigrationFixture();
		await migrateEmailKeysToAccountIds(context);
		const firstAccounts = store.values.get("accounts");
		const operationCount = store.operations.length;
		await migrateEmailKeysToAccountIds(context);
		expect(store.values.get("accounts")).toBe(firstAccounts);
		expect(store.operations).toHaveLength(operationCount);
	});

	it("recovers after every write, delete, keychain operation, and save", async () => {
		const baseline = createMigrationFixture();
		await migrateEmailKeysToAccountIds(baseline.context);
		const operationCount = baseline.store.operations.length;

		for (let failAfter = 1; failAfter <= operationCount; failAfter++) {
			const fixture = createMigrationFixture();
			fixture.store.failAfter = failAfter;
			try {
				await migrateEmailKeysToAccountIds(fixture.context);
			} catch {
				// Expected fault injection.
			}

			const checkpointedAccount = readOnlyAccount(fixture.store);
			if (checkpointedAccount.accountId) {
				for (const suffix of ACCOUNT_STORAGE_SUFFIXES) {
					const source = getLegacyAccountKey(fixture.email, suffix);
					const destination = getAccountKey(
						checkpointedAccount.accountId,
						suffix,
					);
					expect(
						fixture.store.values.has(source) ||
							fixture.store.values.has(destination),
					).toBe(true);
				}
			}

			fixture.store.failAfter = undefined;
			await migrateEmailKeysToAccountIds(fixture.context);
			const account = readOnlyAccount(fixture.store);
			for (const suffix of ACCOUNT_STORAGE_SUFFIXES) {
				expect(
					fixture.store.values.get(getAccountKey(account.accountId, suffix)),
				).toBe(`value:${suffix}`);
			}
			expect(fixture.store.values.get(ACCOUNT_ID_MIGRATION_FLAG)).toBe(true);
		}
	});

	it("leaves serverUrl absent when no legacy value exists", async () => {
		const { store, context, email } = createMigrationFixture();
		store.values.delete(getLegacyAccountKey(email, "server_url"));
		await migrateEmailKeysToAccountIds(context);
		expect(readOnlyAccount(store).serverUrl).toBeUndefined();
	});
});

describe("legacy account adoption", () => {
	it("adopts one matching serverless legacy account", () => {
		const accounts = [legacyAccount({ accountId: "legacy-id" })];
		const accountId = resolveOrCreateAccountId(
			accounts,
			"https://self-hosted.example/",
			"user-1",
		);
		expect(accountId).toBe("legacy-id");
		expect(accounts[0]?.serverUrl).toBe("https://self-hosted.example");
	});

	it("fails closed for ambiguous serverless legacy accounts", () => {
		const accounts = [
			legacyAccount({ accountId: "legacy-a" }),
			legacyAccount({ accountId: "legacy-b" }),
		];
		expect(() =>
			resolveOrCreateAccountId(accounts, "https://server.example", "user-1"),
		).toThrow("Ambiguous legacy accounts");
	});
});
