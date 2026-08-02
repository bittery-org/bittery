import { beforeEach, describe, expect, it } from "bun:test";
import type { AccountStore, ItemCache } from "@bittery/storage";
import { createItemCache } from "@bittery/storage";
import { createInMemoryRecordPort } from "@bittery/storage/testing";
import type {
	CachedEncryptedItem,
	EncryptionContext,
	ICrypto,
} from "@bittery/types";
import {
	accountMetadata,
	createTestAccountStore,
} from "../testing/account-store-harness";
import {
	getTravelModeEnforcer,
	resetTravelModeEnforcerForTests,
} from "./travel-mode-enforcer";
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
		encryptedVaultKey: JSON.stringify({
			ciphertext: "wrapped",
			iv: "vault-iv",
			algorithm: "aes-256-gcm",
			context: {
				vaultId,
				userId: USER_ID,
				keyVersion: 1,
				purpose: "vault-key-wrap",
			},
		}),
		role: "owner" as const,
	};
}

/**
 * Ciphertext carries the context it was sealed with, so `decrypt` fails on any
 * AAD drift exactly like AES-GCM does. That is the property under test.
 */
function seal(payload: unknown, context: EncryptionContext): string {
	return JSON.stringify({ context, payload });
}

const crypto = {
	decrypt: async (
		data: { ciphertext: string },
		_key: Uint8Array,
		context?: EncryptionContext,
	) => {
		if (context?.entityType === "vault_key") {
			return Buffer.from("vault-key").toString("base64");
		}
		const sealed = JSON.parse(data.ciphertext) as {
			context: EncryptionContext;
			payload: unknown;
		};
		if (
			sealed.context.vaultId !== context?.vaultId ||
			sealed.context.entityId !== context?.entityId ||
			sealed.context.version !== context?.version ||
			sealed.context.userId !== context?.userId
		) {
			throw new Error("Decryption failed: authentication tag mismatch");
		}
		return JSON.stringify(sealed.payload);
	},
} as unknown as ICrypto;

async function setup(): Promise<{
	repo: VaultRepository;
	storage: AccountStore;
	itemCache: ItemCache;
}> {
	const { store } = await createTestAccountStore();
	const recordPort = createInMemoryRecordPort();
	const itemCache = createItemCache({ port: recordPort });
	await itemCache.initialize();

	await store.addAccount(accountMetadata({ accountId: ACCOUNT_ID }));
	await store.storeServerUrl("https://bittery.test", ACCOUNT_ID);
	await store.setMasterUnlockKey(new Uint8Array(32), ACCOUNT_ID);
	await store.storeVaultKeys(
		[vaultKey("vault_1", "Source Vault"), vaultKey("vault_2", "Target Vault")],
		ACCOUNT_ID,
	);

	await getTravelModeEnforcer(store, itemCache).applyConfig(ACCOUNT_ID, {
		enabled: false,
		hiddenVaultIds: [],
	});

	const repo = new VaultRepository(
		crypto,
		store,
		itemCache,
		ACCOUNT_ID,
		"https://bittery.test",
		"user@bittery.test",
	);

	return { repo, storage: store, itemCache };
}

function cachedItem(vaultId: string, version: number): CachedEncryptedItem {
	return {
		id: "item_1",
		vaultId,
		category: "login",
		favorite: false,
		encryptedData: seal({ title: "Item" }, {
			vaultId,
			entityId: "item_1",
			entityType: "item",
			version,
			userId: USER_ID,
		} as EncryptionContext),
		encryptionIv: "aXY=",
		encryptionAlgorithm: "AES-GCM",
		version,
		lastModifiedBy: USER_ID,
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
		const { repo } = await setup();
		await repo.upsertEncrypted(cachedItem("vault_1", 1), ACCOUNT_ID);

		const payload = {
			ciphertext: seal({ title: "Item" }, {
				vaultId: "vault_2",
				entityId: "item_1",
				entityType: "item",
				version: 2,
				userId: USER_ID,
			} as EncryptionContext),
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
		const { repo } = await setup();
		await repo.upsertEncrypted(cachedItem("vault_1", 1), ACCOUNT_ID);

		const payload = {
			ciphertext: seal({ title: "Item" }, {
				vaultId: "vault_2",
				entityId: "item_1",
				entityType: "item",
				version: 2,
				userId: USER_ID,
			} as EncryptionContext),
			iv: "aXY=",
			algorithm: "AES-GCM",
		};

		await repo.upsertEncrypted(cachedItem("vault_1", 2), ACCOUNT_ID);

		await repo.moveItem("item_1", "vault_2", payload, { title: "Item" });

		expect(repo.getById("item_1")?.vaultId).toBe("vault_2");
	});
});
