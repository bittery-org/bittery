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
	assert.match(
		first,
		/#\[serde\(deny_unknown_fields\)\]\npub struct LoginAttemptResponse/,
	);
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
	assert.throws(
		() =>
			generateServerContract(
				withField({ type: "string", enum: ["sealed", "open"] }),
				source,
			),
		/inline enums are not supported; use a named schema/,
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
	assert.match(
		generated,
		/enum CreateShareOperationResult \{[\s\S]*#\[serde\(rename = "shareLinkId"\)\][\s\S]*share_link_id: String/,
	);
	assert.match(
		generated,
		/enum CreateVaultOperationResult \{[\s\S]*#\[serde\(rename = "vaultId"\)\][\s\S]*vault_id: String/,
	);
	assert.doesNotMatch(
		generated.slice(
			generated.indexOf("pub enum CreateShareOperationResult"),
			generated.indexOf("pub struct CursorPageAuthVaultKeyResponse"),
		),
		/\btoken\b/,
	);
	assert.match(generated, /enum ErrorCode \{[\s\S]*InternalError/);
	assert.doesNotMatch(generated, /INTERNALERROR/);
});

test("generated auth requests preserve the established immutable JSON field order", async () => {
	const source = await readFile(
		new URL("../../api-contract/openapi.v1.json", import.meta.url),
	);
	const generated = generateServerContract(JSON.parse(source), source);
	const start = generated.slice(
		generated.indexOf("pub struct StartLoginRequest"),
		generated.indexOf("pub struct SyncChangesResponse"),
	);
	assert.ok(
		start.indexOf("pub email: String") <
			start.indexOf("pub client_public_key: String"),
	);
	const finish = generated.slice(
		generated.indexOf("pub struct FinishLoginRequest"),
		generated.indexOf("pub struct FinishLoginResponse"),
	);
	assert.ok(
		finish.indexOf("pub client_public_key: String") <
			finish.indexOf("pub client_proof: String"),
	);
});

test("tagged unions reject an optional discriminator", async () => {
	const source = await readFile(
		new URL("../../api-contract/openapi.v1.json", import.meta.url),
	);
	const document = JSON.parse(source);
	const branch = document.components.schemas.ItemOperationResult.oneOf[0];
	branch.required = branch.required.filter((field) => field !== "status");

	assert.throws(
		() => generateServerContract(document, source),
		/tagged union needs exactly one discriminator, found 0/,
	);
});

test("the Operation outcome union is discriminated by its own tag", async () => {
	const source = await readFile(
		new URL("../../api-contract/openapi.v1.json", import.meta.url),
	);
	const generated = generateServerContract(JSON.parse(source), source);
	const union = generated.slice(
		generated.indexOf('#[serde(tag = "kind"'),
		generated.indexOf("pub enum OperationRejectionCode"),
	);
	assert.match(union, /pub enum OperationOutcome \{/);
	for (const kind of [
		"create_item",
		"update_item",
		"set_item_favorite",
		"trash_item",
		"restore_item",
		"move_item",
		"permanently_delete_item",
		"create_share",
		"create_vault",
	]) {
		assert.match(union, new RegExp(`#\\[serde\\(rename = "${kind}"\\)\\]`));
	}
	// `deny_unknown_fields` on an internally tagged enum is what makes an unknown kind a parse
	// failure rather than another kind's answer read by accident.
	assert.match(union, /deny_unknown_fields/);
});
