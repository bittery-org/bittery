import { describe, expect, test } from "bun:test";
import type { KeyRef } from "@bittery/crypto-port";
import {
	createInMemoryCryptoPort,
	type InMemoryCryptoPort,
} from "@bittery/crypto-port/testing";
import { currentKdfProfile } from "@bittery/shared/kdf-policy";
import type { VaultKeyEntry } from "@bittery/shared/vault-mapping";
import type { AccountStore } from "@bittery/storage";
import type { KdfProfile } from "@bittery/types";
import {
	type AccountKeyStore,
	type AccountRecoveryData,
	changeAccountEmail,
	changeAccountPassword,
	createAccountKeys,
	createVaultCrypto,
	InvalidAccountPasswordError,
	InvalidRecoveryKeyError,
	isOwnerWrappedVaultKey,
	LocalKeyAdoptionError,
	prepareRecoveryKey,
	recoverAccount,
	regenerateAccountSecretKey,
	type WrappedVaultKeyRecord,
} from "./vault-crypto";

/** `AccountStore` has to satisfy the ceremonies' store slice without an adapter. */
const _accountStoreIsAnAccountKeyStore = (
	store: AccountStore,
): AccountKeyStore => store;
void _accountStoreIsAnAccountKeyStore;

const ACCOUNT_ID = "acc_1";
const USER_ID = "user_1";
const EMAIL = "alice@example.com";
const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a whole new horse entirely";
const SECRET_KEY = "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2";
const NEW_SECRET_KEY = "A3-ZYXWVU-TSRQPO-NMLKJ-IHGFE-DCBA2";
const OWNED_VAULT = "vault_owned";
const SHARED_VAULT = "vault_shared";
const KEY_VERSION = 4;
const PROFILE = currentKdfProfile();

// ============================================================================
// Harness
// ============================================================================

interface StoreState {
	pinnedKdfProfile: KdfProfile | null;
	encryptedPrivateKey: string | null;
	secretKey: string | null;
	vaultKeys: VaultKeyEntry[] | null;
	masterUnlockKey: KeyRef | null;
	session: { userId: string; expiresAt?: number; sessionId?: string } | null;
	/** Set to make the named write throw, standing in for a storage failure. */
	failWrite: keyof StoreWrites | null;
	writes: string[];
}

interface StoreWrites {
	storePinnedKdfProfile: true;
	storeSecretKey: true;
	storeEncryptedPrivateKey: true;
	storeVaultKeys: true;
	storeSessionData: true;
	setMasterUnlockKey: true;
}

interface Harness {
	crypto: InMemoryCryptoPort;
	storage: AccountKeyStore;
	state: StoreState;
}

function createHarness(): Harness {
	const crypto = createInMemoryCryptoPort();
	const state: StoreState = {
		pinnedKdfProfile: PROFILE,
		encryptedPrivateKey: null,
		secretKey: SECRET_KEY,
		vaultKeys: null,
		masterUnlockKey: null,
		session: { userId: USER_ID, expiresAt: 1_700_000_000_000, sessionId: "s1" },
		failWrite: null,
		writes: [],
	};

	function record(name: keyof StoreWrites): void {
		if (state.failWrite === name) {
			throw new Error(`storage write failed: ${name}`);
		}
		state.writes.push(name);
	}

	const storage: AccountKeyStore = {
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
			return state.session;
		},
		async getPinnedKdfProfile() {
			return state.pinnedKdfProfile;
		},
		async storePinnedKdfProfile(profile) {
			record("storePinnedKdfProfile");
			state.pinnedKdfProfile = profile;
		},
		async storeSecretKey(key) {
			record("storeSecretKey");
			state.secretKey = key;
		},
		async storeEncryptedPrivateKey(encryptedPrivateKey) {
			record("storeEncryptedPrivateKey");
			state.encryptedPrivateKey = encryptedPrivateKey;
		},
		async storeVaultKeys(vaultKeys) {
			record("storeVaultKeys");
			state.vaultKeys = vaultKeys;
		},
		async storeSessionData() {
			record("storeSessionData");
		},
		async setMasterUnlockKey(key) {
			record("setMasterUnlockKey");
			state.masterUnlockKey = key;
		},
	};

	return { crypto, storage, state };
}

async function mukFor(
	crypto: InMemoryCryptoPort,
	input: {
		password?: string;
		secretKey?: string;
		email?: string;
		profile?: KdfProfile;
	} = {},
): Promise<KeyRef> {
	const { authKey, masterUnlockKey } = await crypto.deriveKeys(
		input.password ?? PASSWORD,
		input.secretKey ?? SECRET_KEY,
		input.email ?? EMAIL,
		input.profile ?? PROFILE,
	);
	await crypto.destroyKey(authKey);
	return masterUnlockKey;
}

