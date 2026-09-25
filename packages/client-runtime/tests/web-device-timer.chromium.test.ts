import { expect, test } from "bun:test";
import { chromium } from "../../../apps/extension/node_modules/playwright/index.mjs";
import type { timerProbe as probe } from "./web-device-timer-chromium-harness";

test("actual WASM Device timer preserves long deadlines and clears cancelled host waits", async () => {
	const root = process.env.BITTERY_JOINED_UPLOAD_BINDINGS_ROOT;
	if (!root) throw new Error("Feature WASM bindings are required");
	const build = await Bun.build({
		entrypoints: [
			new URL("./web-device-timer-chromium-harness.ts", import.meta.url)
				.pathname,
		],
		target: "browser",
		format: "esm",
	});
	expect(build.success).toBe(true);
	const script = await build.outputs[0].text();
	const unexpected: string[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/")
				return new Response(
					'<script type="module" src="/harness.js"></script>',
					{ headers: { "content-type": "text/html" } },
				);
			if (path === "/favicon.ico") return new Response(null, { status: 204 });
			if (path === "/harness.js")
				return new Response(script, {
					headers: { "content-type": "text/javascript" },
				});
			if (path === "/real-core-bindings.js")
				return new Response(Bun.file(`${root}/index.js`), {
					headers: { "content-type": "text/javascript" },
				});
			if (path === "/real-core.wasm")
				return new Response(Bun.file(`${root}/index_bg.wasm`), {
					headers: { "content-type": "application/wasm" },
				});
			unexpected.push(path);
			return new Response(null, { status: 404 });
		},
	});
	let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
	try {
		browser = await chromium.launch({ headless: false });
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto(server.url.toString());
		await page.waitForFunction(() => "timerProbe" in globalThis);
		for (const delay of ["2147483648", "9007199254740991", "2147483647"]) {
			const result = await page.evaluate(
				(delay) => globalThis.timerProbe(delay),
				delay,
			);
			expect(result.completed).toBe(false);
			expect(result.waits).toHaveLength(1);
			expect(result.waits[0].delay).toBe(2147483647);
			expect(result.cleared).toEqual([result.waits[0].id]);
		}
		for (const delay of ["0", "5"]) {
			const result = await page.evaluate(
				(delay) => globalThis.timerProbe(delay),
				delay,
			);
			expect(result.completed).toBe(true);
			expect(result.waits.map((wait) => wait.delay)).toEqual([Number(delay)]);
			expect(result.cleared).toEqual([result.waits[0].id]);
		}
		const remainder = await page.evaluate(() =>
			globalThis.timerProbe("2147483652", true),
		);
		expect(remainder.completed).toBe(true);
		expect(remainder.waits.map((wait) => wait.delay)).toEqual([2147483647, 5]);
		expect(remainder.cleared).toEqual(remainder.waits.map((wait) => wait.id));
		const cancelledRemainder = await page.evaluate(() =>
			globalThis.timerProbe("9007199254740991", true),
		);
		expect(cancelledRemainder.completed).toBe(false);
		expect(cancelledRemainder.waits.map((wait) => wait.delay)).toEqual([
			2147483647, 2147483647,
		]);
		expect(cancelledRemainder.cleared).toEqual(
			cancelledRemainder.waits.map((wait) => wait.id),
		);
		expect(errors).toEqual([]);
		expect(unexpected).toEqual([]);
	} finally {
		try {
			await browser?.close();
		} finally {
			await server.stop(true);
		}
	}
}, 20_000);

declare global {
	var timerProbe: typeof probe;
}
