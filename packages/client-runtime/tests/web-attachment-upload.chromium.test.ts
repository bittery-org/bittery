import { afterAll, describe, expect, test } from "bun:test";
import { chromium } from "../../../apps/extension/node_modules/playwright/index.mjs";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterAll(() => {
	for (const server of servers) server.stop(true);
});

describe("Attachment Upload joined production path in actual Chromium", () => {
	test("runs generated UploadAttachment through the Worker, registries, real Core, HTTP, storage, and binary executor", async () => {
		const [harnessBuild, workerBuild] = await Promise.all([
			Bun.build({
				entrypoints: [
					new URL(
						"./web-attachment-upload-chromium-harness.ts",
						import.meta.url,
					).pathname,
				],
				target: "browser",
				format: "esm",
			}),
			Bun.build({
				entrypoints: [
					new URL("./web-attachment-upload-worker.ts", import.meta.url)
						.pathname,
				],
				target: "browser",
				format: "esm",
			}),
		]);
		expect(harnessBuild.success).toBe(true);
		expect(workerBuild.success).toBe(true);
		const harnessScript = await harnessBuild.outputs[0].text();
		const workerScript = await workerBuild.outputs[0].text();
		const bindingsRoot = process.env.BITTERY_JOINED_UPLOAD_BINDINGS_ROOT;
		if (bindingsRoot === undefined)
			throw new Error("joined Upload generated bindings are unavailable");
		const realCoreBindings = await Bun.file(`${bindingsRoot}/index.js`).text();
		const realCoreWasm = await Bun.file(
			`${bindingsRoot}/index_bg.wasm`,
		).arrayBuffer();
		let itemAuthority: Record<string, unknown> | undefined;
		let attachmentAuthority: Record<string, unknown> | undefined;
		const routes: string[] = [];
		let uploadedBytes: number[] = [];
		let uploadDigest = "";
		let metadata: Record<string, unknown> = {};
		const json = (value: unknown, init: ResponseInit = {}) =>
			Response.json(value, {
				...init,
				headers: { "access-control-allow-origin": "*", ...init.headers },
			});
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				if (request.method === "OPTIONS")
					return new Response(null, {
						headers: {
							"access-control-allow-origin": "*",
							"access-control-allow-methods": "GET,POST,PUT,OPTIONS",
							"access-control-allow-headers": "*",
						},
					});
				if (url.pathname === "/harness.js")
					return new Response(harnessScript, {
						headers: { "content-type": "text/javascript" },
					});
				if (url.pathname === "/upload-worker.js")
					return new Response(workerScript, {
						headers: { "content-type": "text/javascript" },
					});
				if (url.pathname === "/real-core-bindings.js")
					return new Response(realCoreBindings, {
						headers: { "content-type": "text/javascript" },
					});
				if (url.pathname === "/real-core.wasm")
					return new Response(realCoreWasm, {
						headers: { "content-type": "application/wasm" },
					});
				if (url.pathname === "/upload-authority" && request.method === "POST") {
					itemAuthority = (await request.json()) as Record<string, unknown>;
					return json({ seeded: true });
				}
				if (url.pathname === "/upload-observation")
					return json({ routes, uploadedBytes, uploadDigest, metadata });
				if (url.pathname.endsWith("/attachment-uploads")) {
					routes.push("grant");
					return json({
						attachmentId: "attachment-uploaded",
						key: "attachments/uploaded",
						uploadUrl: `${url.origin}/binary-upload`,
					});
				}
				if (url.pathname === "/binary-upload" && request.method === "PUT") {
					routes.push("binary-put");
					uploadedBytes = [...new Uint8Array(await request.arrayBuffer())];
					uploadDigest = request.headers.get("x-amz-content-sha256") ?? "";
					return new Response(null, {
						status: 200,
						headers: { "access-control-allow-origin": "*" },
					});
				}
				if (
					url.pathname.endsWith("/attachments") &&
					request.method === "POST"
				) {
					routes.push("metadata-create");
					metadata = (await request.json()) as Record<string, unknown>;
					attachmentAuthority = {
						id: metadata.attachmentId,
						itemId: "item-existing",
						vaultId: "vault-1",
						storageKey: metadata.storageKey,
						encryptedName: metadata.encryptedName,
						encryptionIv: metadata.encryptionIv,
						encryptionAlgorithm: metadata.encryptionAlgorithm,
						encryptedAttachmentKey: metadata.encryptedAttachmentKey,
						attachmentKeyIv: metadata.attachmentKeyIv,
						attachmentKeyAlgorithm: metadata.attachmentKeyAlgorithm,
						encryptedContentType: metadata.encryptedContentType,
						encryptedContentTypeIv: metadata.encryptedContentTypeIv,
						envelopeVersion: metadata.envelopeVersion,
						fileSize: metadata.fileSize,
						uploadedBy: "user-1",
						createdAt: "2026-08-30T00:00:00Z",
					};
					return json({ attachmentId: "attachment-uploaded" });
				}
				if (url.pathname.endsWith("/attachments") && request.method === "GET") {
					routes.push("attachment-authority");
					return json({
						items:
							attachmentAuthority === undefined ? [] : [attachmentAuthority],
						hasMore: false,
						nextCursor: null,
					});
				}
				if (url.pathname.endsWith("/items/item-existing")) {
					routes.push("item-authority");
					return json(itemAuthority);
				}
				return new Response(
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
				() => "exerciseAttachmentUpload" in globalThis,
			);
			const earlyExits = await page.evaluate(() =>
				globalThis.exerciseAttachmentUploadEarlyExits(),
			);
			expect(earlyExits).toEqual(
				Object.fromEntries(
					[
						"account-missing",
						"item-missing",
						"read-only",
						"optimistic",
						"cancelled",
					].map((failure) => [
						failure,
						{
							failed: true,
							registryRequests: ["claim", "close"],
							reads: 0,
							closes: 1,
						},
					]),
				),
			);
			const result = await page.evaluate(() =>
				globalThis.exerciseAttachmentUpload(),
			);
			expect(result).toEqual({
				response: {
					type: "succeeded",
					value: {
						type: "attachmentUploaded",
						attachmentId: "attachment-uploaded",
						replicaRevision: "3",
					},
				},
				routes: [
					"grant",
					"binary-put",
					"metadata-create",
					"item-authority",
					"attachment-authority",
				],
				uploadedByteLength: 130,
				uploadDigestMatches: true,
				metadataClosed: true,
				sourceReads: 2,
				sourceCloses: 1,
				mainChunksDetached: true,
				reconciledAttachment: {
					accountId: "account-1",
					attachmentId: "attachment-uploaded",
					contentType: "text/plain",
					createdAt: "2026-08-30T00:00:00Z",
					fileSize: 19,
					itemId: "item-existing",
					name: "joined.txt",
					uploadedBy: "user-1",
					vaultId: "vault-1",
				},
			});
		} finally {
			await browser.close();
		}
	}, 30_000);
});

declare global {
	var exerciseAttachmentUpload: () => Promise<unknown>;
}
