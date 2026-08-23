import { describe, expect, it } from "bun:test";
import type { InMemoryCryptoPort } from "@bittery/crypto-port/testing";
import { arrayBufferToBase64 } from "@bittery/shared/crypto";
import { cachedItem as buildCachedItem } from "@bittery/shared/testing/item-fixtures";
import type { AccountStore, ItemCache } from "@bittery/storage";
import type {
	InMemoryPlatformPort,
	InMemoryRecordPort,
} from "@bittery/storage/testing";
import type { VaultKeyData } from "@bittery/storage/types";
import type { CachedEncryptedItem, CachedVaultMetadata } from "@bittery/types";
import {
	accountMetadata,
	createTestAccountStore,
	createTestItemCache,
	mukFor,
	mukRefFor,
	seedAccountWithSession,
} from "../testing/account-store-harness";
import {
	type CredentialMirror,
	deleteAccountEverywhere,
	type LifecycleDeps,
	lockAccount,
	lockAllAccounts,
	lockInvalidSession,
	removeAccount,
	type SessionCredentialRef,
	signOutAccount,
	wipeDevice,
} from "./account-lifecycle";

const DEVICE_KEY = "bittery_device_key";
const SERVER_URL = "https://app.bittery.io";
const FAILURE = new Error("keychain unavailable");

/** The three collections `${accountId}:items|vaults|meta`, in `collections()` order. */
function segmentsOf(accountId: string): string[] {
	return [`${accountId}:items`, `${accountId}:meta`, `${accountId}:vaults`];
}

function cachedItem(id: string): CachedEncryptedItem {
	return buildCachedItem({
		id,
		vaultId: "vault-1",
		encryptedData: "ciphertext",
		encryptionIv: "iv",
		encryptionAlgorithm: "fake",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	});
}

function cachedVault(id: string): CachedVaultMetadata {
	return { id, name: "Personal", type: "personal", icon: null, imageUrl: null };
}

function vaultKey(accountId: string): VaultKeyData {
	return {
		vaultId: `vault-${accountId}`,
		vaultName: "Personal",
		vaultType: "personal",
		encryptedVaultKey: `wrapped-${accountId}`,
		role: "owner",
	};
}

interface RecordingMirror extends CredentialMirror {
	readonly calls: SessionCredentialRef[][];
	/**
	 * The store's own JWT read back at purge time: still non-null is the proof the
	 * mirror was purged before the store dropped it.
	 */
	readonly tokensAtPurge: Array<Array<string | null>>;
	/** Each `forgetQuickUnlock` scope, as `"device"` or the account ids it named. */
	readonly forgotten: Array<"device" | string[]>;
}

function createRecordingMirror(
	storage: AccountStore,
	throws: boolean,
): RecordingMirror {
	const calls: SessionCredentialRef[][] = [];
	const tokensAtPurge: Array<Array<string | null>> = [];
	const forgotten: Array<"device" | string[]> = [];
	return {
		calls,
		tokensAtPurge,
		forgotten,
		async forgetQuickUnlock(scope): Promise<void> {
			forgotten.push(
				scope === "device" ? "device" : scope.map((ref) => ref.accountId),
			);
		},
		async purge(refs: SessionCredentialRef[]): Promise<void> {
			calls.push(refs);
			tokensAtPurge.push(
				await Promise.all(
					refs.map((ref) => storage.getAuthToken(ref.accountId)),
				),
			);
			if (throws) {
				throw FAILURE;
			}
		},
	};
}

interface Fixture {
	storage: AccountStore;
	itemCache: ItemCache;
	crypto: InMemoryCryptoPort;
	port: InMemoryPlatformPort;
	cachePort: InMemoryRecordPort;
	mirror: RecordingMirror;
	deps: LifecycleDeps;
}

