import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The HTML specification bans `import()` on `ServiceWorkerGlobalScope`, so the MV3
 * background cannot reach the WASM bindings the way every other client does. Chrome
 * reports it as "import() is disallowed on ServiceWorkerGlobalScope" and the port then
 * fails every call, which leaves the worker unable to unlock anything.
 *
 * Only a real service worker enforces that ban — Bun happily runs a dynamic import — so
 * this reads the wiring rather than the behaviour. It is here to stop the module drifting
 * back onto `createWasmCryptoPort()`'s dynamic default.
 */
const source = readFileSync(
	new URL("../../src/lib/crypto.ts", import.meta.url),
	"utf8",
);

/** Comments are where the banned call gets named, so they are not the code under test. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("the background's crypto port", () => {
	test("takes its bindings from the static adapter", () => {
		expect(code).toMatch(
			/^import \{ createStaticWasmCryptoPort \} from "@bittery\/crypto-port\/adapters\/wasm-static";$/m,
		);
		expect(code).toMatch(/createStaticWasmCryptoPort\(\)/);
	});

	test("never reaches a dynamic import", () => {
		expect(code).not.toMatch(/\bimport\s*\(/);
		expect(code).not.toMatch(/\bcreateWasmCryptoPort\s*\(/);
	});
});
