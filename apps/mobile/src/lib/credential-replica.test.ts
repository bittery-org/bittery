/// <reference types="bun" />
/**
 * What the app publishes to the Android credential replica, and what it refuses to.
 *
 * The replica is a disposable projection: autofill reads it, nothing reads it back.
 * These tests cover the app's half of that contract — which account owns which rows,
 * when a generation is republished, and what never leaves the app at all. The native
 * half (a transactional replace, removal of rows the server no longer sends, hidden
 * vaults erased before a row moves) is proved in Kotlin, in
 * `CredentialReplicaTest` and `NativeCredentialVaultTravelModeTest`.
 *
 * `FakeNativeReplica` below is a small model of that Kotlin contract, so an assertion
 * can be about rows rather than about a call being made.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// `bun test` runs every file in one process and `mock.module` leaks, so only the
// module this file needs a stand-in for is mocked: `./storage` builds Tauri ports at
// import. Everything else this module touches is injected, not imported.
mock.module("./storage", () => ({ storage: {}, itemCache: {} }));
mock.module("@bittery/core/services/travel-mode-enforcer", () => ({
	getTravelModeEnforcer: () => {
		throw new Error("the default travel-mode source must not be used in tests");
	},
}));

const {
	createCredentialProjection,
	createCredentialReplica,
	MAX_QUEUED_VAULT_WRITE_AGE_MS,
	MAX_QUEUED_VAULT_WRITE_ATTEMPTS,
} = await import("./credential-replica");

type Projection = ReturnType<typeof createCredentialProjection>;

import type {
	CredentialProjectionDeps,
	CredentialReplica,
	PendingPasskeyMutation,
	ProjectionAccount,
	ProjectionLoginItem,
	ReplicaTravelModePolicy,
	ReplicaVaultKeySource,
} from "./credential-replica";

// ---------------------------------------------------------------------------
// A model of the native side
// ---------------------------------------------------------------------------

interface NativeRow {
	id: string;
	vaultId: string;
	serverUserId: string;
	version: number;
	encryptedData: string;
}

/**
 * The rules the Kotlin applies to one payload, small enough to assert against:
 * an unverified policy writes nothing, a hidden vault is erased, and what remains
 * replaces everything that account had.
 */
class FakeNativeReplica {
	readonly payloads: string[] = [];
	readonly itemsByUser = new Map<string, NativeRow[]>();
	readonly vaultKeysByUser = new Map<string, string[]>();
	readonly policyByUser = new Map<string, ReplicaTravelModePolicy | null>();
	readonly clears: number[] = [];
	available = true;
	failNextPublish: string | null = null;

	async isAvailable(): Promise<boolean> {
		return this.available;
	}

	async clearAllMasterUnlockKeys(): Promise<boolean> {
		this.clears.push(Date.now());
		this.itemsByUser.clear();
		this.vaultKeysByUser.clear();
		this.policyByUser.clear();
		return true;
	}

	async syncVaultData(dataJson: string): Promise<{
		vaultKeys: number;
		items: number;
		domains: number;
	}> {
		if (this.failNextPublish) {
			const reason = this.failNextPublish;
			this.failNextPublish = null;
			throw new Error(reason);
		}
		this.payloads.push(dataJson);
		const payload = JSON.parse(dataJson) as {
			userId: string;
			travelMode: ReplicaTravelModePolicy;
			vaultKeys: Array<{ vaultId: string }>;
			items: NativeRow[];
		};

		// Fail closed, the way `AndroidNativeCredentialVault.replaceReplica` does.
		this.policyByUser.set(payload.userId, payload.travelMode ?? null);
		if (!payload.travelMode?.verified) {
			return { vaultKeys: 0, items: 0, domains: 0 };
		}

		const hidden = new Set(payload.travelMode.hiddenVaultIds);
		const keys = payload.vaultKeys
			.map((key) => key.vaultId)
			.filter((vaultId) => !hidden.has(vaultId));
		const items = payload.items.filter((item) => !hidden.has(item.vaultId));
		this.vaultKeysByUser.set(payload.userId, keys);
		this.itemsByUser.set(payload.userId, items);
		return { vaultKeys: keys.length, items: items.length, domains: 0 };
	}

