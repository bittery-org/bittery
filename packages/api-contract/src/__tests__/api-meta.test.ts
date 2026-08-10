import { describe, expect, test } from "bun:test";
import {
	ApiMetaValidationError,
	ApiVersionMismatchError,
	negotiateApiVersion,
	parseApiMeta,
} from "../api-meta.ts";

function metadata() {
	return {
		serverRelease: "0.5.1",
		api: {
			supportedMajors: [1, 2],
			preferredMajor: 2,
		},
		capabilities: ["attachments", "sync-sse"],
		limits: {
			itemCiphertextBytes: "1048576",
			bulkImportBytes: "16777216",
			bulkImportItems: 200,
		},
	};
}

describe("API metadata", () => {
	test("accepts additive response fields", () => {
		const parsed = parseApiMeta({
			...metadata(),
			futureField: { ignored: true },
		});

		expect(parsed).toEqual(metadata());
	});

	test("rejects a preferred major the server does not support", () => {
		const invalid = metadata();
		invalid.api.preferredMajor = 3;

		expect(() => parseApiMeta(invalid)).toThrow(ApiMetaValidationError);
	});

	test("rejects duplicate capability and major values", () => {
		const duplicateMajor = metadata();
		duplicateMajor.api.supportedMajors = [1, 1];
		expect(() => parseApiMeta(duplicateMajor)).toThrow(ApiMetaValidationError);

		const duplicateCapability = metadata();
		duplicateCapability.capabilities = ["sync-sse", "sync-sse"];
		expect(() => parseApiMeta(duplicateCapability)).toThrow(
			ApiMetaValidationError,
		);
	});

	test("rejects numeric and noncanonical decimal byte limits", () => {
		const numericLimit = metadata();
		numericLimit.limits.itemCiphertextBytes = 1_048_576 as never;
		expect(() => parseApiMeta(numericLimit)).toThrow(ApiMetaValidationError);

		const noncanonicalLimit = metadata();
		noncanonicalLimit.limits.bulkImportBytes = "016777216";
		expect(() => parseApiMeta(noncanonicalLimit)).toThrow(
			ApiMetaValidationError,
		);
	});

	test("selects the server preferred major when it is mutually supported", () => {
		const negotiation = negotiateApiVersion(parseApiMeta(metadata()), [1, 2]);

		expect(negotiation.major).toBe(2);
		expect(negotiation.capabilities.has("sync-sse")).toBe(true);
	});

	test("selects the newest mutually supported major when necessary", () => {
		const negotiation = negotiateApiVersion(parseApiMeta(metadata()), [1, 3]);

		expect(negotiation.major).toBe(1);
	});

	test("fails before callers can use an incompatible server", () => {
		expect(() => negotiateApiVersion(parseApiMeta(metadata()), [3])).toThrow(
			ApiVersionMismatchError,
		);
	});
});