/** `acc-1` active and unlocked, `acc-2` locked; both fully seeded on both siblings. */
async function createFixture(
	options: { mirrorThrows?: boolean } = {},
): Promise<Fixture> {
	const harness = await createTestAccountStore();
	const { store, port, crypto } = harness;
	// Pre-seeded instead of randomly generated, so two fixtures are comparable byte for byte.
	await port.secretSet(DEVICE_KEY, arrayBufferToBase64(mukFor("device")));
	const { cache, port: cachePort } = await createTestItemCache();

	for (const accountId of ["acc-1", "acc-2"]) {
		await seedAccountWithSession(
			harness,
			accountMetadata({ accountId, biometricEnabled: true }),
			{ unlocked: accountId === "acc-1" },
		);
		await store.storeServerUrl(SERVER_URL, accountId);
		await store.storeVaultKeys([vaultKey(accountId)], accountId);
		await store.storeEncryptedPrivateKey(`private-${accountId}`, accountId);
		await cache.setCachedItems([cachedItem(`item-${accountId}`)], accountId);
		await cache.setCachedVaults([cachedVault(`vault-${accountId}`)], accountId);
		await cache.setItemCacheMetadata(
			{ lastFullSyncAt: 1, itemCount: 1, cacheVersion: 1 },
			accountId,
		);
	}
	await store.setActiveAccount("acc-1");

	const mirror = createRecordingMirror(store, options.mirrorThrows === true);
	return {
		storage: store,
		itemCache: cache,
		crypto,
		port,
		cachePort,
		mirror,
		deps: { storage: store, itemCache: cache, credentialMirror: mirror },
	};
}

/**
 * Everything both ports hold — the comparison unit for "changes nothing".
 *
 * The wrapped master unlock key inside `session_data` is replaced by a marker: it is sealed
 * with a fresh IV on every write, so its bytes differ between two fixtures built from the
 * same inputs. Whether the field is there at all is the property under test.
 */
function fullState(fixture: Fixture): unknown {
	const normalizeStore = (store: Record<string, string>) =>
		Object.fromEntries(
			Object.entries(store).map(([key, value]) => [
				key,
				key.endsWith("_session_data") ? maskWrappedKey(value) : value,
			]),
		);
	const snapshot = fixture.port.snapshot();
	return {
		secrets: normalizeStore(snapshot.secrets),
		device: normalizeStore(snapshot.device),
		session: normalizeStore(snapshot.session),
		collections: fixture.cachePort.collections(),
	};
}

function maskWrappedKey(sessionData: string): string {
	const parsed = JSON.parse(sessionData) as {
		encryptedMasterUnlockKey?: unknown;
	};
	return JSON.stringify({
		...parsed,
		encryptedMasterUnlockKey: parsed.encryptedMasterUnlockKey
			? "<wrapped>"
			: parsed.encryptedMasterUnlockKey,
	});
}

/** Every port key belonging to one account, across all three stores. */
function accountKeys(port: InMemoryPlatformPort, accountId: string): string[] {
	const snapshot = port.snapshot();
	return [
		...Object.keys(snapshot.secrets),
		...Object.keys(snapshot.device),
		...Object.keys(snapshot.session),
	]
		.filter((key) => key.startsWith(`bittery_account_${accountId}_`))
		.sort();
}

async function accountIds(storage: AccountStore): Promise<string[]> {
	return (await storage.getAccountsList()).map((account) => account.accountId);
}

