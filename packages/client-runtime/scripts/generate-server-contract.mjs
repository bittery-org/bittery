import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const repositoryRoot = path.resolve(packageRoot, "../..");
const inputPath = path.join(
	repositoryRoot,
	"packages/api-contract/openapi.v1.json",
);
const outputPath = path.join(
	packageRoot,
	"crates/bittery-client-core/src/generated/server.rs",
);

export const ROOT_ALLOWLIST = Object.freeze([
	"BootstrapItemsResponse",
	"CreateItemBody",
	"ItemResponseDto",
	"CreateItemOperationOutcome",
	"FinishLoginRequest",
	"FinishLoginResponse",
	"LoginAttemptResponse",
	"ProblemDetails",
	"RefreshSessionResponse",
	"StartLoginRequest",
	"SyncChangesResponse",
	"TravelModeResponse",
]);

// These fields are intentionally unconstrained JSON in the Server contract. Every other schema in
// the Runtime allowlist must have a shape the generator understands; silently replacing a new or
// unsupported shape with `serde_json::Value` would defeat the contract drift gate.
const FREE_JSON_FIELDS = new Set([
	"CreateItemOperationResult.details",
	"SyncEventResponse.metadata",
]);

// Authentication request bytes are part of the established SRP protocol evidence. OpenAPI object
// property order is not semantic and Utoipa may reorder it, so keep the two audited wire orders
// explicit in the generator instead of hand-declaring duplicate request DTOs in the Runtime.
const WIRE_FIELD_ORDER = new Map([
	["StartLoginRequest", ["email", "clientPublicKey"]],
	["FinishLoginRequest", ["clientPublicKey", "clientProof"]],
]);

const RUST_RESERVED = new Set([
	"as",
	"break",
	"const",
	"continue",
	"crate",
	"else",
	"enum",
	"extern",
	"false",
	"fn",
	"for",
	"if",
	"impl",
	"in",
	"let",
	"loop",
	"match",
	"mod",
	"move",
	"mut",
	"pub",
	"ref",
	"return",
	"self",
	"Self",
	"static",
	"struct",
	"super",
	"trait",
	"true",
	"type",
	"unsafe",
	"use",
	"where",
	"while",
	"async",
	"await",
	"dyn",
]);

function referencedName(schema) {
	return schema?.$ref?.replace("#/components/schemas/", "");
}

function compareCodePoints(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

function orderedProperties(owner, properties) {
	const preferred = WIRE_FIELD_ORDER.get(owner);
	if (!preferred) {
		return Object.entries(properties).sort(([left], [right]) =>
			compareCodePoints(left, right),
		);
	}
	const rank = new Map(preferred.map((field, index) => [field, index]));
	return Object.entries(properties).sort(([left], [right]) => {
		const leftRank = rank.get(left);
		const rightRank = rank.get(right);
		if (leftRank !== undefined || rightRank !== undefined) {
			return (leftRank ?? preferred.length) - (rightRank ?? preferred.length);
		}
		return compareCodePoints(left, right);
	});
}

function schemaLocation(owner, field) {
	return field ? `${owner}.${field}` : owner;
}

function unsupportedSchema(owner, field, reason) {
	throw new Error(
		`Unsupported OpenAPI schema at ${schemaLocation(owner, field)}: ${reason}`,
	);
}

function isExplicitFreeJson(schema, owner, field) {
	if (!FREE_JSON_FIELDS.has(schemaLocation(owner, field))) return false;
	if (
		schema &&
		typeof schema === "object" &&
		!Array.isArray(schema) &&
		Object.keys(schema).length === 0
	) {
		return true;
	}
	unsupportedSchema(
		owner,
		field,
		"audited free-JSON field is no longer unconstrained",
	);
}

function collectReferences(schema, found = new Set()) {
	if (!schema || typeof schema !== "object") return found;
	const reference = referencedName(schema);
	if (reference) found.add(reference);
	for (const value of Object.values(schema)) collectReferences(value, found);
	return found;
}

function snakeCase(value) {
	const snake = value
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^A-Za-z0-9]+/g, "_")
		.toLowerCase();
	return RUST_RESERVED.has(snake) ? `r#${snake}` : snake;
}

function pascalCase(value) {
	const result = value
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((part) => {
			const normalized =
				part === part.toUpperCase() ? part.toLowerCase() : part;
			return `${normalized[0].toUpperCase()}${normalized.slice(1)}`;
		})
		.join("");
	return /^\d/.test(result) ? `Value${result}` : result;
}

