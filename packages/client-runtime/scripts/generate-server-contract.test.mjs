import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	generateServerContract,
	ROOT_ALLOWLIST,
} from "./generate-server-contract.mjs";

test("generation is deterministic and contains only the recursive allowlist", async () => {
	const source = await readFile(
		new URL("../../api-contract/openapi.v1.json", import.meta.url),
	);
	const document = JSON.parse(source);
	const first = generateServerContract(document, source);
	const second = generateServerContract(document, source);
	assert.equal(first, second);
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