async function materialOf(
	crypto: InMemoryCryptoPort,
	key: KeyRef,
): Promise<string> {
	return Buffer.from(await crypto.exportKey(key)).toString("base64");
}

/**
 * Seeds the account exactly as the server holds it: an RSA private key sealed under the
 * master unlock key, one vault the account owns and one shared with it.
 */
async function seedAccount(
	harness: Harness,
	options: { muk?: KeyRef } = {},
): Promise<{ vaultKeyMaterial: string; privateKeyPem: string }> {
	const { crypto, state } = harness;
	const muk = options.muk ?? (await mukFor(crypto));
	const rsa = await crypto.generateRsaKeyPair();
	state.encryptedPrivateKey = JSON.stringify(
		await crypto.encrypt(rsa.privateKey, muk, null),
	);

	const vaultKey = await crypto.generateEncryptionKey();
	const vaultKeyMaterial = await materialOf(crypto, vaultKey);
	const encryptedVaultKey = await crypto.encryptVaultKeyWithMuk(
		vaultKey,
		muk,
		OWNED_VAULT,
		USER_ID,
		KEY_VERSION,
	);
	const sharedKey = await crypto.generateEncryptionKey();
	const sharedWrapped = await crypto.encryptVaultKeyForMember(
		sharedKey,
		rsa.publicKey,
	);
	await crypto.destroyKey(vaultKey);
	await crypto.destroyKey(sharedKey);
	if (!options.muk) {
		await crypto.destroyKey(muk);
	}

	state.vaultKeys = [
		vaultEntry(OWNED_VAULT, encryptedVaultKey),
		vaultEntry(SHARED_VAULT, sharedWrapped),
	];
	return { vaultKeyMaterial, privateKeyPem: rsa.privateKey };
}

function vaultEntry(vaultId: string, encryptedVaultKey: string): VaultKeyEntry {
	return {
		vaultId,
		vaultName: vaultId,
		vaultType: "personal",
		vaultIcon: null,
		vaultImageUrl: null,
		encryptedVaultKey,
		role: "owner",
	};
}

/** Opens a re-wrapped vault key with the key the ceremony says it wrapped under. */
async function openWrapped(
	crypto: InMemoryCryptoPort,
	encryptedVaultKey: string,
	masterUnlockKey: KeyRef,
): Promise<string> {
	const vaultCrypto = createVaultCrypto({
		crypto,
		storage: createHarness().storage,
	});
	const vaultKey = await vaultCrypto.unwrapVaultKey({
		encryptedVaultKey,
		masterUnlockKey,
		expectedVaultId: OWNED_VAULT,
		expectedUserId: USER_ID,
	});
	const material = await materialOf(crypto, vaultKey);
	await crypto.destroyKey(vaultKey);
	return material;
}

function collect(payloads: unknown[]) {
	return async (payload: unknown) => {
		payloads.push(payload);
		return { ok: true };
	};
}

// ============================================================================
// 1 · Change the master password
// ============================================================================