describe("lockAccount", () => {
	it("keeps session_data and every cache segment while dropping the session keys", async () => {
		const fixture = await createFixture();

		const outcome = await lockAccount("acc-1", fixture.deps);

		expect(outcome.failures).toEqual([]);
		expect(outcome.affected.map((account) => account.accountId)).toEqual([
			"acc-1",
		]);
		expect(outcome.wasActive).toBe(true);
		expect(await fixture.storage.getStoredSessionData("acc-1")).not.toBeNull();
		expect(await fixture.storage.getStoredSecretKey("acc-1")).toBe(
			"secret-acc-1",
		);
		expect(await fixture.storage.getAuthToken("acc-1")).toBeNull();
		expect(await fixture.storage.getVaultKeys("acc-1")).toBeNull();
		expect(await fixture.storage.getEncryptedPrivateKey("acc-1")).toBeNull();
		expect(await fixture.storage.getUnlockedAccounts()).toEqual([]);
		expect(fixture.cachePort.collections()).toEqual([
			...segmentsOf("acc-1"),
			...segmentsOf("acc-2"),
		]);
	});

	it("leaves the sibling account untouched on every axis", async () => {
		const fixture = await createFixture();

		await lockAccount("acc-1", fixture.deps);

		expect(await fixture.storage.getStoredSessionData("acc-2")).not.toBeNull();
		expect(await fixture.storage.getAuthToken("acc-2")).toBe("token-acc-2");
		expect(await fixture.storage.getVaultKeys("acc-2")).toEqual([
			vaultKey("acc-2"),
		]);
		expect(await fixture.storage.getEncryptedPrivateKey("acc-2")).toBe(
			"private-acc-2",
		);
		expect(await fixture.storage.getStoredSecretKey("acc-2")).toBe(
			"secret-acc-2",
		);
		expect(await fixture.storage.getServerUrl("acc-2")).toBe(SERVER_URL);
	});

	it("leaves the active pointer and the accounts list unchanged", async () => {
		const fixture = await createFixture();
		const before = await fixture.storage.getAccountsList();

		const outcome = await lockAccount("acc-1", fixture.deps);

		expect(await fixture.storage.getActiveAccount()).toEqual("acc-1");
		expect(await fixture.storage.getAccountsList()).toEqual(before);
		expect(outcome.activeAccountId).toBe("acc-1");
		expect(outcome.remaining.map((account) => account.accountId)).toEqual([
			"acc-1",
			"acc-2",
		]);
	});

	it("purges the credential mirror before the store drops the token", async () => {
		const fixture = await createFixture();

		await lockAccount("acc-1", fixture.deps);

		expect(fixture.mirror.calls).toEqual([
			[{ accountId: "acc-1", authToken: "token-acc-1", serverUrl: SERVER_URL }],
		]);
		expect(fixture.mirror.tokensAtPurge).toEqual([["token-acc-1"]]);
	});

	it("is a no-op when the account is already locked", async () => {
		const fixture = await createFixture();
		await lockAccount("acc-1", fixture.deps);
		const before = fullState(fixture);

		const outcome = await lockAccount("acc-1", fixture.deps);

		expect(outcome.failures).toEqual([]);
		expect(fullState(fixture)).toEqual(before);
	});

	it("changes nothing and reports no failures for an unknown account", async () => {
		const fixture = await createFixture();
		const before = fullState(fixture);

		const outcome = await lockAccount("acc-404", fixture.deps);

		expect(outcome.failures).toEqual([]);
		expect(outcome.affected).toEqual([]);
		expect(outcome.wasActive).toBe(false);
		expect(fullState(fixture)).toEqual(before);
	});
});

