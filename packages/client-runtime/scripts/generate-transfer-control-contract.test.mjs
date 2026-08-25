import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import {
	validateTransferControlRequest,
	validateTransferControlResponse,
} from "../generated/transfer-control/validator.js";

const run = promisify(execFile);

test("generated transfer control artifacts match the Rust contract", async () => {
	await run(
		"node",
		["./scripts/generate-transfer-control-contract.mjs", "--check"],
		{
			cwd: new URL("..", import.meta.url),
		},
	);
});

test("generated transfer control stays closed and keeps ciphertext binary", async () => {
	const fixture = JSON.parse(
		await readFile(
			new URL("../generated/transfer-control/fixture.json", import.meta.url),
			"utf8",
		),
	);
	for (const step of fixture.steps) {
		assert.equal(validateTransferControlRequest(step.request), true);
		assert.equal(validateTransferControlResponse(step.response), true);
	}
	assert.equal(JSON.stringify(fixture).includes('"bytes"'), false);
	assert.equal(
		validateTransferControlRequest({ type: "futureTransfer", bytes: [1] }),
		false,
	);
	assert.equal(
		validateTransferControlResponse({ type: "futureResult", url: "secret" }),
		false,
	);
});