describe("changeAccountPassword", () => {
	async function run(harness: Harness, payloads: unknown[]) {
		return changeAccountPassword(
			{
				accountId: ACCOUNT_ID,
				email: EMAIL,
				userId: USER_ID,
				currentPassword: PASSWORD,
				newPassword: NEW_PASSWORD,
				secretKey: SECRET_KEY,
				encryptedPrivateKey: harness.state.encryptedPrivateKey ?? "",
				vaultKeys: harness.state.vaultKeys ?? [],
			},
			{
				crypto: harness.crypto,
				storage: harness.storage,
				commit: collect(payloads),
			},
		);
	}

	test("re-wraps the owner's vault key under keys derived from the new password", async () => {
		const harness = createHarness();
		const { vaultKeyMaterial } = await seedAccount(harness);
		const payloads: Array<{ encryptedVaultKeys: WrappedVaultKeyRecord[] }> = [];

		await run(harness, payloads);

		const sent = payloads[0]?.encryptedVaultKeys ?? [];
		expect(sent.map((entry) => entry.vaultId)).toEqual([OWNED_VAULT]);

		const newMuk = await mukFor(harness.crypto, { password: NEW_PASSWORD });
		expect(
			await openWrapped(
				harness.crypto,
				sent[0]?.encryptedVaultKey ?? "",
				newMuk,
			),
		).toBe(vaultKeyMaterial);
		await harness.crypto.destroyKey(newMuk);
	});

	test("keeps the wrap key version, which the AAD is bound to", async () => {
		const harness = createHarness();
		await seedAccount(harness);
		const payloads: Array<{ encryptedVaultKeys: WrappedVaultKeyRecord[] }> = [];

		await run(harness, payloads);

		const rewrapped = JSON.parse(
			payloads[0]?.encryptedVaultKeys[0]?.encryptedVaultKey ?? "{}",
		) as { context?: { keyVersion?: number } };
		expect(rewrapped.context?.keyVersion).toBe(KEY_VERSION);
	});

	test("leaves an RSA-wrapped vault key out of the payload entirely", async () => {
		const harness = createHarness();
		await seedAccount(harness);
		const payloads: Array<{ encryptedVaultKeys: WrappedVaultKeyRecord[] }> = [];

		await run(harness, payloads);

		expect(
			payloads[0]?.encryptedVaultKeys.some(
				(entry) => entry.vaultId === SHARED_VAULT,
			),
		).toBe(false);
	});

	test("re-seals the private key so the new master unlock key opens it", async () => {
		const harness = createHarness();
		const { privateKeyPem } = await seedAccount(harness);
		const payloads: Array<{ encryptedPrivateKey: string }> = [];

		await run(harness, payloads);

		const newMuk = await mukFor(harness.crypto, { password: NEW_PASSWORD });
		const vaultCrypto = createVaultCrypto({
			crypto: harness.crypto,
			storage: harness.storage,
		});
		expect(
			await vaultCrypto.decryptPrivateKey(
				payloads[0]?.encryptedPrivateKey ?? "",
				newMuk,
			),
		).toBe(privateKeyPem);
		await harness.crypto.destroyKey(newMuk);
	});

	test("refuses a wrong password before anything is sent", async () => {
		const harness = createHarness();
		await seedAccount(harness);
		const payloads: unknown[] = [];

		await expect(
			changeAccountPassword(
				{
					accountId: ACCOUNT_ID,
					email: EMAIL,
					userId: USER_ID,
					currentPassword: "not the password",
					newPassword: NEW_PASSWORD,
					secretKey: SECRET_KEY,
					encryptedPrivateKey: harness.state.encryptedPrivateKey ?? "",
					vaultKeys: harness.state.vaultKeys ?? [],
				},
				{
					crypto: harness.crypto,
					storage: harness.storage,
					commit: collect(payloads),
				},
			),
		).rejects.toBeInstanceOf(InvalidAccountPasswordError);

		expect(payloads).toEqual([]);
		expect(harness.state.writes).toEqual([]);
	});

	test("refuses a wrap envelope with no context rather than guessing a version", async () => {
		const harness = createHarness();
		const muk = await mukFor(harness.crypto);
		await seedAccount(harness, { muk });
		// The pre-context wire form: a bare `EncryptedData` with no wrap context at all.
		// Its real key version is unknowable, and binding a guessed one into the AAD of the
		// replacement is how a vault key becomes permanently unopenable.
		const vaultKey = await harness.crypto.generateEncryptionKey();
		harness.state.vaultKeys = [
			vaultEntry(
				OWNED_VAULT,
				JSON.stringify(
					await harness.crypto.encrypt(
						Buffer.from(await harness.crypto.exportKey(vaultKey)).toString(
							"base64",
						),
						muk,
						null,
					),
				),
			),
		];
		await harness.crypto.destroyKey(vaultKey);
		await harness.crypto.destroyKey(muk);
		const payloads: unknown[] = [];

		await expect(run(harness, payloads)).rejects.toThrow(
			"Missing vault key wrap context",
		);
		expect(payloads).toEqual([]);
	});

	test("fails closed when the account has no pinned KDF profile", async () => {
		const harness = createHarness();
		await seedAccount(harness);
		harness.state.pinnedKdfProfile = null;
		const payloads: unknown[] = [];

		await expect(run(harness, payloads)).rejects.toThrow("sign in again");
		expect(payloads).toEqual([]);
	});

	test("fails the whole ceremony when one vault key cannot be re-wrapped", async () => {
		const harness = createHarness();
		await seedAccount(harness);
		// A wrap envelope naming a different vault: re-wrapping it would hand the server a
		// key nobody can open, so the ceremony must refuse rather than skip it.
		const otherMuk = await mukFor(harness.crypto);
		const strayKey = await harness.crypto.generateEncryptionKey();
		harness.state.vaultKeys = [
			vaultEntry(
				OWNED_VAULT,
				await harness.crypto.encryptVaultKeyWithMuk(
					strayKey,
					otherMuk,
					"some_other_vault",
					USER_ID,
					1,
				),
			),
		];
		await harness.crypto.destroyKey(strayKey);
		await harness.crypto.destroyKey(otherMuk);
		const payloads: unknown[] = [];

		await expect(run(harness, payloads)).rejects.toThrow("vault mismatch");
		expect(payloads).toEqual([]);
		expect(harness.state.writes).toEqual([]);
	});

	test("leaves the pin alone and leaks no key when the server rejects the change", async () => {
		const harness = createHarness();
		await seedAccount(harness);
		const before = harness.crypto.liveKeyCount;

		await expect(
			changeAccountPassword(
				{
					accountId: ACCOUNT_ID,
					email: EMAIL,
					userId: USER_ID,
					currentPassword: PASSWORD,
					newPassword: NEW_PASSWORD,
					secretKey: SECRET_KEY,
					encryptedPrivateKey: harness.state.encryptedPrivateKey ?? "",
					vaultKeys: harness.state.vaultKeys ?? [],
				},
				{
					crypto: harness.crypto,
					storage: harness.storage,
					commit: async () => {
						throw new Error("server said no");
					},
				},
			),
		).rejects.toThrow("server said no");

		expect(harness.state.writes).toEqual([]);
		expect(harness.state.pinnedKdfProfile).toEqual(PROFILE);
		expect(harness.crypto.liveKeyCount).toBe(before);
	});

	test("reports a pin that could not be written as a local adoption failure", async () => {
		const harness = createHarness();
		await seedAccount(harness);
		harness.state.failWrite = "storePinnedKdfProfile";

		await expect(run(harness, [])).rejects.toBeInstanceOf(
			LocalKeyAdoptionError,
		);
	});

	test("destroys every key it derived", async () => {
		const harness = createHarness();
		await seedAccount(harness);
		const before = harness.crypto.liveKeyCount;

		await run(harness, []);

		expect(harness.crypto.liveKeyCount).toBe(before);
	});
});

