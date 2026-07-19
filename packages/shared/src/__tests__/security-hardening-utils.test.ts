import { describe, expect, test } from "bun:test";
import {
	attachVaultKeyWrapContext,
	buildVaultKeyWrapContext,
	type EncryptionContextEnvelopeInput,
	serializeEncryptionContext,
	unwrapPlaintextWithContext,
	VAULT_KEY_WRAP_PURPOSE,
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

describe("vault key wrap helpers", () => {
	test("builds deterministic vault key wrap metadata", () => {
		const context = buildVaultKeyWrapContext({
			vaultId: "vault_1",
			userId: "user_1",
			keyVersion: 3,
		});
		expect(context).toEqual({
			vaultId: "vault_1",
			userId: "user_1",
			keyVersion: 3,
			purpose: VAULT_KEY_WRAP_PURPOSE,
		});
	});

	test("attaches wrap metadata to encrypted vault key payloads", () => {
		const wrapped = attachVaultKeyWrapContext(
			{
				ciphertext: "ciphertext",
				iv: "iv",
				algorithm: "AES-GCM-AAD-V1",
			},
			{
				vaultId: "vault_2",
				userId: "user_2",
				keyVersion: 1,
			},
		);
		expect(wrapped.context).toEqual({
			vaultId: "vault_2",
			userId: "user_2",
			keyVersion: 1,
			purpose: VAULT_KEY_WRAP_PURPOSE,
		});
	});
});
