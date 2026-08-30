import { createWebClientRuntime } from "../src/web/composition";

type UploadServerState = {
	routes: string[];
	uploadedBytes: number[];
	uploadDigest: string;
	metadata: Record<string, unknown>;
};

Object.assign(globalThis, {
	async exerciseAttachmentUploadEarlyExits(): Promise<unknown> {
		const results: Record<string, unknown> = {};
		for (const failure of [
			"account-missing",
			"item-missing",
			"read-only",
			"optimistic",
			"cancelled",
		]) {
			const mode =
				failure === "read-only" || failure === "optimistic"
					? failure
					: "writable";
			const composition = createWebClientRuntime({
				createWorker: () =>
					new Worker(`/upload-worker.js?mode=${mode}`, { type: "module" }),
			});
			const accountId =
				failure === "account-missing" ? "missing-account" : "account-1";
			const itemId =
				failure === "item-missing" ? "missing-item" : "item-existing";
			let reads = 0;
			let closes = 0;
			const registryRequests: string[] = [];
			const cancellation = new AbortController();
			const invoke = composition.attachmentUploads.invoke.bind(
				composition.attachmentUploads,
			);
			composition.attachmentUploads.invoke = async (...args) => {
				const type = (JSON.parse(args[0]) as { type: string }).type;
				registryRequests.push(type);
				const response = await invoke(...args);
				if (
					failure === "cancelled" &&
					type === "claim" &&
					JSON.parse(response.controlResponseJson).type === "claimed"
				)
					cancellation.abort();
				return response;
			};
			const observationId = `early-status-${failure}`;
			await composition.runtime.observe(
				observationId,
				'{"type":"runtimeStatus","accountId":null}',
				() => undefined,
			);
			const capabilityId = composition.attachmentUploads.grant({
				accountId,
				itemId,
				name: `${failure}.txt`,
				contentType: "text/plain",
				expectedBytes: 1n,
				source: {
					async read() {
						reads += 1;
						return new Uint8Array([1]);
					},
					async close() {
						closes += 1;
					},
				},
			});
			let failed = false;
			try {
				const response = JSON.parse(
					await composition.runtime.request(
						`early-${failure}`,
						JSON.stringify({
							type: "uploadAttachment",
							accountId,
							itemId,
							name: `${failure}.txt`,
							contentType: "text/plain",
							fileSize: "1",
							sourceCapabilityId: capabilityId,
						}),
						{ signal: cancellation.signal },
					),
				) as { type?: string };
				failed = response.type === "failed";
			} catch {
				failed = true;
			}
			await composition.runtime.unobserve(observationId);
			await composition.runtime.request(
				`early-wipe-${failure}`,
				'{"type":"wipe"}',
			);
			await composition.close();
			results[failure] = {
				failed,
				registryRequests: registryRequests.filter(
					(type) => type === "claim" || type === "read" || type === "close",
				),
				reads,
				closes,
			};
		}
		return results;
	},
	async exerciseAttachmentUpload(): Promise<unknown> {
		const composition = createWebClientRuntime({
			createWorker: () => new Worker("/upload-worker.js", { type: "module" }),
		});
		const plaintext = new TextEncoder().encode("joined upload bytes");
		const retainedChunks: Uint8Array[] = [];
		let reads = 0;
		let closes = 0;
		const projections: Array<Record<string, unknown>> = [];
		await composition.runtime.observe(
			"joined-upload-items",
			'{"type":"items","accountId":"account-1"}',
			(json) => projections.push(JSON.parse(json) as Record<string, unknown>),
		);
		const capabilityId = composition.attachmentUploads.grant({
			accountId: "account-1",
			itemId: "item-existing",
			name: "joined.txt",
			contentType: "text/plain",
			expectedBytes: BigInt(plaintext.byteLength),
			source: {
				async read(maxBytes) {
					reads += 1;
					if (reads > 1) return null;
					const chunk = plaintext.slice(0, maxBytes);
					retainedChunks.push(chunk);
					return chunk;
				},
				async close() {
					closes += 1;
				},
			},
		});

		const response = JSON.parse(
			await composition.runtime.request(
				"joined-upload",
				JSON.stringify({
					type: "uploadAttachment",
					accountId: "account-1",
					itemId: "item-existing",
					name: "joined.txt",
					contentType: "text/plain",
					fileSize: String(plaintext.byteLength),
					sourceCapabilityId: capabilityId,
				}),
			),
		) as Record<string, unknown>;
		await composition.runtime.unobserve("joined-upload-items");
		const server = (await fetch("/upload-observation").then((value) =>
			value.json(),
		)) as UploadServerState;
		await composition.close();
		const latest = projections.at(-1)?.value as
			| { items?: Array<{ attachments?: Array<Record<string, unknown>> }> }
			| undefined;
		return {
			response,
			routes: server.routes,
			uploadedByteLength: server.uploadedBytes.length,
			uploadDigestMatches:
				server.uploadDigest ===
				(await crypto.subtle
					.digest("SHA-256", Uint8Array.from(server.uploadedBytes))
					.then((digest) =>
						[...new Uint8Array(digest)]
							.map((byte) => byte.toString(16).padStart(2, "0"))
							.join(""),
					)),
			metadataClosed:
				server.metadata.attachmentId === "attachment-uploaded" &&
				server.metadata.fileSize === plaintext.byteLength &&
				typeof server.metadata.encryptedName === "string" &&
				server.metadata.encryptedName !== "joined.txt" &&
				typeof server.metadata.encryptedContentType === "string" &&
				server.metadata.encryptedContentType !== "text/plain",
			sourceReads: reads,
			sourceCloses: closes,
			mainChunksDetached: retainedChunks.every(
				(chunk) => chunk.byteLength === 0,
			),
			reconciledAttachment: latest?.items?.[0]?.attachments?.[0],
		};
	},
});

declare global {
	var exerciseAttachmentUpload: () => Promise<unknown>;
	var exerciseAttachmentUploadEarlyExits: () => Promise<unknown>;
}