// ============================================================================
// 2 · Change the account email
// ============================================================================

describe("changeAccountEmail", () => {
	const NEW_EMAIL = "  Alice.New@Example.COM ";
	const NORMALIZED = "alice.new@example.com";

	async function run(harness: Harness, payloads: unknown[]) {
		return changeAccountEmail(
			{
				accountId: ACCOUNT_ID,
				currentEmail: EMAIL,
				newEmail: NEW_EMAIL,
				userId: USER_ID,
				currentPassword: PASSWORD,
				secretKey: SECRET_KEY,
				encryptedPrivateKey: harness.state.encryptedPrivateKey ?? "",
				vaultKeys: harness.state.vaultKeys ?? [],
			},
			{
				crypto: harness.crypto,
				storage: harness.storage,
				commit: collect(payloads),
			},
		);
	}

	test("normalizes the new email and derives the new keys from it", async () => {
		const harness = createHarness();
		const { vaultKeyMaterial } = await seedAccount(harness);
		const payloads: Array<{
			newEmail: string;
			encryptedVaultKeys: WrappedVaultKeyRecord[];
		}> = [];

		const result = await run(harness, payloads);

		expect(result.newEmail).toBe(NORMALIZED);
		expect(payloads[0]?.newEmail).toBe(NORMALIZED);

		const newMuk = await mukFor(harness.crypto, { email: NORMALIZED });
		expect(
			await openWrapped(
				harness.crypto,
				payloads[0]?.encryptedVaultKeys[0]?.encryptedVaultKey ?? "",
				newMuk,
			),
		).toBe(vaultKeyMaterial);
		await harness.crypto.destroyKey(newMuk);
	});

	test("the old email's keys no longer open the re-wrapped vault key", async () => {
		const harness = createHarness();
		await seedAccount(harness);
		const payloads: Array<{ encryptedVaultKeys: WrappedVaultKeyRecord[] }> = [];

		await run(harness, payloads);

		const oldMuk = await mukFor(harness.crypto);
		await expect(
			openWrapped(
				harness.crypto,
				payloads[0]?.encryptedVaultKeys[0]?.encryptedVaultKey ?? "",
				oldMuk,
			),
		).rejects.toThrow();
		await harness.crypto.destroyKey(oldMuk);
	});

	test("refuses a wrong password before anything is sent", async () => {
		const harness = createHarness();
		await seedAccount(harness);
		const payloads: unknown[] = [];

		await expect(
			changeAccountEmail(
				{
					accountId: ACCOUNT_ID,
					currentEmail: EMAIL,
					newEmail: NEW_EMAIL,
					userId: USER_ID,
					currentPassword: "wrong",
					secretKey: SECRET_KEY,
					encryptedPrivateKey: harness.state.encryptedPrivateKey ?? "",
					vaultKeys: harness.state.vaultKeys ?? [],
				},
				{
					crypto: harness.crypto,
					storage: harness.storage,
					commit: collect(payloads),
				},
			),
		).rejects.toBeInstanceOf(InvalidAccountPasswordError);
		expect(payloads).toEqual([]);
	});
});

// ============================================================================
// 3 · Regenerate the Secret Key
// ============================================================================

