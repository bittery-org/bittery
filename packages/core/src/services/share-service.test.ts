import { describe, expect, test } from "bun:test";
import type { CryptoPort, KeyRef } from "@bittery/crypto-port";
import { createInMemoryCryptoPort } from "@bittery/crypto-port/testing";
import type { DecryptedItem } from "@bittery/shared/types";
import {
	type CreateShareInput,
	readShareKeyFromUrl,
	ShareService,
} from "./share-service";
import { createVaultCrypto } from "./vault-crypto";

const ACCOUNT_ID = "acc_alice";
const ACCOUNT_EMAIL = "alice@example.com";
const USER_ID = "user_alice";
const VAULT_ID = "vault_1";

const SHARE_KEY_A = new Uint8Array([10, 20, 30, 40]);
const SHARE_KEY_B = new Uint8Array([50, 60, 70, 80]);
const VAULT_KEY_BYTES = new TextEncoder().encode("vault-key");

const CREATE_RESPONSE = {
	token: "tok_abc123",
	expiresAt: "2026-08-30T00:00:00.000Z",
	baseShareUrl: "https://bittery.test/share/",
};

function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

function item(overrides: Partial<DecryptedItem> = {}): DecryptedItem {
	return {
		id: "item_1",
		vaultId: VAULT_ID,
		category: "login",
		favorite: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-02-02T00:00:00.000Z",
		title: "example.com",
		...overrides,
	};
}

function shareInput(
	overrides: Partial<CreateShareInput> = {},
): CreateShareInput {
	return {
		item: item(),
		accessMode: "anyone",
		expiresIn: "7days",
		isOneTimeUse: false,
		accountEmail: ACCOUNT_EMAIL,
		...overrides,
	};
}

interface EncryptCall {
	plaintext: string;
	key: Uint8Array;
	result: { ciphertext: string; iv: string; algorithm: string };
}

interface ClientRequest {
	defaultClient: unknown;
	accountId?: string;
}

interface HarnessOptions {
	shareKeys?: Uint8Array[];
	vaultKeys?: Array<{ vaultId: string; encryptedVaultKey: string }> | null;
	accounts?: Array<{ accountId: string; email: string }>;
}

interface Harness {
	service: ShareService;
	defaultClient: never;
	liveKeyCount(): number;
	encryptCalls: EncryptCall[];
	vaultKeyReads: Array<string | undefined>;
	clientRequests: ClientRequest[];
	createInputs: Array<Record<string, unknown>>;
	defaultClientCreateInputs: Array<Record<string, unknown>>;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const {
		shareKeys = [SHARE_KEY_A, SHARE_KEY_B],
		vaultKeys,
		accounts = [{ accountId: ACCOUNT_ID, email: ACCOUNT_EMAIL }],
	} = options;