describe("lockAllAccounts", () => {
	it("pins the known asymmetry: drops every master unlock key but keeps every JWT", async () => {
		const fixture = await createFixture();
		await fixture.storage.setMasterUnlockKey(
			await mukRefFor(fixture.crypto, "acc-2"),
			"acc-2",
		);

		const outcome = await lockAllAccounts(fixture.deps);

		expect(outcome.failures).toEqual([]);
		expect(await fixture.storage.getUnlockedAccounts()).toEqual([]);
		// Deliberately weaker than N × lockAccount: `storage.lockAllAccounts` keeps
		// the JWTs so an autolock does not turn quick-unlock into a re-login.
		expect(await fixture.storage.getAuthToken("acc-1")).toBe("token-acc-1");
		expect(await fixture.storage.getAuthToken("acc-2")).toBe("token-acc-2");
		expect(await fixture.storage.getVaultKeys("acc-1")).toEqual([
			vaultKey("acc-1"),
		]);
		expect(await fixture.storage.getEncryptedPrivateKey("acc-1")).toBe(
			"private-acc-1",
		);
	});

	it("keeps every session_data and every cache segment", async () => {
		const fixture = await createFixture();

		const outcome = await lockAllAccounts(fixture.deps);

		expect(outcome.affected.map((account) => account.accountId)).toEqual([
			"acc-1",
			"acc-2",
		]);
		expect(await fixture.storage.getStoredSessionData("acc-1")).not.toBeNull();
		expect(await fixture.storage.getStoredSessionData("acc-2")).not.toBeNull();
		expect(fixture.cachePort.collections()).toEqual([
			...segmentsOf("acc-1"),
			...segmentsOf("acc-2"),
		]);
		expect(await fixture.storage.getActiveAccount()).toEqual("acc-1");
	});

	it("is a no-op when every account is already locked", async () => {
		const fixture = await createFixture();
		await lockAllAccounts(fixture.deps);
		const before = fullState(fixture);

		const outcome = await lockAllAccounts(fixture.deps);

		expect(outcome.failures).toEqual([]);
		expect(fullState(fixture)).toEqual(before);
	});
});