describe("regenerateAccountSecretKey", () => {
	async function run(
		harness: Harness,
		payloads: unknown[],
		commit?: (payload: unknown) => Promise<unknown>,
	) {
		return regenerateAccountSecretKey(
			{
				accountId: ACCOUNT_ID,
				email: EMAIL,
				userId: USER_ID,
				currentPassword: PASSWORD,
				currentSecretKey: SECRET_KEY,
				newSecretKey: NEW_SECRET_KEY,
				encryptedPrivateKey: harness.state.encryptedPrivateKey ?? "",
				vaultKeys: harness.state.vaultKeys ?? [],
			},
			{
				crypto: harness.crypto,
				storage: harness.storage,
				commit: commit ?? collect(payloads),
			},
		);
	}

	test("sends the new Secret Key's hint, never the key", async () => {
		const harness = createHarness();
		await seedAccount(harness);
		const payloads: Array<{ secretKeyHint: string }> = [];

		await run(harness, payloads);

		expect(payloads[0]?.secretKeyHint).toBe("A3-ZYXWVU");
		expect(JSON.stringify(payloads[0])).not.toContain(NEW_SECRET_KEY);
	});

	test("adopts the whole account locally, swapping the cached key last", async () => {
		const harness = createHarness();
		const { vaultKeyMaterial, privateKeyPem } = await seedAccount(harness);

		await run(harness, []);

		expect(harness.state.writes).toEqual([
			"storePinnedKdfProfile",
			"storeSecretKey",
			"storeEncryptedPrivateKey",
			"storeVaultKeys",
			"storeSessionData",
			"setMasterUnlockKey",
		]);
		expect(harness.state.secretKey).toBe(NEW_SECRET_KEY);

		// The point of the whole ceremony: everything the store now holds opens under the
		// key the store now caches.
		const cached = harness.state.masterUnlockKey;
		if (!cached) {
			throw new Error("expected a cached master unlock key");
		}
		const vaultCrypto = createVaultCrypto({
			crypto: harness.crypto,
			storage: harness.storage,
		});
		expect(
			await vaultCrypto.decryptPrivateKey(
				harness.state.encryptedPrivateKey ?? "",
				cached,
			),
		).toBe(privateKeyPem);

		const owned = harness.state.vaultKeys?.find(
			(entry) => entry.vaultId === OWNED_VAULT,
		);
		expect(
			await openWrapped(harness.crypto, owned?.encryptedVaultKey ?? "", cached),
		).toBe(vaultKeyMaterial);
	});

	test("keeps the RSA-wrapped entry in the locally cached set", async () => {
		const harness = createHarness();
		await seedAccount(harness);
		const before = harness.state.vaultKeys?.find(
			(entry) => entry.vaultId === SHARED_VAULT,
		);

		await run(harness, []);

		expect(
			harness.state.vaultKeys?.find((entry) => entry.vaultId === SHARED_VAULT),
		).toEqual(before as VaultKeyEntry);
	});

	test("adopts nothing when the server rejects the change", async () => {
		const harness = createHarness();
		await seedAccount(harness);
		const before = harness.crypto.liveKeyCount;

		await expect(
			run(harness, [], async () => {
				throw new Error("server said no");
			}),
		).rejects.toThrow("server said no");

		expect(harness.state.writes).toEqual([]);
		expect(harness.state.secretKey).toBe(SECRET_KEY);
		expect(harness.crypto.liveKeyCount).toBe(before);
	});

	test("reports a half-written adoption as a local failure, not a failed change", async () => {
		const harness = createHarness();
		await seedAccount(harness);
		harness.state.failWrite = "storeVaultKeys";
		const before = harness.crypto.liveKeyCount;

		await expect(run(harness, [])).rejects.toBeInstanceOf(
			LocalKeyAdoptionError,
		);

		// The cached key is never swapped to one the rest of the store does not match, and
		// the ref does not leak just because the adoption stopped halfway.
		expect(harness.state.masterUnlockKey).toBeNull();
		expect(harness.crypto.liveKeyCount).toBe(before);
	});

	test("hands the cached key to the store rather than destroying it", async () => {
		const harness = createHarness();
		await seedAccount(harness);
		const before = harness.crypto.liveKeyCount;

		await run(harness, []);

		expect(harness.crypto.liveKeyCount).toBe(before + 1);
		const cached = harness.state.masterUnlockKey;
		if (!cached) {
			throw new Error("expected a cached master unlock key");
		}
		expect(await harness.crypto.exportKey(cached)).toBeInstanceOf(Uint8Array);
	});
});

// ============================================================================
// 4 and 5 · Set up, or regenerate, the Recovery Key
// ============================================================================

