import { describe, expect, test } from "bun:test";
import { CryptoError } from "@bittery/crypto-wasm";
import { CryptoPortError } from "../errors";
import type { KdfProfile } from "../types";
import { runCryptoPortConformance } from "./port-conformance";
import {
	createWasmWorkerCryptoPort,
	createWasmWorkerOwner,
} from "./wasm-worker";
import {
	createWasmWorkerDoubles,
	type WasmWorkerDoublesOptions,
} from "./wasm-worker-test-doubles";

const PROFILE: KdfProfile = {
	schemaVersion: 1,
	algorithm: "pbkdf2-sha256",
	iterations: 600_000,
};

const PASSWORD = "correct horse battery staple";
const SECRET_KEY = "A3-ABCDEF-GHJKMN-PQRST-UVWXY-Z2345";
const EMAIL = "worker@bittery.test";

/** A fresh, initialised port over fresh doubles, as the suite requires. */
async function makePort(options?: WasmWorkerDoublesOptions) {
	const doubles = createWasmWorkerDoubles(options);
	const port = createWasmWorkerCryptoPort(doubles.deps);
	await port.initialize();
	return { port, doubles };
}

runCryptoPortConformance("wasm-worker", async () => (await makePort()).port);

/** Every `Uint8Array` anywhere inside a message, however deeply nested. */
function bytesIn(value: unknown): Uint8Array[] {
	if (value instanceof Uint8Array) {
		return [value];
	}
	if (Array.isArray(value)) {
		return value.flatMap(bytesIn);
	}
	if (typeof value === "object" && value !== null) {
		return Object.values(value).flatMap(bytesIn);
	}
	return [];
}

/** Every string anywhere inside a message, including encrypted-data objects. */
function stringsIn(value: unknown): string[] {
	if (typeof value === "string") {
		return [value];
	}
	if (Array.isArray(value)) {
		return value.flatMap(stringsIn);
	}
	if (typeof value === "object" && value !== null) {
		return Object.values(value).flatMap(stringsIn);
	}
	return [];
}

