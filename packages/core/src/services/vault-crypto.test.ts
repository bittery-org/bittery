import { describe, expect, test } from "bun:test";
import type { KeyRef } from "@bittery/crypto-port";
import {
	createInMemoryCryptoPort,
	type InMemoryCryptoPort,
} from "@bittery/crypto-port/testing";
import { currentKdfProfile } from "@bittery/shared/kdf-policy";
import type { EncryptedData, KdfProfile } from "@bittery/types";
import {
	createVaultCrypto,
	isOwnerWrappedVaultKey,
	VAULT_KEY_WRAP_PURPOSE,
	type VaultCrypto,
	type VaultCryptoStore,
} from "./vault-crypto";

const VAULT_ID = "vault_1";
const OTHER_VAULT_ID = "vault_2";
const USER_ID = "user_1";
const ACCOUNT_ID = "acc_1";
const EMAIL = "alice@example.com";
const PASSWORD = "correct horse battery staple";
const SECRET_KEY = "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2";

interface StoreState {
	vaultKeys: Array<{ vaultId: string; encryptedVaultKey: string }> | null;
	masterUnlockKey: KeyRef | null;
	encryptedPrivateKey: string | null;
	userId: string | null;
	pinnedKdfProfile: KdfProfile | null;
}

interface Harness {
	crypto: InMemoryCryptoPort;
	vaultCrypto: VaultCrypto;
	state: StoreState;
}

function createHarness(): Harness {
	const crypto = createInMemoryCryptoPort();
	const state: StoreState = {
		vaultKeys: null,
		masterUnlockKey: null,
		encryptedPrivateKey: null,
		userId: USER_ID,
		pinnedKdfProfile: null,
	};

	const storage: VaultCryptoStore = {
		async getVaultKeys() {
			return state.vaultKeys;
		},
		async getMasterUnlockKey() {
			return state.masterUnlockKey;
		},
		async getEncryptedPrivateKey() {
			return state.encryptedPrivateKey;
		},
		async getStoredSessionData() {
			return state.userId ? { userId: state.userId } : null;
		},
		async getPinnedKdfProfile() {
			return state.pinnedKdfProfile;
		},
	};

	return { crypto, vaultCrypto: createVaultCrypto({ crypto, storage }), state };
}

function requireKeyRef(key: KeyRef | null): KeyRef {
	if (!key) throw new Error("Expected a live test key");
	return key;
}

/** The one ciphertext-visible way to compare two keys: their material. */
async function materialOf(
	crypto: InMemoryCryptoPort,
	key: KeyRef,
): Promise<string> {
	return Buffer.from(await crypto.exportKey(key)).toString("base64");
}

async function seedOwnerWrappedVault(
	harness: Harness,
	options: {
		vaultId?: string;
		userId?: string;
		keyVersion?: number;
	} = {},
): Promise<{ vaultKey: KeyRef; encryptedVaultKey: string }> {
	const { crypto, state } = harness;
	const muk = await crypto.generateEncryptionKey();
	state.masterUnlockKey = muk;

	const vaultKey = await crypto.generateEncryptionKey();
	const encryptedVaultKey = await crypto.encryptVaultKeyWithMuk(
		vaultKey,
		muk,
		options.vaultId ?? VAULT_ID,
		options.userId ?? USER_ID,
		options.keyVersion ?? 1,
	);
	state.vaultKeys = [
		{ vaultId: options.vaultId ?? VAULT_ID, encryptedVaultKey },
	];
	return { vaultKey, encryptedVaultKey };
}

/**
 * A record in the pre-AAD format: sealed with no context at all, carrying the context as a
 * JSON envelope inside the plaintext. Written out literally rather than through a helper,
 * because the marker and the NUL-joined field order ARE the back-compat contract.
 */
async function sealLegacyEnvelope(
	crypto: InMemoryCryptoPort,
	key: KeyRef,
	plaintext: string,
	context: {
		vaultId: string;
		entityId: string;
		entityType: string;
		version: number;
		userId: string;
	},
): Promise<EncryptedData> {
	return crypto.encrypt(
		JSON.stringify({
			marker: "bittery-context-envelope-v1",
			context: [
				context.vaultId,
				context.entityId,
				context.entityType,
				String(context.version),
				context.userId,
			].join("\0"),
			payload: plaintext,
		}),
		key,
		null,
	);
}

