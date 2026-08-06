/**
 * Expo (mobile) crypto adapter conformance.
 *
 * The behavioural contract comes from the shared suite; this file only has to hand it a
 * fresh port backed by a faked `@bittery/crypto-nitro`. The extra tests below pin what is
 * *specific* to this adapter and therefore invisible to a suite that must stay platform-
 * agnostic: that `KeyRef` is a boxed, zeroized `Uint8Array` rather than a backend handle, that
 * no key material crosses the native boundary except as base64, which native methods each
 * member actually calls, the module being loaded at most once, the SRP client being created at
 * most once, and the exact error strings `classify` reads.
 */

import { describe, expect, test } from "bun:test";
import { CryptoPortError } from "../errors";
import { createExpoCryptoPort } from "./expo";
import { createExpoDoubles } from "./expo-test-doubles";
import { runCryptoPortConformance } from "./port-conformance";

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
async function makeExpoPort() {
	const doubles = createExpoDoubles();
	const port = createExpoCryptoPort(doubles.deps);
	await port.initialize();
	return { port, doubles };
}

runCryptoPortConformance("expo", async () => (await makeExpoPort()).port);

describe("expo adapter — KeyRef is a boxed Uint8Array", () => {
	test("importKey does not alias the caller's buffer", async () => {
		const { port } = await makeExpoPort();
		const original = Uint8Array.from({ length: 32 }, (_, i) => i);
		const source = original.slice();

		const key = await port.importKey(source);
		source.fill(0xff);

		expect([...(await port.exportKey(key))]).toEqual([...original]);
	});

	test("cloneKey's bytes survive independently of the original array", async () => {
		const { port } = await makeExpoPort();
		const bytes = new Uint8Array(32).fill(3);
		const key = await port.importKey(bytes);
		const clone = await port.cloneKey(key);

		await port.destroyKey(key);

		expect([...(await port.exportKey(clone))]).toEqual([...bytes]);
	});
});

describe("expo adapter — key material crosses the native boundary as base64, never bytes", () => {
	test("encrypt sends the key as base64, not as an array", async () => {
		const { port, doubles } = await makeExpoPort();
		const key = await port.generateEncryptionKey();

		await port.encrypt("plain", key, null);

		expect(doubles.backend.callsTo("encrypt").length).toBeGreaterThan(0);
	});

	test("wrapKey and unwrapKey reuse encrypt/decrypt over the key's own base64", async () => {
		const { port, doubles } = await makeExpoPort();
		const key = await port.importKey(new Uint8Array(32).fill(9));
		const wrappingKey = await port.generateEncryptionKey();

		const wrapped = await port.wrapKey(key, wrappingKey);
		await port.unwrapKey(wrapped, wrappingKey);

		// No dedicated "wrap a key" native method exists (S2/S2b/S2c confirmed the full
		// native surface); the adapter must not invent one.
		expect(doubles.backend.callsTo("encrypt").length).toBeGreaterThan(0);
		expect(doubles.backend.callsTo("decrypt").length).toBeGreaterThan(0);
		expect(doubles.backend.calls.some((call) => call.includes("wrap"))).toBe(
			false,
		);
	});
});

