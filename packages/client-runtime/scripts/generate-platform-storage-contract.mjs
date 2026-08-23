import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";
import { compile } from "json-schema-to-typescript";

const run = promisify(execFile);
const packageRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const outputRoot = path.join(packageRoot, "generated/platform-storage");
const schemaPath = path.join(outputRoot, "contract.schema.json");
const typesPath = path.join(outputRoot, "contract.ts");
const validatorPath = path.join(outputRoot, "validator.js");
const declarationsPath = path.join(outputRoot, "validator.d.ts");
const check = process.argv.includes("--check");
const schemaId = "urn:bittery:client-runtime:platform-storage";

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
		"platform-storage-contract-schema",
		"--bin",
		"generate-platform-storage-contract-schema",
	],
	{ cwd: packageRoot },
);
const schema = JSON.parse(stdout);
schema.$id = schemaId;
const schemaText = `${JSON.stringify(schema, null, 2)}\n`;
const typesText = await compile(schema, "PlatformStorageContract", {
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
const requestId = `${schemaId}:request`;
const responseId = `${schemaId}:response`;
ajv.addSchema({
	$id: requestId,
	$ref: `${schemaId}#/$defs/PlatformStorageRequest`,
});
ajv.addSchema({
	$id: responseId,
	$ref: `${schemaId}#/$defs/PlatformStorageResponse`,
});
ajv.getSchema(requestId);
ajv.getSchema(responseId);
const validatorText = `/* This file is generated. Do not edit. */\n${standaloneCode(
	ajv,
	{
		validatePlatformStorageRequest: requestId,
		validatePlatformStorageResponse: responseId,
	},
)}`;
const declarationsText = `/* This file is generated. Do not edit. */
import type { PlatformStorageRequest, PlatformStorageResponse } from "./contract";
export declare function validatePlatformStorageRequest(value: unknown): value is PlatformStorageRequest;
export declare function validatePlatformStorageResponse(value: unknown): value is PlatformStorageResponse;
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
			`Generated platform storage contract is stale: ${stale.join(", ")}`,
		);
	}
} else {
	await mkdir(outputRoot, { recursive: true });
	await Promise.all(
		outputs.map(([file, contents]) => writeFile(file, contents)),
	);
}
