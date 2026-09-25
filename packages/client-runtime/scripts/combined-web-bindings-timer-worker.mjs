import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { timerProbeRuntime } from "./combined-web-bindings.fixture.mjs";

try {
	const bindings = await import(pathToFileURL(workerData.bindings).href);
	await bindings.default({
		module_or_path: await readFile(workerData.wasm),
	});
	let attempts = 0;
	const runtime = timerProbeRuntime(bindings, {
		invoke: async (requestJson) => {
			if (JSON.parse(requestJson).type === "retireRuntime") {
				attempts += 1;
				return '{"type":"sinkFailure"}';
			}
			return '{"type":"invariantViolation"}';
		},
	});
	await runtime.open();
	globalThis.setTimeout =
		workerData.mode === "missing"
			? undefined
			: () => {
					throw new Error("timer rejected");
				};
	let settled = false;
	void runtime.request_json("wipe-without-timer", '{"type":"wipe"}').then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
	await delay(25);
	parentPort.postMessage({ attempts, settled });
} catch (error) {
	parentPort.postMessage({ error: String(error) });
}
