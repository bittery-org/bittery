import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import { compile } from "json-schema-to-typescript";
import { generateStandaloneValidator } from "./generate-standalone-validator.mjs";

const run = promisify(execFile);
const packageRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const outputRoot = path.join(packageRoot, "generated/runtime-protocol");
const schemaPath = path.join(outputRoot, "contract.schema.json");
const typesPath = path.join(outputRoot, "contract.ts");
const validatorPath = path.join(outputRoot, "validator.js");
const declarationsPath = path.join(outputRoot, "validator.d.ts");
const check = process.argv.includes("--check");
const schemaId = "urn:bittery:client-runtime:runtime-protocol";

const { stdout } = await run(
	"cargo",
	[
		"run",
		"--quiet",
		"--manifest-path",
		path.join(packageRoot, "Cargo.toml"),
		"-p",
		"bittery-client-core",
		"--features",
		"runtime-protocol-contract-schema",
		"--bin",
		"generate-runtime-protocol-contract-schema",
	],
	{ cwd: packageRoot },
);
const schema = JSON.parse(stdout);
schema.$id = schemaId;
const schemaText = `${JSON.stringify(schema, null, 2)}\n`;
const typesText = await compile(schema, "RuntimeProtocolContract", {
	additionalProperties: false,
	bannerComment:
		"/* eslint-disable */\n/* This file is generated. Do not edit. */",
	format: false,
	unknownAny: false,
});

const ajv = new Ajv2020({
	allErrors: false,
	code: { esm: true, source: true },
	strict: true,
});
ajv.addSchema(schema);
const entryPoints = {
	validateRuntimeRequest: ["request", "RuntimeRequest"],
	validateRuntimeOutcome: ["outcome", "RuntimeOutcome"],
	validateObservationRequest: ["observation", "ObservationRequest"],
	validateRuntimeProjection: ["projection", "RuntimeProjection"],
};
const exports = {};
for (const [name, [slug, definition]] of Object.entries(entryPoints)) {
	const id = `${schemaId}:${slug}`;
	ajv.addSchema({ $id: id, $ref: `${schemaId}#/$defs/${definition}` });
	ajv.getSchema(id);
	exports[name] = id;
}
const validatorText = `/* This file is generated. Do not edit. */\n${generateStandaloneValidator(
	ajv,
	exports,
)}`;
const declaredTypes = Object.values(entryPoints)
	.map(([, definition]) => definition)
	.sort()
	.join(", ");
const declarationsText = `/* This file is generated. Do not edit. */
import type { ${declaredTypes} } from "./contract";
${Object.entries(entryPoints)
	.map(
		([name, [, definition]]) =>
			`export declare function ${name}(value: unknown): value is ${definition};`,
	)
	.join("\n")}
`;

const outputs = [
	[schemaPath, schemaText],
	[typesPath, typesText],
	[validatorPath, validatorText],
	[declarationsPath, declarationsText],
];
if (check) {
	const stale = [];
	for (const [file, expected] of outputs) {
		const actual = await readFile(file, "utf8").catch(() => "");
		if (actual !== expected) stale.push(path.relative(packageRoot, file));
	}
	if (stale.length > 0) {
		throw new Error(
			`Generated Runtime protocol contract is stale: ${stale.join(", ")}`,
		);
	}
} else {
	await mkdir(outputRoot, { recursive: true });
	await Promise.all(
		outputs.map(([file, contents]) => writeFile(file, contents)),
	);
}
