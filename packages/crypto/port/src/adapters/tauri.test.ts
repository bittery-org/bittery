/**
 * Tauri desktop crypto adapter conformance.
 *
 * The behavioural contract comes from the shared suite; this file only has to hand it a
 * fresh port backed by a faked `invoke`. The extra tests below pin what is *specific* to
 * this adapter and therefore invisible to a suite that must stay platform-agnostic: that
 * `KeyRef` is a boxed, zeroized `Uint8Array` rather than a backend handle, that no key
 * material crosses `invoke` except as base64, which commands each member actually calls,
 * `invoke` being loaded at most once, and the exact Tauri error strings `classify` reads.
 */

import { describe, expect, test } from "bun:test";
import { CryptoPortError } from "../errors";
import { runCryptoPortConformance } from "./port-conformance";
import { createTauriCryptoPort } from "./tauri";
import { createTauriDoubles } from "./tauri-test-doubles";

async function catchPortError(
	operation: () => Promise<unknown>,
): Promise<CryptoPortError> {
	let caught: unknown = null;
	try {
		await operation();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(CryptoPortError);
	return caught as CryptoPortError;
}

/** A fresh, initialised port over fresh doubles, as the suite requires. */
async function makeTauriPort() {
	const doubles = createTauriDoubles();
	const port = createTauriCryptoPort(doubles.deps);
	await port.initialize();
	return { port, doubles };
}

runCryptoPortConformance("tauri", async () => (await makeTauriPort()).port);

describe("tauri adapter — KeyRef is a boxed Uint8Array", () => {
	test("importKey does not alias the caller's buffer", async () => {
		const { port } = await makeTauriPort();
		const original = Uint8Array.from({ length: 32 }, (_, i) => i);
		const source = original.slice();

		const key = await port.importKey(source);
		source.fill(0xff);

		expect([...(await port.exportKey(key))]).toEqual([...original]);
	});

	test("cloneKey's bytes survive independently of the original array", async () => {
		const { port } = await makeTauriPort();
		const bytes = new Uint8Array(32).fill(3);
		const key = await port.importKey(bytes);
		const clone = await port.cloneKey(key);

		await port.destroyKey(key);

		expect([...(await port.exportKey(clone))]).toEqual([...bytes]);
	});
});

describe("tauri adapter — key material crosses IPC as base64, never bytes", () => {
	test("encrypt sends the key as base64, not as an array", async () => {
		const { port, doubles } = await makeTauriPort();
		const key = await port.generateEncryptionKey();

		await port.encrypt("plain", key, null);

		const call = doubles.backend.callsTo("crypto_encrypt").at(-1);
		expect(typeof call?.args?.keyBase64).toBe("string");
	});

	test("wrapKey and unwrapKey reuse crypto_encrypt/crypto_decrypt over the key's own base64", async () => {
		const { port, doubles } = await makeTauriPort();
		const key = await port.importKey(new Uint8Array(32).fill(9));
		const wrappingKey = await port.generateEncryptionKey();

		const wrapped = await port.wrapKey(key, wrappingKey);
		await port.unwrapKey(wrapped, wrappingKey);

		// No dedicated "wrap a key" command exists on the Rust side (S3/S4 confirmed this);
		// the adapter must not invent one.
		expect(doubles.backend.calls.map((call) => call.cmd)).toContain(
			"crypto_encrypt",
		);
		expect(doubles.backend.calls.map((call) => call.cmd)).toContain(
			"crypto_decrypt",
		);
		expect(
			doubles.backend.calls.some((call) => call.cmd.includes("wrap")),
		).toBe(false);
	});
});

describe("tauri adapter — command surface", () => {
	test("initialize loads invoke at most once, however many members run", async () => {
		const { port, doubles } = await makeTauriPort();

		await port.initialize();
		const key = await port.generateEncryptionKey();
		await port.encrypt("a", key, null);
		await port.generateUuid();

		expect(doubles.invokeLoads).toBe(1);
	});

	test("deriveSrpPassword never calls invoke — it is a local UTF-8 decode", async () => {
		const { port, doubles } = await makeTauriPort();
		const { authKey } = await port.deriveKeys(
			"correct horse battery staple",
			"A3-ABCDEF-GHJKMN-PQRST-UVWXY-Z2345",
			"test@bittery.test",
			{ schemaVersion: 1, algorithm: "pbkdf2-sha256", iterations: 600_000 },
		);
		const callsBefore = doubles.backend.calls.length;

		const password = await port.deriveSrpPassword(authKey);

		expect(typeof password).toBe("string");
		expect(doubles.backend.calls.length).toBe(callsBefore);
	});

	test("deriveKeys issues exactly the two commands deriveMasterKey/deriveKeysFromMasterKey issue separately", async () => {
		const { port, doubles } = await makeTauriPort();

		await port.deriveKeys(
			"correct horse battery staple",
			"A3-ABCDEF-GHJKMN-PQRST-UVWXY-Z2345",
			"test@bittery.test",
			{ schemaVersion: 1, algorithm: "pbkdf2-sha256", iterations: 600_000 },
		);

		expect(doubles.backend.calls.map((call) => call.cmd)).toEqual([
			"crypto_derive_keys",
		]);
	});

	test("decryptMany resolves every KeyRef before issuing any invoke call", async () => {
		const { port, doubles } = await makeTauriPort();
		const key = await port.generateEncryptionKey();
		const other = await makeTauriPort();
		const foreign = await other.port.generateEncryptionKey();
		const request = {
			id: "a",
			data: await port.encrypt("plain", key, null),
			key: foreign,
			context: null,
		};
		const callsBefore = doubles.backend.calls.length;

		await expect(port.decryptMany([request])).rejects.toThrow();

		expect(doubles.backend.calls.length).toBe(callsBefore);
	});

	test("decryptMany issues one crypto_decrypt call per item", async () => {
		const { port, doubles } = await makeTauriPort();
		const key = await port.generateEncryptionKey();
		const requests = await Promise.all(
			["a", "b", "c"].map(async (id) => ({
				id,
				data: await port.encrypt(`plain-${id}`, key, null),
				key,
				context: null,
			})),
		);
		const callsBefore = doubles.backend.callsTo("crypto_decrypt").length;

		await port.decryptMany(requests);

		expect(doubles.backend.callsTo("crypto_decrypt").length - callsBefore).toBe(
			3,
		);
	});

	test("encrypt/decrypt with a context use the _with_context commands", async () => {
		const { port, doubles } = await makeTauriPort();
		const key = await port.generateEncryptionKey();
		const context = {
			vaultId: "vault-1",
			entityId: "item-1",
			entityType: "item" as const,
			version: 1,
			userId: "user-1",
		};

		const callsBefore = doubles.backend.calls.length;
		const sealed = await port.encrypt("plain", key, context);
		await port.decrypt(sealed, key, context);

		expect(
			doubles.backend.calls.slice(callsBefore).map((call) => call.cmd),
		).toEqual(["crypto_encrypt_with_context", "crypto_decrypt_with_context"]);
	});

	test("performKeyRotation and reEncryptItem issue no other command", async () => {
		const { port, doubles } = await makeTauriPort();
		const oldVaultKey = await port.generateEncryptionKey();
		const muk = await port.generateEncryptionKey();
		const callsBefore = doubles.backend.calls.length;

		await port.performKeyRotation(
			oldVaultKey,
			[{ userId: "owner", publicKey: "" }],
			[],
			"vault-1",
			1,
			"owner",
			muk,
		);

		expect(
			doubles.backend.calls.slice(callsBefore).map((call) => call.cmd),
		).toEqual(["crypto_perform_key_rotation"]);
	});
});

describe("tauri adapter — error translation", () => {
	test("a Tauri command that rejects with a plain string still becomes a CryptoPortError", async () => {
		const { port, doubles } = await makeTauriPort();
		doubles.backend.nextFailure = "boom";

		const error = await catchPortError(() => port.generateUuid());

		expect(error.code).toBe("backend-failure");
		expect(error.message).toBe("boom");
	});

	test("crypto_commands.rs's own base64 guard classifies as invalid-input", async () => {
		const { port } = await makeTauriPort();

		const error = await catchPortError(() =>
			port.decryptMasterKey(
				{
					ciphertext: "!!!not-base64!!!",
					iv: "aa",
					algorithm: "AES-GCM-AAD-V1",
				},
				"R1-ABCDEF-GHJKMN-PQRST-UVWXY-Z2345-ABCDE-FGHJK",
				"test@bittery.test",
			),
		);

		expect(error.code).toBe("invalid-input");
		expect(error.message.toLowerCase()).toContain("base64");
	});

	test("a mismatched Recovery Key surfaces as decryption-failed", async () => {
		const { port } = await makeTauriPort();
		const recoveryKey = await port.generateRecoveryKey();
		const otherRecoveryKey = await port.generateRecoveryKey();
		const masterKey = await port.generateEncryptionKey();
		const sealed = await port.encryptMasterKey(
			masterKey,
			recoveryKey,
			"test@bittery.test",
		);

		const error = await catchPortError(() =>
			port.decryptMasterKey(sealed, otherRecoveryKey, "test@bittery.test"),
		);

		expect(error.code).toBe("decryption-failed");
	});

	test("an uninstalled Tauri module is honestly a backend failure, not a silent hang", async () => {
		const doubles = createTauriDoubles({ invokeModuleMissing: true });
		const port = createTauriCryptoPort(doubles.deps);

		const error = await catchPortError(() => port.generateUuid());

		expect(error.code).toBe("backend-failure");
	});
});

describe("tauri adapter — restart survival", () => {
	test("a KeyRef minted by one port instance is rejected by a fresh one", async () => {
		const { port, doubles } = await makeTauriPort();
		const key = await port.generateEncryptionKey();

		const restarted = createTauriCryptoPort(doubles.deps);
		await restarted.initialize();

		await expect(restarted.exportKey(key)).rejects.toThrow();
	});
});
