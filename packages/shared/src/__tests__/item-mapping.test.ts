import { describe, expect, it } from "bun:test";
import {
	type CachedItemMetadata,
	type RepositoryItemMetadata,
	type RepositoryItemRecord,
	stripToDecryptedData,
	toCachedItem,
	toCachedItemFromRepositoryItem,
	toCachedItemMetadata,
	toEncryptedPayload,
	toItemVaultSummary,
	toNewCachedItem,
	toRawItem,
	withEncryptedPayload,
} from "../item-mapping";
import { cachedItem, serverEncryptedItem } from "../testing/item-fixtures";
import type { ServerVaultSummary } from "../vault-mapping";

// ============================================================================
// toCachedItem — attachments: "no attachments" vs "not loaded"
// ============================================================================

describe("toCachedItem attachments", () => {
	it("keeps an empty attachments array distinguishable from an absent one", () => {
		const noAttachments = toCachedItem(
			serverEncryptedItem({ attachments: [] }),
			{},
		);
		expect(noAttachments.attachments).toEqual([]);

		const notLoaded = toCachedItem(serverEncryptedItem(), {});
		expect(notLoaded.attachments).toBeUndefined();
	});

	it("maps a null wire attachments field (the vault-listing endpoint) to absent, not empty", () => {
		const item = toCachedItem(serverEncryptedItem({ attachments: null }), {});
		expect(item.attachments).toBeUndefined();
	});

	it("copies each attachment rather than aliasing the wire response's objects", () => {
		const wireAttachment = {
			id: "attachment-1",
			itemId: "item-1",
			vaultId: "vault-1",
			encryptedName: "name",
			encryptedContentType: "type",
			encryptedContentTypeIv: "iv",
			encryptionAlgorithm: "AES-GCM-AAD-V1",
			encryptionIv: "iv",
			fileSize: 10,
			storageKey: "key",
			uploadedBy: "user-1",
			createdAt: "2024-01-01T00:00:00.000Z",
		} as const;

		const item = toCachedItem(
			serverEncryptedItem({ attachments: [wireAttachment] }),
			{},
		);

		expect(item.attachments?.[0]).toEqual(wireAttachment);
		expect(item.attachments?.[0]).not.toBe(wireAttachment);
	});
});

// ============================================================================
// Scope keys — omitting a scope field must not add an `undefined` key
// ============================================================================

describe("scope keys", () => {
	it("toCachedItem does not add accountId/accountEmail/serverUrl keys when scope omits them", () => {
		const item = toCachedItem(serverEncryptedItem(), {});

		expect(Object.hasOwn(item, "accountId")).toBe(false);
		expect(Object.hasOwn(item, "accountEmail")).toBe(false);
		expect(Object.hasOwn(item, "serverUrl")).toBe(false);
	});

	it("toNewCachedItem does the same", () => {
		const item = toNewCachedItem(
			{
				id: "item-1",
				vaultId: "vault-1",
				category: "login",
				timestamp: "2024-01-01T00:00:00.000Z",
				version: 1,
				payload: {
					encryptedData: "cipher",
					encryptionIv: "iv",
					encryptionAlgorithm: "AES-GCM-AAD-V1",
					encryptionVersion: 1,
					encryptedByUserId: "user-1",
				},
			},
			{ accountEmail: "a@example.com" },
		);

		expect(Object.hasOwn(item, "accountId")).toBe(false);
		expect(Object.hasOwn(item, "serverUrl")).toBe(false);
		expect(item.accountEmail).toBe("a@example.com");
	});
});

// ============================================================================
// deletedAt — normalised to null, never left `undefined`
// ============================================================================

describe("deletedAt", () => {
	it("normalises an absent deletedAt to null", () => {
		const item = toCachedItem(
			serverEncryptedItem({ deletedAt: undefined }),
			{},
		);
		expect(item.deletedAt).toBeNull();
	});

	it("keeps an explicit deletedAt", () => {
		const item = toCachedItem(
			serverEncryptedItem({ deletedAt: "2024-02-01T00:00:00.000Z" }),
			{},
		);
		expect(item.deletedAt).toBe("2024-02-01T00:00:00.000Z");
	});

	it("toNewCachedItem always mints a live (null) record", () => {
		expect(cachedItem().deletedAt).toBeNull();
	});
});

// ============================================================================
// withEncryptedPayload — must not read the ciphertext it is replacing
// ============================================================================

