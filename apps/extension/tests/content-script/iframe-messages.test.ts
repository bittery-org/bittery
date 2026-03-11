import { describe, expect, test } from "bun:test";
import {
	createAutofillReadySchema,
	validateIframeMessage,
} from "../../src/content-script/iframe-messages";

describe("iframe message trust checks", () => {
	const expectedOrigin = "chrome-extension://test-extension";
	const expectedSource = {} as Window;
	const expectedNonce = "nonce-123";
	const readySchema = createAutofillReadySchema("AUTOFILL_IFRAME_READY");

	test("ignores forged page messages from the wrong source", () => {
		const result = validateIframeMessage(
			{
				source: {} as Window,
				origin: expectedOrigin,
				data: {
					type: "AUTOFILL_IFRAME_READY",
					nonce: expectedNonce,
				},
			},
			{
				expectedSource,
				expectedOrigin,
				expectedNonce,
				schema: readySchema,
			},
		);

		expect(result).toBeNull();
	});

	test("ignores messages from the wrong origin", () => {
		const result = validateIframeMessage(
			{
				source: expectedSource,
				origin: "https://example.com",
				data: {
					type: "AUTOFILL_IFRAME_READY",
					nonce: expectedNonce,
				},
			},
			{
				expectedSource,
				expectedOrigin,
				expectedNonce,
				schema: readySchema,
			},
		);

		expect(result).toBeNull();
	});

	test("ignores messages with the wrong nonce", () => {
		const result = validateIframeMessage(
			{
				source: expectedSource,
				origin: expectedOrigin,
				data: {
					type: "AUTOFILL_IFRAME_READY",
					nonce: "wrong-nonce",
				},
			},
			{
				expectedSource,
				expectedOrigin,
				expectedNonce,
				schema: readySchema,
			},
		);

		expect(result).toBeNull();
	});

	test("accepts valid iframe messages", () => {
		const result = validateIframeMessage(
			{
				source: expectedSource,
				origin: expectedOrigin,
				data: {
					type: "AUTOFILL_IFRAME_READY",
					nonce: expectedNonce,
				},
			},
			{
				expectedSource,
				expectedOrigin,
				expectedNonce,
				schema: readySchema,
			},
		);

		expect(result).toEqual({
			type: "AUTOFILL_IFRAME_READY",
			nonce: expectedNonce,
		});
	});
});