	itemIds(userId: string): string[] {
		return (this.itemsByUser.get(userId) ?? []).map((item) => item.id).sort();
	}

	item(userId: string, itemId: string): NativeRow | undefined {
		return (this.itemsByUser.get(userId) ?? []).find(
			(item) => item.id === itemId,
		);
	}

	payload(index: number): {
		accountId: string;
		userId: string;
		travelMode: ReplicaTravelModePolicy;
		vaultKeys: Array<{ vaultId: string; encryptedKey: string }>;
		items: NativeRow[];
	} {
		return JSON.parse(this.payloads[index] as string);
	}
}

// ---------------------------------------------------------------------------
// The queued-write side (native-originated outbound work)
// ---------------------------------------------------------------------------

class FakeQueuedWrites {
	pending: PendingPasskeyMutation[] = [];
	readonly forgotten: string[] = [];
	readonly failures: Array<{ ids: string[]; error: string }> = [];

	async getPendingPasskeyMutations(): Promise<PendingPasskeyMutation[]> {
		return this.pending;
	}

	async markPendingPasskeyMutationsApplied(ids: string[]): Promise<boolean> {
		this.forgotten.push(...ids);
		return true;
	}

	async markPendingPasskeyMutationsFailed(
		ids: string[],
		error: string,
	): Promise<boolean> {
		this.failures.push({ ids, error });
		return true;
	}
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KDF = {
	schemaVersion: 1,
	algorithm: "pbkdf2-sha256",
	iterations: 650_000,
} as const;

function account(id: string): ProjectionAccount {
	return {
		accountId: `acct_${id}`,
		userId: `user-${id}`,
		email: `${id}@x.dev`,
	};
}

function vaultKey(vaultId: string): ReplicaVaultKeySource {
	return {
		vaultId,
		vaultName: "Personal",
		vaultType: "personal",
		encryptedVaultKey: `wrapped-${vaultId}`,
		role: "owner",
	};
}

function loginItem(
	id: string,
	overrides: Partial<ProjectionLoginItem> = {},
): ProjectionLoginItem {
	return {
		id,
		accountId: "acct_a",
		vaultId: "vault-1",
		category: "login",
		title: id,
		url: "https://example.com",
		username: "ada",
		favorite: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		version: 1,
		lastModifiedBy: "user-a",
		encryptionVersion: 1,
		encryptedByUserId: "user-a",
		_encrypted: { data: `cipher-${id}`, iv: "iv", algorithm: "AES-GCM-AAD-V1" },
		...overrides,
	} as ProjectionLoginItem;
}

function verifiedPolicy(
	overrides: Partial<ReplicaTravelModePolicy> = {},
): ReplicaTravelModePolicy {
	return {
		verified: true,
		enabled: false,
		hiddenVaultIds: [],
		updatedAt: 1,
		...overrides,
	};
}

class Harness {
	readonly native = new FakeNativeReplica();
	readonly queue = new FakeQueuedWrites();
	readonly vaultKeysByAccount = new Map<string, ReplicaVaultKeySource[]>();
	readonly policyByAccount = new Map<string, ReplicaTravelModePolicy>();
	readonly preparedUnlocks: string[][] = [];
	unlockedAccounts: string[] = ["acct_a", "acct_b"];
	secretKeyByAccount = new Map<string, string | null>();
	kdfByAccount = new Map<string, typeof KDF | null>();
	nowMs = 1_000_000;
	readonly replica: CredentialReplica;
	projection: Projection;

	constructor() {
		this.vaultKeysByAccount.set("acct_a", [vaultKey("vault-1")]);
		this.vaultKeysByAccount.set("acct_b", [vaultKey("vault-9")]);
		this.policyByAccount.set("acct_a", verifiedPolicy());
		this.policyByAccount.set("acct_b", verifiedPolicy());
		this.secretKeyByAccount.set("acct_a", "A3-AAA");
		this.secretKeyByAccount.set("acct_b", "A3-BBB");
		this.kdfByAccount.set("acct_a", KDF);
		this.kdfByAccount.set("acct_b", KDF);
		this.replica = createCredentialReplica({ provider: this.native });
		this.projection = createCredentialProjection(this.deps());
	}