describe("wrapped vault key envelope", () => {
	test("wrapVaultKeyForOwner writes the ciphertext and its wrap context", async () => {
		const harness = createHarness();
		const muk = await harness.crypto.generateEncryptionKey();
		const vaultKey = await harness.crypto.generateEncryptionKey();

		const wrapped = await harness.vaultCrypto.wrapVaultKeyForOwner({
			vaultKey,
			masterUnlockKey: muk,
			vaultId: VAULT_ID,
			userId: USER_ID,
			keyVersion: 3,
		});

		expect(isOwnerWrappedVaultKey(wrapped)).toBe(true);
		const parsed = JSON.parse(wrapped);
		expect(typeof parsed.ciphertext).toBe("string");
		expect(typeof parsed.iv).toBe("string");
		expect(parsed.context).toEqual({
			vaultId: VAULT_ID,
			userId: USER_ID,
			keyVersion: 3,
			purpose: VAULT_KEY_WRAP_PURPOSE,
		});
	});

	test("round trips through unwrapVaultKey", async () => {
		const harness = createHarness();
		const muk = await harness.crypto.generateEncryptionKey();
		const vaultKey = await harness.crypto.generateEncryptionKey();
		const wrapped = await harness.vaultCrypto.wrapVaultKeyForOwner({
			vaultKey,
			masterUnlockKey: muk,
			vaultId: VAULT_ID,
			userId: USER_ID,
			keyVersion: 1,
		});

		const unwrapped = await harness.vaultCrypto.unwrapVaultKey({
			encryptedVaultKey: wrapped,
			masterUnlockKey: muk,
			expectedVaultId: VAULT_ID,
			expectedUserId: USER_ID,
		});

		expect(await materialOf(harness.crypto, unwrapped)).toBe(
			await materialOf(harness.crypto, vaultKey),
		);
	});

	test("an RSA-wrapped member key is not an owner-wrapped envelope", async () => {
		const harness = createHarness();
		const vaultKey = await harness.crypto.generateEncryptionKey();
		const { publicKey } = await harness.crypto.generateRsaKeyPair();

		const forMember = await harness.crypto.encryptVaultKeyForMember(
			vaultKey,
			publicKey,
		);

		expect(isOwnerWrappedVaultKey(forMember)).toBe(false);
	});
});

describe("wrap context binding", () => {
	test("refuses a vault key wrapped for another vault", async () => {
		const harness = createHarness();
		const { encryptedVaultKey } = await seedOwnerWrappedVault(harness);

		await expect(
			harness.vaultCrypto.unwrapStoredVaultKey({
				encryptedVaultKey,
				vaultId: OTHER_VAULT_ID,
			}),
		).rejects.toThrow("Vault key wrap vault mismatch");
	});

	test("refuses a vault key wrapped for another user", async () => {
		const harness = createHarness();
		const { encryptedVaultKey } = await seedOwnerWrappedVault(harness);

		await expect(
			harness.vaultCrypto.unwrapStoredVaultKey({
				encryptedVaultKey,
				userId: "user_2",
			}),
		).rejects.toThrow("Vault key wrap user mismatch");
	});

	test("refuses an envelope with no wrap context", async () => {
		const harness = createHarness();
		const { encryptedVaultKey } = await seedOwnerWrappedVault(harness);
		const { context: _dropped, ...withoutContext } =
			JSON.parse(encryptedVaultKey);

		await expect(
			harness.vaultCrypto.unwrapStoredVaultKey({
				encryptedVaultKey: JSON.stringify(withoutContext),
			}),
		).rejects.toThrow("Missing vault key wrap context");
	});

	test("refuses a wrap context that is not a vault-key wrap", async () => {
		const harness = createHarness();
		const { encryptedVaultKey } = await seedOwnerWrappedVault(harness);
		const tampered = JSON.parse(encryptedVaultKey);
		tampered.context.purpose = "something-else";

		await expect(
			harness.vaultCrypto.unwrapStoredVaultKey({
				encryptedVaultKey: JSON.stringify(tampered),
			}),
		).rejects.toThrow("Invalid vault key wrap purpose");
	});

	test("refuses a key version that is not a positive integer", async () => {
		const harness = createHarness();
		const { encryptedVaultKey } = await seedOwnerWrappedVault(harness);
		const tampered = JSON.parse(encryptedVaultKey);
		tampered.context.keyVersion = 0;

		await expect(
			harness.vaultCrypto.unwrapStoredVaultKey({
				encryptedVaultKey: JSON.stringify(tampered),
			}),
		).rejects.toThrow("Invalid vault key wrap version");
	});

	test("the wrap context is bound into the AAD, not merely declared", async () => {
		const harness = createHarness();
		const { encryptedVaultKey } = await seedOwnerWrappedVault(harness, {
			keyVersion: 1,
		});
		// Passes every declarative check above, so only the AAD can catch it.
		const tampered = JSON.parse(encryptedVaultKey);
		tampered.context.keyVersion = 2;

		await expect(
			harness.vaultCrypto.unwrapStoredVaultKey({
				encryptedVaultKey: JSON.stringify(tampered),
			}),
		).rejects.toThrow();
	});
});

