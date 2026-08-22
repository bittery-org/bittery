import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	generateServerContract,
	ROOT_ALLOWLIST,
} from "./generate-server-contract.mjs";

function reverseObjectOrder(value) {
	if (Array.isArray(value)) return value.map(reverseObjectOrder);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.reverse()
			.map(([key, child]) => [key, reverseObjectOrder(child)]),
	);
}

test("generation is deterministic and contains only the recursive allowlist", async () => {
	const source = await readFile(
		new URL("../../api-contract/openapi.v1.json", import.meta.url),
	);
	const document = JSON.parse(source);
	const first = generateServerContract(document, source);
	const second = generateServerContract(document, source);
	assert.equal(first, second);
	assert.equal(
		first,
		generateServerContract(reverseObjectOrder(document), source),
	);
	for (const name of ROOT_ALLOWLIST) {
		const rustName = name
			.split("_")
			.map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
			.join("");
		assert.match(first, new RegExp(`(?:struct|enum|type) ${rustName}`));
	}
	assert.doesNotMatch(first, /CheckoutSessionResponse/);
	assert.doesNotMatch(first, /derive\([^)]*Debug/);
});

test("generation rejects unsupported shapes except audited free JSON fields", async () => {
	const source = await readFile(
		new URL("../../api-contract/openapi.v1.json", import.meta.url),
	);
	const original = JSON.parse(source);
	const withField = (schema) => {
		const document = structuredClone(original);
		document.components.schemas.CreateItemBody.properties.encryptedData =
			schema;
		return document;
	};

	assert.throws(
		() =>
			generateServerContract(
				withField({ allOf: [{ type: "string" }] }),
				source,
			),
		/Unsupported OpenAPI schema at CreateItemBody\.encryptedData: allOf/,
	);
	assert.throws(
		() =>
			generateServerContract(
				withField({ oneOf: [{ type: "string" }, { type: "integer" }] }),
				source,
			),
		/only one nullable branch is supported/,
	);
	assert.throws(
		() =>
			generateServerContract(
				withField({ type: ["string", "integer", "null"] }),
				source,
			),
		/only one nullable type branch is supported/,
	);
	assert.throws(
		() =>
			generateServerContract(
				withField({ type: "object", additionalProperties: { type: "string" } }),
				source,
			),
		/map\/object additionalProperties are not supported/,
	);
	assert.throws(
		() => generateServerContract(withField({}), source),
		/unknown type/,
	);

	const generated = generateServerContract(original, source);
	assert.match(generated, /details: Option<serde_json::Value>/);
	assert.match(generated, /metadata: Option<serde_json::Value>/);
});

test("tagged operation results use exact camelCase wire fields", async () => {
	const source = await readFile(
		new URL("../../api-contract/openapi.v1.json", import.meta.url),
	);
	const generated = generateServerContract(JSON.parse(source), source);
	assert.match(
		generated,
		/Applied \{[\s\S]*#\[serde\(rename = "itemId"\)\][\s\S]*item_id: String/,
	);
	assert.match(generated, /enum ErrorCode \{[\s\S]*InternalError/);
	assert.doesNotMatch(generated, /INTERNALERROR/);
});
