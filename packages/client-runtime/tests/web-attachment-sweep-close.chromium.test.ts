import { expect, test } from "bun:test";
import { chromium } from "../../../apps/extension/node_modules/playwright/index.mjs";

test("actual WASM close retains the Account lease until an invoked orphan deletion settles", async () => {
	const bindingsRoot = process.env.BITTERY_JOINED_UPLOAD_BINDINGS_ROOT;
	if (!bindingsRoot)
		throw new Error("Actual feature WASM bindings are required");
	const build = await Bun.build({
		entrypoints: [
			new URL(
				"./web-attachment-sweep-close-chromium-harness.ts",
				import.meta.url,
			).pathname,
		],
		target: "browser",
		format: "esm",
	});
	expect(build.success).toBe(true);
	const harness = await build.outputs[0].text();
	const unexpected: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/favicon.ico") return new Response(null, { status: 204 });
			if (path === "/")
				return new Response(
					'<script type="module" src="/harness.js"></script>',
					{
						headers: { "content-type": "text/html" },
					},
				);
			if (path === "/harness.js")
				return new Response(harness, {
					headers: { "content-type": "text/javascript" },
				});
			if (path === "/real-core-bindings.js")
				return new Response(Bun.file(`${bindingsRoot}/index.js`), {
					headers: { "content-type": "text/javascript" },
				});
			if (path === "/real-core.wasm")
				return new Response(Bun.file(`${bindingsRoot}/index_bg.wasm`), {
					headers: { "content-type": "application/wasm" },
				});
			unexpected.push(`${request.method} ${path}`);
			return new Response("Unexpected fixture route", { status: 500 });
		},
	});
	let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
	try {
		browser = await chromium.launch({ headless: false });
		const context = await browser.newContext();
		const owner = await context.newPage();
		const next = await context.newPage();
		const errors: string[] = [];
		for (const page of [owner, next]) {
			page.on("pageerror", (error) => errors.push(error.message));
			await page.goto(server.url.toString());
			await page.waitForFunction(() => "sweepCloseStart" in globalThis);
		}
		try {
			const before = await owner.evaluate(() =>
				(globalThis as any).sweepCloseStart(),
			);
			expect(before).toEqual({ metadata: 1, chunks: 1 });
			await owner.waitForFunction(
				() => (globalThis as any).sweepCloseState().deletionEntered,
			);
			await next.evaluate(() => (globalThis as any).sweepCloseOpenCompetitor());
			expect(
				await next.evaluate(() => (globalThis as any).sweepCloseTryAcquire()),
			).toBe(false);
			await owner.evaluate(() => (globalThis as any).sweepCloseBegin());
			let acquiredWhileHeld = false;
			for (let attempt = 0; attempt < 10 && !acquiredWhileHeld; attempt++) {
				acquiredWhileHeld = await next.evaluate(() =>
					(globalThis as any).sweepCloseTryAcquire(),
				);
				if (!acquiredWhileHeld)
					await new Promise((resolve) => setTimeout(resolve, 20));
			}
			const whileHeld = await owner.evaluate(() =>
				(globalThis as any).sweepCloseState(),
			);
			// Always drain the actual deletion, including on RED, before evaluating the ordering.
			const after = await owner.evaluate(() =>
				(globalThis as any).sweepCloseRelease(),
			);
			expect(after.deletionSettled).toBe(true);
			expect(after.closeSettled).toBe(true);
			expect(after.rows.chunks).toBe(0);
			expect(after.errors).toEqual([]);
			expect(whileHeld).toEqual({
				deletionEntered: true,
				deletionSettled: false,
				closeSettled: false,
				errors: [],
			});
			expect(
				acquiredWhileHeld,
				"a second normal owner acquired the Account lease before the first owner's already-invoked deletion settled",
			).toBe(false);
			expect(
				await next.evaluate(() => (globalThis as any).sweepCloseTryAcquire()),
			).toBe(true);
			expect(errors).toEqual([]);
			expect(unexpected).toEqual([]);
		} finally {
			await Promise.allSettled([
				owner.evaluate(() => (globalThis as any).sweepCloseCleanup()),
				next.evaluate(() => (globalThis as any).sweepCloseCleanup()),
			]);
		}
	} finally {
		await browser?.close();
		await server.stop(true);
	}
}, 30_000);
