import { afterAll, describe, expect, test } from "bun:test";
import { chromium } from "../../../apps/extension/node_modules/playwright/index.mjs";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterAll(() => {
	for (const server of servers) server.stop(true);
});

async function chromiumHarness() {
	const build = await Bun.build({
		entrypoints: [
			new URL(
				"./web-attachment-download-sink-chromium-harness.ts",
				import.meta.url,
			).pathname,
		],
		target: "browser",
		format: "esm",
	});
	expect(build.success).toBe(true);
	const script = await build.outputs[0].text();
	const workerBuild = await Bun.build({
		entrypoints: [
			new URL("./web-attachment-download-sink-worker.ts", import.meta.url)
				.pathname,
		],
		target: "browser",
		format: "esm",
	});
	expect(workerBuild.success).toBe(true);
	const workerScript = await workerBuild.outputs[0].text();
	const realCoreBindings = await Bun.file(
		new URL(
			"../../crypto/wasm/generated/wasm-bindgen/index.js",
			import.meta.url,
		),
	).text();
	const realCoreWasm = await Bun.file(
		new URL(
			"../../crypto/wasm/generated/wasm-bindgen/index_bg.wasm",
			import.meta.url,
		),
	).arrayBuffer();
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const pathname = new URL(request.url).pathname;
			return pathname === "/harness.js"
				? new Response(script, {
						headers: { "content-type": "text/javascript" },
					})
				: pathname === "/worker.js"
					? new Response(workerScript, {
							headers: { "content-type": "text/javascript" },
						})
					: pathname === "/real-core-bindings.js"
						? new Response(realCoreBindings, {
								headers: { "content-type": "text/javascript" },
							})
						: pathname === "/real-core.wasm"
							? new Response(realCoreWasm, {
									headers: { "content-type": "application/wasm" },
								})
							: new Response(
									'<script type="module" src="/harness.js"></script>',
									{
										headers: { "content-type": "text/html" },
									},
								);
		},
	});
	servers.push(server);
	const browser = await chromium.launch({ headless: true });
	const page = await browser.newPage();
	await page.goto(`http://127.0.0.1:${server.port}/`);
	await page.waitForFunction(
		() => "exerciseAttachmentDownloadTimerProbe" in globalThis,
	);
	return { browser, page };
}

describe("Attachment Download production sink in actual Chromium", () => {
	test("requires an actually firing Worker timer before authenticated readiness", async () => {
		const { page, browser } = await chromiumHarness();
		try {
			for (const mode of ["missing", "throwing"]) {
				expect(
					await page.evaluate(
						(selected) =>
							globalThis.exerciseAttachmentDownloadTimerProbe(selected),
						mode,
					),
				).toEqual({ rejected: true, grantRejected: true });
			}
			expect(
				await page.evaluate(() =>
					globalThis.exerciseAttachmentDownloadTimerProbe("delayed"),
				),
			).toEqual({ rejected: false, grantRejected: false });
			expect(
				await page.evaluate(() =>
					globalThis.exerciseAttachmentDownloadTimerProbe("noop"),
				),
			).toEqual({
				pendingBeforeClose: true,
				closeCompleted: true,
				grantRejected: true,
			});
		} finally {
			await browser.close();
		}
	}, 20_000);

	test("a real Core open failure retires through Wipe and close before fresh reconstruction", async () => {
		const { page, browser } = await chromiumHarness();
		try {
			expect(
				await page.evaluate(() =>
					globalThis.exerciseAttachmentDownloadOpenFailureWipe(),
				),
			).toEqual({
				wipeComplete: true,
				freshDeviceState: true,
				grantSucceeded: true,
			});
		} finally {
			await browser.close();
		}
	}, 15_000);

	test("keeps writes provisional and enforces atomic scope, replay, and cleanup", async () => {
		const build = await Bun.build({
			entrypoints: [
				new URL(
					"./web-attachment-download-sink-chromium-harness.ts",
					import.meta.url,
				).pathname,
			],
			target: "browser",
			format: "esm",
		});
		expect(build.success).toBe(true);
		const script = await build.outputs[0].text();
		const workerBuild = await Bun.build({
			entrypoints: [
				new URL("./web-attachment-download-sink-worker.ts", import.meta.url)
					.pathname,
			],
			target: "browser",
			format: "esm",
		});
		expect(workerBuild.success).toBe(true);
		const workerScript = await workerBuild.outputs[0].text();
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const pathname = new URL(request.url).pathname;
				return pathname === "/harness.js"
					? new Response(script, {
							headers: { "content-type": "text/javascript" },
						})
					: pathname === "/worker.js"
						? new Response(workerScript, {
								headers: { "content-type": "text/javascript" },
							})
						: pathname === "/attachment"
							? new Response(new Uint8Array([1, 2, 3, 4, 5]))
							: pathname === "/held"
								? new Response(new ReadableStream())
								: new Response(
										'<script type="module" src="/harness.js"></script>',
										{
											headers: { "content-type": "text/html" },
										},
									);
			},
		});
		servers.push(server);
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage();
			await page.goto(`http://127.0.0.1:${server.port}/`);
			await page.waitForFunction(
				() => "exerciseAttachmentDownloadSink" in globalThis,
			);
			const result = await page.evaluate(() =>
				globalThis.exerciseAttachmentDownloadSink(
					`${location.origin}/attachment`,
				),
			);
			expect(result).toEqual({
				response: {
					type: "attachmentDownloaded",
					accountId: "account-one",
					attachmentId: "attachment-one",
					workerChunksDetached: true,
				},
				unpublishedDuringWrites: true,
				mainChunksWiped: true,
				published: [1, 2, 3, 4, 5],
				provisional: [],
				discards: 0,
				cleanupDiscards: 1,
				cleanupProvisional: [],
			});
		} finally {
			await browser.close();
		}
	}, 15_000);
});

declare global {
	var exerciseAttachmentDownloadSink: () => Promise<unknown>;
}
