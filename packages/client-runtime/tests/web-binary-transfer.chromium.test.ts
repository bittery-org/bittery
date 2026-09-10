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

describe("binary transfer adapter in an actual MV3 service worker", () => {
	test("uses an OPFS File PUT whose UA length and lock survive a cancelled held response", async () => {
		type Observed = {
			body: number[];
			contentLength: string | null;
			contentType: string | null;
			contentSha256: string | null;
		};
		const observed = new Map<string, Observed>();
		const arrivals = new Map<string, () => void>();
		const arrivalPromises = new Map<string, Promise<void>>();
		const releases = new Map<string, () => void>();
		const releasePromises = new Map<string, Promise<void>>();
		for (const id of ["first", "second", "foreground"]) {
			arrivalPromises.set(
				id,
				new Promise((resolve) => arrivals.set(id, resolve)),
			);
			releasePromises.set(
				id,
				new Promise((resolve) => releases.set(id, resolve)),
			);
		}
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const id = new URL(request.url).searchParams.get("transfer") ?? "";
				observed.set(id, {
					body: Array.from(new Uint8Array(await request.arrayBuffer())),
					contentLength: request.headers.get("content-length"),
					contentType: request.headers.get("content-type"),
					contentSha256: request.headers.get("x-amz-content-sha256"),
				});
				arrivals.get(id)?.();
				await Promise.race([
					releasePromises.get(id),
					new Promise<void>((resolve) =>
						request.signal.addEventListener("abort", () => resolve(), {
							once: true,
						}),
					),
				]);
				return new Response(null, { status: 204 });
			},
		});

		const extensionDirectory = await mkdtemp(
			path.join(tmpdir(), "bittery-transfer-mv3-"),
		);
		const userDataDirectory = await mkdtemp(
			path.join(tmpdir(), "bittery-transfer-profile-"),
		);
		temporaryPaths.push(extensionDirectory, userDataDirectory);
		const build = await Bun.build({
			entrypoints: [
				path.join(import.meta.dir, "web-binary-transfer-mv3-harness.ts"),
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
				name: "Bittery binary transfer acceptance fixture",
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
			const uploadUrl = `http://127.0.0.1:${server.port}/upload`;
			await worker.evaluate(
				({ uploadUrl }) =>
					globalThis.startBinaryTransferUpload(
						"first",
						uploadUrl,
						"generation-first",
					),
				{ uploadUrl },
			);
			await arrivalPromises.get("first");

			const secondStart = worker.evaluate(
				({ uploadUrl }) =>
					globalThis.startBinaryTransferUpload(
						"second",
						uploadUrl,
						"generation-second",
					),
				{ uploadUrl },
			);
			const secondState = await Promise.race([
				arrivalPromises.get("second")?.then(() => "arrived" as const),
				new Promise<"blocked">((resolve) =>
					setTimeout(() => resolve("blocked"), 50),
				),
			]);
			expect(secondState).toBe("blocked");

			const cancelled = await worker.evaluate(() =>
				globalThis.cancelBinaryTransferUpload("first"),
			);
			expect(cancelled).toEqual({
				cancel: { type: "cancelled" },
				finish: { type: "cancelled" },
			});
			await arrivalPromises.get("second");
			releases.get("second")?.();
			await secondStart;
			const completed = await worker.evaluate(() =>
				globalThis.awaitBinaryTransferUpload("second"),
			);
			expect(completed).toEqual({
				finish: { type: "uploadFinished" },
				scriptHeaderNames: ["content-type", "x-amz-content-sha256"],
			});
			const foreground = worker.evaluate(
				({ uploadUrl }) =>
					globalThis.runForegroundAttachmentUpload(
						"account-browser",
						"attachment-browser",
						uploadUrl,
					),
				{ uploadUrl },
			);
			await arrivalPromises.get("foreground");
			releases.get("foreground")?.();
			expect(await foreground).toEqual({
				type: "uploaded",
				ciphertextSha256:
					"787c798e39a5bc1910355bae6d0cd87a36b2e10fd0202a83e3bb6b005da83472",
			});
			for (const id of ["first", "second"]) {
				expect(observed.get(id)).toEqual({
					body: [1, 2, 3],
					contentLength: "3",
					contentType: "application/octet-stream",
					contentSha256:
						"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
				});
			}
			expect(observed.get("foreground")).toEqual({
				body: [4, 5, 6],
				contentLength: "3",
				contentType: "application/octet-stream",
				contentSha256:
					"787c798e39a5bc1910355bae6d0cd87a36b2e10fd0202a83e3bb6b005da83472",
			});
		} finally {
			releases.get("first")?.();
			releases.get("second")?.();
			releases.get("foreground")?.();
			await context.close();
			server.stop(true);
		}
	}, 30_000);
});
