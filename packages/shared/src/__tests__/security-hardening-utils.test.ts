import { describe, expect, test } from "bun:test";
import {
	type EncryptionContextEnvelopeInput,
	type KdfParamsPolicyInput,
	serializeEncryptionContext,
	unwrapPlaintextWithContext,
	validateServerKdfParamsOrThrow,
	wrapPlaintextWithContext,
} from "../index";

function testContext(): EncryptionContextEnvelopeInput {
	return {
		vaultId: "vault_1",
		entityId: "item_1",
		entityType: "item",
		version: 2,
		userId: "user_1",
	};
}

function testKdfParams(): KdfParamsPolicyInput {
	return {
		schemaVersion: 1,
		algorithm: "pbkdf2-sha256",
		iterations: 310_000,
		salt: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
	};
}

describe("context envelope helpers", () => {
	test("roundtrip succeeds with the same context", () => {
		const context = testContext();
		const wrapped = wrapPlaintextWithContext("hello", context);
		const unwrapped = unwrapPlaintextWithContext(wrapped, context);
		expect(unwrapped).toBe("hello");
	});

	test("fails when context differs", () => {
		const wrapped = wrapPlaintextWithContext("hello", testContext());
		expect(() =>
			unwrapPlaintextWithContext(wrapped, {
				...testContext(),
				entityId: "item_2",
			}),
		).toThrow("Encryption context mismatch");
	});

	test("serialization is deterministic", () => {
		const context = testContext();
		expect(serializeEncryptionContext(context)).toBe(
			["vault_1", "item_1", "item", "2", "user_1"].join("\0"),
		);
	});
});

describe("kdf policy helper", () => {
	test("accepts valid unpinned params", () => {
		expect(() => validateServerKdfParamsOrThrow(testKdfParams())).not.toThrow();
	});

	test("rejects iteration downgrade against pin", () => {
		const pinned = { ...testKdfParams(), iterations: 320_000 };
		expect(() =>
			validateServerKdfParamsOrThrow(
				{ ...pinned, iterations: 315_000 },
				pinned,
			),
		).toThrow("KDF iterations downgraded from pinned value");
	});

	test("rejects salt change against pin", () => {
		const pinned = testKdfParams();
		expect(() =>
			validateServerKdfParamsOrThrow(
				{
					...pinned,
					salt: "deadbeefdeadbeefdeadbeefdeadbeef",
				},
				pinned,
			),
		).toThrow("KDF salt changed from pinned value");
	});
});
