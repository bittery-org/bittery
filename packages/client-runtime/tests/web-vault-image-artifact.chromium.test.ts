import { afterAll, describe, expect, test } from "bun:test";
import { chromium } from "../../../apps/extension/node_modules/playwright/index.mjs";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterAll(() => {
	for (const server of servers) server.stop(true);
});
describe("Vault-image artifact in actual Chromium IndexedDB", () => {
	test("publishes exact bytes, wipes the transferred chunk, restarts, and sweeps orphans", async () => {
		const build = await Bun.build({
			entrypoints: [
				new URL(
					"./web-vault-image-artifact-chromium-harness.ts",
					import.meta.url,
				).pathname,
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
			const page = await browser.newPage();
			await page.goto(`http://127.0.0.1:${server.port}/`);
			await page.waitForFunction(
				() => "runVaultImageArtifactHistory" in globalThis,
			);
			expect(
				await page.evaluate(() => globalThis.runVaultImageArtifactHistory()),
			).toEqual([
				{ type: "begun" },
				{ type: "chunkWritten", result: "stored" },
				{ wipedTransferred: [0, 0, 0] },
				{ type: "published", result: "published" },
				{ type: "chunk", bytes: [97, 98, 99] },
				{ type: "swept" },
				{ type: "missing" },
			]);
		} finally {
			await browser.close();
		}
	}, 15_000);

	test("rejects conflicts and digest drift and serializes concurrent publication with rollback", async () => {
		const build = await Bun.build({
			entrypoints: [
				new URL(
					"./web-vault-image-artifact-chromium-harness.ts",
					import.meta.url,
				).pathname,
			],
			target: "browser",
			format: "esm",
		});
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
			const page = await browser.newPage();
			await page.goto(`http://127.0.0.1:${server.port}/`);
			await page.waitForFunction(
				() => "runVaultImageArtifactAdversarialHistory" in globalThis,
			);
			expect(
				await page.evaluate(() =>
					globalThis.runVaultImageArtifactAdversarialHistory(),
				),
			).toEqual({
				conflict: true,
				digestRejected: true,
				publicationStates: ["fulfilled", "rejected"],
				rolledBack: true,
				replay: { type: "chunkWritten", result: "stored" },
			});
		} finally {
			await browser.close();
		}
	}, 15_000);

	test("holds the real IndexedDB transaction across WebCrypto while another executor deletes and replaces the scope", async () => {
		const build = await Bun.build({
			entrypoints: [
				new URL(
					"./web-vault-image-artifact-chromium-harness.ts",
					import.meta.url,
				).pathname,
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
			const page = await browser.newPage();
			await page.goto(`http://127.0.0.1:${server.port}/`);
			await page.waitForFunction(
				() => "runVaultImageHeldDigestHistory" in globalThis,
			);
			expect(
				await page.evaluate(() => globalThis.runVaultImageHeldDigestHistory()),
			).toEqual({
				deletionBlockedDuringDigest: true,
				publicationAnswer: { type: "published", result: "published" },
				deletionAnswer: { type: "deleted" },
				replacementBegin: { type: "begun" },
				replacementWrite: { type: "chunkWritten", result: "stored" },
			});
		} finally {
			await browser.close();
		}
	}, 15_000);
});
declare global {
	var runVaultImageArtifactHistory: () => Promise<unknown>;
	var runVaultImageArtifactAdversarialHistory: () => Promise<unknown>;
	var runVaultImageHeldDigestHistory: () => Promise<unknown>;
}