function rustTypeName(value) {
	return value.split("_").map(pascalCase).join("");
}

function isNullable(schema) {
	return (
		(Array.isArray(schema?.type) && schema.type.includes("null")) ||
		schema?.oneOf?.some((entry) => entry.type === "null")
	);
}

function nonNullSchema(schema) {
	if (schema?.oneOf) {
		const nonNull = schema.oneOf.filter((entry) => entry.type !== "null");
		const nullCount = schema.oneOf.length - nonNull.length;
		if (nonNull.length !== 1 || nullCount !== 1) return schema;
		return nonNull[0];
	}
	if (Array.isArray(schema?.type)) {
		return { ...schema, type: schema.type.find((value) => value !== "null") };
	}
	return schema;
}

function rustType(schema, owner, field) {
	if (isExplicitFreeJson(schema, owner, field)) return "serde_json::Value";
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		unsupportedSchema(owner, field, "schema is not an object");
	}
	if (schema.enum) {
		unsupportedSchema(
			owner,
			field,
			"inline enums are not supported; use a named schema",
		);
	}
	if (schema.allOf) unsupportedSchema(owner, field, "allOf is not supported");
	if (schema.anyOf) unsupportedSchema(owner, field, "anyOf is not supported");
	if (schema.oneOf && nonNullSchema(schema) === schema) {
		unsupportedSchema(
			owner,
			field,
			"only one nullable branch is supported here",
		);
	}
	if (
		Array.isArray(schema.type) &&
		(schema.type.length !== 2 ||
			schema.type.filter((value) => value === "null").length !== 1)
	) {
		unsupportedSchema(
			owner,
			field,
			"only one nullable type branch is supported here",
		);
	}
	const value = nonNullSchema(schema);
	const reference = referencedName(value);
	let type;
	if (reference) type = rustTypeName(reference);
	else if (owner === "CursorPage_AuthVaultKeyResponse" && field === "items") {
		type = "Vec<AuthVaultKeyResponse>";
	} else if (value?.type === "array") {
		if (!value.items)
			unsupportedSchema(owner, field, "array has no item schema");
		type = `Vec<${rustType(value.items, owner, `${field}[]`)}>`;
	} else if (value?.type === "string") type = "String";
	else if (value?.type === "integer")
		type = value.format === "int64" ? "i64" : "i32";
	else if (value?.type === "number") type = "f64";
	else if (value?.type === "boolean") type = "bool";
	else if (value?.type === "object" && value.additionalProperties) {
		unsupportedSchema(
			owner,
			field,
			"map/object additionalProperties are not supported",
		);
	} else if (value?.type === "object") {
		unsupportedSchema(
			owner,
			field,
			"inline object is not supported; use a named schema",
		);
	} else
		unsupportedSchema(
			owner,
			field,
			`unknown type ${JSON.stringify(value?.type)}`,
		);
	return isNullable(schema) ? `Option<${type}>` : type;
}

function renderEnum(name, schema) {
	const variants = schema.enum.map(
		(value) =>
			`    #[serde(rename = ${JSON.stringify(value)})]\n    ${pascalCase(value)},`,
	);
	return [
		"#[derive(Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]",
		`pub enum ${rustTypeName(name)} {`,
		...variants,
		"}",
	].join("\n");
}

