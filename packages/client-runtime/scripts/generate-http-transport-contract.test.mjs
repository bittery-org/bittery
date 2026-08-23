import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import {
	validateHttpRequestJson,
	validateHttpResponseJson,
} from "../generated/http-transport/validator.js";

const run = promisify(execFile);

test("generated HTTP transport artifacts match the Rust contract", async () => {
	await run("node", ["./scripts/generate-http-transport-contract.mjs", "--check"], {
		cwd: new URL("..", import.meta.url),
	});
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
		validateHttpResponseJson({ type: "completed", status: 0, headers: [], body: [] }),
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
		validateHttpResponseJson({ type: "completed", status: 600, headers: [], body: [] }),
		false,
	);
	assert.equal(
		validateHttpResponseJson({ type: "completed", status: 200, headers: [], body: [], extra: true }),
		false,
	);
});
