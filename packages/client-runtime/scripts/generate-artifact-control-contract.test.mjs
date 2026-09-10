import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	validateArtifactControlRequest,
	validateArtifactControlResponse,
} from "../generated/artifact-control/validator.js";

test("generated artifact control stays closed and keeps ciphertext binary", async () => {
	const fixture = JSON.parse(
		await readFile(
			new URL("../generated/artifact-control/fixture.json", import.meta.url),
			"utf8",
		),
	);
	for (const step of fixture.steps) {
		assert.equal(validateArtifactControlRequest(step.request), true);
		assert.equal(validateArtifactControlResponse(step.response), true);
	}
	assert.equal(JSON.stringify(fixture).includes("bytes"), false);
	assert.equal(
		validateArtifactControlRequest({ type: "futureControl", bytes: [1] }),
		false,
	);
	const chunkRequest = fixture.steps.find(
		({ request }) => request.type === "writeChunk",
	)?.request;
	assert.ok(chunkRequest, "fixture must exercise a chunk-index control");
	assert.equal(validateArtifactControlRequest(chunkRequest), true);
	assert.equal(
		validateArtifactControlRequest({
			...chunkRequest,
			chunkIndex: 4_294_967_296,
		}),
		false,
	);
	assert.equal(
		validateArtifactControlRequest({
			...chunkRequest,
			chunkIndex: 4_294_967_295,
		}),
		true,
	);
	assert.equal(
		validateArtifactControlRequest({
			...chunkRequest,
			owner: {
				...chunkRequest.owner,
				chunkCount: 4_294_967_296,
			},
		}),
		false,
	);
	assert.equal(
		validateArtifactControlRequest({
			...chunkRequest,
			owner: {
				...chunkRequest.owner,
				chunkCount: 4_294_967_295,
			},
		}),
		true,
	);
});
