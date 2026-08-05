/**
 * Extension adapter conformance.
 *
 * The behavioural contract comes from the shared suite; this file only has to hand it a
 * fresh port backed by a faked `@bittery/crypto-wasm`. The extra tests below pin what is
 * *specific* to running crypto on the same thread as the caller, which the platform-
 * agnostic suite cannot see: that a `KeyRef` really is backed by the WASM handle table
 * (not some parallel bookkeeping), that a foreign or destroyed ref is rejected without
 * ever touching the backend, that the backend loads once however many calls it serves,
 * and that a failed load is retried rather than poisoning the rest of the instance's life
 * — the property a service-worker restart depends on.
 *
 * Error-code classification itself is not re-pinned exhaustively here: `classify` is
 * imported unchanged from `../wasm-crypto-backend` and `wasm-worker.test.ts` already pins
 * its full mapping against the real `CryptoError` `Display` strings. A couple of
 * representative cases below are enough to prove this adapter surfaces what `classify`
 * says, nothing more.
 */

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
		let destroyCalls = 0;
		const original = doubles.wasm.destroyKeyHandle.bind(doubles.wasm);
		doubles.wasm.destroyKeyHandle = (handle: bigint) => {
			destroyCalls += 1;
			return original(handle);
		};

		await port.destroyKey(key);
		await port.destroyKey(key);

		expect(destroyCalls).toBe(1);
	});

	test("a foreign KeyRef is rejected without ever touching the backend", async () => {
		const { port } = await makePort();
		const { port: other, doubles: otherDoubles } = await makePort();
		const foreign = await other.generateEncryptionKey();
		expect(otherDoubles.wasm.liveHandleCount).toBe(1);

		await expect(port.encrypt("plain", foreign, null)).rejects.toMatchObject({
			code: "invalid-key-ref",
		});

		// The foreign ref's own handle is untouched — the rejection never reached any
		// backend, this port's or the other one's.
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

		// The service worker was torn down and rebuilt: a brand new closure, a brand new
		// key table. Nothing carries over — there is no state to survive, by construction.
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

	// The full mapping is pinned once, in `wasm-worker.test.ts`, against the shared
	// `classify` this adapter also calls. These few rows only confirm this adapter
	// actually surfaces what `classify` says rather than swallowing or renaming it.
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