/** Let every queued microtask and the worker's own awaits run to completion. */
async function settle(): Promise<void> {
	await new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

describe("wasm-worker adapter — the thread boundary", () => {
	test("accepts the shared owner's injected crypto channel", async () => {
		const doubles = createWasmWorkerDoubles();
		const owner = createWasmWorkerOwner(doubles.deps);
		const port = createWasmWorkerCryptoPort(owner.channel("crypto"));

		await port.initialize();
		expect(await port.generateUuid()).toMatch(/^[0-9a-f-]{36}$/);
		expect(doubles.worker.callsTo("initialize")).toEqual([
			{ method: "initialize", args: [] },
		]);
		expect(doubles.workersCreated).toBe(1);
	});

	test("boots one worker and loads WASM once, however many calls it serves", async () => {
		const { port, doubles } = await makePort();

		await port.initialize();
		await port.generateUuid();
		const key = await port.generateEncryptionKey();
		await port.encrypt("plain", key, null);

		expect(doubles.workersCreated).toBe(1);
		expect(doubles.wasmLoads).toBe(1);
	});

	test("a KeyRef is translated into a worker handle on the way in", async () => {
		const { port, doubles } = await makePort();
		const key = await port.generateEncryptionKey();

		await port.encrypt("plain", key, null);

		const [call] = doubles.worker.callsTo("encrypt");
		expect(call?.args).toEqual(["plain", { __bitteryWorkerKey: 0 }, null]);
	});

	test("a key nested inside an argument is translated too", async () => {
		const { port, doubles } = await makePort();
		const key = await port.generateEncryptionKey();
		const data = await port.encrypt("plain", key, null);

		await port.decryptMany([{ id: "a", data, key, context: null }]);

		const [call] = doubles.worker.callsTo("decryptMany");
		expect(call?.args).toEqual([
			[
				{
					id: "a",
					data,
					key: { __bitteryWorkerKey: 0 },
					context: null,
				},
			],
		]);
	});

	test("a returned handle is minted into a distinct KeyRef", async () => {
		const { port, doubles } = await makePort();

		const first = await port.generateEncryptionKey();
		const second = await port.generateEncryptionKey();

		expect(first).not.toBe(second);
		expect(
			doubles.worker.replies
				.filter((reply) => reply.method === "generateEncryptionKey")
				.map((reply) => (reply.ok ? reply.value : null)),
		).toEqual([{ __bitteryWorkerKey: 0 }, { __bitteryWorkerKey: 1 }]);
	});

	test("no message carries key bytes except importKey's call and exportKey's answer", async () => {
		const { port, doubles } = await makePort();

		const derived = await port.deriveKeys(PASSWORD, SECRET_KEY, EMAIL, PROFILE);
		const vaultKey = await port.importKey(new Uint8Array(32).fill(7));
		const sealed = await port.encrypt("secret", vaultKey, null);
		await port.decrypt(sealed, vaultKey, null);
		const wrapped = await port.wrapKey(vaultKey, derived.masterUnlockKey, null);
		await port.unwrapKey(wrapped, derived.masterUnlockKey, null);
		await port.encryptVaultKeyWithMuk(
			vaultKey,
			derived.masterUnlockKey,
			"vault-1",
			"user-1",
			1,
		);
		await port.exportKey(vaultKey);
		await port.destroyKey(vaultKey);

		expect(
			doubles.worker.calls
				.filter((call) => bytesIn(call.args).length > 0)
				.map((call) => call.method),
		).toEqual(["importKey"]);
		expect(
			doubles.worker.replies
				.filter((reply) => reply.ok && bytesIn(reply.value).length > 0)
				.map((reply) => reply.method),
		).toEqual(["exportKey"]);
	});

	test("vault-key unwrap replies carry only handles", async () => {
		const { port, doubles } = await makePort();
		const pair = await port.generateRsaKeyPair();
		const muk = await port.generateEncryptionKey();
		const vaultKey = await port.importKey(new Uint8Array(32).fill(23));
		const ownerEnvelope = JSON.parse(
			await port.encryptVaultKeyWithMuk(
				vaultKey,
				muk,
				"vault-opaque",
				"user-opaque",
				1,
			),
		);
		const ownerContext = {
			vaultId: "vault-opaque",
			entityId: "vault-key-wrap",
			entityType: "vault_key" as const,
			version: 1,
			userId: "user-opaque",
		};
		await port.unwrapKey(ownerEnvelope, muk, ownerContext);

		const encryptedPrivateKey = await port.encrypt(pair.privateKey, muk, null);
		const memberEnvelope = await port.encryptVaultKeyForMember(
			vaultKey,
			pair.publicKey,
		);
		await port.decryptRsaWrappedKey(
			memberEnvelope,
			encryptedPrivateKey,
			muk,
			null,
		);

		for (const method of ["unwrapKey", "decryptRsaWrappedKey"] as const) {
			const replies = doubles.worker.replies.filter(
				(reply) => reply.method === method,
			);
			expect(replies).toHaveLength(1);
			expect(replies[0]).toMatchObject({ ok: true });
			expect(replies[0]).toMatchObject({
				ok: true,
				value: { __bitteryWorkerKey: expect.any(Number) },
			});
		}

		const compositeCall = doubles.worker.callsTo("decryptRsaWrappedKey")[0];
		expect(stringsIn(compositeCall?.args)).not.toContain(pair.privateKey);
		expect(bytesIn(compositeCall?.args).length).toBe(0);
	});

	test("a foreign KeyRef is rejected before anything is posted", async () => {
		const { port, doubles } = await makePort();
		const { port: other } = await makePort();
		const foreign = await other.generateEncryptionKey();
		const before = doubles.worker.calls.length;

		await expect(port.encrypt("plain", foreign, null)).rejects.toMatchObject({
			code: "invalid-key-ref",
		});

		expect(doubles.worker.calls.length).toBe(before);
	});

	test("destroyKey retires the ref here and zeroizes the handle there", async () => {
		const { port, doubles } = await makePort();
		const key = await port.generateEncryptionKey();
		expect(doubles.wasm.liveHandleCount).toBe(1);

		await port.destroyKey(key);

		expect(doubles.wasm.liveHandleCount).toBe(0);
		expect(doubles.worker.callsTo("destroyKey")).toHaveLength(1);
	});

	test("destroying twice posts nothing the second time", async () => {
		const { port, doubles } = await makePort();
		const key = await port.generateEncryptionKey();

		await port.destroyKey(key);
		await port.destroyKey(key);

		expect(doubles.worker.callsTo("destroyKey")).toHaveLength(1);
	});
});

describe("wasm-worker adapter — the double itself", () => {
	test("distinct derivations produce distinct keys, not one of 256", async () => {
		const { port } = await makePort();
		const derived = new Set<string>();

		for (let index = 0; index < 512; index++) {
			const masterKey = await port.deriveMasterKey(
				`${PASSWORD}-${index}`,
				SECRET_KEY,
				EMAIL,
				PROFILE,
			);
			derived.add([...(await port.exportKey(masterKey))].join(","));
		}

		expect(derived.size).toBe(512);
	});
});

describe("wasm-worker adapter — round trips", () => {
	test("decryptMany decrypts a whole item list in one round trip", async () => {
		const { port, doubles } = await makePort();
		const key = await port.generateEncryptionKey();
		const requests = await Promise.all(
			Array.from({ length: 25 }, async (_unused, index) => ({
				id: `item-${index}`,
				data: await port.encrypt(`plain-${index}`, key, null),
				key,
				context: null,
			})),
		);
		const before = doubles.worker.calls.length;

		const results = await port.decryptMany(requests);

		expect(results).toHaveLength(25);
		expect(doubles.worker.calls.length - before).toBe(1);
	});

	test("concurrent calls are matched by id, not by the order answers arrive", async () => {
		const { port, doubles } = await makePort();
		const answered = doubles.worker.replies.length;
		doubles.worker.holdReplies = true;

		const uuid = port.generateUuid();
		const secretKey = port.generateSecretKey();
		const recoveryKey = port.generateRecoveryKey();
		await settle();
		expect(doubles.worker.replies.length - answered).toBe(3);
		doubles.worker.releaseHeldReplies("reverse");

		expect(await port.validateSecretKey(await secretKey)).toBe(true);
		expect(await port.validateRecoveryKey(await recoveryKey)).toBe(true);
		expect(await uuid).toMatch(/^[0-9a-f-]{36}$/);
	});
});

describe("wasm-worker adapter — failure", () => {
	test("a worker that dies rejects every call in flight", async () => {
		const { port, doubles } = await makePort();
		doubles.worker.holdReplies = true;
		const inFlight = port.generateUuid();
		await settle();

		doubles.worker.fail("Worker terminated unexpectedly");

		await expect(inFlight).rejects.toMatchObject({
			code: "backend-failure",
			message: "Worker terminated unexpectedly",
		});
		await expect(port.generateUuid()).rejects.toMatchObject({
			code: "backend-failure",
			message: "Worker terminated unexpectedly",
		});
		expect(doubles.workersCreated).toBe(1);
	});

	test("a WASM module that will not load fails the call, and is retried on the next", async () => {
		const options: WasmWorkerDoublesOptions = {
			wasmFailure: new Error("Failed to fetch bittery_crypto_bg.wasm"),
		};
		const doubles = createWasmWorkerDoubles(options);
		const port = createWasmWorkerCryptoPort(doubles.deps);

		await expect(port.initialize()).rejects.toMatchObject({
			code: "backend-failure",
		});

		options.wasmFailure = undefined;
		await port.initialize();
		expect(await port.generateUuid()).toMatch(/^[0-9a-f-]{36}$/);
		expect(doubles.wasmLoads).toBe(2);
	});

	test("every failure arrives as a CryptoPortError, never as the raw worker value", async () => {
		const { port, doubles } = await makePort();
		doubles.wasm.nextUuidFailure = "a bare string, as wasm-bindgen can throw";

		const failure = await port.generateUuid().catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(CryptoPortError);
		expect((failure as CryptoPortError).message).toBe(
			"a bare string, as wasm-bindgen can throw",
		);
	});

	test.each([
		["Invalid or expired key handle", "invalid-key-ref"],
		["Decryption failed: aead::Error", "decryption-failed"],
		[
			"RSA operation failed: Decryption failed: decoding error",
			"decryption-failed",
		],
		["Invalid session proof", "verification-failed"],
		["Invalid public ephemeral", "verification-failed"],
		["Invalid input: Invalid recovery key format", "invalid-input"],
		["Invalid PEM format: Invalid public key PEM: unexpected", "invalid-input"],
		["Base64 decode error: Invalid symbol 33", "invalid-input"],
		["Invalid key length: expected 32, got 16", "invalid-input"],
		["Invalid secret key format", "invalid-input"],
		["Invalid members JSON: expected value", "invalid-input"],
		["Encryption failed: aead::Error", "backend-failure"],
		["RSA operation failed: Key generation failed: rng", "backend-failure"],
		["SRP error: unsupported prime group", "backend-failure"],
		["recursive use of an object detected", "backend-failure"],
	])("%s becomes %s", async (message, code) => {
		const { port, doubles } = await makePort();
		doubles.wasm.nextUuidFailure = new Error(message);

		await expect(port.generateUuid()).rejects.toMatchObject({ code, message });
	});

	// The worker classifies before postMessage, so the tag has to survive as code and text.
	test.each([
		[
			"Decryption",
			() => new CryptoError.Decryption("decryption failed: aead::Error"),
			"decryption-failed",
			"CryptoError.Decryption: decryption failed: aead::Error",
		],
		[
			"KeyDestroyed",
			() => new CryptoError.KeyDestroyed(),
			"key-destroyed",
			"CryptoError.KeyDestroyed",
		],
		[
			"InvalidIvLength",
			() => new CryptoError.InvalidIvLength({ expected: 12n, actual: 16n }),
			"invalid-input",
			"CryptoError.InvalidIvLength: expected=12, actual=16",
		],
		[
			"BackgroundTaskFailed",
			() => new CryptoError.BackgroundTaskFailed(),
			"backend-failure",
			"CryptoError.BackgroundTaskFailed",
		],
	])(
		"generated %s error becomes %s",
		async (_variant, build, code, message) => {
			const { port, doubles } = await makePort();
			doubles.wasm.nextUuidFailure = build();

			await expect(port.generateUuid()).rejects.toMatchObject({
				code,
				message,
			});
		},
	);
});
