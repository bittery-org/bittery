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
const outputRoot = path.join(packageRoot, "generated/artifact-control");
const schemaPath = path.join(outputRoot, "contract.schema.json");
const typesPath = path.join(outputRoot, "contract.ts");
const validatorPath = path.join(outputRoot, "validator.js");
const declarationsPath = path.join(outputRoot, "validator.d.ts");
const fixturePath = path.join(outputRoot, "fixture.json");
const check = process.argv.includes("--check");
const schemaId = "urn:bittery:client-runtime:artifact-control";

const { stdout } = await run(
	"cargo",
	[
		"run",
		"--quiet",
		"--manifest-path",
		path.join(packageRoot, "Cargo.toml"),
		"-p",
		"bittery-client-bindings",
		"--features",
		"artifact-control-contract-schema",
		"--bin",
		"generate-artifact-control-contract-schema",
	],
	{ cwd: packageRoot },
);
const schema = JSON.parse(stdout);
const { stdout: fixtureStdout } = await run(
	"cargo",
	[
		"run",
		"--quiet",
		"--manifest-path",
		path.join(packageRoot, "Cargo.toml"),
		"-p",
		"bittery-client-bindings",
		"--features",
		"artifact-control-contract-schema",
		"--bin",
		"generate-artifact-control-contract-schema",
		"--",
		"--fixture",
	],
	{ cwd: packageRoot },
);
const fixtureText = `${JSON.stringify(JSON.parse(fixtureStdout), null, 2)}\n`;
schema.$id = schemaId;
const schemaText = `${JSON.stringify(schema, null, 2)}\n`;
const typesText = await compile(schema, "ArtifactControlContract", {
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
ajv.addFormat("uint32", true);
ajv.addSchema(schema);
const requestId = `${schemaId}:request`;
const responseId = `${schemaId}:response`;
ajv.addSchema({
	$id: requestId,
	$ref: `${schemaId}#/$defs/ArtifactControlRequest`,
});
ajv.addSchema({
	$id: responseId,
	$ref: `${schemaId}#/$defs/ArtifactControlResponse`,
});
const validatorText = `/* This file is generated. Do not edit. */\n${generateStandaloneValidator(
	ajv,
	{
		validateArtifactControlRequest: requestId,
		validateArtifactControlResponse: responseId,
	},
)}`;
const declarationsText = `/* This file is generated. Do not edit. */
import type { ArtifactControlRequest, ArtifactControlResponse } from "./contract";
export declare function validateArtifactControlRequest(value: unknown): value is ArtifactControlRequest;
export declare function validateArtifactControlResponse(value: unknown): value is ArtifactControlResponse;
`;
const outputs = [
	[schemaPath, schemaText],
	[typesPath, typesText],
	[validatorPath, validatorText],
	[declarationsPath, declarationsText],
	[fixturePath, fixtureText],
];
if (check) {
	const stale = [];
	for (const [file, expected] of outputs) {
		const actual = await readFile(file, "utf8").catch(() => "");
		if (actual !== expected) stale.push(path.relative(packageRoot, file));
	}
	if (stale.length > 0)
		throw new Error(
			`Generated artifact control contract is stale: ${stale.join(", ")}`,
		);
} else {
	await mkdir(outputRoot, { recursive: true });
	await Promise.all(
		outputs.map(([file, contents]) => writeFile(file, contents)),
	);
}
