import { describe, expect, test } from "bun:test";
import { CryptoPortError } from "../errors";
import { runCryptoPortConformance } from "./port-conformance";
import { createWasmCryptoPort } from "./wasm";
import {
	createWasmDoubles,
	type WasmDoublesOptions,
} from "./wasm-test-doubles";

/** A fresh, initialised port over a fresh double, as the suite requires. */
async function makePort(options?: WasmDoublesOptions) {
	const doubles = createWasmDoubles(options);
	const port = createWasmCryptoPort(doubles.deps);
	await port.initialize();
	return { port, doubles };
}

runCryptoPortConformance("wasm", async () => (await makePort()).port);

describe("wasm adapter — KeyRef is the WASM handle table", () => {
	test("loads WASM once, however many calls it serves", async () => {
		const { port, doubles } = await makePort();

		await port.initialize();
		await port.generateUuid();
		const key = await port.generateEncryptionKey();
		await port.encrypt("plain", key, null);

		expect(doubles.wasmLoads).toBe(1);
	});

	test("generateEncryptionKey mints a live handle in the WASM key table", async () => {
		const { port, doubles } = await makePort();
		expect(doubles.wasm.liveHandleCount).toBe(0);

		const first = await port.generateEncryptionKey();
		const second = await port.generateEncryptionKey();

		expect(first).not.toBe(second);
		expect(doubles.wasm.liveHandleCount).toBe(2);
	});

	test("destroyKey retires the ref here and zeroizes the handle there", async () => {
		const { port, doubles } = await makePort();
		const key = await port.generateEncryptionKey();
		expect(doubles.wasm.liveHandleCount).toBe(1);

		await port.destroyKey(key);

		expect(doubles.wasm.liveHandleCount).toBe(0);
	});

	test("destroying twice never asks the backend to destroy a handle twice", async () => {
		const { port, doubles } = await makePort();
		const key = await port.generateEncryptionKey();
		await port.destroyKey(key);
		await port.destroyKey(key);

		expect(doubles.wasm.destroyCalls).toBe(1);
	});

	test("a foreign KeyRef is rejected without ever touching the backend", async () => {
		const { port } = await makePort();
		const { port: other, doubles: otherDoubles } = await makePort();
		const foreign = await other.generateEncryptionKey();
		expect(otherDoubles.wasm.liveHandleCount).toBe(1);

		await expect(port.encrypt("plain", foreign, null)).rejects.toMatchObject({
			code: "invalid-key-ref",
		});

		expect(otherDoubles.wasm.liveHandleCount).toBe(1);
	});
});

describe("wasm adapter — decryptMany", () => {
	test("decrypts a whole item list without a round trip to save", async () => {
		const { port } = await makePort();
		const key = await port.generateEncryptionKey();
		const requests = await Promise.all(
			Array.from({ length: 10 }, async (_unused, index) => ({
				id: `item-${index}`,
				data: await port.encrypt(`plain-${index}`, key, null),
				key,
				context: null,
			})),
		);

		const results = await port.decryptMany(requests);

		expect(results).toHaveLength(10);
		expect(results.every((result) => result.ok)).toBe(true);
	});
});

describe("wasm adapter — surviving a fresh instance (service-worker restart)", () => {
	test("a WASM module that will not load fails the call, and is retried on the next", async () => {
		const options: WasmDoublesOptions = {
			wasmFailure: new Error("Failed to fetch bittery_crypto_bg.wasm"),
		};
		const doubles = createWasmDoubles(options);
		const port = createWasmCryptoPort(doubles.deps);

		await expect(port.initialize()).rejects.toMatchObject({
			code: "backend-failure",
		});

		options.wasmFailure = undefined;
		await port.initialize();
		expect(await port.generateUuid()).toMatch(/^[0-9a-f-]{36}$/);
		expect(doubles.wasmLoads).toBe(2);
	});

	test("a fresh port after a restart has no memory of the last instance's keys", async () => {
		const { port: beforeRestart } = await makePort();
		const key = await beforeRestart.generateEncryptionKey();

		const { port: afterRestart } = await makePort();

		await expect(
			afterRestart.encrypt("plain", key, null),
		).rejects.toMatchObject({ code: "invalid-key-ref" });
	});
});

describe("wasm adapter — failure", () => {
	test("every failure arrives as a CryptoPortError, never as the raw backend value", async () => {
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
		["Invalid session proof", "verification-failed"],
		["Invalid input: Invalid recovery key format", "invalid-input"],
		["SRP error: unsupported prime group", "backend-failure"],
	])("%s becomes %s", async (message, code) => {
		const { port, doubles } = await makePort();
		doubles.wasm.nextUuidFailure = new Error(message);

		await expect(port.generateUuid()).rejects.toMatchObject({ code, message });
	});
});