describe("withEncryptedPayload", () => {
	it("ignores stale ciphertext fields even if the caller's base object still carries them", () => {
		// `CachedItemMetadata` statically excludes these fields, but nothing stops a caller
		// from handing over a wider object at runtime (e.g. a full `CachedEncryptedItem`).
		// The seal must come from `payload`, never from whatever `base` happens to carry.
		const staleBase = {
			...cachedItem({
				encryptedData: "STALE_CIPHERTEXT",
				encryptionIv: "STALE_IV",
				encryptionAlgorithm: "STALE_ALG",
				version: 1,
				lastModifiedBy: "stale-user",
			}),
		};

		const result = withEncryptedPayload(
			staleBase as CachedItemMetadata,
			{
				encryptedData: "fresh-cipher",
				encryptionIv: "fresh-iv",
				encryptionAlgorithm: "AES-GCM-AAD-V1",
				encryptionVersion: 2,
				encryptedByUserId: "fresh-user",
			},
			{ updatedAt: "2024-03-01T00:00:00.000Z", version: 2 },
		);

		expect(result.encryptedData).toBe("fresh-cipher");
		expect(result.encryptionIv).toBe("fresh-iv");
		expect(result.encryptionAlgorithm).toBe("AES-GCM-AAD-V1");
		expect(result.lastModifiedBy).toBe("fresh-user");
		expect(result.version).toBe(2);
	});

	it("carries forward everything base does not name — favourite, trash state, attachments", () => {
		const base = toCachedItemMetadata(
			{
				id: "item-1",
				vaultId: "vault-1",
				accountId: "account-1",
				category: "login",
				favorite: true,
				createdAt: "2024-01-01T00:00:00.000Z",
				deletedAt: "2024-01-05T00:00:00.000Z",
				attachments: [],
			},
			{},
		);

		const result = withEncryptedPayload(
			base,
			{
				encryptedData: "cipher",
				encryptionIv: "iv",
				encryptionAlgorithm: "AES-GCM-AAD-V1",
				encryptionVersion: 1,
				encryptedByUserId: "user-1",
			},
			{ updatedAt: "2024-01-06T00:00:00.000Z", version: 2 },
		);

		expect(result.favorite).toBe(true);
		expect(result.deletedAt).toBe("2024-01-05T00:00:00.000Z");
		expect(result.attachments).toEqual([]);
		expect(result.createdAt).toBe("2024-01-01T00:00:00.000Z");
	});
});

// ============================================================================
// toCachedItemMetadata — must not read a repository item's ciphertext blob
// ============================================================================

describe("toCachedItemMetadata", () => {
	it("never reads `_encrypted` or any stale ciphertext field off a repository item", () => {
		const readKeys: string[] = [];
		const repositoryItem: RepositoryItemMetadata & {
			_encrypted: { data: string; iv: string; algorithm: string };
			encryptedData: string;
			encryptionIv: string;
			encryptionAlgorithm: string;
			version: number;
		} = {
			id: "item-1",
			vaultId: "vault-1",
			accountId: "account-1",
			category: "login",
			favorite: false,
			createdAt: "2024-01-01T00:00:00.000Z",
			deletedAt: null,
			attachments: undefined,
			_encrypted: { data: "cipher", iv: "iv", algorithm: "AES-GCM-AAD-V1" },
			encryptedData: "should-not-be-read",
			encryptionIv: "should-not-be-read",
			encryptionAlgorithm: "should-not-be-read",
			version: 99,
		};
		const guarded = new Proxy(repositoryItem, {
			get(target, prop, receiver) {
				readKeys.push(String(prop));
				return Reflect.get(target, prop, receiver);
			},
		});

		const result = toCachedItemMetadata(guarded, {});

		expect(readKeys).not.toContain("_encrypted");
		expect(readKeys).not.toContain("encryptedData");
		expect(readKeys).not.toContain("encryptionIv");
		expect(readKeys).not.toContain("encryptionAlgorithm");
		expect(readKeys).not.toContain("version");
		expect(result).not.toHaveProperty("_encrypted");
		expect(result).not.toHaveProperty("encryptedData");
	});

	it("prefers the item's own scope over the fallback scope", () => {
		const result = toCachedItemMetadata(
			{
				id: "item-1",
				vaultId: "vault-1",
				accountId: "item-account",
				category: "login",
				favorite: false,
				createdAt: "2024-01-01T00:00:00.000Z",
				deletedAt: null,
				attachments: undefined,
			},
			{ accountId: "fallback-account" },
		);

		expect(result.accountId).toBe("item-account");
	});

	it("falls back to the supplied scope when the item does not name one", () => {
		const result = toCachedItemMetadata(
			{
				id: "item-1",
				vaultId: "vault-1",
				accountId: undefined,
				category: "login",
				favorite: false,
				createdAt: "2024-01-01T00:00:00.000Z",
				deletedAt: null,
				attachments: undefined,
			},
			{ accountId: "fallback-account" },
		);

		expect(result.accountId).toBe("fallback-account");
	});
});

// ============================================================================
// toCachedItemFromRepositoryItem — the one place `_encrypted` is legitimately read
// ============================================================================