describe("the pre-AAD ciphertext fallback", () => {
	test("opens a vault key written before AAD binding existed", async () => {
		const harness = createHarness();
		const muk = await harness.crypto.generateEncryptionKey();
		harness.state.masterUnlockKey = muk;
		const vaultKey = await harness.crypto.generateEncryptionKey();
		const vaultKeyBase64 = await materialOf(harness.crypto, vaultKey);

		const legacy = await sealLegacyEnvelope(
			harness.crypto,
			muk,
			vaultKeyBase64,
			{
				vaultId: VAULT_ID,
				entityId: VAULT_KEY_WRAP_PURPOSE,
				entityType: "vault_key",
				version: 1,
				userId: USER_ID,
			},
		);

		const unwrapped = await harness.vaultCrypto.unwrapStoredVaultKey({
			encryptedVaultKey: JSON.stringify({
				...legacy,
				context: {
					vaultId: VAULT_ID,
					userId: USER_ID,
					keyVersion: 1,
					purpose: VAULT_KEY_WRAP_PURPOSE,
				},
			}),
			vaultId: VAULT_ID,
			userId: USER_ID,
		});

		expect(await materialOf(harness.crypto, unwrapped)).toBe(vaultKeyBase64);
	});

	test("opens an item written before AAD binding existed", async () => {
		const harness = createHarness();
		const vaultKey = await harness.crypto.generateEncryptionKey();
		const scope = {
			vaultId: VAULT_ID,
			itemId: "item_1",
			version: 2,
			userId: USER_ID,
		};
		const legacy = await sealLegacyEnvelope(harness.crypto, vaultKey, "{}", {
			vaultId: VAULT_ID,
			entityId: "item_1",
			entityType: "item",
			version: 2,
			userId: USER_ID,
		});

		expect(await harness.vaultCrypto.decryptItem(legacy, vaultKey, scope)).toBe(
			"{}",
		);
	});

	test("opens an attachment written before AAD binding existed", async () => {
		const harness = createHarness();
		const vaultKey = await harness.crypto.generateEncryptionKey();
		const scope = {
			vaultId: VAULT_ID,
			attachmentKey: "attachment_1",
			userId: USER_ID,
		};
		const legacy = await sealLegacyEnvelope(
			harness.crypto,
			vaultKey,
			"secret.txt",
			{
				vaultId: scope.vaultId,
				entityId: scope.attachmentKey,
				entityType: "attachment_name",
				version: 1,
				userId: scope.userId,
			},
		);

		expect(
			await harness.vaultCrypto.decryptAttachment(
				legacy,
				vaultKey,
				scope,
				"name",
			),
		).toBe("secret.txt");
	});

	test("still refuses a legacy envelope bound to another entity", async () => {
		const harness = createHarness();
		const vaultKey = await harness.crypto.generateEncryptionKey();
		const legacy = await sealLegacyEnvelope(
			harness.crypto,
			vaultKey,
			"secret",
			{
				vaultId: VAULT_ID,
				entityId: "item_1",
				entityType: "item",
				version: 1,
				userId: USER_ID,
			},
		);

		await expect(
			harness.vaultCrypto.decryptItem(legacy, vaultKey, {
				vaultId: VAULT_ID,
				itemId: "item_2",
				version: 1,
				userId: USER_ID,
			}),
		).rejects.toThrow("Encryption context mismatch");
	});

	test("reports the plaintext is not an envelope when the key is simply wrong", async () => {
		const harness = createHarness();
		const vaultKey = await harness.crypto.generateEncryptionKey();
		const otherKey = await harness.crypto.generateEncryptionKey();
		const encrypted = await harness.crypto.encrypt("secret", vaultKey, null);

		await expect(
			harness.vaultCrypto.decryptItem(encrypted, otherKey, {
				vaultId: VAULT_ID,
				itemId: "item_1",
				version: 1,
				userId: USER_ID,
			}),
		).rejects.toThrow();
	});

	test("an item written with AAD does not go near the fallback", async () => {
		const harness = createHarness();
		const vaultKey = await harness.crypto.generateEncryptionKey();
		const scope = {
			vaultId: VAULT_ID,
			itemId: "item_1",
			version: 1,
			userId: USER_ID,
		};

		const encrypted = await harness.vaultCrypto.encryptItem(
			'{"title":"example"}',
			vaultKey,
			scope,
		);

		expect(
			await harness.vaultCrypto.decryptItem(encrypted, vaultKey, scope),
		).toBe('{"title":"example"}');
		await expect(
			harness.vaultCrypto.decryptItem(encrypted, vaultKey, {
				...scope,
				itemId: "item_2",
			}),
		).rejects.toThrow();
	});
});