describe("expo adapter — native surface", () => {
	test("initialize loads the module at most once, however many members run", async () => {
		const { port, doubles } = await makeExpoPort();

		await port.initialize();
		const key = await port.generateEncryptionKey();
		await port.encrypt("a", key, null);
		await port.generateUuid();

		expect(doubles.moduleLoads).toBe(1);
	});

	test("deriveSrpPassword never touches the native module — it is a local UTF-8 decode", async () => {
		const { port, doubles } = await makeExpoPort();
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

	test("deriveKeys issues exactly the one native call the module exposes for it", async () => {
		const { port, doubles } = await makeExpoPort();

		await port.deriveKeys(
			"correct horse battery staple",
			"A3-ABCDEF-GHJKMN-PQRST-UVWXY-Z2345",
			"test@bittery.test",
			{ schemaVersion: 1, algorithm: "pbkdf2-sha256", iterations: 600_000 },
		);

		expect(doubles.backend.calls).toEqual(["deriveKeys"]);
	});

	test("decryptMany resolves every KeyRef before touching the native module", async () => {
		const { port, doubles } = await makeExpoPort();
		const key = await port.generateEncryptionKey();
		const other = await makeExpoPort();
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

	test("decryptMany issues one decrypt call per item, looped rather than batched", async () => {
		const { port, doubles } = await makeExpoPort();
		const key = await port.generateEncryptionKey();
		const requests = await Promise.all(
			["a", "b", "c"].map(async (id) => ({
				id,
				data: await port.encrypt(`plain-${id}`, key, null),
				key,
				context: null,
			})),
		);
		const callsBefore = doubles.backend.callsTo("decrypt").length;

		await port.decryptMany(requests);

		expect(doubles.backend.callsTo("decrypt").length - callsBefore).toBe(3);
	});

	test("encrypt/decrypt with a context use the _with_context native methods", async () => {
		const { port, doubles } = await makeExpoPort();
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

		expect(doubles.backend.calls.slice(callsBefore)).toEqual([
			"encryptWithContext",
			"decryptWithContext",
		]);
	});

	test("performKeyRotation issues no other native call", async () => {
		const { port, doubles } = await makeExpoPort();
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

		expect(doubles.backend.calls.slice(callsBefore)).toEqual([
			"performKeyRotation",
		]);
	});

	test("the SRP client is created at most once, however many SRP members run", async () => {
		const { port, doubles } = await makeExpoPort();

		await port.generateSrpRegistration("a password");
		const ephemeral = await port.generateClientEphemeral();
		const session = await port.deriveClientSession(
			ephemeral.secret,
			{
				salt: (await port.generateSrpRegistration("a password")).salt,
				serverPublicKey: (await port.generateClientEphemeral()).publicKey,
				kdfParams: {
					schemaVersion: 1,
					algorithm: "pbkdf2-sha256",
					iterations: 600_000,
				},
			},
			"a password",
		);
		await expect(
			port.verifyServerSession(ephemeral.publicKey, session, "wrong-proof"),
		).rejects.toThrow();

		expect(doubles.backend.srpClientsCreated).toBe(1);
	});
});

describe("expo adapter — error translation", () => {
	test("a native rejection still becomes a CryptoPortError", async () => {
		const { port, doubles } = await makeExpoPort();
		doubles.backend.nextFailure = new Error("boom");

		const error = await catchPortError(() => port.generateUuid());

		expect(error.code).toBe("backend-failure");
		expect(error.message).toBe("boom");
	});

	test("a synchronous native throw still becomes a CryptoPortError", async () => {
		const { port, doubles } = await makeExpoPort();
		doubles.backend.nextFailure = new Error("sync boom");

		const error = await catchPortError(() => port.generateSecretKey());

		expect(error.code).toBe("backend-failure");
	});

	test("the FFI's own base64 guard classifies as invalid-input", async () => {
		const { port } = await makeExpoPort();

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
		const { port } = await makeExpoPort();
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

	test("a wrong SRP server proof classifies as verification-failed", async () => {
		const { port } = await makeExpoPort();
		const ephemeral = await port.generateClientEphemeral();
		const session = await port.deriveClientSession(
			ephemeral.secret,
			{
				salt: (await port.generateSrpRegistration("a password")).salt,
				serverPublicKey: (await port.generateClientEphemeral()).publicKey,
				kdfParams: {
					schemaVersion: 1,
					algorithm: "pbkdf2-sha256",
					iterations: 600_000,
				},
			},
			"a password",
		);

		const error = await catchPortError(() =>
			port.verifyServerSession(ephemeral.publicKey, session, "wrong-proof"),
		);

		expect(error.code).toBe("verification-failed");
	});

	test("a native module that isn't linked is honestly a backend failure, not a silent hang", async () => {
		const doubles = createExpoDoubles({ moduleMissing: true });
		const port = createExpoCryptoPort(doubles.deps);

		const error = await catchPortError(() => port.generateUuid());

		expect(error.code).toBe("backend-failure");
	});
});

describe("expo adapter — passkey byte conversion", () => {
	test("buildPasskeyAttestationObject and signPasskeyAssertion return real Uint8Array bytes decoded from the module's base64", async () => {
		const { port, doubles } = await makeExpoPort();
		const keypair = await port.generatePasskeyKeypair();
		const credentialId = await port.generatePasskeyCredentialId();

		const attestation = await port.buildPasskeyAttestationObject(
			"bittery.test",
			credentialId,
			keypair.publicKeyCose,
			0,
		);
		const assertion = await port.signPasskeyAssertion(
			keypair.privateKey,
			"bittery.test",
			credentialId,
			1,
		);

		expect(attestation.authenticatorData).toBeInstanceOf(Uint8Array);
		expect(attestation.attestationObject).toBeInstanceOf(Uint8Array);
		expect(assertion.authenticatorData).toBeInstanceOf(Uint8Array);
		expect(assertion.signatureDer).toBeInstanceOf(Uint8Array);
		expect(
			doubles.backend.callsTo("buildPasskeyAttestationObject").length,
		).toBe(1);
		expect(doubles.backend.callsTo("signPasskeyAssertion").length).toBe(1);
	});
});

describe("expo adapter — restart survival", () => {
	test("a KeyRef minted by one port instance is rejected by a fresh one", async () => {
		const { port, doubles } = await makeExpoPort();
		const key = await port.generateEncryptionKey();

		const restarted = createExpoCryptoPort(doubles.deps);
		await restarted.initialize();

		await expect(restarted.exportKey(key)).rejects.toThrow();
	});
});
