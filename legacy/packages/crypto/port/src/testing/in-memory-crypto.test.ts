/**
 * The fake is the fifth subject of the conformance suite, and the only one that can run
 * before an adapter exists. Keeping it green is what stops the suite drifting into
 * assertions no real backend could satisfy.
 */

import { describe, expect, test } from "bun:test";
import { runCryptoPortConformance } from "../adapters/port-conformance";
import { createInMemoryCryptoPort } from "./in-memory-crypto";

runCryptoPortConformance("in-memory", async () => {
	const port = createInMemoryCryptoPort();
	await port.initialize();
	return port;
});

describe("in-memory crypto port — key accounting", () => {
	test("destroyKey retires the ref it was given", async () => {
		const port = createInMemoryCryptoPort();

		const key = await port.generateEncryptionKey();
		expect(port.liveKeyCount).toBe(1);
		await port.destroyKey(key);

		expect(port.liveKeyCount).toBe(0);
	});

	test("a derivation leaves exactly the refs it hands back", async () => {
		const port = createInMemoryCryptoPort();

		const derived = await port.deriveKeys("password", "A3-secret", "a@b.test", {
			schemaVersion: 1,
			algorithm: "pbkdf2-sha256",
			iterations: 600_000,
		});

		expect(port.liveKeyCount).toBe(2);
		await port.destroyKey(derived.authKey);
		await port.destroyKey(derived.masterUnlockKey);
		expect(port.liveKeyCount).toBe(0);
	});
});