describe("batch item decryption", () => {
	test("preserves request order and reports a failed item in place", async () => {
		const harness = createHarness();
		const vaultKey = await harness.crypto.generateEncryptionKey();
		const scope = (itemId: string) => ({
			vaultId: VAULT_ID,
			itemId,
			version: 1,
			userId: USER_ID,
		});
		const first = await harness.vaultCrypto.encryptItem(
			"first",
			vaultKey,
			scope("item_1"),
		);
		const third = await harness.vaultCrypto.encryptItem(
			"third",
			vaultKey,
			scope("item_3"),
		);

		const results = await harness.vaultCrypto.decryptItems([
			{ id: "item_1", data: first, vaultKey, scope: scope("item_1") },
			{ id: "item_2", data: first, vaultKey, scope: scope("item_2") },
			{ id: "item_3", data: third, vaultKey, scope: scope("item_3") },
		]);

		expect(results.map((result) => result.id)).toEqual([
			"item_1",
			"item_2",
			"item_3",
		]);
		expect(results[0]).toEqual({ id: "item_1", ok: true, plaintext: "first" });
		expect(results[1]?.ok).toBe(false);
		expect(results[2]).toEqual({ id: "item_3", ok: true, plaintext: "third" });
	});

	test("opens a legacy item without failing the rest of the batch", async () => {
		const harness = createHarness();
		const vaultKey = await harness.crypto.generateEncryptionKey();
		const scope = {
			vaultId: VAULT_ID,
			itemId: "legacy_item",
			version: 2,
			userId: USER_ID,
		};
		const legacy = await sealLegacyEnvelope(
			harness.crypto,
			vaultKey,
			"legacy",
			{
				vaultId: scope.vaultId,
				entityId: scope.itemId,
				entityType: "item",
				version: scope.version,
				userId: scope.userId,
			},
		);

		expect(
			await harness.vaultCrypto.decryptItems([
				{ id: scope.itemId, data: legacy, vaultKey, scope },
			]),
		).toEqual([{ id: scope.itemId, ok: true, plaintext: "legacy" }]);
	});

	test("borrows every vault key ref in the batch", async () => {
		const harness = createHarness();
		const vaultKey = await harness.crypto.generateEncryptionKey();
		const before = harness.crypto.liveKeyCount;
		const scope = {
			vaultId: VAULT_ID,
			itemId: "item_1",
			version: 1,
			userId: USER_ID,
		};
		const encrypted = await harness.vaultCrypto.encryptItem(
			"secret",
			vaultKey,
			scope,
		);

		await harness.vaultCrypto.decryptItems([
			{ id: scope.itemId, data: encrypted, vaultKey, scope },
		]);

		expect(harness.crypto.liveKeyCount).toBe(before);
		expect(await harness.crypto.exportKey(vaultKey)).toBeInstanceOf(Uint8Array);
	});
});