describe("signOutAccount", () => {
	it("deletes the session and all three cache segments", async () => {
		const fixture = await createFixture();

		const outcome = await signOutAccount("acc-1", fixture.deps);

		expect(outcome.failures).toEqual([]);
		expect(await fixture.storage.getStoredSessionData("acc-1")).toBeNull();
		expect(await fixture.storage.getAuthToken("acc-1")).toBeNull();
		expect(await fixture.storage.getVaultKeys("acc-1")).toBeNull();
		expect(await fixture.storage.getEncryptedPrivateKey("acc-1")).toBeNull();
		expect(await fixture.storage.getUnlockedAccounts()).toEqual([]);
		expect(fixture.cachePort.collections()).toEqual(segmentsOf("acc-2"));
	});

	it("deletes the Secret Key while keeping account metadata after explicit Sign out", async () => {
		const fixture = await createFixture();

		await signOutAccount("acc-1", fixture.deps);

		expect(await fixture.storage.getStoredSecretKey("acc-1")).toBeNull();
		expect(await fixture.storage.getServerUrl("acc-1")).toBe(SERVER_URL);
		expect(await fixture.storage.isBiometricEnabled("acc-1")).toBe(true);
		expect(await accountIds(fixture.storage)).toEqual(["acc-1", "acc-2"]);
	});

	it("locks a rejected Server Session without deleting Quick Unlock material", async () => {
		const fixture = await createFixture();
		await fixture.storage.updateStoredSessionMetadata("acc-1", {
			sessionId: "session-acc-1",
			expiresAt: Date.now() + 60_000,
		});

		const outcome = await lockInvalidSession(
			{ sessionId: "session-acc-1" },
			fixture.deps,
		);

		expect(outcome.failures).toEqual([]);
		expect(await fixture.storage.getAuthToken("acc-1")).toBeNull();
		expect(await fixture.storage.getStoredSessionData("acc-1")).not.toBeNull();
		expect(await fixture.storage.getStoredSecretKey("acc-1")).toBe(
			"secret-acc-1",
		);
	});

	it("leaves the active pointer on the signed-out account", async () => {
		const fixture = await createFixture();

		const outcome = await signOutAccount("acc-1", fixture.deps);

		expect(await fixture.storage.getActiveAccount()).toEqual("acc-1");
		expect(outcome.activeAccountId).toBe("acc-1");
		expect(outcome.wasActive).toBe(true);
	});

	it("leaves the sibling's session and every one of its segments intact", async () => {
		const fixture = await createFixture();

		await signOutAccount("acc-1", fixture.deps);

		expect(await fixture.storage.getStoredSessionData("acc-2")).not.toBeNull();
		expect(await fixture.storage.getAuthToken("acc-2")).toBe("token-acc-2");
		expect(await fixture.storage.getVaultKeys("acc-2")).toEqual([
			vaultKey("acc-2"),
		]);
		expect(fixture.cachePort.collections()).toEqual(segmentsOf("acc-2"));
	});

	it("is a no-op when the session is already gone", async () => {
		const fixture = await createFixture();
		await signOutAccount("acc-1", fixture.deps);
		const before = fullState(fixture);

		const outcome = await signOutAccount("acc-1", fixture.deps);

		expect(outcome.failures).toEqual([]);
		expect(fullState(fixture)).toEqual(before);
	});

	it("clears the item cache even when forgetSession throws", async () => {
		const fixture = await createFixture();
		fixture.storage.forgetSession = async (): Promise<void> => {
			throw FAILURE;
		};

		const outcome = await signOutAccount("acc-1", fixture.deps);

		expect(fixture.cachePort.collections()).toEqual(segmentsOf("acc-2"));
		expect(outcome.failures).toEqual([
			{ accountId: "acc-1", step: "forget_session", cause: FAILURE },
		]);
	});

	it("still clears both sides when the credential mirror throws", async () => {
		const fixture = await createFixture({ mirrorThrows: true });

		const outcome = await signOutAccount("acc-1", fixture.deps);

		expect(await fixture.storage.getStoredSessionData("acc-1")).toBeNull();
		expect(fixture.cachePort.collections()).toEqual(segmentsOf("acc-2"));
		expect(outcome.failures).toEqual([
			{ accountId: "acc-1", step: "purge_credential_mirror", cause: FAILURE },
		]);
	});

	it("locks a target resolved by account id", async () => {
		const fixture = await createFixture();

		const outcome = await lockInvalidSession(
			{ accountId: "acc-2" },
			fixture.deps,
		);

		expect(outcome.affected.map((account) => account.accountId)).toEqual([
			"acc-2",
		]);
		expect(await fixture.storage.getAuthToken("acc-2")).toBeNull();
		expect(await fixture.storage.getStoredSessionData("acc-2")).not.toBeNull();
		expect(await fixture.storage.getStoredSessionData("acc-1")).not.toBeNull();
		expect(fixture.cachePort.collections()).toEqual([
			...segmentsOf("acc-1"),
			...segmentsOf("acc-2"),
		]);
	});

	it("locks a target resolved by sessionId", async () => {
		const fixture = await createFixture();
		await fixture.storage.updateStoredSessionMetadata("acc-2", {
			sessionId: "session-acc-2",
			expiresAt: Date.now() + 60_000,
		});

		const outcome = await lockInvalidSession(
			{ sessionId: "session-acc-2" },
			fixture.deps,
		);

		expect(outcome.affected.map((account) => account.accountId)).toEqual([
			"acc-2",
		]);
		expect(await fixture.storage.getAuthToken("acc-2")).toBeNull();
		expect(await fixture.storage.getStoredSessionData("acc-2")).not.toBeNull();
		expect(await fixture.storage.getStoredSessionData("acc-1")).not.toBeNull();
	});

	it("destroys nothing when the target resolves to no account", async () => {
		const fixture = await createFixture();
		const before = fullState(fixture);

		const outcome = await lockInvalidSession(
			{ accountId: "nobody" },
			fixture.deps,
		);

		expect(outcome.affected).toEqual([]);
		expect(outcome.failures).toEqual([]);
		expect(fullState(fixture)).toEqual(before);
	});
});