	deps(): CredentialProjectionDeps {
		return {
			replica: this.replica,
			queuedWrites: this.queue,
			store: {
				getUnlockedAccounts: async () => this.unlockedAccounts,
				getVaultKeys: async (accountId: string) =>
					this.vaultKeysByAccount.get(accountId) ?? null,
				getStoredSecretKey: async (accountId: string) =>
					this.secretKeyByAccount.get(accountId) ?? null,
				getPinnedKdfProfile: async (accountId: string) =>
					this.kdfByAccount.get(accountId) ?? null,
			},
			travelModePolicyFor: (accountId: string) =>
				this.policyByAccount.get(accountId) ?? {
					verified: false,
					enabled: false,
					hiddenVaultIds: [],
					updatedAt: null,
				},
			prepareNativeUnlock: async (accountIds: readonly string[]) => {
				this.preparedUnlocks.push([...accountIds]);
			},
			waitForIdle: async () => {},
			now: () => this.nowMs,
		};
	}

	project(
		accounts: ProjectionAccount[],
		loginItems: ProjectionLoginItem[],
	): Promise<{ vaultKeys: number; items: number; domains: number } | null> {
		return this.projection.projectAccounts({ accounts, loginItems });
	}
}

let harness: Harness;

beforeEach(() => {
	harness = new Harness();
});

// ---------------------------------------------------------------------------
// Publishing a generation
// ---------------------------------------------------------------------------

describe("publishing an account's generation", () => {
	test("one account's generation leaves the other account's rows alone", async () => {
		const items = [
			loginItem("a-1"),
			loginItem("b-1", { accountId: "acct_b", vaultId: "vault-9" }),
		];
		await harness.project([account("a"), account("b")], items);

		expect(harness.native.itemIds("user-a")).toEqual(["a-1"]);
		expect(harness.native.itemIds("user-b")).toEqual(["b-1"]);

		// Account A gains an item. Account B changes nothing.
		await harness.project(
			[account("a"), account("b")],
			[...items, loginItem("a-2")],
		);

		expect(harness.native.itemIds("user-a")).toEqual(["a-1", "a-2"]);
		expect(harness.native.itemIds("user-b")).toEqual(["b-1"]);
		// B was already published and unchanged, so it was not republished.
		expect(harness.native.payloads).toHaveLength(3);
		expect(harness.native.payload(2).userId).toBe("user-a");
	});

	test("an account's whole generation travels in one call", async () => {
		await harness.project(
			[account("a")],
			[loginItem("a-1"), loginItem("a-2"), loginItem("a-3")],
		);

		expect(harness.native.payloads).toHaveLength(1);
		expect(harness.native.payload(0).items.map((item) => item.id)).toEqual([
			"a-1",
			"a-2",
			"a-3",
		]);
		expect(harness.native.payload(0).vaultKeys).toHaveLength(1);
	});

	test("an unchanged account is not republished", async () => {
		const items = [loginItem("a-1")];
		await harness.project([account("a")], items);
		await harness.project([account("a")], items);

		expect(harness.native.payloads).toHaveLength(1);
	});

	test("a failed publish keeps the last good generation and retries it", async () => {
		await harness.project([account("a")], [loginItem("a-1")]);
		expect(harness.native.itemIds("user-a")).toEqual(["a-1"]);

		harness.native.failNextPublish = "SYNC_FAILED";
		const failed = await harness.project(
			[account("a")],
			[loginItem("a-1"), loginItem("a-2")],
		);

		// Nothing was published, and what autofill can already read is untouched.
		expect(failed).toBeNull();
		expect(harness.native.itemIds("user-a")).toEqual(["a-1"]);

		// The failed generation was never recorded, so the next pass sends it again.
		const totals = await harness.project(
			[account("a")],
			[loginItem("a-1"), loginItem("a-2")],
		);
		expect(totals).toEqual({ vaultKeys: 1, items: 2, domains: 0 });
		expect(harness.native.itemIds("user-a")).toEqual(["a-1", "a-2"]);
	});

	test("a failed account stops that pass, and the next pass publishes both", async () => {
		// A throws, so B never gets its turn in that pass, and neither is recorded.
		harness.native.failNextPublish = "SYNC_FAILED";
		await harness.project(
			[account("a"), account("b")],
			[
				loginItem("a-1"),
				loginItem("b-1", { accountId: "acct_b", vaultId: "vault-9" }),
			],
		);
		expect(harness.native.itemIds("user-b")).toEqual([]);

		await harness.project(
			[account("a"), account("b")],
			[
				loginItem("a-1"),
				loginItem("b-1", { accountId: "acct_b", vaultId: "vault-9" }),
			],
		);
		expect(harness.native.itemIds("user-a")).toEqual(["a-1"]);
		expect(harness.native.itemIds("user-b")).toEqual(["b-1"]);
	});

	test("a new item version is always republished", async () => {
		await harness.project([account("a")], [loginItem("a-1", { version: 1 })]);
		expect(harness.native.item("user-a", "a-1")?.version).toBe(1);

		// Only the version moves: same id, same timestamps, same ciphertext.
		await harness.project([account("a")], [loginItem("a-1", { version: 2 })]);

		expect(harness.native.payloads).toHaveLength(2);
		expect(harness.native.item("user-a", "a-1")?.version).toBe(2);
	});

	test("an item is never read back from the replica", async () => {
		await harness.project([account("a")], [loginItem("a-1", { version: 5 })]);

		// The projection publishes what the app cache holds and nothing else: the
		// version, the ciphertext and the encryption context cross unchanged, so the
		// native side can apply its own ordering rules. Nothing flows the other way —
		// `CredentialReplica` has no read method at all.
		const published = harness.native.payload(0).items[0] as NativeRow & {
			encryptionIv: string;
			encryptedByUserId: string;
		};
		expect(published.version).toBe(5);
		expect(published.encryptedData).toBe("cipher-a-1");
		expect(published.encryptedByUserId).toBe("user-a");
	});
});

// ---------------------------------------------------------------------------
// Vaults that go away
// ---------------------------------------------------------------------------

describe("vaults that go away", () => {
	test("an item whose vault key is gone is left out of the generation", async () => {
		harness.vaultKeysByAccount.set("acct_a", [vaultKey("vault-1")]);
		await harness.project(
			[account("a")],
			[loginItem("a-1"), loginItem("a-2", { vaultId: "vault-2" })],
		);

		expect(harness.native.itemIds("user-a")).toEqual(["a-1"]);
	});

	test("losing a vault key republishes the account without its items", async () => {
		const items = [loginItem("a-1"), loginItem("a-2", { vaultId: "vault-2" })];
		harness.vaultKeysByAccount.set("acct_a", [
			vaultKey("vault-1"),
			vaultKey("vault-2"),
		]);
		await harness.project([account("a")], items);
		expect(harness.native.itemIds("user-a")).toEqual(["a-1", "a-2"]);

		harness.vaultKeysByAccount.set("acct_a", [vaultKey("vault-1")]);
		await harness.project([account("a")], items);

		expect(harness.native.itemIds("user-a")).toEqual(["a-1"]);
	});

	test("an account with no vault keys publishes nothing and forgets its generation", async () => {
		const items = [loginItem("a-1")];
		await harness.project([account("a")], items);
		expect(harness.native.payloads).toHaveLength(1);

		harness.vaultKeysByAccount.set("acct_a", []);
		await harness.project([account("a")], items);
		expect(harness.native.payloads).toHaveLength(1);

		// The keys come back with the same data. The generation was forgotten, so it
		// is published again rather than skipped as unchanged.
		harness.vaultKeysByAccount.set("acct_a", [vaultKey("vault-1")]);
		await harness.project([account("a")], items);
		expect(harness.native.payloads).toHaveLength(2);
	});

	test("an account that needs reauthentication throws rather than publishing a partial identity", async () => {
		harness.secretKeyByAccount.set("acct_a", null);

		expect(
			await harness.project([account("a")], [loginItem("a-1")]),
		).toBeNull();
		expect(harness.native.payloads).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Travel mode
// ---------------------------------------------------------------------------

describe("travel mode", () => {
	test("an account with no verified policy publishes nothing", async () => {
		harness.policyByAccount.delete("acct_a");

		await harness.project([account("a")], [loginItem("a-1")]);

		expect(harness.native.payloads).toHaveLength(0);
		expect(harness.native.itemIds("user-a")).toEqual([]);
	});

	test("an unverified account does not stop the accounts behind it", async () => {
		harness.policyByAccount.delete("acct_a");

		await harness.project(
			[account("a"), account("b")],
			[
				loginItem("a-1"),
				loginItem("b-1", { accountId: "acct_b", vaultId: "vault-9" }),
			],
		);

		expect(harness.native.itemIds("user-a")).toEqual([]);
		expect(harness.native.itemIds("user-b")).toEqual(["b-1"]);
	});

	test("losing verification stops republishing and forgets the generation", async () => {
		const items = [loginItem("a-1")];
		await harness.project([account("a")], items);

		harness.policyByAccount.delete("acct_a");
		await harness.project([account("a")], items);
		expect(harness.native.payloads).toHaveLength(1);

		harness.policyByAccount.set("acct_a", verifiedPolicy());
		await harness.project([account("a")], items);
		expect(harness.native.payloads).toHaveLength(2);
	});

	test("the policy and the data it governs arrive in the same call", async () => {
		harness.policyByAccount.set(
			"acct_a",
			verifiedPolicy({ enabled: true, hiddenVaultIds: ["vault-2"] }),
		);
		harness.vaultKeysByAccount.set("acct_a", [
			vaultKey("vault-1"),
			vaultKey("vault-2"),
		]);

		await harness.project(
			[account("a")],
			[loginItem("a-1"), loginItem("a-2", { vaultId: "vault-2" })],
		);

		const payload = harness.native.payload(0);
		expect(payload.travelMode).toEqual({
			verified: true,
			enabled: true,
			hiddenVaultIds: ["vault-2"],
			updatedAt: 1,
		});
		expect(payload.items.map((item) => item.id)).toEqual(["a-1", "a-2"]);
		// The native side erases the hidden vault before it writes a row.
		expect(harness.native.itemIds("user-a")).toEqual(["a-1"]);
	});

	test("a policy change alone republishes the account", async () => {
		const items = [loginItem("a-1")];
		await harness.project([account("a")], items);

		harness.policyByAccount.set(
			"acct_a",
			verifiedPolicy({
				enabled: true,
				hiddenVaultIds: ["vault-7"],
				updatedAt: 2,
			}),
		);
		await harness.project([account("a")], items);

		expect(harness.native.payloads).toHaveLength(2);
		expect(harness.native.payload(1).travelMode.enabled).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Accounts coming and going
// ---------------------------------------------------------------------------

describe("accounts coming and going", () => {
	test("with no accounts nothing is published", async () => {
		expect(await harness.project([], [loginItem("a-1")])).toBeNull();
		expect(harness.native.payloads).toHaveLength(0);
	});

	test("an account that goes away and comes back is published again", async () => {
		const items = [loginItem("a-1")];
		await harness.project([account("a")], items);
		await harness.project([account("b")], []);
		await harness.project([account("a")], items);

		expect(
			harness.native.payloads
				.map((payload) => (JSON.parse(payload) as { userId: string }).userId)
				.filter((userId) => userId === "user-a"),
		).toHaveLength(2);
	});

	test("signing out drops the native keys and every published generation", async () => {
		const items = [loginItem("a-1")];
		await harness.project([account("a")], items);
		expect(harness.native.payloads).toHaveLength(1);

		await harness.replica.clearAll();
		expect(harness.native.clears).toHaveLength(1);

		// The same account with the same data has to be published again: after a
		// sign-out the replica holds nothing, so "unchanged" would serve nothing.
		await harness.project([account("a")], items);
		expect(harness.native.payloads).toHaveLength(2);
	});

	test("a purge on a host with no plugin does not throw", async () => {
		harness.native.available = false;
		await harness.replica.clearAll();
		expect(harness.native.clears).toHaveLength(0);
	});

	test("the live keys are mirrored before anything is published", async () => {
		harness.unlockedAccounts = ["acct_a"];
		await harness.project([account("a")], [loginItem("a-1")]);

		expect(harness.preparedUnlocks).toEqual([["acct_a"]]);
	});

	/**
	 * A locked account has no live key in the other process, so every row it could
	 * publish is ciphertext nobody can read. Sending one costs a key mirror and buys
	 * nothing; sending an *empty* one destroys what the account was serving.
	 */
	test("nothing is published while no account is unlocked", async () => {
		harness.unlockedAccounts = [];
		await harness.project([account("a")], []);

		expect(harness.preparedUnlocks).toEqual([]);
		expect(harness.native.payloads).toHaveLength(0);
	});

	/**
	 * Locking clears `VaultRepository`, so the debounced pass that follows sees no
	 * items at all. Publishing that is the bug: the snapshot is authoritative, so it
	 * replaces every row the account was serving with nothing, and the next autofill
	 * unlock finds a live key over an empty replica.
	 */
	test("a locked account keeps serving its last published generation", async () => {
		await harness.project([account("a")], [loginItem("a-1")]);
		expect(harness.native.itemIds("user-a")).toEqual(["a-1"]);

		harness.unlockedAccounts = [];
		await harness.project([account("a")], []);

		expect(harness.native.itemIds("user-a")).toEqual(["a-1"]);
		expect(harness.native.payloads).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Queued vault writes — the one path that runs the other way
// ---------------------------------------------------------------------------

describe("queued vault writes", () => {
	function mutation(
		overrides: Partial<PendingPasskeyMutation> = {},
	): PendingPasskeyMutation {
		return {
			id: `mut-${overrides.itemId ?? "1"}`,
			userId: "user-a",
			vaultId: "vault-1",
			itemId: "item-1",
			operation: "update_item",
			encryptedData: "cipher",
			encryptionIv: "iv",
			encryptionAlgorithm: "AES-GCM-AAD-V1",
			baseVersion: 3,
			encryptionVersion: 1,
			encryptedByUserId: "user-a",
			createdAt: harness.nowMs,
			attemptCount: 0,
			...overrides,
		};
	}

	function outbound() {
		const enqueued: unknown[] = [];
		return {
			enqueued,
			sync: {
				outboundQueue: {
					enqueue: async (command: unknown) => {
						enqueued.push(command);
					},
				},
			},
		};
	}

	test("a queued write becomes an outbound command with its native encryption context", async () => {
		harness.queue.pending = [mutation()];
		const target = outbound();

		const result = await harness.projection.flushQueuedVaultWrites({
			accounts: [account("a")],
			outbound: target.sync,
		});

		expect(result).toEqual({ applied: 1, failed: 0, discarded: 0 });
		expect(target.enqueued).toEqual([
			{
				id: "mut-1",
				operationId: "mut-1",
				accountId: "acct_a",
				accountEmail: "a@x.dev",
				type: "update",
				entityId: "item-1",
				vaultId: "vault-1",
				category: undefined,
				encryptedPayload: {
					encryptedData: "cipher",
					encryptionIv: "iv",
					encryptionAlgorithm: "AES-GCM-AAD-V1",
					encryptionVersion: 1,
					encryptedByUserId: "user-a",
				},
				baseVersion: 3,
				timestamp: harness.nowMs,
				retryCount: 0,
			},
		]);
		// Accepted work is dropped from the native queue, and only then.
		expect(harness.queue.forgotten).toEqual(["mut-1"]);
	});

	test("a queued write never becomes a local item write", async () => {
		harness.queue.pending = [mutation()];
		const target = outbound();

		await harness.projection.flushQueuedVaultWrites({
			accounts: [account("a")],
			outbound: target.sync,
		});

		// The only exit is the outbound queue. Nothing here touches the app's own
		// item state — the server's answer is what comes back, through sync.
		expect(target.enqueued).toHaveLength(1);
		expect(harness.native.payloads).toHaveLength(0);
	});

	test("a write for an account that is not unlocked stays queued", async () => {
		harness.queue.pending = [mutation({ userId: "user-z" })];
		const target = outbound();

		const result = await harness.projection.flushQueuedVaultWrites({
			accounts: [account("a")],
			outbound: target.sync,
		});

		expect(result).toEqual({ applied: 0, failed: 0, discarded: 0 });
		expect(target.enqueued).toHaveLength(0);
		expect(harness.queue.forgotten).toEqual([]);
		expect(harness.queue.failures).toEqual([]);
	});

	test("a write that has been tried too often or waited too long is discarded", async () => {
		harness.queue.pending = [
			mutation({
				itemId: "tired",
				attemptCount: MAX_QUEUED_VAULT_WRITE_ATTEMPTS,
			}),
			mutation({
				itemId: "old",
				createdAt: harness.nowMs - MAX_QUEUED_VAULT_WRITE_AGE_MS - 1,
			}),
			mutation({ itemId: "fresh" }),
		];
		const target = outbound();

		const result = await harness.projection.flushQueuedVaultWrites({
			accounts: [account("a")],
			outbound: target.sync,
		});

		expect(result).toEqual({ applied: 1, failed: 0, discarded: 2 });
		expect(target.enqueued).toHaveLength(1);
		expect(harness.queue.forgotten.sort()).toEqual([
			"mut-fresh",
			"mut-old",
			"mut-tired",
		]);
	});

	test("a refusal the server will repeat is discarded, not retried forever", async () => {
		harness.queue.pending = [mutation({ itemId: "gone" })];
		const target = {
			outboundQueue: {
				enqueue: async () => {
					throw new Error("Item not found");
				},
			},
		};

		const result = await harness.projection.flushQueuedVaultWrites({
			accounts: [account("a")],
			outbound: target,
		});

		expect(result).toEqual({ applied: 0, failed: 0, discarded: 1 });
		expect(harness.queue.forgotten).toEqual(["mut-gone"]);
		expect(harness.queue.failures).toEqual([]);
	});

	test("an update to an id the server never saw is discarded", async () => {
		harness.queue.pending = [
			mutation({ itemId: "local_passkey_1", operation: "update_item" }),
		];
		const target = {
			outboundQueue: {
				enqueue: async () => {
					throw new Error("connection reset");
				},
			},
		};

		const result = await harness.projection.flushQueuedVaultWrites({
			accounts: [account("a")],
			outbound: target,
		});

		expect(result).toEqual({ applied: 0, failed: 0, discarded: 1 });
		expect(harness.queue.forgotten).toEqual(["mut-local_passkey_1"]);
	});

	test("a failure that may pass later is counted and keeps its reason", async () => {
		harness.queue.pending = [
			mutation({ itemId: "one" }),
			mutation({ itemId: "two" }),
		];
		const target = {
			outboundQueue: {
				enqueue: async () => {
					throw new Error("network unreachable");
				},
			},
		};

		const result = await harness.projection.flushQueuedVaultWrites({
			accounts: [account("a")],
			outbound: target,
		});

		expect(result).toEqual({ applied: 0, failed: 2, discarded: 0 });
		// One acknowledgement per reason, and nothing is dropped from the queue.
		expect(harness.queue.failures).toEqual([
			{ ids: ["mut-one", "mut-two"], error: "network unreachable" },
		]);
		expect(harness.queue.forgotten).toEqual([]);
	});

	test("with no sync engine the writes stay queued and are counted as failures", async () => {
		harness.queue.pending = [mutation()];

		const result = await harness.projection.flushQueuedVaultWrites({
			accounts: [account("a")],
			outbound: undefined,
		});

		expect(result).toEqual({ applied: 0, failed: 1, discarded: 0 });
		expect(harness.queue.failures).toEqual([
			{ ids: ["mut-1"], error: "Item sync engine is unavailable" },
		]);
		expect(harness.queue.forgotten).toEqual([]);
	});

	test("with no accounts the queue is left alone", async () => {
		harness.queue.pending = [mutation()];

		const result = await harness.projection.flushQueuedVaultWrites({
			accounts: [],
			outbound: outbound().sync,
		});

		expect(result).toEqual({ applied: 0, failed: 0, discarded: 0 });
		expect(harness.queue.forgotten).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// One pass, in order
// ---------------------------------------------------------------------------

describe("a sync pass", () => {
	test("queued writes are flushed before anything is published", async () => {
		let publishedWhenRefreshed = -1;
		harness.queue.pending = [
			{
				id: "mut-1",
				userId: "user-a",
				vaultId: "vault-1",
				itemId: "item-1",
				operation: "update_item",
				encryptedData: "cipher",
				encryptionIv: "iv",
				encryptionAlgorithm: "AES-GCM-AAD-V1",
				baseVersion: 1,
				encryptionVersion: 1,
				encryptedByUserId: "user-a",
				createdAt: harness.nowMs,
				attemptCount: 0,
			},
		];

		const result = await harness.projection.runPass({
			accounts: [account("a")],
			loginItems: [loginItem("a-1")],
			outbound: {
				outboundQueue: {
					enqueue: async () => {},
				},
			},
			onQueuedWritesApplied: async () => {
				publishedWhenRefreshed = harness.native.payloads.length;
			},
		});

		// A provider-made write reaches the server before the app overwrites the
		// replica with what it knew a moment ago.
		expect(publishedWhenRefreshed).toBe(0);
		expect(result.queuedWrites.applied).toBe(1);
		expect(result.projected).toEqual({ vaultKeys: 1, items: 1, domains: 0 });
		expect(harness.native.payloads).toHaveLength(1);
	});

	/**
	 * The second request carries newer items. Repeating the first pass's own input
	 * republishes what was already published and leaves the newer items sitting in
	 * the app until something else changes them.
	 */
	test("a request that arrives mid-pass is served with its own items", async () => {
		let startFirstPass!: () => void;
		const firstPassStarted = new Promise<void>((resolve) => {
			startFirstPass = resolve;
		});
		let releaseFirstPass!: () => void;
		const firstPassBlocked = new Promise<void>((resolve) => {
			releaseFirstPass = resolve;
		});

		let passes = 0;
		harness.projection = createCredentialProjection({
			...harness.deps(),
			// Hold the first pass open, so the second request lands mid-pass.
			waitForIdle: async () => {
				passes += 1;
				if (passes > 1) return;
				startFirstPass();
				await firstPassBlocked;
			},
		});

		const first = harness.projection.runLatestPass({
			accounts: [account("a")],
			loginItems: [loginItem("a-1")],
			outbound: undefined,
		});
		await firstPassStarted;

		const second = harness.projection.runLatestPass({
			accounts: [account("a")],
			loginItems: [loginItem("a-1"), loginItem("a-2")],
			outbound: undefined,
		});
		releaseFirstPass();
		await Promise.all([first, second]);

		// Two passes, and the second one published what the second request held.
		expect(passes).toBe(2);
		expect(harness.native.itemIds("user-a")).toEqual(["a-1", "a-2"]);
	});

	/** A pass must repeat for a request, never for its own output. */
	test("a pass that nobody asked to repeat runs once", async () => {
		let passes = 0;
		harness.projection = createCredentialProjection({
			...harness.deps(),
			waitForIdle: async () => {
				passes += 1;
			},
		});

		await harness.projection.runLatestPass({
			accounts: [account("a")],
			loginItems: [loginItem("a-1")],
			outbound: undefined,
		});

		expect(passes).toBe(1);
	});

	test("nothing is refreshed when no queued write was accepted", async () => {
		let refreshed = 0;
		await harness.projection.runPass({
			accounts: [account("a")],
			loginItems: [loginItem("a-1")],
			outbound: undefined,
			onQueuedWritesApplied: async () => {
				refreshed += 1;
			},
		});

		expect(refreshed).toBe(0);
	});
});
