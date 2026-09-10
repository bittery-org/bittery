import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import { compile } from "json-schema-to-typescript";
import { generateStandaloneValidator } from "./generate-standalone-validator.mjs";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "generated/vault-image-control");
const check = process.argv.includes("--check");
const id = "urn:bittery:client-runtime:vault-image-control";
const cargo = (fixture = false) =>
	run(
		"cargo",
		[
			"run",
			"--quiet",
			"--manifest-path",
			path.join(root, "Cargo.toml"),
			"-p",
			"bittery-client-bindings",
			"--features",
			"vault-image-control-contract-schema",
			"--bin",
			"generate-vault-image-control-contract-schema",
			...(fixture ? ["--", "--fixture"] : []),
		],
		{
			cwd: root,
			env: {
				...process.env,
				CARGO_TARGET_DIR:
					process.env.CARGO_TARGET_DIR ??
					"/home/julian/.cache/bittery-greenfield/cargo-target",
				TMPDIR: process.env.TMPDIR ?? "/home/julian/.cache",
			},
		},
	);
const schema = JSON.parse((await cargo()).stdout);
schema.$id = id;
const fixture = JSON.parse((await cargo(true)).stdout);
const schemaText = `${JSON.stringify(schema, null, 2)}\n`;
const fixtureText = `${JSON.stringify(fixture, null, 2)}\n`;
const typesText = await compile(schema, "VaultImageControlContract", {
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
const ids = {
	request: `${id}:request`,
	response: `${id}:response`,
	sourceRequest: `${id}:source-request`,
	sourceResponse: `${id}:source-response`,
};
ajv.addSchema({
	$id: ids.request,
	$ref: `${id}#/$defs/VaultImageControlRequest`,
});
ajv.addSchema({
	$id: ids.response,
	$ref: `${id}#/$defs/VaultImageControlResponse`,
});
ajv.addSchema({
	$id: ids.sourceRequest,
	$ref: `${id}#/$defs/VaultImageSourceControlRequest`,
});
ajv.addSchema({
	$id: ids.sourceResponse,
	$ref: `${id}#/$defs/VaultImageSourceControlResponse`,
});
const validatorText = `/* This file is generated. Do not edit. */\n${generateStandaloneValidator(ajv, { validateVaultImageControlRequest: ids.request, validateVaultImageControlResponse: ids.response, validateVaultImageSourceControlRequest: ids.sourceRequest, validateVaultImageSourceControlResponse: ids.sourceResponse })}`;
const declarationsText = `/* This file is generated. Do not edit. */\nimport type { VaultImageControlRequest, VaultImageControlResponse, VaultImageSourceControlRequest, VaultImageSourceControlResponse } from "./contract";\nexport declare function validateVaultImageControlRequest(value: unknown): value is VaultImageControlRequest;\nexport declare function validateVaultImageControlResponse(value: unknown): value is VaultImageControlResponse;\nexport declare function validateVaultImageSourceControlRequest(value: unknown): value is VaultImageSourceControlRequest;\nexport declare function validateVaultImageSourceControlResponse(value: unknown): value is VaultImageSourceControlResponse;\n`;
const outputs = [
	[path.join(out, "contract.schema.json"), schemaText],
	[path.join(out, "contract.ts"), typesText],
	[path.join(out, "validator.js"), validatorText],
	[path.join(out, "validator.d.ts"), declarationsText],
	[path.join(out, "fixture.json"), fixtureText],
];
if (check) {
	const stale = [];
	for (const [file, expected] of outputs)
		if ((await readFile(file, "utf8").catch(() => "")) !== expected)
			stale.push(path.relative(root, file));
	if (stale.length)
		throw new Error(
			`Generated Vault-image control contract is stale: ${stale.join(", ")}`,
		);
} else {
	await mkdir(out, { recursive: true });
	await Promise.all(outputs.map(([file, value]) => writeFile(file, value)));
}
