import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const combinedRoot =
	process.env.BITTERY_COMBINED_WEB_BINDINGS_ROOT ??
	resolve(scriptRoot, "../../crypto/wasm/generated/wasm-bindgen");
const standaloneRoot = resolve(scriptRoot, "../generated/web");

test("one WebAssembly module exposes crypto and the Client Runtime", async () => {
	const productionWasm = (
		await Promise.all(
			[combinedRoot, standaloneRoot].map(async (root) => {
				try {
					return (await readdir(root))
						.filter((name) => name.endsWith("_bg.wasm"))
						.map((name) => resolve(root, name));
				} catch (error) {
					if (error?.code === "ENOENT") return [];
					throw error;
				}
			}),
		)
	).flat();
	const bindings = await import(
		pathToFileURL(resolve(combinedRoot, "index.js")).href
	);
	const wasm = await readFile(resolve(combinedRoot, "index_bg.wasm"));
	await bindings.default({ module_or_path: wasm });

	assert.equal(
		typeof bindings.ubrn_uniffi_bittery_crypto_api_checksum_func_generate_uuid,
		"function",
	);
	assert.equal(
		typeof bindings.ubrn_uniffi_bittery_crypto_api_fn_func_generate_uuid,
		"function",
	);
	assert.equal(typeof bindings.WebClientRuntime, "function");

	const runtime = new bindings.WebClientRuntime();
	const projections = [];
	runtime.observe_json(
		"runtime-status",
		JSON.stringify({ type: "runtimeStatus", accountId: null }),
		(value) => {
			projections.push(JSON.parse(value));
			runtime.unobserve("runtime-status");
		},
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

	const closePromise = runtime.close();
	assert.ok(closePromise instanceof Promise);
	await closePromise;
	await runtime.close();
	runtime.free();

	const reentrantRuntime = new bindings.WebClientRuntime();
	let reentrantClose;
	reentrantRuntime.observe_json(
		"reentrant-close",
		JSON.stringify({ type: "runtimeStatus", accountId: null }),
		() => {
			reentrantClose = reentrantRuntime.close();
		},
	);
	assert.ok(reentrantClose instanceof Promise);
	await reentrantClose;
	await reentrantRuntime.close();
	reentrantRuntime.free();

	assert.deepEqual(productionWasm, [resolve(combinedRoot, "index_bg.wasm")]);
});