describe("toCachedItemFromRepositoryItem", () => {
	it("reads the ciphertext triple from `_encrypted` and the audit fields from the record", () => {
		const record: RepositoryItemRecord = {
			id: "item-1",
			vaultId: "vault-1",
			category: "login",
			favorite: false,
			createdAt: "2024-01-01T00:00:00.000Z",
			updatedAt: "2024-01-02T00:00:00.000Z",
			deletedAt: null,
			version: 3,
			lastModifiedBy: "user-2",
			encryptionVersion: 2,
			encryptedByUserId: "user-1",
			attachments: undefined,
			_encrypted: { data: "cipher", iv: "iv", algorithm: "AES-GCM-AAD-V1" },
		};

		const result = toCachedItemFromRepositoryItem(record, {});

		expect(result.encryptedData).toBe("cipher");
		expect(result.encryptionIv).toBe("iv");
		expect(result.encryptionAlgorithm).toBe("AES-GCM-AAD-V1");
		expect(result.version).toBe(3);
		expect(result.lastModifiedBy).toBe("user-2");
	});
});

// ============================================================================
// toRawItem
// ============================================================================

describe("toRawItem", () => {
	it("normalises deletedAt the same way toCachedItem does", () => {
		const raw = toRawItem(cachedItem({ deletedAt: null }));
		expect(raw.deletedAt).toBeNull();
	});

	it("attaches a vault summary only when the caller passes one", () => {
		const withoutVault = toRawItem(cachedItem());
		expect(withoutVault).not.toHaveProperty("vault");

		const withVault = toRawItem(cachedItem(), { name: "My Vault" });
		expect(withVault.vault.name).toBe("My Vault");
		expect(withVault.vault.type).toBe("personal");
	});
});

describe("toItemVaultSummary", () => {
	it("falls back to a placeholder name for an unknown vault", () => {
		const summary = toItemVaultSummary(null, "vault-1");
		expect(summary).toEqual({
			id: "vault-1",
			name: "Unknown Vault",
			type: "personal",
			icon: null,
			imageUrl: null,
		});
	});

	it("keeps the caller-supplied fields", () => {
		const vault: Partial<ServerVaultSummary> = {
			id: "vault-1",
			name: "Team Vault",
			icon: "lock",
		};
		expect(toItemVaultSummary(vault, "vault-1")).toEqual({
			id: "vault-1",
			name: "Team Vault",
			type: "personal",
			icon: "lock",
			imageUrl: null,
		});
	});
});

// ============================================================================
// toEncryptedPayload — the one remaining ciphertext/encryptedData rename
// ============================================================================

describe("toEncryptedPayload", () => {
	it("renames ciphertext/iv/algorithm to their stored spelling", () => {
		expect(
			toEncryptedPayload({
				ciphertext: "ciphertext",
				iv: "iv",
				algorithm: "AES-GCM-AAD-V1",
				encryptionVersion: 5,
				encryptedByUserId: "user_2",
			}),
		).toEqual({
			encryptedData: "ciphertext",
			encryptionIv: "iv",
			encryptionAlgorithm: "AES-GCM-AAD-V1",
			encryptionVersion: 5,
			encryptedByUserId: "user_2",
		});
	});
});

// ============================================================================
// stripToDecryptedData — must remove every metadata key, and only metadata
// ============================================================================

describe("stripToDecryptedData", () => {
	const ALL_METADATA: Record<string, unknown> = {
		id: "item-1",
		vaultId: "vault-1",
		category: "login",
		favorite: false,
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
		deletedAt: null,
		version: 1,
		lastModifiedBy: "user-1",
		encryptionVersion: 1,
		encryptedByUserId: "user-1",
		attachments: [],
		accountEmail: "a@example.com",
		accountId: "account-1",
		serverUrl: "https://app.bittery.test",
		_encrypted: { data: "cipher", iv: "iv", algorithm: "AES-GCM-AAD-V1" },
		vault: {
			id: "vault-1",
			name: "Vault",
			type: "personal",
			icon: null,
			imageUrl: null,
		},
		account: { id: "account-1", email: "a@example.com" },
	};

	it("removes every metadata key and keeps only decrypted content", () => {
		const decorated = {
			...ALL_METADATA,
			title: "My Login",
			username: "alice",
			url: "https://example.com",
		};

		expect(stripToDecryptedData(decorated)).toEqual({
			title: "My Login",
			username: "alice",
			url: "https://example.com",
		});
	});

	it("strips `account` specifically — a caller-added field that must never reach the ciphertext", () => {
		const decorated = { ...ALL_METADATA, title: "My Login" };
		expect(stripToDecryptedData(decorated)).not.toHaveProperty("account");
	});

	it("does not mutate the item it is stripping", () => {
		const decorated = { ...ALL_METADATA, title: "My Login" };
		stripToDecryptedData(decorated);
		expect(decorated).toHaveProperty("id");
		expect(decorated).toHaveProperty("account");
	});
});
