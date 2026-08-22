import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const bindingRoot =
	process.env.BITTERY_WEB_BINDINGS_ROOT ??
	resolve(scriptRoot, "../generated/web");

test("Web adapter observes full snapshots and keeps request handling async", async () => {
	const bindings = await import(
		pathToFileURL(resolve(bindingRoot, "bittery_client_bindings.js")).href
	);
	const wasm = await readFile(
		resolve(bindingRoot, "bittery_client_bindings_bg.wasm"),
	);
	await bindings.default({ module_or_path: wasm });

	const runtime = new bindings.WebClientRuntime();
	const projections = [];
	runtime.observe_json(
		"runtime-status",
		JSON.stringify({ type: "runtimeStatus", accountId: null }),
		(value) => projections.push(JSON.parse(value)),
	);
	assert.deepEqual(projections, [
		{
			type: "runtimeStatus",
			value: { accountId: null, revision: 0, accounts: [], closed: false },
		},
	]);

	const responsePromise = runtime.request_json(
		"sign-in",
		JSON.stringify({
			type: "signIn",
			serverUrl: "https://server.test",
			email: "person@example.test",
			masterPassword: "UNIQUE_MASTER_PASSWORD",
			secretKey: "UNIQUE_SECRET_KEY",
		}),
	);
	assert.ok(responsePromise instanceof Promise);
	assert.deepEqual(JSON.parse(await responsePromise), {
		Err: {
			code: "AUTHENTICATION_UNAVAILABLE",
			message: "authentication is implemented by a later vertical slice",
		},
	});

	runtime.unobserve("runtime-status");
	runtime.unobserve("runtime-status");
	runtime.close();
	runtime.close();
	runtime.free();
});
