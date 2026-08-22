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
	"CreateItemOperationOutcome",
	"FinishLoginRequest",
	"FinishLoginResponse",
	"LoginAttemptResponse",
	"ProblemDetails",
	"RefreshSessionResponse",
	"StartLoginRequest",
	"SyncChangesResponse",
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
		return schema.oneOf.find((entry) => entry.type !== "null") ?? schema;
	}
	if (Array.isArray(schema?.type)) {
		return { ...schema, type: schema.type.find((value) => value !== "null") };
	}
	return schema;
}

function rustType(schema, owner, field) {
	const value = nonNullSchema(schema);
	const reference = referencedName(value);
	let type;
	if (reference) type = rustTypeName(reference);
	else if (owner === "CursorPage_AuthVaultKeyResponse" && field === "items") {
		type = "Vec<AuthVaultKeyResponse>";
	} else if (value?.type === "array")
		type = `Vec<${rustType(value.items, owner, field)}>`;
	else if (value?.type === "string") type = "String";
	else if (value?.type === "integer")
		type = value.format === "int64" ? "i64" : "i32";
	else if (value?.type === "number") type = "f64";
	else if (value?.type === "boolean") type = "bool";
	else type = "serde_json::Value";
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
		const status =
			branch.properties?.status?.enum?.[0] ?? `variant-${index + 1}`;
		const required = new Set(branch.required ?? []);
		const fields = Object.entries(branch.properties ?? {})
			.filter(([field]) => field !== "status")
			.sort(([left], [right]) => left.localeCompare(right))
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
		'#[serde(tag = "status", rename_all = "camelCase")]',
		`pub enum ${rustTypeName(name)} {`,
		...variants,
		"}",
	].join("\n");
}

function renderSchema(name, schema) {
	if (schema.enum) return renderEnum(name, schema);
	if (schema.oneOf && !isNullable(schema))
		return renderTaggedOneOf(name, schema);
	if (schema.type === "string") {
		return `pub type ${rustTypeName(name)} = String;`;
	}
	if (schema.type !== "object") {
		return `pub type ${rustTypeName(name)} = serde_json::Value;`;
	}
	const required = new Set(schema.required ?? []);
	const fields = Object.entries(schema.properties ?? {})
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([field, fieldSchema]) => {
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
		});
	return [
		"#[derive(Clone, PartialEq, serde::Deserialize, serde::Serialize)]",
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
	const definitions = [...selected].sort().map((name) => {
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