	const encryptCalls: EncryptCall[] = [];
	const vaultKeyReads: Array<string | undefined> = [];
	const clientRequests: ClientRequest[] = [];
	const createInputs: Array<Record<string, unknown>> = [];
	const defaultClientCreateInputs: Array<Record<string, unknown>> = [];
	const unusedShareKeys = [...shareKeys];
	const backend = createInMemoryCryptoPort();
	const masterUnlockKey = await backend.importKey(new Uint8Array(32).fill(9));
	const crypto: CryptoPort = new Proxy(backend, {
		get(target, property) {
			if (property === "generateEncryptionKey") {
				return async () => {
					const key = unusedShareKeys.shift();
					if (!key) throw new Error("Test harness ran out of share keys");
					return target.importKey(key);
				};
			}
			if (property === "encrypt") {
				return async (
					plaintext: string,
					key: KeyRef,
					context: Parameters<CryptoPort["encrypt"]>[2],
				) => {
					const result = await target.encrypt(plaintext, key, context);
					encryptCalls.push({
						plaintext,
						key: await target.exportKey(key),
						result,
					});
					return result;
				};
			}
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const vaultCrypto = createVaultCrypto({
		crypto,
		storage: {} as never,
	});
	const vaultKey = await crypto.importKey(VAULT_KEY_BYTES);
	const wrappedVaultKey = await vaultCrypto.wrapVaultKeyForOwner({
		vaultKey,
		masterUnlockKey,
		vaultId: VAULT_ID,
		userId: USER_ID,
		keyVersion: 1,
	});
	await crypto.destroyKey(vaultKey);
	const storedVaultKeys =
		vaultKeys === null
			? null
			: [{ vaultId: VAULT_ID, encryptedVaultKey: wrappedVaultKey }];

	const accountScopedClient = {
		share: {
			create: async (itemId: string, input: Record<string, unknown>) => {
				createInputs.push({ itemId, ...input });
				return { data: { id: "share_1", ...CREATE_RESPONSE } };
			},
		},
	};

	const defaultClient = {
		share: {
			create: async (itemId: string, input: Record<string, unknown>) => {
				defaultClientCreateInputs.push({ itemId, ...input });
				return { data: { id: "share_1", ...CREATE_RESPONSE } };
			},
		},
	};

	const service = new ShareService({
		storage: {
			getActiveAccount: async () => ACCOUNT_ID,
			getAccountsList: async () => accounts,
			getVaultKeys: async (accountId?: string) => {
				vaultKeyReads.push(accountId);
				return storedVaultKeys;
			},
			getMasterUnlockKey: async () => masterUnlockKey,
			getEncryptedPrivateKey: async () => null,
			getStoredSessionData: async () => ({ userId: USER_ID }),
			getAccountMetadata: async () => null,
			getActiveAccountUserId: async () => USER_ID,
		} as never,
		crypto,
		vaultCrypto: createVaultCrypto({
			crypto,
			storage: {
				getVaultKeys: async () => storedVaultKeys,
				getMasterUnlockKey: async () => masterUnlockKey,
				getEncryptedPrivateKey: async () => null,
				getStoredSessionData: async () => ({ userId: USER_ID }),
				getPinnedKdfProfile: async () => null,
			},
		}),
		accounts: {
			getClientForAccount: async (
				passedDefaultClient: unknown,
				accountId?: string,
			) => {
				clientRequests.push({ defaultClient: passedDefaultClient, accountId });
				return accountScopedClient;
			},
		} as never,
	});

	return {
		service,
		defaultClient: defaultClient as never,
		liveKeyCount: () => backend.liveKeyCount,
		encryptCalls,
		vaultKeyReads,
		clientRequests,
		createInputs,
		defaultClientCreateInputs,
	};
}

describe("ShareService.createShare link assembly", () => {
	test("returns a link carrying the share key in the fragment", async () => {
		const harness = await createHarness();
		const before = harness.liveKeyCount();

		const result = await harness.service.createShare(
			shareInput(),
			harness.defaultClient,
		);

		expect(result.shareUrl).toBe(
			`https://bittery.test/share/tok_abc123#${toBase64(SHARE_KEY_A)}`,
		);
		expect(result.expiresAt).toBe("2026-08-30T00:00:00.000Z");
		expect(harness.liveKeyCount()).toBe(before);
	});

	// Regression guard: a share link without its fragment is permanently
	// undecryptable, so the parts it is assembled from must never escape here.
	test("hands back no share key material besides the finished link", async () => {
		const harness = await createHarness();

		const result = await harness.service.createShare(
			shareInput(),
			harness.defaultClient,
		);

		expect(Object.keys(result).sort()).toEqual(["expiresAt", "shareUrl"]);
		expect(result).not.toHaveProperty("shareKeyBase64");
		expect(result).not.toHaveProperty("token");
		expect(result).not.toHaveProperty("baseShareUrl");
		expect(
			result.shareUrl.slice(0, result.shareUrl.indexOf("#")),
		).not.toContain(toBase64(SHARE_KEY_A));
	});

	test("mints a fresh key for every share", async () => {
		const harness = await createHarness({
			shareKeys: [SHARE_KEY_A, SHARE_KEY_B],
		});

		const first = await harness.service.createShare(
			shareInput(),
			harness.defaultClient,
		);
		const second = await harness.service.createShare(
			shareInput(),
			harness.defaultClient,
		);

		expect(readShareKeyFromUrl(first.shareUrl)).toBe(toBase64(SHARE_KEY_A));
		expect(readShareKeyFromUrl(second.shareUrl)).toBe(toBase64(SHARE_KEY_B));
		expect(readShareKeyFromUrl(first.shareUrl)).not.toBe(
			readShareKeyFromUrl(second.shareUrl),
		);
	});

	test("produces a link readShareKeyFromUrl can read the key back from", async () => {
		const harness = await createHarness();

		const result = await harness.service.createShare(
			shareInput(),
			harness.defaultClient,
		);

		expect(readShareKeyFromUrl(result.shareUrl)).toBe(toBase64(SHARE_KEY_A));
	});
});

describe("ShareService.createShare encryption", () => {
	test("encrypts under the share key, never the vault key", async () => {
		const harness = await createHarness();

		await harness.service.createShare(shareInput(), harness.defaultClient);

		expect(harness.encryptCalls).toHaveLength(2);
		for (const call of harness.encryptCalls) {
			expect(call.key).toEqual(SHARE_KEY_A);
			expect(toBase64(call.key)).not.toBe(toBase64(VAULT_KEY_BYTES));
		}
	});

	test("shares only the payload fields, withholding local-only ones", async () => {
		const harness = await createHarness();
		const customFields = [
			{ id: "cf_1", label: "PIN", value: "1234", type: "password" as const },
		];

		await harness.service.createShare(
			shareInput({
				item: item({
					password: "hunter2",
					totpSecret: "JBSWY3DPEHPK3PXP",
					customFields,
					passwordHistory: [
						{ password: "hunter1", changedAt: "2025-12-01T00:00:00.000Z" },
					],
					passkeys: [
						{
							credentialId: "cred_1",
							rpId: "example.com",
							rpName: "Example",
							userHandle: "uh_1",
							userName: "alice",
							userDisplayName: "Alice",
							privateKey: "priv",
							publicKey: "pub",
							algorithm: -7,
							signCount: 1,
							transports: ["internal"],
							createdAt: "2026-01-01T00:00:00.000Z",
						},
					],
					tags: ["work"],
					linkedItemId: "item_linked",
				}),
			}),
			harness.defaultClient,
		);

		const payload = JSON.parse(
			harness.encryptCalls[0]?.plaintext ?? "{}",
		) as Record<string, unknown>;

		expect(payload.title).toBe("example.com");
		expect(payload.password).toBe("hunter2");
		expect(payload.totpSecret).toBe("JBSWY3DPEHPK3PXP");
		expect(payload.customFields).toEqual(customFields);

		const withheld = [
			"id",
			"vaultId",
			"favorite",
			"createdAt",
			"updatedAt",
			"passwordHistory",
			"passkeys",
			"tags",
			"linkedItemId",
		];
		expect(withheld.filter((field) => field in payload)).toEqual([]);
	});
});

describe("ShareService.createShare server payload", () => {
	// Existing share links are decrypted from exactly these request fields, so the
	// test pins the wire mapping while the real test port supplies randomized IVs.
	test("sends the pinned share creation payload", async () => {
		const harness = await createHarness();

		await harness.service.createShare(
			shareInput({
				item: item({ title: "Wire pin" }),
				expiresIn: "1day",
				isOneTimeUse: true,
			}),
			harness.defaultClient,
		);
		expect(harness.encryptCalls.map((call) => call.plaintext)).toEqual([
			'{"title":"Wire pin","category":"login"}',
			toBase64(SHARE_KEY_A),
		]);

		expect(harness.createInputs[0]).toEqual({
			itemId: "item_1",
			accessMode: "anyone",
			isOneTimeUse: true,
			expiresIn: "1day",
			allowedEmails: null,
			encryptedItemData: harness.encryptCalls[0]?.result.ciphertext,
			encryptionIv: harness.encryptCalls[0]?.result.iv,
			encryptedShareKey: harness.encryptCalls[1]?.result.ciphertext,
			shareKeyIv: harness.encryptCalls[1]?.result.iv,
		});
	});

	test("forwards the allowed emails for an email-restricted share", async () => {
		const harness = await createHarness();

		await harness.service.createShare(
			shareInput({
				accessMode: "email-restricted",
				allowedEmails: ["bob@example.com", "carol@example.com"],
			}),
			harness.defaultClient,
		);

		expect(harness.createInputs[0]?.accessMode).toBe("email-restricted");
		expect(harness.createInputs[0]?.allowedEmails).toEqual([
			"bob@example.com",
			"carol@example.com",
		]);
	});

	test("drops allowed emails when the share is open to anyone", async () => {
		const harness = await createHarness();

		await harness.service.createShare(
			shareInput({
				accessMode: "anyone",
				allowedEmails: ["bob@example.com"],
			}),
			harness.defaultClient,
		);

		expect(harness.createInputs[0]?.allowedEmails).toBeNull();
	});
});

describe("ShareService.createShare account identity", () => {
	// An unresolvable scope must never reach `AccountStore`, whose omitted-accountId
	// fallback resolves to the *active* account — sharing one account's item with
	// another account's vault key.
	test("never reads vault keys when the account scope cannot be resolved", async () => {
		const harness = await createHarness();

		await expect(
			harness.service.createShare(
				shareInput({ accountEmail: "stranger@example.com" }),
				harness.defaultClient,
			),
		).rejects.toThrow("Account not found for the provided email address");

		// `toEqual` treats `[undefined]` as `[]`, so assert the length directly.
		expect(harness.vaultKeyReads.length).toBe(0);
		expect(harness.createInputs.length).toBe(0);
	});

	test("refuses to share when the vault is locked", async () => {
		const harness = await createHarness({ vaultKeys: null });

		await expect(
			harness.service.createShare(shareInput(), harness.defaultClient),
		).rejects.toThrow("Could not decrypt vault key");

		expect(harness.createInputs.length).toBe(0);
	});

	test("creates the share on the account-scoped client", async () => {
		const harness = await createHarness();

		await harness.service.createShare(shareInput(), harness.defaultClient);

		expect(harness.clientRequests).toEqual([
			{ defaultClient: harness.defaultClient, accountId: ACCOUNT_ID },
		]);
		expect(harness.createInputs).toHaveLength(1);
		expect(harness.defaultClientCreateInputs).toHaveLength(0);
	});
});

describe("readShareKeyFromUrl", () => {
	test("returns null for a link with no fragment", () => {
		expect(readShareKeyFromUrl("https://bittery.test/share/tok_abc123")).toBe(
			null,
		);
	});

	test("returns null for a link with an empty fragment", () => {
		expect(readShareKeyFromUrl("https://bittery.test/share/tok_abc123#")).toBe(
			null,
		);
	});
});
