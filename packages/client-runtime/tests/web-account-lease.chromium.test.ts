import { afterAll, describe, expect, test } from "bun:test";
import { chromium } from "../../../apps/extension/node_modules/playwright/index.mjs";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterAll(() => {
	for (const server of servers) server.stop(true);
});

describe("Account writer lease in actual Chromium contexts", () => {
	test("denies a second context, reacquires fairly, and releases when its context closes", async () => {
		const build = await Bun.build({
			entrypoints: [
				new URL("./web-account-lease-chromium-harness.ts", import.meta.url)
					.pathname,
			],
			target: "browser",
			format: "esm",
		});
		expect(build.success).toBe(true);
		const script = await build.outputs[0].text();
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				return new URL(request.url).pathname === "/harness.js"
					? new Response(script, {
							headers: { "content-type": "text/javascript" },
						})
					: new Response('<script type="module" src="/harness.js"></script>', {
							headers: { "content-type": "text/html" },
						});
			},
		});
		servers.push(server);
		const browser = await chromium.launch({ headless: true });
		try {
			const context = await browser.newContext();
			const first = await context.newPage();
			const second = await context.newPage();
			const url = `http://127.0.0.1:${server.port}/`;
			await Promise.all([first.goto(url), second.goto(url)]);
			await Promise.all([
				first.waitForFunction(() => "acquireAccountLease" in globalThis),
				second.waitForFunction(() => "acquireAccountLease" in globalThis),
			]);

			expect(
				await first.evaluate(() => globalThis.acquireAccountLease("account-a")),
			).toBe(true);
			expect(
				await second.evaluate(() =>
					globalThis.acquireAccountLease("account-a"),
				),
			).toBe(false);
			await first.evaluate(() => globalThis.releaseAccountLease("account-a"));
			expect(
				await second.evaluate(() =>
					globalThis.acquireAccountLease("account-a"),
				),
			).toBe(true);
			expect(
				await second.evaluate(() => globalThis.isAccountLeaseLive("account-a")),
			).toBe(true);

			await second.close();
			let reacquired = false;
			for (let attempt = 0; attempt < 100 && !reacquired; attempt += 1) {
				reacquired = await first.evaluate(() =>
					globalThis.acquireAccountLease("account-a"),
				);
				if (!reacquired) {
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
			}
			expect(reacquired).toBe(true);
			await first.evaluate(() => globalThis.releaseAccountLease("account-a"));
			await context.close();
		} finally {
			await browser.close();
		}
	}, 15_000);
});

declare global {
	var acquireAccountLease: (accountId: string) => Promise<boolean>;
	var isAccountLeaseLive: (accountId: string) => boolean;
	var releaseAccountLease: (accountId: string) => void;
}
