import assert from "node:assert/strict";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { generateStandaloneValidator } from "./generate-standalone-validator.mjs";

test("standalone generation emits executable ESM without changing Unicode length validation", async () => {
	const schemaId = "urn:bittery:client-runtime:esm-regression";
	const ajv = new Ajv2020({
		code: { esm: true, source: true },
		strict: true,
	});
	ajv.addSchema({ $id: schemaId, type: "string", maxLength: 1 });
	const source = generateStandaloneValidator(ajv, {
		validateUnicodeScalar: schemaId,
	});
	const module = await import(
		`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
	);

	assert.equal(module.validateUnicodeScalar("😀"), true);
	assert.equal(module.validateUnicodeScalar("😀a"), false);
});

const validators = [
	"artifact-control",
	"http-transport",
	"persistence",
	"platform-storage",
	"profile-admission",
	"runtime-protocol",
	"recovery-control",
	"transfer-control",
];

for (const validator of validators) {
	test(`generated ${validator} validator imports and executes as ESM`, async () => {
		const module = await import(`../generated/${validator}/validator.js`);
		const exportedValidators = Object.values(module);

		assert.ok(exportedValidators.length > 0);
		for (const validate of exportedValidators) {
			assert.equal(typeof validate({}), "boolean");
		}
	});
}

test("generated platform storage requests enforce nullable cursor bounds", async () => {
	const { validatePlatformStorageRequest } = await import(
		"../generated/platform-storage/validator.js"
	);
	const acceptsCursor = (cursor) =>
		validatePlatformStorageRequest({
			type: "listKeys",
			area: "devicePlain",
			prefix: "bittery:runtime:platform-storage:",
			cursor,
		});

	assert.deepEqual(
		{
			initial: acceptsCursor(null),
			nonempty: acceptsCursor("opaque-continuation"),
			maximum: acceptsCursor("x".repeat(98304)),
			empty: acceptsCursor(""),
			oversized: acceptsCursor("x".repeat(98305)),
		},
		{
			initial: true,
			nonempty: true,
			maximum: true,
			empty: false,
			oversized: false,
		},
	);
});