describe("reading a stored vault key", () => {
	test("finds the account's key for that vault", async () => {
		const harness = createHarness();
		const { vaultKey } = await seedOwnerWrappedVault(harness);

		const found = await harness.vaultCrypto.getVaultKey({
			vaultId: VAULT_ID,
			accountId: ACCOUNT_ID,
		});

		expect(await materialOf(harness.crypto, requireKeyRef(found))).toBe(
			await materialOf(harness.crypto, vaultKey),
		);
	});

	test("is null for a vault this account holds no key for", async () => {
		const harness = createHarness();
		await seedOwnerWrappedVault(harness);

		expect(
			await harness.vaultCrypto.getVaultKey({ vaultId: OTHER_VAULT_ID }),
		).toBeNull();
	});

	test("is null when nothing has been stored at all", async () => {
		const harness = createHarness();

		expect(
			await harness.vaultCrypto.getVaultKey({ vaultId: VAULT_ID }),
		).toBeNull();
	});

	test("refuses to guess when the account is locked", async () => {
		const harness = createHarness();
		await seedOwnerWrappedVault(harness);
		harness.state.masterUnlockKey = null;

		await expect(
			harness.vaultCrypto.getVaultKey({ vaultId: VAULT_ID }),
		).rejects.toThrow("Master Unlock Key not available");
	});

	test("borrows the store's master unlock key without destroying it", async () => {
		const harness = createHarness();
		await seedOwnerWrappedVault(harness);

		const first = await harness.vaultCrypto.getVaultKey({ vaultId: VAULT_ID });
		const second = await harness.vaultCrypto.getVaultKey({ vaultId: VAULT_ID });

		// A destroyed MUK would have made the second read throw.
		expect(await materialOf(harness.crypto, requireKeyRef(second))).toBe(
			await materialOf(harness.crypto, requireKeyRef(first)),
		);
	});

	test("mints one fresh ref per unwrap, so the caller can destroy it alone", async () => {
		const harness = createHarness();
		await seedOwnerWrappedVault(harness);
		const before = harness.crypto.liveKeyCount;

		const first = await harness.vaultCrypto.getVaultKey({ vaultId: VAULT_ID });
		const second = await harness.vaultCrypto.getVaultKey({ vaultId: VAULT_ID });
		expect(harness.crypto.liveKeyCount).toBe(before + 2);

		await harness.crypto.destroyKey(requireKeyRef(first));
		expect(harness.crypto.liveKeyCount).toBe(before + 1);
		// The sibling ref is untouched by that.
		expect(
			typeof (await materialOf(harness.crypto, requireKeyRef(second))),
		).toBe("string");
	});
});