describe("removeAccount", () => {
	it("removes the row, every account-scoped key, the MUK and all three segments", async () => {
		const fixture = await createFixture();

		const outcome = await removeAccount("acc-1", fixture.deps);

		expect(outcome.failures).toEqual([]);
		expect(await accountIds(fixture.storage)).toEqual(["acc-2"]);
		expect(accountKeys(fixture.port, "acc-1")).toEqual([]);
		expect(await fixture.storage.getStoredSecretKey("acc-1")).toBeNull();
		expect(await fixture.storage.getStoredSessionData("acc-1")).toBeNull();
		expect(await fixture.storage.getAuthToken("acc-1")).toBeNull();
		expect(await fixture.storage.getUnlockedAccounts()).toEqual([]);
		expect(fixture.cachePort.collections()).toEqual(segmentsOf("acc-2"));
	});

	it("leaves the sibling fully intact", async () => {
		const fixture = await createFixture();

		await removeAccount("acc-1", fixture.deps);

		expect(accountKeys(fixture.port, "acc-2")).toEqual([
			"bittery_account_acc-2_biometric_enabled",
			"bittery_account_acc-2_encrypted_private_key",
			"bittery_account_acc-2_jwt_token",
			"bittery_account_acc-2_secret_key",
			"bittery_account_acc-2_server_url",
			"bittery_account_acc-2_session_data",
			"bittery_account_acc-2_vault_keys",
		]);
		expect(await fixture.storage.getStoredSessionData("acc-2")).not.toBeNull();
		expect(fixture.cachePort.collections()).toEqual(segmentsOf("acc-2"));
	});

	it("promotes the successor when the removed account was active", async () => {
		const fixture = await createFixture();

		const outcome = await removeAccount("acc-1", fixture.deps);

		expect(outcome.wasActive).toBe(true);
		expect(outcome.activeAccountId).toBe("acc-2");
		expect(outcome.activeAccount?.accountId).toBe("acc-2");
		expect(await fixture.storage.getActiveAccount()).toEqual("acc-2");
	});

	it("does not move the pointer when a non-active account is removed", async () => {
		const fixture = await createFixture();

		const outcome = await removeAccount("acc-2", fixture.deps);

		expect(outcome.wasActive).toBe(false);
		expect(outcome.activeAccountId).toBe("acc-1");
		expect(await fixture.storage.getActiveAccount()).toEqual("acc-1");
	});

	it("keeps the device key while another account remains", async () => {
		const fixture = await createFixture();

		await removeAccount("acc-2", fixture.deps);

		expect(fixture.port.snapshot().secrets[DEVICE_KEY]).toBeDefined();
	});

	it("deletes the device key and leaves the pointer null when the last account goes", async () => {
		const fixture = await createFixture();

		await removeAccount("acc-2", fixture.deps);
		const outcome = await removeAccount("acc-1", fixture.deps);

		expect(outcome.failures).toEqual([]);
		expect(await accountIds(fixture.storage)).toEqual([]);
		expect(await fixture.storage.getActiveAccount()).toBeNull();
		expect(outcome.activeAccountId).toBeUndefined();
		expect(fixture.port.snapshot().secrets[DEVICE_KEY]).toBeUndefined();
		expect(fixture.cachePort.collections()).toEqual([]);
	});

	it("clears the cache before the row disappears", async () => {
		const fixture = await createFixture();
		const rowsAtCacheClear: string[][] = [];
		const clearItemCache = fixture.itemCache.clearItemCache.bind(
			fixture.itemCache,
		);
		fixture.itemCache.clearItemCache = async (
			accountId: string,
		): Promise<void> => {
			rowsAtCacheClear.push(await accountIds(fixture.storage));
			await clearItemCache(accountId);
		};

		await removeAccount("acc-1", fixture.deps);

		// The row is the only name the segments have; clearing them after it is gone
		// orphans the ciphertext permanently.
		expect(rowsAtCacheClear).toEqual([["acc-1", "acc-2"]]);
	});

	it("leaves no orphaned segment behind when clearing the account data throws", async () => {
		const fixture = await createFixture();
		fixture.storage.clearAllStoredData = async (): Promise<void> => {
			throw FAILURE;
		};

		const outcome = await removeAccount("acc-1", fixture.deps);

		expect(fixture.cachePort.collections()).toEqual(segmentsOf("acc-2"));
		expect(await accountIds(fixture.storage)).toEqual(["acc-1", "acc-2"]);
		expect(outcome.failures).toEqual([
			{ accountId: "acc-1", step: "clear_account_data", cause: FAILURE },
		]);
	});

	it("does not demote the promoted successor on a repeated removal", async () => {
		const fixture = await createFixture();
		await removeAccount("acc-1", fixture.deps);
		const before = fullState(fixture);

		const outcome = await removeAccount("acc-1", fixture.deps);

		expect(outcome.failures).toEqual([]);
		expect(await fixture.storage.getActiveAccount()).toEqual("acc-2");
		expect(fullState(fixture)).toEqual(before);
	});

	it("changes nothing for an unknown account", async () => {
		const fixture = await createFixture();
		const before = fullState(fixture);

		const outcome = await removeAccount("acc-404", fixture.deps);

		expect(outcome.failures).toEqual([]);
		expect(outcome.affected).toEqual([]);
		expect(fullState(fixture)).toEqual(before);
	});
});