describe("prepareRecoveryKey", () => {
	async function run(harness: Harness) {
		return prepareRecoveryKey(
			{
				accountId: ACCOUNT_ID,
				email: EMAIL,
				password: PASSWORD,
				secretKey: SECRET_KEY,
				encryptedPrivateKey: harness.state.encryptedPrivateKey ?? "",
			},
			{ crypto: harness.crypto, storage: harness.storage },
		);
	}

	test("seals a master key the Recovery Key opens back to the same unlock key", async () => {
		const harness = createHarness();
		await seedAccount(harness);

		const prepared = await run(harness);

		const masterKey = await harness.crypto.decryptMasterKey(
			JSON.parse(prepared.encryptedMasterKey),
			prepared.recoveryKey,
			EMAIL,
		);
		const { authKey, masterUnlockKey } =
			await harness.crypto.deriveKeysFromMasterKey(masterKey, EMAIL);
		const expected = await mukFor(harness.crypto);

		expect(await materialOf(harness.crypto, masterUnlockKey)).toBe(
			await materialOf(harness.crypto, expected),
		);

		for (const key of [masterKey, authKey, masterUnlockKey, expected]) {
			await harness.crypto.destroyKey(key);
		}
	});

	test("returns the two-segment hint, not the key", async () => {
		const harness = createHarness();
		await seedAccount(harness);

		const prepared = await run(harness);

		expect(prepared.recoveryKeyHint).toBe(
			prepared.recoveryKey.split("-").slice(0, 2).join("-"),
		);
		expect(prepared.recoveryKey.startsWith("R1-")).toBe(true);
	});

	test("refuses a wrong password and leaks no key", async () => {
		const harness = createHarness();
		await seedAccount(harness);
		const before = harness.crypto.liveKeyCount;

		await expect(
			prepareRecoveryKey(
				{
					accountId: ACCOUNT_ID,
					email: EMAIL,
					password: "wrong",
					secretKey: SECRET_KEY,
					encryptedPrivateKey: harness.state.encryptedPrivateKey ?? "",
				},
				{ crypto: harness.crypto, storage: harness.storage },
			),
		).rejects.toBeInstanceOf(InvalidAccountPasswordError);

		expect(harness.crypto.liveKeyCount).toBe(before);
	});

	test("fails closed when the account has no pinned KDF profile", async () => {
		const harness = createHarness();
		await seedAccount(harness);
		harness.state.pinnedKdfProfile = null;

		await expect(run(harness)).rejects.toThrow("sign in again");
	});
});

// ============================================================================
// 6 · Recover the account
// ============================================================================