describe("a vault key shared through RSA", () => {
	async function seedSharedVault(harness: Harness): Promise<KeyRef> {
		const { crypto, state } = harness;
		const muk = await crypto.generateEncryptionKey();
		state.masterUnlockKey = muk;

		const { publicKey, privateKey } = await crypto.generateRsaKeyPair();
		state.encryptedPrivateKey = JSON.stringify(
			await crypto.encrypt(privateKey, muk, null),
		);

		const vaultKey = await crypto.generateEncryptionKey();
		state.vaultKeys = [
			{
				vaultId: VAULT_ID,
				encryptedVaultKey: await crypto.encryptVaultKeyForMember(
					vaultKey,
					publicKey,
				),
			},
		];
		return vaultKey;
	}

	test("opens with the account's private key", async () => {
		const harness = createHarness();
		const vaultKey = await seedSharedVault(harness);

		const found = await harness.vaultCrypto.getVaultKey({ vaultId: VAULT_ID });

		expect(await materialOf(harness.crypto, requireKeyRef(found))).toBe(
			await materialOf(harness.crypto, vaultKey),
		);
	});

	test("says so when the private key is not available", async () => {
		const harness = createHarness();
		await seedSharedVault(harness);
		harness.state.encryptedPrivateKey = null;

		await expect(
			harness.vaultCrypto.getVaultKey({ vaultId: VAULT_ID }),
		).rejects.toThrow("Encrypted private key not available");
	});

	test("decryptPrivateKey returns the PEM it was stored as", async () => {
		const harness = createHarness();
		await seedSharedVault(harness);
		const muk = requireKeyRef(harness.state.masterUnlockKey);

		const pem = await harness.vaultCrypto.decryptPrivateKey(
			harness.state.encryptedPrivateKey as string,
			muk,
		);

		expect(pem).toContain("PRIVATE KEY");
	});
});

describe("KDF pinning", () => {
	test("accepts the current profile", async () => {
		const harness = createHarness();
		const profile = currentKdfProfile();

		expect(await harness.vaultCrypto.validateKdfProfile(profile)).toEqual(
			profile,
		);
	});

	test("refuses an unsupported algorithm", async () => {
		const harness = createHarness();

		await expect(
			harness.vaultCrypto.validateKdfProfile({
				...currentKdfProfile(),
				algorithm: "pbkdf2-sha1" as KdfProfile["algorithm"],
			}),
		).rejects.toThrow("Unsupported KDF algorithm");
	});

	test("refuses iterations below the policy floor", async () => {
		const harness = createHarness();

		await expect(
			harness.vaultCrypto.validateKdfProfile({
				...currentKdfProfile(),
				iterations: 1000,
			}),
		).rejects.toThrow("KDF iterations outside supported range");
	});

	test("refuses a downgrade against this account's pin", async () => {
		const harness = createHarness();
		const pinned = currentKdfProfile();
		harness.state.pinnedKdfProfile = {
			...pinned,
			iterations: pinned.iterations + 100_000,
		};

		await expect(
			harness.vaultCrypto.validateKdfProfile(pinned, ACCOUNT_ID),
		).rejects.toThrow("KDF iterations downgraded from pinned value");
	});

	test("reads no pin when no account is named", async () => {
		const harness = createHarness();
		const pinned = currentKdfProfile();
		harness.state.pinnedKdfProfile = {
			...pinned,
			iterations: pinned.iterations + 100_000,
		};

		expect(await harness.vaultCrypto.validateKdfProfile(pinned)).toEqual(
			pinned,
		);
	});
});