describe("wipeDevice", () => {
	it("empties the accounts list, the pointer, the device key and every segment", async () => {
		const fixture = await createFixture();

		const outcome = await wipeDevice(fixture.deps);

		expect(outcome.failures).toEqual([]);
		expect(outcome.affected.map((account) => account.accountId)).toEqual([
			"acc-1",
			"acc-2",
		]);
		expect(await accountIds(fixture.storage)).toEqual([]);
		expect(await fixture.storage.getActiveAccount()).toBeNull();
		expect(fixture.port.snapshot().secrets[DEVICE_KEY]).toBeUndefined();
		expect(fixture.cachePort.collections()).toEqual([]);
		expect(await fixture.storage.getUnlockedAccounts()).toEqual([]);
	});

	it("reports no failures on an already-wiped device", async () => {
		const fixture = await createFixture();
		await wipeDevice(fixture.deps);

		const outcome = await wipeDevice(fixture.deps);

		expect(outcome.failures).toEqual([]);
		expect(outcome.affected).toEqual([]);
		expect(outcome.remaining).toEqual([]);
	});

	it("removes the remaining accounts when one account fails", async () => {
		const fixture = await createFixture();
		const clearAllStoredData = fixture.storage.clearAllStoredData.bind(
			fixture.storage,
		);
		fixture.storage.clearAllStoredData = async (
			accountId?: string,
		): Promise<void> => {
			if (accountId === "acc-1") {
				throw FAILURE;
			}
			await clearAllStoredData(accountId);
		};

		const outcome = await wipeDevice(fixture.deps);

		expect(await accountIds(fixture.storage)).toEqual(["acc-1"]);
		expect(accountKeys(fixture.port, "acc-2")).toEqual([]);
		expect(fixture.cachePort.collections()).toEqual([]);
		expect(outcome.failures).toEqual([
			{ accountId: "acc-1", step: "clear_account_data", cause: FAILURE },
		]);
	});
});

describe("deleteAccountEverywhere", () => {
	it("aborts and leaves every local record intact when the server delete fails", async () => {
		const fixture = await createFixture();
		const before = fullState(fixture);

		const outcome = await deleteAccountEverywhere(
			{ accountId: "acc-1", confirmEmail: "acc-1@test.com" },
			{
				...fixture.deps,
				server: {
					deleteAccount: async (): Promise<void> => {
						throw FAILURE;
					},
				},
			},
		);

		expect(fullState(fixture)).toEqual(before);
		expect(fixture.mirror.calls).toEqual([]);
		expect(outcome.failures).toEqual([
			{ accountId: "acc-1", step: "delete_server_account", cause: FAILURE },
		]);
	});

	it("removes every local trace after the server delete succeeds", async () => {
		const fixture = await createFixture();
		const confirmed: string[] = [];

		const outcome = await deleteAccountEverywhere(
			{ accountId: "acc-1", confirmEmail: "acc-1@test.com" },
			{
				...fixture.deps,
				server: {
					deleteAccount: async ({ confirmEmail }): Promise<void> => {
						confirmed.push(confirmEmail);
					},
				},
			},
		);

		expect(confirmed).toEqual(["acc-1@test.com"]);
		expect(outcome.failures).toEqual([]);
		expect(await accountIds(fixture.storage)).toEqual(["acc-2"]);
		expect(accountKeys(fixture.port, "acc-1")).toEqual([]);
		expect(fixture.cachePort.collections()).toEqual(segmentsOf("acc-2"));
		expect(outcome.activeAccountId).toBe("acc-2");
	});
});