function renderTaggedOneOf(name, schema) {
	const variants = schema.oneOf.map((branch, index) => {
		if (
			branch.type !== "object" ||
			branch.allOf ||
			branch.anyOf ||
			branch.oneOf
		) {
			unsupportedSchema(
				name,
				undefined,
				`tagged branch ${index + 1} is not an object`,
			);
		}
		const statusSchema = branch.properties?.status;
		const status = statusSchema?.enum?.[0] ?? `variant-${index + 1}`;
		if (statusSchema?.type !== "string" || statusSchema.enum?.length !== 1) {
			unsupportedSchema(
				name,
				undefined,
				`tagged branch ${index + 1} has no single status tag`,
			);
		}
		const required = new Set(branch.required ?? []);
		if (!required.has("status")) {
			unsupportedSchema(
				name,
				undefined,
				`tagged branch ${index + 1} must require its status discriminator`,
			);
		}
		const fields = Object.entries(branch.properties ?? {})
			.filter(([field]) => field !== "status")
			.sort(([left], [right]) => compareCodePoints(left, right))
			.map(([field, fieldSchema]) => {
				const base = rustType(fieldSchema, name, field);
				const type =
					required.has(field) || base.startsWith("Option<")
						? base
						: `Option<${base}>`;
				const rustField = snakeCase(field);
				const rename =
					rustField.replace(/^r#/, "") === field
						? ""
						: `        #[serde(rename = ${JSON.stringify(field)})]\n`;
				return `${rename}        ${rustField}: ${type},`;
			});
		return `    #[serde(rename = ${JSON.stringify(status)})]\n    ${pascalCase(status)} {\n${fields.join("\n")}\n    },`;
	});
	return [
		"#[derive(Clone, PartialEq, serde::Deserialize, serde::Serialize)]",
		'#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]',
		`pub enum ${rustTypeName(name)} {`,
		...variants,
		"}",
	].join("\n");
}

function renderSchema(name, schema) {
	if (schema.allOf)
		unsupportedSchema(name, undefined, "allOf is not supported");
	if (schema.anyOf)
		unsupportedSchema(name, undefined, "anyOf is not supported");
	if (schema.enum) return renderEnum(name, schema);
	if (schema.oneOf && !isNullable(schema))
		return renderTaggedOneOf(name, schema);
	if (schema.oneOf)
		unsupportedSchema(
			name,
			undefined,
			"nullable root unions are not supported",
		);
	if (schema.type === "string") {
		return `pub type ${rustTypeName(name)} = String;`;
	}
	if (schema.type !== "object")
		unsupportedSchema(
			name,
			undefined,
			`unknown type ${JSON.stringify(schema.type)}`,
		);
	if (schema.additionalProperties)
		unsupportedSchema(
			name,
			undefined,
			"map/object additionalProperties are not supported",
		);
	const required = new Set(schema.required ?? []);
	const fields = orderedProperties(name, schema.properties ?? {}).map(
		([field, fieldSchema]) => {
			const base = rustType(fieldSchema, name, field);
			const type =
				required.has(field) || base.startsWith("Option<")
					? base
					: `Option<${base}>`;
			const rustField = snakeCase(field);
			const rename =
				rustField.replace(/^r#/, "") === field
					? []
					: [`    #[serde(rename = ${JSON.stringify(field)})]`];
			return [...rename, `    pub ${rustField}: ${type},`].join("\n");
		},
	);
	return [
		"#[derive(Clone, PartialEq, serde::Deserialize, serde::Serialize)]",
		"#[serde(deny_unknown_fields)]",
		`pub struct ${rustTypeName(name)} {`,
		...fields,
		"}",
	].join("\n");
}

export function generateServerContract(document, sourceBytes) {
	const schemas = document.components?.schemas ?? {};
	const selected = new Set(ROOT_ALLOWLIST);
	for (const root of ROOT_ALLOWLIST) {
		if (!schemas[root])
			throw new Error(`OpenAPI allowlist schema is missing: ${root}`);
	}
	for (const name of selected) {
		for (const reference of collectReferences(schemas[name]))
			selected.add(reference);
	}
	// Utoipa inlines this page's item shape even though the same named schema exists.
	if (selected.has("CursorPage_AuthVaultKeyResponse"))
		selected.add("AuthVaultKeyResponse");

	const digest = createHash("sha256").update(sourceBytes).digest("hex");
	const definitions = [...selected].sort(compareCodePoints).map((name) => {
		if (!schemas[name])
			throw new Error(`Referenced OpenAPI schema is missing: ${name}`);
		return renderSchema(name, schemas[name]);
	});
	return [
		"// @generated by packages/client-runtime/scripts/generate-server-contract.mjs.",
		"// Do not edit by hand.",
		`// Source: packages/api-contract/openapi.v1.json (sha256 ${digest})`,
		"",
		...definitions.flatMap((definition) => [definition, ""]),
	].join("\n");
}

const sourceBytes = await readFile(inputPath);
const document = JSON.parse(sourceBytes);
const generated = generateServerContract(document, sourceBytes);

if (process.argv.includes("--check")) {
	const current = await readFile(outputPath, "utf8").catch(() => "");
	if (current !== generated) {
		console.error(
			"Generated Runtime Server contract is stale. Run `pnpm --filter @bittery/client-runtime generate:server-contract`.",
		);
		process.exitCode = 1;
	}
} else {
	await writeFile(outputPath, generated);
}
