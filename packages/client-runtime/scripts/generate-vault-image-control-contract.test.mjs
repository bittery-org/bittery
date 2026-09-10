import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	validateVaultImageControlRequest,
	validateVaultImageControlResponse,
	validateVaultImageSourceControlRequest,
	validateVaultImageSourceControlResponse,
} from "../generated/vault-image-control/validator.js";

test("generated Vault-image control is closed and keeps plaintext binary out of JSON", async () => {
	const fixture = JSON.parse(
		await readFile(
			new URL("../generated/vault-image-control/fixture.json", import.meta.url),
			"utf8",
		),
	);
	for (const step of fixture.steps) {
		assert.equal(validateVaultImageControlRequest(step.request), true);
		assert.equal(validateVaultImageControlResponse(step.response), true);
	}
	for (const step of fixture.sourceSteps) {
		assert.equal(validateVaultImageSourceControlRequest(step.request), true);
		assert.equal(validateVaultImageSourceControlResponse(step.response), true);
	}
	assert.equal(JSON.stringify(fixture).includes("bytes"), false);
	assert.equal(
		validateVaultImageControlRequest({ type: "future", bytes: [1] }),
		false,
	);
	assert.equal(
		validateVaultImageSourceControlRequest({ type: "future", bytes: [1] }),
		false,
	);
	const write = fixture.steps.find(
		({ request }) => request.type === "writeChunk",
	).request;
	assert.equal(
		validateVaultImageControlRequest({ ...write, chunkIndex: 4_294_967_296 }),
		false,
	);
	assert.equal(
		validateVaultImageControlRequest({ ...write, chunkIndex: 4_294_967_295 }),
		true,
	);
});