/**
 * Quick-unlock material is the device's own copy of the key — Android's biometric
 * MUK escrow. It is not in `AccountStore`, so only the mirror can drop it, and
 * nothing did: the escrow outlived sign-out, removal and deletion.
 */
describe("quick-unlock material", () => {
	it("survives a lock, which a biometric prompt is meant to undo", async () => {
		const fixture = await createFixture();

		await lockAccount("acc-1", fixture.deps);
		await lockAllAccounts(fixture.deps);

		expect(fixture.mirror.forgotten).toEqual([]);
	});

	it("goes with the account that signed out, and names only that account", async () => {
		const fixture = await createFixture();

		await signOutAccount("acc-2", fixture.deps);

		expect(fixture.mirror.forgotten).toEqual([["acc-2"]]);
	});

	it("survives when the Server rejects the old Session", async () => {
		const fixture = await createFixture();

		await lockInvalidSession({ accountId: "acc-1" }, fixture.deps);

		expect(fixture.mirror.forgotten).toEqual([]);
	});

	it("goes when the account is taken off the device", async () => {
		const fixture = await createFixture();

		await removeAccount("acc-1", fixture.deps);

		expect(fixture.mirror.forgotten).toEqual([["acc-1"]]);
	});

	/** A wipe leaves nothing, including material this device can no longer name. */
	it("goes device-wide on a wipe", async () => {
		const fixture = await createFixture();

		await wipeDevice(fixture.deps);

		expect(fixture.mirror.forgotten.at(-1)).toEqual("device");
	});

	it("goes device-wide when an account is deleted everywhere", async () => {
		const fixture = await createFixture();

		await deleteAccountEverywhere(
			{ accountId: "acc-1", confirmEmail: "acc-1@test.com" },
			{
				...fixture.deps,
				server: { deleteAccount: async (): Promise<void> => {} },
			},
		);

		expect(fixture.mirror.forgotten.at(-1)).toEqual("device");
	});
});

describe("read failures", () => {
	it("reports an unreadable accounts list and still destroys the targeted account", async () => {
		const fixture = await createFixture();
		const getAccountsList = fixture.storage.getAccountsList.bind(
			fixture.storage,
		);
		// Only the pre-read fails, so the single reported failure can only be that one.
		let reads = 0;
		fixture.storage.getAccountsList = async () => {
			reads += 1;
			if (reads === 1) {
				throw FAILURE;
			}
			return getAccountsList();
		};

		const outcome = await removeAccount("acc-1", fixture.deps);

		expect(outcome.failures).toEqual([
			{ accountId: null, step: "read_account_state", cause: FAILURE },
		]);
		// An unenumerable list cannot name the target, but it is still destroyed.
		expect(outcome.affected).toEqual([]);
		expect(outcome.remaining.map((account) => account.accountId)).toEqual([
			"acc-2",
		]);
		expect(await accountIds(fixture.storage)).toEqual(["acc-2"]);
		expect(accountKeys(fixture.port, "acc-1")).toEqual([]);
		expect(fixture.cachePort.collections()).toEqual(segmentsOf("acc-2"));
	});
});
