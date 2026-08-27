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
const outputRoot = path.join(packageRoot, "generated/transfer-control");
const schemaId = "urn:bittery:client-runtime:transfer-control";
const check = process.argv.includes("--check");

const cargo = async (...extra) =>
	(
		await run(
			"cargo",
			[
				"run",
				"--quiet",
				"--manifest-path",
				path.join(packageRoot, "Cargo.toml"),
				"-p",
				"bittery-client-bindings",
				"--features",
				"transfer-control-contract-schema",
				"--bin",
				"generate-transfer-control-contract-schema",
				...extra,
			],
			{ cwd: packageRoot },
		)
	).stdout;

const schema = JSON.parse(await cargo());
schema.$id = schemaId;
const fixture = JSON.parse(await cargo("--", "--fixture"));
const schemaText = `${JSON.stringify(schema, null, 2)}\n`;
const typesText = await compile(schema, "TransferControlContract", {
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
for (const name of ["uint16", "uint32"]) ajv.addFormat(name, true);
ajv.addSchema(schema);
const requestId = `${schemaId}:request`;
const responseId = `${schemaId}:response`;
ajv.addSchema({
	$id: requestId,
	$ref: `${schemaId}#/$defs/TransferControlRequest`,
});
ajv.addSchema({
	$id: responseId,
	$ref: `${schemaId}#/$defs/TransferControlResponse`,
});
const standaloneValidator = generateStandaloneValidator(ajv, {
	validateTransferControlRequest: requestId,
	validateTransferControlResponse: responseId,
});
const validatorText = `/* This file is generated. Do not edit. */\n${standaloneValidator}`;
const declarationsText = `/* This file is generated. Do not edit. */
import type { TransferControlRequest, TransferControlResponse } from "./contract";
export declare function validateTransferControlRequest(value: unknown): value is TransferControlRequest;
export declare function validateTransferControlResponse(value: unknown): value is TransferControlResponse;
`;
const outputs = [
	[path.join(outputRoot, "contract.schema.json"), schemaText],
	[path.join(outputRoot, "contract.ts"), typesText],
	[path.join(outputRoot, "validator.js"), validatorText],
	[path.join(outputRoot, "validator.d.ts"), declarationsText],
	[
		path.join(outputRoot, "fixture.json"),
		`${JSON.stringify(fixture, null, 2)}\n`,
	],
];

if (check) {
	const stale = [];
	for (const [file, expected] of outputs) {
		if ((await readFile(file, "utf8").catch(() => "")) !== expected)
			stale.push(path.relative(packageRoot, file));
	}
	if (stale.length > 0)
		throw new Error(
			`Generated transfer control contract is stale: ${stale.join(", ")}`,
		);
} else {
	await mkdir(outputRoot, { recursive: true });
	await Promise.all(
		outputs.map(([file, contents]) => writeFile(file, contents)),
	);
}
