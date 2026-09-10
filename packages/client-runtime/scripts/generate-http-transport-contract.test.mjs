import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import {
	validateHttpRequestJson,
	validateHttpResponseJson,
	validateHttpStreamCommandJson,
	validateHttpStreamResponseJson,
} from "../generated/http-transport/validator.js";

const run = promisify(execFile);

test("generated HTTP transport artifacts match the Rust contract", async () => {
	await run(
		"node",
		["./scripts/generate-http-transport-contract.mjs", "--check"],
		{
			cwd: new URL("..", import.meta.url),
		},
	);
});

test("stream commands and responses stay closed and cannot masquerade as buffered HTTP", () => {
	const request = {
		dispatchId: "stream-1",
		method: "GET",
		url: "https://server.test/events",
		headers: [],
		body: [],
		maxResponseBytes: 65536,
	};
	assert.equal(
		validateHttpStreamCommandJson({ type: "openStream", request }),
		true,
	);
	assert.equal(
		validateHttpStreamCommandJson({
			type: "readStream",
			dispatchId: "stream-1",
		}),
		true,
	);
	assert.equal(
		validateHttpStreamCommandJson({ type: "readStream", dispatchId: "" }),
		false,
	);
	assert.equal(
		validateHttpStreamCommandJson({
			type: "readStream",
			dispatchId: "stream-1",
			retry: true,
		}),
		false,
	);
	assert.equal(validateHttpRequestJson({ type: "openStream", request }), false);
	assert.equal(
		validateHttpStreamResponseJson({
			type: "opened",
			status: 200,
			headers: [],
		}),
		true,
	);
	assert.equal(
		validateHttpStreamResponseJson({ type: "chunk", bytes: [0, 255] }),
		true,
	);
	assert.equal(
		validateHttpStreamResponseJson({ type: "chunk", bytes: [] }),
		false,
	);
	assert.equal(
		validateHttpStreamResponseJson({ type: "chunk", bytes: [256] }),
		false,
	);
	assert.equal(
		validateHttpStreamResponseJson({ type: "ended", reconnect: true }),
		false,
	);
	assert.equal(validateHttpResponseJson({ type: "chunk", bytes: [1] }), false);
});

test("generated validators keep the primitive transport closed", () => {
	assert.equal(
		validateHttpRequestJson({
			dispatchId: "dispatch-1",
			method: "POST",
			url: "https://server.test/auth/start",
			headers: [{ name: "content-type", value: "application/json" }],
			body: [123, 125],
			maxResponseBytes: 4096,
		}),
		true,
	);
	assert.equal(
		validateHttpResponseJson({
			type: "completed",
			status: 0,
			headers: [],
			body: [],
		}),
		true,
	);
	assert.equal(validateHttpResponseJson({ type: "futureFailure" }), false);
	assert.equal(
		validateHttpRequestJson({
			dispatchId: "",
			method: "GET",
			url: "https://server.test",
			headers: [],
			body: [],
			maxResponseBytes: 0,
		}),
		false,
	);
	assert.equal(
		validateHttpResponseJson({
			type: "completed",
			status: 600,
			headers: [],
			body: [],
		}),
		false,
	);
	assert.equal(
		validateHttpResponseJson({
			type: "completed",
			status: 200,
			headers: [],
			body: [],
			extra: true,
		}),
		false,
	);
});
