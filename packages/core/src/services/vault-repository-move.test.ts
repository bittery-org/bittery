import { beforeEach, describe, expect, it } from "bun:test";
import type { CryptoPort } from "@bittery/crypto-port";
import type { AccountStore, ItemCache } from "@bittery/storage";
import { createItemCache } from "@bittery/storage";
import { createInMemoryRecordPort } from "@bittery/storage/testing";
import type { CachedEncryptedItem } from "@bittery/types";
import {
	accountMetadata,
	createTestAccountStore,
} from "../testing/account-store-harness";
import {
	getTravelModeEnforcer,
	resetTravelModeEnforcerForTests,
} from "./travel-mode-enforcer";
import { createVaultCrypto, type VaultCrypto } from "./vault-crypto";
import { VaultRepository } from "./vault-repository";

const ACCOUNT_ID = "acc-1";
const USER_ID = `user-${ACCOUNT_ID}`;

function vaultKey(vaultId: string, vaultName: string) {
	return {
		vaultId,
		vaultName,
		vaultType: "team" as const,
		vaultIcon: "lock",
		vaultImageUrl: null,
		encryptedVaultKey: "",
		role: "owner" as const,
	};
}

async function setup(): Promise<{
	repo: VaultRepository;
	storage: AccountStore;
	itemCache: ItemCache;
	crypto: CryptoPort;
	vaultCrypto: VaultCrypto;
}> {
	const { store, crypto } = await createTestAccountStore();
	const recordPort = createInMemoryRecordPort();
	const itemCache = createItemCache({ port: recordPort });
	await itemCache.initialize();

	await store.addAccount(accountMetadata({ accountId: ACCOUNT_ID }));
	await store.storeServerUrl("https://bittery.test", ACCOUNT_ID);
	const masterUnlockKey = await crypto.importKey(new Uint8Array(32));
	await store.setMasterUnlockKey(masterUnlockKey, ACCOUNT_ID);
	const vaultCrypto = createVaultCrypto({ crypto, storage: store });
	const entries = [];
	for (const [vaultId, name] of [
		["vault_1", "Source Vault"],
		["vault_2", "Target Vault"],
	] as const) {
		const key = await crypto.importKey(new TextEncoder().encode("vault-key"));
		try {
			entries.push({
				...vaultKey(vaultId, name),
				encryptedVaultKey: await vaultCrypto.wrapVaultKeyForOwner({
					vaultKey: key,
					masterUnlockKey,
					vaultId,
					userId: USER_ID,
					keyVersion: 1,
				}),
			});
		} finally {
			await crypto.destroyKey(key);
		}
	}
	await store.storeVaultKeys(entries, ACCOUNT_ID);

	await getTravelModeEnforcer(store, itemCache).applyConfig(ACCOUNT_ID, {
		enabled: false,
		hiddenVaultIds: [],
	});

	const repo = new VaultRepository(
		crypto,
		vaultCrypto,
		store,
		itemCache,
		ACCOUNT_ID,
		"https://bittery.test",
		"user@bittery.test",
	);

	return { repo, storage: store, itemCache, crypto, vaultCrypto };
}

async function cachedItem(
	vaultCrypto: VaultCrypto,
	crypto: CryptoPort,
	vaultId: string,
	version: number,
): Promise<CachedEncryptedItem> {
	const key = await vaultCrypto.getVaultKey({
		vaultId,
		accountId: ACCOUNT_ID,
		userId: USER_ID,
	});
	if (!key) throw new Error("Missing test vault key");
	const encrypted = await vaultCrypto.encryptItem(
		JSON.stringify({ title: "Item" }),
		key,
		{ vaultId, itemId: "item_1", version, userId: USER_ID },
	);
	await crypto.destroyKey(key);
	return {
		id: "item_1",
		vaultId,
		category: "login",
		favorite: false,
		encryptedData: encrypted.ciphertext,
		encryptionIv: encrypted.iv,
		encryptionAlgorithm: encrypted.algorithm,
		version,
		lastModifiedBy: USER_ID,
		encryptionVersion: version,
		encryptedByUserId: USER_ID,
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-01T00:00:00.000Z",
		deletedAt: null,
	} as CachedEncryptedItem;
}

describe("VaultRepository.moveItem", () => {
	beforeEach(() => {
		resetTravelModeEnforcerForTests();
	});

	it("moves the item into the target vault", async () => {
		const { repo, vaultCrypto, crypto } = await setup();
		await repo.upsertEncrypted(
			await cachedItem(vaultCrypto, crypto, "vault_1", 1),
			ACCOUNT_ID,
		);

		const payload = {
			ciphertext: "not-read-by-moveItem",
			iv: "aXY=",
			algorithm: "AES-GCM",
		};

		await repo.moveItem("item_1", "vault_2", payload, { title: "Item" });

		expect(repo.getById("item_1")?.vaultId).toBe("vault_2");
		expect(repo.getById("item_1")?.version).toBe(2);
	});

	// The caller seals the payload against the item version it read, then awaits
	// account resolution, key unwrapping and re-encryption. An inbound sync event
	// landing in that window bumps the stored version, so a context re-derived at
	// write time no longer matches the sealed one. Moving an item back into the
	// vault it just came from is the common way to hit this: the first move's
	// server echo arrives while the second move is still in flight.
	it("survives a concurrent version bump between sealing and writing", async () => {
		const { repo, vaultCrypto, crypto } = await setup();
		await repo.upsertEncrypted(
			await cachedItem(vaultCrypto, crypto, "vault_1", 1),
			ACCOUNT_ID,
		);

		const payload = {
			ciphertext: "not-read-by-moveItem",
			iv: "aXY=",
			algorithm: "AES-GCM",
		};

		await repo.upsertEncrypted(
			await cachedItem(vaultCrypto, crypto, "vault_1", 2),
			ACCOUNT_ID,
		);

		await repo.moveItem("item_1", "vault_2", payload, { title: "Item" });

		expect(repo.getById("item_1")?.vaultId).toBe("vault_2");
	});
});