describe("deriving the account keys", () => {
	test("returns the SRP password and the master unlock key", async () => {
		const harness = createHarness();

		const derived = await harness.vaultCrypto.deriveAccountKeys({
			accountPassword: PASSWORD,
			secretKey: SECRET_KEY,
			email: EMAIL,
			profile: currentKdfProfile(),
		});

		expect(derived.srpPassword.length).toBeGreaterThan(0);
		expect(derived.encryptedMasterKey).toBeNull();
		expect(await materialOf(harness.crypto, derived.masterUnlockKey)).toEqual(
			expect.any(String),
		);
	});

	test("is deterministic in the password, the Secret Key and the email", async () => {
		const harness = createHarness();
		const profile = currentKdfProfile();
		const input = {
			accountPassword: PASSWORD,
			secretKey: SECRET_KEY,
			email: EMAIL,
			profile,
		};

		const first = await harness.vaultCrypto.deriveAccountKeys(input);
		const same = await harness.vaultCrypto.deriveAccountKeys(input);
		const other = await harness.vaultCrypto.deriveAccountKeys({
			...input,
			email: "bob@example.com",
		});

		expect(same.srpPassword).toBe(first.srpPassword);
		expect(await materialOf(harness.crypto, same.masterUnlockKey)).toBe(
			await materialOf(harness.crypto, first.masterUnlockKey),
		);
		expect(other.srpPassword).not.toBe(first.srpPassword);
	});

	test("leaves only the master unlock key alive — the auth key is destroyed", async () => {
		const harness = createHarness();
		const before = harness.crypto.liveKeyCount;

		const derived = await harness.vaultCrypto.deriveAccountKeys({
			accountPassword: PASSWORD,
			secretKey: SECRET_KEY,
			email: EMAIL,
			profile: currentKdfProfile(),
		});

		expect(harness.crypto.liveKeyCount).toBe(before + 1);
		await harness.crypto.destroyKey(derived.masterUnlockKey);
		expect(harness.crypto.liveKeyCount).toBe(before);
	});

	test("destroys every derived key when SRP conversion fails", async () => {
		const harness = createHarness();
		const before = harness.crypto.liveKeyCount;
		harness.crypto.deriveSrpPassword = async () => {
			throw new Error("SRP conversion failed");
		};

		await expect(
			harness.vaultCrypto.deriveAccountKeys({
				accountPassword: PASSWORD,
				secretKey: SECRET_KEY,
				email: EMAIL,
				profile: currentKdfProfile(),
			}),
		).rejects.toThrow("SRP conversion failed");
		expect(harness.crypto.liveKeyCount).toBe(before);
	});

	test("destroys every derived key when Recovery Key wrapping fails", async () => {
		const harness = createHarness();
		const recoveryKey = await harness.crypto.generateRecoveryKey();
		const before = harness.crypto.liveKeyCount;
		harness.crypto.encryptMasterKey = async () => {
			throw new Error("Recovery Key wrapping failed");
		};

		await expect(
			harness.vaultCrypto.deriveAccountKeys({
				accountPassword: PASSWORD,
				secretKey: SECRET_KEY,
				email: EMAIL,
				profile: currentKdfProfile(),
				recoveryKey,
			}),
		).rejects.toThrow("Recovery Key wrapping failed");
		expect(harness.crypto.liveKeyCount).toBe(before);
	});

	test("seals the master key under the Recovery Key without letting it escape", async () => {
		const harness = createHarness();
		const recoveryKey = await harness.crypto.generateRecoveryKey();
		const before = harness.crypto.liveKeyCount;

		const derived = await harness.vaultCrypto.deriveAccountKeys({
			accountPassword: PASSWORD,
			secretKey: SECRET_KEY,
			email: EMAIL,
			profile: currentKdfProfile(),
			recoveryKey,
		});

		expect(derived.encryptedMasterKey).not.toBeNull();
		expect(harness.crypto.liveKeyCount).toBe(before + 1);

		// The sealed master key still derives the same account keys.
		const recovered = await harness.crypto.decryptMasterKey(
			derived.encryptedMasterKey as EncryptedData,
			recoveryKey,
			EMAIL,
		);
		const { masterUnlockKey } = await harness.crypto.deriveKeysFromMasterKey(
			recovered,
			EMAIL,
		);
		expect(await materialOf(harness.crypto, masterUnlockKey)).toBe(
			await materialOf(harness.crypto, derived.masterUnlockKey),
		);
	});

	test("refuses the profile before running the KDF, minting nothing", async () => {
		const harness = createHarness();
		const pinned = currentKdfProfile();
		harness.state.pinnedKdfProfile = {
			...pinned,
			iterations: pinned.iterations + 100_000,
		};
		const before = harness.crypto.liveKeyCount;

		await expect(
			harness.vaultCrypto.deriveAccountKeys({
				accountPassword: PASSWORD,
				secretKey: SECRET_KEY,
				email: EMAIL,
				profile: pinned,
				accountId: ACCOUNT_ID,
			}),
		).rejects.toThrow("KDF iterations downgraded from pinned value");
		expect(harness.crypto.liveKeyCount).toBe(before);
	});
});
