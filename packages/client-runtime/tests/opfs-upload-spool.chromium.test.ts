import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "../../../apps/extension/node_modules/playwright/index.mjs";

const temporaryPaths: string[] = [];

afterAll(async () => {
	await Promise.all(
		temporaryPaths.map((temporaryPath) =>
			rm(temporaryPath, { recursive: true, force: true }),
		),
	);
});

describe("OPFS upload spool in an actual MV3 service worker", () => {
	test("Chromium emits exact Content-Length for the OPFS File without a script-set forbidden header", async () => {
		let markUploadObserved = () => {};
		const uploadObserved = new Promise<void>((resolve) => {
			markUploadObserved = resolve;
		});
		let releaseUploadResponse = () => {};
		const uploadResponseReleased = new Promise<void>((resolve) => {
			releaseUploadResponse = resolve;
		});
		let markWipeStarted = () => {};
		const wipeStarted = new Promise<void>((resolve) => {
			markWipeStarted = resolve;
		});
		let wipeFinished = false;
		let observed:
			| {
					body: number[];
					contentLength: string | null;
					contentType: string | null;
					contentSha256: string | null;
			  }
			| undefined;
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const pathname = new URL(request.url).pathname;
				if (pathname === "/wipe-started") {
					markWipeStarted();
					return new Response(null, { status: 204 });
				}
				if (pathname === "/wipe-finished") {
					wipeFinished = true;
					return new Response(null, { status: 204 });
				}
				observed = {
					body: Array.from(new Uint8Array(await request.arrayBuffer())),
					contentLength: request.headers.get("content-length"),
					contentType: request.headers.get("content-type"),
					contentSha256: request.headers.get("x-amz-content-sha256"),
				};
				markUploadObserved();
				await uploadResponseReleased;
				return new Response(null, { status: 204 });
			},
		});

		const extensionDirectory = await mkdtemp(
			path.join(tmpdir(), "bittery-opfs-mv3-"),
		);
		const userDataDirectory = await mkdtemp(
			path.join(tmpdir(), "bittery-opfs-profile-"),
		);
		temporaryPaths.push(extensionDirectory, userDataDirectory);
		const build = await Bun.build({
			entrypoints: [
				path.join(import.meta.dir, "opfs-upload-spool-mv3-harness.ts"),
			],
			target: "browser",
			format: "esm",
			minify: false,
		});
		expect(build.success).toBe(true);
		await Bun.write(
			path.join(extensionDirectory, "background.js"),
			await build.outputs[0].text(),
		);
		await Bun.write(
			path.join(extensionDirectory, "manifest.json"),
			JSON.stringify({
				manifest_version: 3,
				name: "Bittery OPFS upload spool acceptance fixture",
				version: "1.0.0",
				background: { service_worker: "background.js", type: "module" },
				host_permissions: [`http://127.0.0.1:${server.port}/*`],
			}),
		);

		const context = await chromium.launchPersistentContext(userDataDirectory, {
			headless: false,
			args: [
				`--disable-extensions-except=${extensionDirectory}`,
				`--load-extension=${extensionDirectory}`,
				"--no-sandbox",
			],
		});
		try {
			const worker =
				context.serviceWorkers()[0] ??
				(await context.waitForEvent("serviceworker"));
			const fixtureUrl = `http://127.0.0.1:${server.port}`;
			const networkResult = worker.evaluate(
				async ({ uploadUrl, contentSha256 }) =>
					globalThis.runOpfsUploadSpoolNetworkTest(uploadUrl, contentSha256),
				{
					uploadUrl: `${fixtureUrl}/upload`,
					contentSha256:
						"7192385c3c0605de55bb9476ce1d90748190ecb32a8eed7f5207b30cf6a1fe89",
				},
			);
			await uploadObserved;
			const concurrentWipe = worker.evaluate(
				async ({ fixtureUrl }) =>
					globalThis.runConcurrentOpfsUploadSpoolWipe(fixtureUrl),
				{ fixtureUrl },
			);
			await wipeStarted;
			const wipeState = await Promise.race([
				concurrentWipe.then(() => "finished" as const),
				new Promise<"blocked">((resolve) =>
					setTimeout(() => resolve("blocked"), 50),
				),
			]);
			expect(wipeState).toBe("blocked");
			expect(wipeFinished).toBe(false);
			releaseUploadResponse();
			const result = await networkResult;
			await concurrentWipe;
			expect(wipeFinished).toBe(true);

			expect(result).toEqual({
				fileSize: 6,
				scriptHeaderNames: ["content-type", "x-amz-content-sha256"],
			});
			expect(observed).toEqual({
				body: [1, 2, 3, 4, 5, 6],
				contentLength: "6",
				contentType: "application/octet-stream",
				contentSha256:
					"7192385c3c0605de55bb9476ce1d90748190ecb32a8eed7f5207b30cf6a1fe89",
			});
		} finally {
			releaseUploadResponse();
			await context.close();
			server.stop(true);
		}
	}, 30_000);
});
