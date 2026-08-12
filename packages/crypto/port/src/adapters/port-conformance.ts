/**
 * The shared crypto port conformance suite.
 *
 * One suite body, run against every adapter over a doubled backend plus the in-memory fake.
 * It pins what the TypeScript layer owns and the Rust tests cannot see: which argument lands
 * in which slot, where base64 begins and ends, `KeyRef` lifetime, error translation, and
 * that a key the port does not hold throws instead of resolving to `null`.
 *
 * Two rules keep it honest, carried over verbatim from `packages/storage`:
 *
 *   1. **Nothing here may import a platform API**, and nothing here may branch on `name`.
 *      `name` is a label for the test output, not a capability probe. The moment this file
 *      says `if (name === "web")` the suite has stopped being a contract.
 *   2. **Only port-visible behaviour is asserted.** Where the contract deliberately leaves
 *      an adapter free — how a `KeyRef` is represented, how long a derivation takes, what a
 *      ciphertext looks like — the suite says nothing.
 *
 * It is NOT an interop test. Ciphertext produced by one backend is never handed to another
 * here; that is what the Rust format vectors are for. A suite of green adapters proves they
 * agree on the *shape* of every call, not that they agree on the bytes.
 *
 * `make()` must hand back a **fresh, initialised** port on every call: the suite calls it
 * once per test, sometimes twice, and assumes no state carries over between them.
 */

import { describe, expect, setSystemTime, test } from "bun:test";
import type { CryptoPort } from "../crypto-port";
import {
	CRYPTO_PORT_ERROR_CODES,
	CryptoPortError,
	type CryptoPortErrorCode,
} from "../errors";
import type { ItemData, KdfProfile } from "../types";

/**
 * Named so a port that grew a member without growing the suite fails to compile. The
 * `satisfies` catches a name that no longer exists; `NoMemberMissing` catches the reverse.
 */
export const CRYPTO_PORT_MEMBERS = [
	"initialize",
	"generateEncryptionKey",
	"importKey",
	"exportKey",
	"cloneKey",
	"destroyKey",
	"deriveKeys",
	"deriveMasterKey",
	"deriveKeysFromMasterKey",
	"deriveSrpPassword",
	"encrypt",
	"decrypt",
	"decryptMany",
	"wrapKey",
	"unwrapKey",
	"generateRsaKeyPair",
	"rsaEncrypt",
	"rsaDecrypt",
	"decryptRsaWrappedKey",
	"encryptVaultKeyForMember",
	"encryptVaultKeyWithMuk",
	"reEncryptItem",
	"rewrapAttachmentKey",
	"generateSecretKey",
	"validateSecretKey",
	"generateRecoveryKey",
	"validateRecoveryKey",
	"encryptMasterKey",
	"decryptMasterKey",
	"generateSrpRegistration",
	"generateClientEphemeral",
	"deriveClientSession",
	"verifyServerSession",
	"generatePasskeyKeypair",
	"generatePasskeyCredentialId",
	"buildPasskeyAttestationObject",
	"signPasskeyAssertion",
	"generateTotp",
	"generateUuid",
] as const satisfies readonly (keyof CryptoPort)[];

type MissingMember = Exclude<
	keyof CryptoPort,
	(typeof CRYPTO_PORT_MEMBERS)[number]
>;

export type NoMemberMissing = [MissingMember] extends [never]
	? true
	: ["port member missing from CRYPTO_PORT_MEMBERS", MissingMember];

export const noMemberMissing: NoMemberMissing = true;

const PROFILE: KdfProfile = {
	schemaVersion: 1,
	algorithm: "pbkdf2-sha256",
	iterations: 600_000,
};

const PASSWORD = "correct horse battery staple";
const SECRET_KEY = "A3-ABCDEF-GHJKMN-PQRST-UVWXY-Z2345";
const EMAIL = "conformance@bittery.test";

/** Multi-byte content, so a marshalling layer cannot split a value mid-codepoint. */
const UNICODE_PLAINTEXT = "héllo — wörld 🔐 ünïcøde ✓";

/** Every byte class base64 gets wrong when it is hand-rolled, at the required key length. */
const AWKWARD_KEY_BYTES = Uint8Array.from([
	0x00, 0xff, 0x7f, 0x80, 0x01, 0xfe, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70,
	0x90, 0xa0, 0xb0, 0xc0, 0xd0, 0xe0, 0xf0, 0x0a, 0x0d, 0x09, 0x2b, 0x2f, 0x3d,
	0x41, 0x5a, 0x61, 0x7a, 0xaa, 0x55,
]);

const CONTEXT = {
	vaultId: "vault-1",
	entityId: "item-1",
	entityType: "item",
	version: 3,
	userId: "user-1",
} as const;

function itemContext(itemId: string): ItemData["context"] {
	return { ...CONTEXT, entityId: itemId };
}

const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * RFC 6238 Appendix B, base32-encoded: the ASCII seeds "12345678901234567890" and its 32- and
 * 64-byte extensions. Vectors rather than a smoke test, because an adapter that swapped
 * `digits` for `period` — or handed `algorithm` to the wrong slot — still returns *a* code.
 */
const TOTP_SEED_SHA1 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const TOTP_SEED_SHA256 =
	"GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA====";
const TOTP_SEED_SHA512 =
	"GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA=";

/** The RFC's first row: T = 59s, X = 30s, 8 digits. */
const TOTP_T59_MS = 59_000;
const TOTP_PERIOD = 30;

function encodeBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function isBase64(value: string): boolean {
	try {
		return encodeBase64(decodeBase64(value)) === value;
	} catch {
		return false;
	}
}

/**
 * Runs `body` with the clock pinned. A TOTP code is a function of wall-clock time, so a known
 * vector only means anything inside a known window.
 */
async function atUnixTime<T>(
	milliseconds: number,
	body: () => Promise<T>,
): Promise<T> {
	setSystemTime(new Date(milliseconds));
	try {
		return await body();
	} finally {
		setSystemTime();
	}
}

async function expectPortError(
	operation: () => Promise<unknown>,
	code?: CryptoPortErrorCode,
): Promise<CryptoPortError> {
	let caught: unknown = null;
	try {
		await operation();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(CryptoPortError);
	const error = caught as CryptoPortError;
	expect(CRYPTO_PORT_ERROR_CODES).toContain(error.code);
	if (code !== undefined) {
		expect(error.code).toBe(code);
	}
	return error;
}

/**
 * Run the shared conformance suite against one adapter.
 *
 * @param name  Label for the test output only. Never branch on it.
 * @param make  Produces a fresh, initialised port for a single test.
 */
export function runCryptoPortConformance(
	name: string,
	make: () => Promise<CryptoPort>,
): void {
	// ==================================================================
	// Totality
	// ==================================================================

	describe(`${name} — totality`, () => {
		test("every member of CryptoPort is present and callable", async () => {
			const port = await make();

			for (const member of CRYPTO_PORT_MEMBERS) {
				expect(typeof port[member]).toBe("function");
			}
		});

		test("initialize is idempotent", async () => {
			const port = await make();

			await port.initialize();
			await port.initialize();

			const key = await port.generateEncryptionKey();
			expect(
				await port.decrypt(await port.encrypt("ok", key, null), key, null),
			).toBe("ok");
		});
	});

	// ==================================================================
	// KeyRef lifetime — the property the whole seam is built on
	// ==================================================================

	describe(`${name} — KeyRef lifetime`, () => {
		test("generateEncryptionKey yields a distinct, usable ref each time", async () => {
			const port = await make();

			const first = await port.generateEncryptionKey();
			const second = await port.generateEncryptionKey();

			expect(first).not.toBe(second);
			const sealed = await port.encrypt("payload", first, null);
			expect(await port.decrypt(sealed, first, null)).toBe("payload");
			await expectPortError(() => port.decrypt(sealed, second, null));
		});

		test("importKey and exportKey round-trip every byte", async () => {
			const port = await make();

			const key = await port.importKey(AWKWARD_KEY_BYTES);

			expect([...(await port.exportKey(key))]).toEqual([...AWKWARD_KEY_BYTES]);
		});

		test("exportKey hands back a copy, not the live buffer", async () => {
			const port = await make();
			const key = await port.importKey(AWKWARD_KEY_BYTES);

			(await port.exportKey(key)).fill(0);

			expect([...(await port.exportKey(key))]).toEqual([...AWKWARD_KEY_BYTES]);
		});

		test("destroyKey makes every later use of the ref throw", async () => {
			const port = await make();
			const key = await port.generateEncryptionKey();
			const sealed = await port.encrypt("payload", key, null);

			await port.destroyKey(key);

			await expectPortError(
				() => port.encrypt("payload", key, null),
				"key-destroyed",
			);
			await expectPortError(
				() => port.decrypt(sealed, key, null),
				"key-destroyed",
			);
			await expectPortError(() => port.exportKey(key), "key-destroyed");
			await expectPortError(() => port.cloneKey(key), "key-destroyed");
		});

		test("destroyKey is idempotent", async () => {
			const port = await make();
			const key = await port.generateEncryptionKey();

			await port.destroyKey(key);
			await port.destroyKey(key);

			await expectPortError(() => port.exportKey(key), "key-destroyed");
		});

		test("a ref minted by another port is rejected, not silently used", async () => {
			const port = await make();
			const other = await make();
			const foreign = await other.generateEncryptionKey();

			await expectPortError(
				() => port.encrypt("payload", foreign, null),
				"invalid-key-ref",
			);
			await expectPortError(() => port.exportKey(foreign), "invalid-key-ref");
			await expectPortError(() => port.destroyKey(foreign), "invalid-key-ref");
		});

		test("a clone outlives the original", async () => {
			const port = await make();
			const key = await port.importKey(AWKWARD_KEY_BYTES);
			const clone = await port.cloneKey(key);

			await port.destroyKey(key);

			expect([...(await port.exportKey(clone))]).toEqual([
				...AWKWARD_KEY_BYTES,
			]);
		});

		test("the original outlives a destroyed clone", async () => {
			const port = await make();
			const key = await port.importKey(AWKWARD_KEY_BYTES);
			const clone = await port.cloneKey(key);

			await port.destroyKey(clone);

			expect([...(await port.exportKey(key))]).toEqual([...AWKWARD_KEY_BYTES]);
		});
	});

	// ==================================================================
	// Symmetric encryption
	// ==================================================================

	describe(`${name} — encrypt / decrypt`, () => {
		test("round-trips without a context", async () => {
			const port = await make();
			const key = await port.generateEncryptionKey();

			const sealed = await port.encrypt("plain", key, null);

			expect(await port.decrypt(sealed, key, null)).toBe("plain");
		});

		test("round-trips multi-byte plaintext", async () => {
			const port = await make();
			const key = await port.generateEncryptionKey();

			const sealed = await port.encrypt(UNICODE_PLAINTEXT, key, null);

			expect(await port.decrypt(sealed, key, null)).toBe(UNICODE_PLAINTEXT);
		});

		test("round-trips the empty string", async () => {
			const port = await make();
			const key = await port.generateEncryptionKey();

			const sealed = await port.encrypt("", key, null);

			expect(await port.decrypt(sealed, key, null)).toBe("");
		});

		test("emits base64 ciphertext and iv plus a non-empty algorithm", async () => {
			const port = await make();
			const key = await port.generateEncryptionKey();

			const sealed = await port.encrypt("plain", key, null);

			expect(isBase64(sealed.ciphertext)).toBe(true);
			expect(isBase64(sealed.iv)).toBe(true);
			expect(sealed.iv.length).toBeGreaterThan(0);
			expect(sealed.algorithm.length).toBeGreaterThan(0);
		});

		test("uses a fresh iv for every call", async () => {
			const port = await make();
			const key = await port.generateEncryptionKey();

			const first = await port.encrypt("plain", key, null);
			const second = await port.encrypt("plain", key, null);

			expect(first.iv).not.toBe(second.iv);
			expect(first.ciphertext).not.toBe(second.ciphertext);
		});

		test("a different key does not decrypt", async () => {
			const port = await make();
			const key = await port.generateEncryptionKey();
			const other = await port.generateEncryptionKey();

			const sealed = await port.encrypt("plain", key, null);

			await expectPortError(
				() => port.decrypt(sealed, other, null),
				"decryption-failed",
			);
		});

		test("round-trips with a context", async () => {
			const port = await make();
			const key = await port.generateEncryptionKey();

			const sealed = await port.encrypt(UNICODE_PLAINTEXT, key, CONTEXT);

			expect(await port.decrypt(sealed, key, CONTEXT)).toBe(UNICODE_PLAINTEXT);
		});

		test("every field of the context is bound into the ciphertext", async () => {
			const port = await make();
			const key = await port.generateEncryptionKey();
			const sealed = await port.encrypt("plain", key, CONTEXT);

			const variants = [
				{ ...CONTEXT, vaultId: "vault-2" },
				{ ...CONTEXT, entityId: "item-2" },
				{ ...CONTEXT, entityType: "attachment_blob" as const },
				{ ...CONTEXT, version: 4 },
				{ ...CONTEXT, userId: "user-2" },
			];

			for (const variant of variants) {
				await expectPortError(
					() => port.decrypt(sealed, key, variant),
					"decryption-failed",
				);
			}
		});

		test("a context-bound ciphertext does not decrypt without the context", async () => {
			const port = await make();
			const key = await port.generateEncryptionKey();

			const sealed = await port.encrypt("plain", key, CONTEXT);

			await expectPortError(
				() => port.decrypt(sealed, key, null),
				"decryption-failed",
			);
		});

		test("a contextless ciphertext does not decrypt with a context", async () => {
			const port = await make();
			const key = await port.generateEncryptionKey();

			const sealed = await port.encrypt("plain", key, null);

			await expectPortError(
				() => port.decrypt(sealed, key, CONTEXT),
				"decryption-failed",
			);
		});

		test("tampered ciphertext fails rather than returning garbage", async () => {
			const port = await make();
			const key = await port.generateEncryptionKey();
			const sealed = await port.encrypt("plain", key, null);
			const bytes = decodeBase64(sealed.ciphertext);
			bytes[0] = (bytes[0] ?? 0) ^ 0xff;

			await expectPortError(() =>
				port.decrypt({ ...sealed, ciphertext: encodeBase64(bytes) }, key, null),
			);
		});
	});

	// ==================================================================
	// wrapKey / unwrapKey
	// ==================================================================

	describe(`${name} — wrapKey / unwrapKey`, () => {
		test("unwrapKey restores the same key material", async () => {
			const port = await make();
			const key = await port.importKey(AWKWARD_KEY_BYTES);
			const wrappingKey = await port.generateEncryptionKey();

			const restored = await port.unwrapKey(
				await port.wrapKey(key, wrappingKey, null),
				wrappingKey,
				null,
			);

			expect([...(await port.exportKey(restored))]).toEqual([
				...AWKWARD_KEY_BYTES,
			]);
		});

		test("the wrong wrapping key does not unwrap", async () => {
			const port = await make();
			const key = await port.generateEncryptionKey();
			const wrappingKey = await port.generateEncryptionKey();
			const otherWrappingKey = await port.generateEncryptionKey();

			const wrapped = await port.wrapKey(key, wrappingKey, null);

			await expectPortError(
				() => port.unwrapKey(wrapped, otherWrappingKey, null),
				"decryption-failed",
			);
		});

		test("an unwrapped ref has its own lifetime", async () => {
			const port = await make();
			const key = await port.generateEncryptionKey();
			const wrappingKey = await port.generateEncryptionKey();
			const restored = await port.unwrapKey(
				await port.wrapKey(key, wrappingKey, null),
				wrappingKey,
				null,
			);

			await port.destroyKey(restored);

			expect((await port.exportKey(wrappingKey)).length).toBeGreaterThan(0);
			expect((await port.exportKey(key)).length).toBeGreaterThan(0);
		});

		test("authenticated key plaintext stays behind the seam", async () => {
			const port = await make();
			const wrappingKey = await port.generateEncryptionKey();
			const context = {
				vaultId: "vault-key-context",
				entityId: "vault-key-wrap",
				entityType: "vault_key" as const,
				version: 2,
				userId: "user-key-context",
			};
			const keyBase64 = encodeBase64(AWKWARD_KEY_BYTES);
			const authenticated = await port.encrypt(keyBase64, wrappingKey, context);
			const restored = await port.unwrapKey(
				authenticated,
				wrappingKey,
				context,
			);
			expect([...(await port.exportKey(restored))]).toEqual([
				...AWKWARD_KEY_BYTES,
			]);
		});

		test("wrapping a destroyed key throws", async () => {
			const port = await make();
			const key = await port.generateEncryptionKey();
			const wrappingKey = await port.generateEncryptionKey();

			await port.destroyKey(key);

			await expectPortError(
				() => port.wrapKey(key, wrappingKey, null),
				"key-destroyed",
			);
		});
	});

	// ==================================================================
	// decryptMany
	// ==================================================================

	describe(`${name} — decryptMany`, () => {
		test("returns one result per request, in request order", async () => {
			const port = await make();
			const key = await port.generateEncryptionKey();
			const requests = await Promise.all(
				["a", "b", "c"].map(async (id) => ({
					id,
					data: await port.encrypt(`plain-${id}`, key, null),
					key,
					context: null,
				})),
			);

			const results = await port.decryptMany(requests);

			expect(results.map((result) => result.id)).toEqual(["a", "b", "c"]);
			expect(
				results.map((result) => (result.ok ? result.plaintext : null)),
			).toEqual(["plain-a", "plain-b", "plain-c"]);
		});

		test("spans several keys and contexts in one batch", async () => {
			const port = await make();
			const first = await port.generateEncryptionKey();
			const second = await port.generateEncryptionKey();

			const results = await port.decryptMany([
				{
					id: "no-context",
					data: await port.encrypt("one", first, null),
					key: first,
					context: null,
				},
				{
					id: "with-context",
					data: await port.encrypt("two", second, CONTEXT),
					key: second,
					context: CONTEXT,
				},
			]);

			expect(
				results.map((result) => (result.ok ? result.plaintext : null)),
			).toEqual(["one", "two"]);
		});

		test("one bad item is reported in place, not thrown", async () => {
			const port = await make();
			const key = await port.generateEncryptionKey();
			const other = await port.generateEncryptionKey();

			const results = await port.decryptMany([
				{
					id: "good",
					data: await port.encrypt("one", key, null),
					key,
					context: null,
				},
				{
					id: "bad",
					data: await port.encrypt("two", other, null),
					key,
					context: null,
				},
			]);

			expect(results[0]?.ok).toBe(true);
			expect(results[1]?.ok).toBe(false);
			expect(
				results[1]?.ok === false ? results[1].error.length : 0,
			).toBeGreaterThan(0);
		});

		test("an empty batch returns an empty array", async () => {
			const port = await make();

			expect(await port.decryptMany([])).toEqual([]);
		});

		test("a destroyed key fails the call rather than one item", async () => {
			const port = await make();
			const key = await port.generateEncryptionKey();
			const request = {
				id: "a",
				data: await port.encrypt("one", key, null),
				key,
				context: null,
			};

			await port.destroyKey(key);

			await expectPortError(() => port.decryptMany([request]), "key-destroyed");
		});
	});

	// ==================================================================
	// Derivation
	// ==================================================================

	describe(`${name} — derivation`, () => {
		test("deriveKeys is deterministic for identical inputs", async () => {
			const port = await make();

			const first = await port.deriveKeys(PASSWORD, SECRET_KEY, EMAIL, PROFILE);
			const second = await port.deriveKeys(
				PASSWORD,
				SECRET_KEY,
				EMAIL,
				PROFILE,
			);

			const sealed = await port.encrypt("plain", first.masterUnlockKey, null);
			expect(await port.decrypt(sealed, second.masterUnlockKey, null)).toBe(
				"plain",
			);
		});

		test("the auth key and the master unlock key are different keys", async () => {
			const port = await make();

			const derived = await port.deriveKeys(
				PASSWORD,
				SECRET_KEY,
				EMAIL,
				PROFILE,
			);

			const sealed = await port.encrypt("plain", derived.authKey, null);
			await expectPortError(
				() => port.decrypt(sealed, derived.masterUnlockKey, null),
				"decryption-failed",
			);
		});

		test("every derivation argument reaches the backend", async () => {
			const port = await make();
			const baseline = await port.deriveKeys(
				PASSWORD,
				SECRET_KEY,
				EMAIL,
				PROFILE,
			);
			const sealed = await port.encrypt(
				"plain",
				baseline.masterUnlockKey,
				null,
			);

			const variants: Array<[string, string, string, KdfProfile]> = [
				["other password", SECRET_KEY, EMAIL, PROFILE],
				[PASSWORD, "A3-ZZZZZZ-YYYYYY-XXXXX-WWWWW-VVVVV", EMAIL, PROFILE],
				[PASSWORD, SECRET_KEY, "someone-else@bittery.test", PROFILE],
				[PASSWORD, SECRET_KEY, EMAIL, { ...PROFILE, iterations: 700_000 }],
			];

			for (const [password, secretKey, email, profile] of variants) {
				const derived = await port.deriveKeys(
					password,
					secretKey,
					email,
					profile,
				);
				await expectPortError(
					() => port.decrypt(sealed, derived.masterUnlockKey, null),
					"decryption-failed",
				);
			}
		});

		test("deriveKeys is deriveMasterKey followed by deriveKeysFromMasterKey", async () => {
			const port = await make();

			const oneStep = await port.deriveKeys(
				PASSWORD,
				SECRET_KEY,
				EMAIL,
				PROFILE,
			);
			const masterKey = await port.deriveMasterKey(
				PASSWORD,
				SECRET_KEY,
				EMAIL,
				PROFILE,
			);
			const twoStep = await port.deriveKeysFromMasterKey(masterKey, EMAIL);

			const sealed = await port.encrypt("plain", oneStep.masterUnlockKey, null);
			expect(await port.decrypt(sealed, twoStep.masterUnlockKey, null)).toBe(
				"plain",
			);
		});

		test("deriveKeysFromMasterKey binds the email", async () => {
			const port = await make();
			const masterKey = await port.deriveMasterKey(
				PASSWORD,
				SECRET_KEY,
				EMAIL,
				PROFILE,
			);

			const mine = await port.deriveKeysFromMasterKey(masterKey, EMAIL);
			const theirs = await port.deriveKeysFromMasterKey(
				masterKey,
				"someone-else@bittery.test",
			);

			const sealed = await port.encrypt("plain", mine.masterUnlockKey, null);
			await expectPortError(
				() => port.decrypt(sealed, theirs.masterUnlockKey, null),
				"decryption-failed",
			);
		});

		test("deriveSrpPassword is a non-empty string, stable per auth key", async () => {
			const port = await make();
			const first = await port.deriveKeys(PASSWORD, SECRET_KEY, EMAIL, PROFILE);
			const second = await port.deriveKeys(
				PASSWORD,
				SECRET_KEY,
				EMAIL,
				PROFILE,
			);

			const password = await port.deriveSrpPassword(first.authKey);

			expect(typeof password).toBe("string");
			expect(password.length).toBeGreaterThan(0);
			expect(await port.deriveSrpPassword(second.authKey)).toBe(password);
		});

		test("deriveSrpPassword rejects a destroyed auth key", async () => {
			const port = await make();
			const derived = await port.deriveKeys(
				PASSWORD,
				SECRET_KEY,
				EMAIL,
				PROFILE,
			);

			await port.destroyKey(derived.authKey);

			await expectPortError(
				() => port.deriveSrpPassword(derived.authKey),
				"key-destroyed",
			);
		});
	});

	// ==================================================================
	// Secret Key and Recovery Key
	// ==================================================================

	describe(`${name} — Secret Key and Recovery Key`, () => {
		test("a generated Secret Key validates and is distinct per call", async () => {
			const port = await make();

			const first = await port.generateSecretKey();
			const second = await port.generateSecretKey();

			expect(await port.validateSecretKey(first)).toBe(true);
			expect(first).not.toBe(second);
		});

		test("validateSecretKey answers false rather than throwing", async () => {
			const port = await make();

			expect(await port.validateSecretKey("")).toBe(false);
			expect(await port.validateSecretKey("not-a-secret-key")).toBe(false);
		});

		test("a generated Recovery Key validates and is distinct per call", async () => {
			const port = await make();

			const first = await port.generateRecoveryKey();
			const second = await port.generateRecoveryKey();

			expect(await port.validateRecoveryKey(first)).toBe(true);
			expect(first).not.toBe(second);
		});

		test("validateRecoveryKey answers false rather than throwing", async () => {
			const port = await make();

			expect(await port.validateRecoveryKey("")).toBe(false);
			expect(await port.validateRecoveryKey("R1-nope")).toBe(false);
		});

		test("a Secret Key is not a Recovery Key, and vice versa", async () => {
			const port = await make();

			expect(
				await port.validateRecoveryKey(await port.generateSecretKey()),
			).toBe(false);
			expect(
				await port.validateSecretKey(await port.generateRecoveryKey()),
			).toBe(false);
		});

		test("encryptMasterKey and decryptMasterKey round-trip", async () => {
			const port = await make();
			const recoveryKey = await port.generateRecoveryKey();
			const masterKey = await port.importKey(AWKWARD_KEY_BYTES);

			const restored = await port.decryptMasterKey(
				await port.encryptMasterKey(masterKey, recoveryKey, EMAIL),
				recoveryKey,
				EMAIL,
			);

			expect([...(await port.exportKey(restored))]).toEqual([
				...AWKWARD_KEY_BYTES,
			]);
		});

		test("the wrong Recovery Key does not decrypt the master key", async () => {
			const port = await make();
			const recoveryKey = await port.generateRecoveryKey();
			const otherRecoveryKey = await port.generateRecoveryKey();
			const masterKey = await port.generateEncryptionKey();

			const sealed = await port.encryptMasterKey(masterKey, recoveryKey, EMAIL);

			await expectPortError(
				() => port.decryptMasterKey(sealed, otherRecoveryKey, EMAIL),
				"decryption-failed",
			);
		});

		test("the email is bound into the recovery blob", async () => {
			const port = await make();
			const recoveryKey = await port.generateRecoveryKey();
			const masterKey = await port.generateEncryptionKey();

			const sealed = await port.encryptMasterKey(masterKey, recoveryKey, EMAIL);

			await expectPortError(
				() =>
					port.decryptMasterKey(
						sealed,
						recoveryKey,
						"someone-else@bittery.test",
					),
				"decryption-failed",
			);
		});
	});

	// ==================================================================
	// RSA
	// ==================================================================

	describe(`${name} — RSA`, () => {
		test("generateRsaKeyPair yields two distinct PEM strings", async () => {
			const port = await make();

			const pair = await port.generateRsaKeyPair();

			expect(pair.publicKey).toContain("-----BEGIN PUBLIC KEY-----");
			expect(pair.privateKey.length).toBeGreaterThan(0);
			expect(pair.publicKey).not.toBe(pair.privateKey);
			expect((await port.generateRsaKeyPair()).publicKey).not.toBe(
				pair.publicKey,
			);
		});

		test("rsaEncrypt and rsaDecrypt round-trip", async () => {
			const port = await make();
			const pair = await port.generateRsaKeyPair();

			const ciphertext = await port.rsaEncrypt(
				UNICODE_PLAINTEXT,
				pair.publicKey,
			);

			expect(await port.rsaDecrypt(ciphertext, pair.privateKey)).toBe(
				UNICODE_PLAINTEXT,
			);
		});

		test("a foreign private key does not decrypt", async () => {
			const port = await make();
			const pair = await port.generateRsaKeyPair();
			const other = await port.generateRsaKeyPair();

			const ciphertext = await port.rsaEncrypt("plain", pair.publicKey);

			await expectPortError(() =>
				port.rsaDecrypt(ciphertext, other.privateKey),
			);
		});

		test("an unusable PEM is reported, not swallowed", async () => {
			const port = await make();

			await expectPortError(() => port.rsaEncrypt("plain", "not a pem"));
		});

		test("an encrypted private key opens an RSA-wrapped symmetric key as a ref", async () => {
			const port = await make();
			const pair = await port.generateRsaKeyPair();
			const wrappingKey = await port.generateEncryptionKey();
			const encryptedPrivateKey = await port.encrypt(
				pair.privateKey,
				wrappingKey,
				null,
			);
			const ciphertext = await port.rsaEncrypt(
				encodeBase64(AWKWARD_KEY_BYTES),
				pair.publicKey,
			);

			const key = await port.decryptRsaWrappedKey(
				ciphertext,
				encryptedPrivateKey,
				wrappingKey,
				null,
			);

			expect([...(await port.exportKey(key))]).toEqual([...AWKWARD_KEY_BYTES]);
		});
	});

	// ==================================================================
	// Vault keys and rotation
	// ==================================================================

	describe(`${name} — vault keys and rotation`, () => {
		test("encryptVaultKeyForMember is RSA over the base64 vault key", async () => {
			const port = await make();
			const member = await port.generateRsaKeyPair();
			const vaultKey = await port.importKey(AWKWARD_KEY_BYTES);

			const wrapped = await port.encryptVaultKeyForMember(
				vaultKey,
				member.publicKey,
			);

			expect(await port.rsaDecrypt(wrapped, member.privateKey)).toBe(
				encodeBase64(AWKWARD_KEY_BYTES),
			);
		});

		test("encryptVaultKeyWithMuk emits a JSON envelope carrying the wrap context", async () => {
			const port = await make();
			const vaultKey = await port.generateEncryptionKey();
			const muk = await port.generateEncryptionKey();

			const wrapped = JSON.parse(
				await port.encryptVaultKeyWithMuk(
					vaultKey,
					muk,
					"vault-9",
					"user-9",
					7,
				),
			);

			expect(isBase64(wrapped.ciphertext)).toBe(true);
			expect(isBase64(wrapped.iv)).toBe(true);
			expect(wrapped.algorithm.length).toBeGreaterThan(0);
			expect(wrapped.context).toEqual({
				vaultId: "vault-9",
				userId: "user-9",
				keyVersion: 7,
				purpose: "vault-key-wrap",
			});
		});

		test("reEncryptItem keeps a bound item bound to the same context", async () => {
			const port = await make();
			const oldKey = await port.generateEncryptionKey();
			const newKey = await port.generateEncryptionKey();
			const sealed = await port.encrypt(
				UNICODE_PLAINTEXT,
				oldKey,
				itemContext("item-7"),
			);

			const reEncrypted = await port.reEncryptItem(
				{
					id: "item-7",
					encryptedData: sealed.ciphertext,
					encryptionIv: sealed.iv,
					encryptionAlgorithm: sealed.algorithm,
					context: itemContext("item-7"),
				},
				oldKey,
				newKey,
			);

			const rotated = {
				ciphertext: reEncrypted.encryptedData,
				iv: reEncrypted.encryptionIv,
				algorithm: sealed.algorithm,
			};
			expect(reEncrypted.itemId).toBe("item-7");
			expect(await port.decrypt(rotated, newKey, itemContext("item-7"))).toBe(
				UNICODE_PLAINTEXT,
			);
			await expectPortError(() => port.decrypt(rotated, newKey, null));
			await expectPortError(() =>
				port.decrypt(rotated, newKey, itemContext("item-8")),
			);
		});

		test("reEncryptItem rejects an item the old key cannot open", async () => {
			const port = await make();
			const oldKey = await port.generateEncryptionKey();
			const newKey = await port.generateEncryptionKey();
			const stranger = await port.generateEncryptionKey();
			const sealed = await port.encrypt(
				"plain",
				stranger,
				itemContext("item-7"),
			);

			await expectPortError(() =>
				port.reEncryptItem(
					{
						id: "item-7",
						encryptedData: sealed.ciphertext,
						encryptionIv: sealed.iv,
						encryptionAlgorithm: sealed.algorithm,
						context: itemContext("item-7"),
					},
					oldKey,
					newKey,
				),
			);
		});

		test("rewrapAttachmentKey preserves its attachment envelope context", async () => {
			const port = await make();
			const oldVaultKey = await port.generateEncryptionKey();
			const newVaultKey = await port.generateEncryptionKey();
			const context = {
				vaultId: "vault-1",
				entityId: "attachment-7",
				entityType: "attachment_key" as const,
				version: 2,
				userId: "user-1",
			};
			const attachmentKeyBase64 = encodeBase64(AWKWARD_KEY_BYTES);
			const nextContext = { ...context, version: context.version + 1 };
			const original = await port.encrypt(
				attachmentKeyBase64,
				oldVaultKey,
				context,
			);

			const rewrapped = await port.rewrapAttachmentKey(
				original,
				oldVaultKey,
				newVaultKey,
				context,
				nextContext,
			);

			expect(await port.decrypt(rewrapped, newVaultKey, nextContext)).toBe(
				attachmentKeyBase64,
			);
			await expectPortError(() =>
				port.decrypt(rewrapped, oldVaultKey, nextContext),
			);
			await expectPortError(() =>
				port.decrypt(rewrapped, newVaultKey, {
					...nextContext,
					entityId: "attachment-8",
				}),
			);
		});
	});

	// ==================================================================
	// SRP-6a
	// ==================================================================

	describe(`${name} — SRP-6a`, () => {
		test("generateSrpRegistration yields a salt and a verifier", async () => {
			const port = await make();

			const registration = await port.generateSrpRegistration(PASSWORD);

			expect(registration.salt.length).toBeGreaterThan(0);
			expect(registration.verifier.length).toBeGreaterThan(0);
			expect(registration.salt).not.toBe(registration.verifier);
			expect((await port.generateSrpRegistration(PASSWORD)).salt).not.toBe(
				registration.salt,
			);
		});

		test("generateClientEphemeral yields a distinct pair per call", async () => {
			const port = await make();

			const first = await port.generateClientEphemeral();
			const second = await port.generateClientEphemeral();

			expect(first.publicKey.length).toBeGreaterThan(0);
			expect(first.secret.length).toBeGreaterThan(0);
			expect(first.publicKey).not.toBe(first.secret);
			expect(first.secret).not.toBe(second.secret);
		});

		test("deriveClientSession is deterministic and depends on the password", async () => {
			const port = await make();
			const ephemeral = await port.generateClientEphemeral();
			const challenge = {
				salt: (await port.generateSrpRegistration(PASSWORD)).salt,
				serverPublicKey: (await port.generateClientEphemeral()).publicKey,
			};

			const session = await port.deriveClientSession(
				ephemeral.secret,
				challenge,
				PASSWORD,
			);
			const again = await port.deriveClientSession(
				ephemeral.secret,
				challenge,
				PASSWORD,
			);
			const wrongPassword = await port.deriveClientSession(
				ephemeral.secret,
				challenge,
				"a different password",
			);

			expect(session.key.length).toBeGreaterThan(0);
			expect(session.proof.length).toBeGreaterThan(0);
			expect(again).toEqual(session);
			expect(wrongPassword.proof).not.toBe(session.proof);
		});

		test("verifyServerSession rejects a proof the server did not produce", async () => {
			const port = await make();
			const ephemeral = await port.generateClientEphemeral();
			const session = await port.deriveClientSession(
				ephemeral.secret,
				{
					salt: (await port.generateSrpRegistration(PASSWORD)).salt,
					serverPublicKey: (await port.generateClientEphemeral()).publicKey,
				},
				PASSWORD,
			);

			await expectPortError(() =>
				port.verifyServerSession(
					ephemeral.publicKey,
					session,
					"0000000000000000000000000000000000000000000000000000000000000000",
				),
			);
		});
	});

	// ==================================================================
	// Passkey / WebAuthn
	// ==================================================================

	describe(`${name} — passkey`, () => {
		test("generatePasskeyKeypair yields distinct base64 halves", async () => {
			const port = await make();

			const keypair = await port.generatePasskeyKeypair();

			expect(isBase64(keypair.privateKey)).toBe(true);
			expect(isBase64(keypair.publicKeyCose)).toBe(true);
			expect(keypair.privateKey).not.toBe(keypair.publicKeyCose);
			expect((await port.generatePasskeyKeypair()).privateKey).not.toBe(
				keypair.privateKey,
			);
		});

		test("generatePasskeyCredentialId yields distinct base64 per call", async () => {
			const port = await make();

			const first = await port.generatePasskeyCredentialId();

			expect(isBase64(first)).toBe(true);
			expect(decodeBase64(first).length).toBeGreaterThan(0);
			expect(await port.generatePasskeyCredentialId()).not.toBe(first);
		});

		test("buildPasskeyAttestationObject returns bytes bound to its arguments", async () => {
			const port = await make();
			const keypair = await port.generatePasskeyKeypair();
			const credentialId = await port.generatePasskeyCredentialId();

			const attestation = await port.buildPasskeyAttestationObject(
				"bittery.test",
				credentialId,
				keypair.publicKeyCose,
				0,
			);
			const elsewhere = await port.buildPasskeyAttestationObject(
				"other.test",
				credentialId,
				keypair.publicKeyCose,
				0,
			);

			expect(attestation.authenticatorData).toBeInstanceOf(Uint8Array);
			expect(attestation.attestationObject).toBeInstanceOf(Uint8Array);
			expect(attestation.authenticatorData.length).toBeGreaterThan(0);
			expect(attestation.attestationObject.length).toBeGreaterThan(0);
			expect([...elsewhere.authenticatorData]).not.toEqual([
				...attestation.authenticatorData,
			]);
		});

		test("signPasskeyAssertion returns bytes bound to the sign count", async () => {
			const port = await make();
			const keypair = await port.generatePasskeyKeypair();
			const clientDataHash = await port.generatePasskeyCredentialId();

			const first = await port.signPasskeyAssertion(
				keypair.privateKey,
				"bittery.test",
				clientDataHash,
				1,
			);
			const second = await port.signPasskeyAssertion(
				keypair.privateKey,
				"bittery.test",
				clientDataHash,
				2,
			);

			expect(first.authenticatorData).toBeInstanceOf(Uint8Array);
			expect(first.signatureDer).toBeInstanceOf(Uint8Array);
			expect(first.signatureDer.length).toBeGreaterThan(0);
			expect([...second.authenticatorData]).not.toEqual([
				...first.authenticatorData,
			]);
		});

		test("signPasskeyAssertion reports an unusable private key", async () => {
			const port = await make();
			const clientDataHash = await port.generatePasskeyCredentialId();

			await expectPortError(() =>
				port.signPasskeyAssertion(
					"!!! not base64 !!!",
					"bittery.test",
					clientDataHash,
					1,
				),
			);
		});
	});

	// ==================================================================
	// One-time codes
	// ==================================================================

	describe(`${name} — TOTP`, () => {
		test("generateTotp matches the RFC 6238 vectors at T = 59s", async () => {
			const port = await make();

			const codes = await atUnixTime(TOTP_T59_MS, async () => [
				(await port.generateTotp(TOTP_SEED_SHA1, "SHA1", 8, TOTP_PERIOD)).code,
				(await port.generateTotp(TOTP_SEED_SHA256, "SHA256", 8, TOTP_PERIOD))
					.code,
				(await port.generateTotp(TOTP_SEED_SHA512, "SHA512", 8, TOTP_PERIOD))
					.code,
			]);

			expect(codes).toEqual(["94287082", "46119246", "90693936"]);
		});

		test("generateTotp truncates one window to the requested digit count", async () => {
			const port = await make();

			const codes = await atUnixTime(TOTP_T59_MS, async () => [
				(await port.generateTotp(TOTP_SEED_SHA1, "SHA1", 6, TOTP_PERIOD)).code,
				(await port.generateTotp(TOTP_SEED_SHA1, "SHA1", 7, TOTP_PERIOD)).code,
				(await port.generateTotp(TOTP_SEED_SHA1, "SHA1", 8, TOTP_PERIOD)).code,
			]);

			expect(codes).toEqual(["287082", "4287082", "94287082"]);
		});

		test("generateTotp reads the hash name case-insensitively", async () => {
			const port = await make();

			const code = await atUnixTime(
				TOTP_T59_MS,
				async () =>
					(await port.generateTotp(TOTP_SEED_SHA256, "sha256", 8, TOTP_PERIOD))
						.code,
			);

			expect(code).toBe("46119246");
		});

		test("generateTotp reports where the code sits in its window", async () => {
			const port = await make();

			const late = await atUnixTime(TOTP_T59_MS, () =>
				port.generateTotp(TOTP_SEED_SHA1, "SHA1", 6, TOTP_PERIOD),
			);
			const fresh = await atUnixTime(60_000, () =>
				port.generateTotp(TOTP_SEED_SHA1, "SHA1", 6, TOTP_PERIOD),
			);

			expect(late.period).toBe(TOTP_PERIOD);
			expect(late.remainingSeconds).toBe(1);
			expect(late.progress).toBeCloseTo((29 / 30) * 100, 5);
			// A new window: full countdown, nothing elapsed, and a different code.
			expect(fresh.remainingSeconds).toBe(TOTP_PERIOD);
			expect(fresh.progress).toBe(0);
			expect(fresh.code).not.toBe(late.code);
		});

		test("generateTotp is stable within one window and moves between them", async () => {
			const port = await make();

			const early = await atUnixTime(30_000, () =>
				port.generateTotp(TOTP_SEED_SHA1, "SHA1", 8, TOTP_PERIOD),
			);
			const later = await atUnixTime(TOTP_T59_MS, () =>
				port.generateTotp(TOTP_SEED_SHA1, "SHA1", 8, TOTP_PERIOD),
			);
			const next = await atUnixTime(60_000, () =>
				port.generateTotp(TOTP_SEED_SHA1, "SHA1", 8, TOTP_PERIOD),
			);

			expect(early.code).toBe(later.code);
			expect(next.code).not.toBe(later.code);
		});

		test("generateTotp rejects arguments the core will not accept", async () => {
			const port = await make();

			await expectPortError(
				() => port.generateTotp(TOTP_SEED_SHA1, "SHA1", 5, TOTP_PERIOD),
				"invalid-input",
			);
			await expectPortError(
				() => port.generateTotp(TOTP_SEED_SHA1, "SHA1", 9, TOTP_PERIOD),
				"invalid-input",
			);
			await expectPortError(
				() => port.generateTotp(TOTP_SEED_SHA1, "SHA1", 6, 0),
				"invalid-input",
			);
			await expectPortError(
				() => port.generateTotp("ABC!DEF", "SHA1", 6, TOTP_PERIOD),
				"invalid-input",
			);
		});
	});

	// ==================================================================
	// Identifiers
	// ==================================================================

	describe(`${name} — identifiers`, () => {
		test("generateUuid returns a distinct v4 uuid per call", async () => {
			const port = await make();

			const first = await port.generateUuid();
			const second = await port.generateUuid();

			expect(first).toMatch(UUID_V4);
			expect(second).toMatch(UUID_V4);
			expect(first).not.toBe(second);
		});
	});
}