describe("recoverAccount", () => {
	async function seedRecoveryData(
		crypto: InMemoryCryptoPort,
		recoveryKey: string,
	): Promise<{
		data: AccountRecoveryData;
		vaultKeyMaterial: string;
		privateKeyPem: string;
	}> {
		const masterKey = await crypto.deriveMasterKey(
			PASSWORD,
			SECRET_KEY,
			EMAIL,
			PROFILE,
		);
		const encryptedMasterKey = JSON.stringify(
			await crypto.encryptMasterKey(masterKey, recoveryKey, EMAIL),
		);
		const { authKey, masterUnlockKey } = await crypto.deriveKeysFromMasterKey(
			masterKey,
			EMAIL,
		);
		await crypto.destroyKey(authKey);
		await crypto.destroyKey(masterKey);

		const rsa = await crypto.generateRsaKeyPair();
		const encryptedPrivateKey = JSON.stringify(
			await crypto.encrypt(rsa.privateKey, masterUnlockKey, null),
		);
		const vaultKey = await crypto.generateEncryptionKey();
		const vaultKeyMaterial = await materialOf(crypto, vaultKey);
		const encryptedVaultKey = await crypto.encryptVaultKeyWithMuk(
			vaultKey,
			masterUnlockKey,
			OWNED_VAULT,
			USER_ID,
			KEY_VERSION,
		);
		const sharedKey = await crypto.generateEncryptionKey();
		const shared = await crypto.encryptVaultKeyForMember(
			sharedKey,
			rsa.publicKey,
		);
		for (const key of [vaultKey, sharedKey, masterUnlockKey]) {
			await crypto.destroyKey(key);
		}

		return {
			data: {
				userId: USER_ID,
				encryptedMasterKey,
				encryptedPrivateKey,
				vaultKeys: [
					{ vaultId: OWNED_VAULT, encryptedVaultKey },
					{ vaultId: SHARED_VAULT, encryptedVaultKey: shared },
				],
			},
			vaultKeyMaterial,
			privateKeyPem: rsa.privateKey,
		};
	}

	test("re-keys the account and keeps the Recovery Key working", async () => {
		const crypto = createInMemoryCryptoPort();
		const recoveryKey = await crypto.generateRecoveryKey();
		const { data, vaultKeyMaterial, privateKeyPem } = await seedRecoveryData(
			crypto,
			recoveryKey,
		);
		const payloads: Array<{
			encryptedMasterKey: string;
			encryptedVaultKeys: WrappedVaultKeyRecord[];
			secretKeyHint: string;
			recoveryKeyHint: string;
		}> = [];

		const recovered = await recoverAccount(
			{ email: EMAIL, recoveryKey, newPassword: NEW_PASSWORD },
			{
				crypto,
				loadRecoveryData: async () => data,
				commit: async (payload) => {
					payloads.push(payload);
					return { token: "t" };
				},
			},
		);

		expect(recovered.result).toEqual({ token: "t" });
		expect(recovered.secretKey.startsWith("A3-")).toBe(true);
		expect(payloads[0]?.secretKeyHint).toBe(
			recovered.secretKey.split("-").slice(0, 2).join("-"),
		);
		expect(payloads[0]?.recoveryKeyHint).toBe(
			recoveryKey.split("-").slice(0, 2).join("-"),
		);

		// The vault key, the private key and the Recovery Key all still work against the
		// keys the ceremony handed back.
		expect(
			await openWrapped(
				crypto,
				payloads[0]?.encryptedVaultKeys[0]?.encryptedVaultKey ?? "",
				recovered.masterUnlockKey,
			),
		).toBe(vaultKeyMaterial);

		const vaultCrypto = createVaultCrypto({
			crypto,
			storage: createHarness().storage,
		});
		expect(
			await vaultCrypto.decryptPrivateKey(
				recovered.encryptedPrivateKey,
				recovered.masterUnlockKey,
			),
		).toBe(privateKeyPem);

		const resealed = await crypto.decryptMasterKey(
			JSON.parse(payloads[0]?.encryptedMasterKey ?? "{}"),
			recoveryKey,
			EMAIL,
		);
		const derived = await crypto.deriveKeysFromMasterKey(resealed, EMAIL);
		expect(await materialOf(crypto, derived.masterUnlockKey)).toBe(
			await materialOf(crypto, recovered.masterUnlockKey),
		);

		for (const key of [
			resealed,
			derived.authKey,
			derived.masterUnlockKey,
			recovered.masterUnlockKey,
		]) {
			await crypto.destroyKey(key);
		}
	});

	test("re-wraps only the keys the master unlock key held", async () => {
		const crypto = createInMemoryCryptoPort();
		const recoveryKey = await crypto.generateRecoveryKey();
		const { data } = await seedRecoveryData(crypto, recoveryKey);
		const payloads: Array<{ encryptedVaultKeys: WrappedVaultKeyRecord[] }> = [];

		const recovered = await recoverAccount(
			{ email: EMAIL, recoveryKey, newPassword: NEW_PASSWORD },
			{
				crypto,
				loadRecoveryData: async () => data,
				commit: async (payload) => {
					payloads.push(payload);
					return null;
				},
			},
		);

		expect(payloads[0]?.encryptedVaultKeys.map((k) => k.vaultId)).toEqual([
			OWNED_VAULT,
		]);
		expect(
			isOwnerWrappedVaultKey(
				payloads[0]?.encryptedVaultKeys[0]?.encryptedVaultKey ?? "",
			),
		).toBe(true);
		await crypto.destroyKey(recovered.masterUnlockKey);
	});

	test("rejects a malformed Recovery Key before asking the server for anything", async () => {
		const crypto = createInMemoryCryptoPort();
		let loaded = false;

		await expect(
			recoverAccount(
				{ email: EMAIL, recoveryKey: "nonsense", newPassword: NEW_PASSWORD },
				{
					crypto,
					loadRecoveryData: async () => {
						loaded = true;
						throw new Error("should not be reached");
					},
					commit: async () => null,
				},
			),
		).rejects.toBeInstanceOf(InvalidRecoveryKeyError);
		expect(loaded).toBe(false);
	});

	test("rejects a well-formed Recovery Key that is not this account's", async () => {
		const crypto = createInMemoryCryptoPort();
		const { data } = await seedRecoveryData(
			crypto,
			await crypto.generateRecoveryKey(),
		);
		const before = crypto.liveKeyCount;

		await expect(
			recoverAccount(
				{
					email: EMAIL,
					recoveryKey: await crypto.generateRecoveryKey(),
					newPassword: NEW_PASSWORD,
				},
				{
					crypto,
					loadRecoveryData: async () => data,
					commit: async () => null,
				},
			),
		).rejects.toThrow();
		expect(crypto.liveKeyCount).toBe(before);
	});

	test("leaks no key when the reset is rejected", async () => {
		const crypto = createInMemoryCryptoPort();
		const recoveryKey = await crypto.generateRecoveryKey();
		const { data } = await seedRecoveryData(crypto, recoveryKey);
		const before = crypto.liveKeyCount;

		await expect(
			recoverAccount(
				{ email: EMAIL, recoveryKey, newPassword: NEW_PASSWORD },
				{
					crypto,
					loadRecoveryData: async () => data,
					commit: async () => {
						throw new Error("token expired");
					},
				},
			),
		).rejects.toThrow("token expired");
		expect(crypto.liveKeyCount).toBe(before);
	});
});

// ============================================================================
// 7 · Create a new account
// ============================================================================

describe("createAccountKeys", () => {
	async function run(
		crypto: InMemoryCryptoPort,
		commit: (payload: unknown) => Promise<unknown>,
	) {
		const recoveryKey = await crypto.generateRecoveryKey();
		const created = await createAccountKeys(
			{
				email: EMAIL,
				password: PASSWORD,
				secretKey: SECRET_KEY,
				recoveryKey,
			},
			{ crypto, commit },
		);
		return { ...created, recoveryKey };
	}

	test("wraps the first vault key under the account's own identifiers", async () => {
		const crypto = createInMemoryCryptoPort();
		const { keys } = await run(crypto, async () => ({ userId: "ignored" }));

		const vaultCrypto = createVaultCrypto({
			crypto,
			storage: createHarness().storage,
		});
		const vaultKey = await vaultCrypto.unwrapVaultKey({
			encryptedVaultKey: keys.encryptedVaultKey,
			masterUnlockKey: keys.masterUnlockKey,
			expectedVaultId: keys.vaultId,
			expectedUserId: keys.userId,
		});
		expect(await crypto.exportKey(vaultKey)).toBeInstanceOf(Uint8Array);

		await crypto.destroyKey(vaultKey);
		await crypto.destroyKey(keys.masterUnlockKey);
	});

	test("seals the master key under the Recovery Key it was handed", async () => {
		const crypto = createInMemoryCryptoPort();
		const { keys, recoveryKey } = await run(crypto, async () => null);

		const masterKey = await crypto.decryptMasterKey(
			JSON.parse(keys.encryptedMasterKey),
			recoveryKey,
			EMAIL,
		);
		const derived = await crypto.deriveKeysFromMasterKey(masterKey, EMAIL);
		expect(await materialOf(crypto, derived.masterUnlockKey)).toBe(
			await materialOf(crypto, keys.masterUnlockKey),
		);

		for (const key of [
			masterKey,
			derived.authKey,
			derived.masterUnlockKey,
			keys.masterUnlockKey,
		]) {
			await crypto.destroyKey(key);
		}
	});

	test("opens the private key with the master unlock key it returns", async () => {
		const crypto = createInMemoryCryptoPort();
		const { keys } = await run(crypto, async () => null);

		const vaultCrypto = createVaultCrypto({
			crypto,
			storage: createHarness().storage,
		});
		const pem = await vaultCrypto.decryptPrivateKey(
			keys.encryptedPrivateKey,
			keys.masterUnlockKey,
		);
		expect(pem).toContain("PRIVATE KEY");
		await crypto.destroyKey(keys.masterUnlockKey);
	});

	test("sends hints rather than the Secret Key or the Recovery Key", async () => {
		const crypto = createInMemoryCryptoPort();
		const payloads: unknown[] = [];
		const { keys, recoveryKey } = await run(crypto, async (payload) => {
			payloads.push(payload);
			return null;
		});

		expect(keys.secretKeyHint).toBe("A3-ABCDEF");
		expect(keys.recoveryKeyHint).toBe(
			recoveryKey.split("-").slice(0, 2).join("-"),
		);
		const sent = JSON.stringify(payloads[0]);
		expect(sent).not.toContain(SECRET_KEY);
		expect(sent).not.toContain(recoveryKey);
		await crypto.destroyKey(keys.masterUnlockKey);
	});

	test("mints distinct identifiers for the user and the first vault", async () => {
		const crypto = createInMemoryCryptoPort();
		const { keys } = await run(crypto, async () => null);

		const uuid =
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
		expect(keys.userId).toMatch(uuid);
		expect(keys.vaultId).toMatch(uuid);
		expect(keys.userId).not.toBe(keys.vaultId);
		await crypto.destroyKey(keys.masterUnlockKey);
	});

	test("leaves nothing behind when the signup mutation fails", async () => {
		const crypto = createInMemoryCryptoPort();
		const before = crypto.liveKeyCount;

		await expect(
			run(crypto, async () => {
				throw new Error("email already taken");
			}),
		).rejects.toThrow("email already taken");
		expect(crypto.liveKeyCount).toBe(before);
	});
});
