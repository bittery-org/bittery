import { takeFullOwnedUint8ArrayIntrinsic } from "../src/binary-intrinsics";
import { IndexedDbAttachmentArtifactExecutor } from "../src/indexeddb-attachment-artifact-executor";
import { IndexedDbReplicaExecutor } from "../src/indexeddb-executor";
import { IndexedDbVaultImageArtifactExecutor } from "../src/indexeddb-vault-image-artifact-executor";
import {
	WebAccountLeaseExecutor,
	type WebAccountLeaseHandle,
} from "../src/web-account-lease-executor";
import {
	commitWebAttachmentDownloadRuntimeIncarnation,
	prepareWebAttachmentDownloadRuntimeIncarnation,
	WebAttachmentDownloadSinkRegistry,
} from "../src/web-attachment-download-sink";
import {
	commitWebAttachmentUploadRuntimeIncarnation,
	prepareWebAttachmentUploadRuntimeIncarnation,
	WebAttachmentUploadSourceRegistry,
} from "../src/web-attachment-upload-source";
import { WebBinaryTransferExecutor } from "../src/web-binary-transfer-executor";
import { WebPlatformStorageHost } from "../src/web-platform-storage-host";
import { WebStorageFamily } from "../src/web-storage-family";
import {
	activateWebVaultImageSourceRegistry,
	WebVaultImageSourceRegistry,
} from "../src/web-vault-image-source";
import type { RuntimeWasm, WebClientRuntimeLike } from "../src/worker-runtime";

type SweepRuntime = WebClientRuntimeLike & {
	seedAttachmentSweepTestAuthority(serverUrl: string): Promise<void>;
};
const accountId = "account-1";
const orphan = {
	accountId,
	operationId: "unowned-sweep-operation",
	attachmentId: "unowned-sweep-attachment",
	generation: crypto.randomUUID(),
};
const leases = new WebAccountLeaseExecutor();
const artifacts = new IndexedDbAttachmentArtifactExecutor();
const images = new IndexedDbVaultImageArtifactExecutor();
const family = new WebStorageFamily(() => images.close());
let runtime: SweepRuntime | undefined;
let competitor: WebAccountLeaseHandle | null = null;
let releaseDeletion!: () => void;
const heldDeletion = new Promise<void>((resolve) => {
	releaseDeletion = resolve;
});
let deletionEntered = false;
let deletionSettled = false;
let closeSettled = false;
let closeTask: Promise<void> | undefined;
const errors: string[] = [];

function result<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}
function done(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () => reject(transaction.error);
		transaction.onerror = () => reject(transaction.error);
	});
}
async function orphanRows() {
	const database = await result(indexedDB.open("bittery_attachment_artifacts"));
	try {
		const transaction = database.transaction(
			["provisional_artifacts", "provisional_chunks"],
			"readonly",
		);
		const completed = done(transaction);
		const key = [
			orphan.accountId,
			orphan.operationId,
			orphan.attachmentId,
			orphan.generation,
		];
		const [metadata, chunks] = await Promise.all([
			result(transaction.objectStore("provisional_artifacts").count(key)),
			result(
				transaction
					.objectStore("provisional_chunks")
					.index("by_generation")
					.count(key),
			),
		]);
		await completed;
		return { metadata, chunks };
	} finally {
		database.close();
	}
}

async function seedOrphan() {
	const begun = await family.runNormal(() =>
		artifacts.invoke(
			JSON.stringify({ type: "beginProvisional", writer: orphan }),
		),
	);
	if (JSON.parse(begun.controlResponseJson).type !== "provisionalBegun")
		throw new Error("Actual orphan Begin failed");
	const bytes = new Uint8Array(32).fill(71);
	const chunkSha256 = Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
	const written = await family.runNormal(() =>
		artifacts.invoke(
			JSON.stringify({
				type: "writeProvisionalChunk",
				writer: orphan,
				chunkIndex: 0,
				chunkSha256,
			}),
			bytes,
		),
	);
	if (JSON.parse(written.controlResponseJson).type !== "chunkWritten")
		throw new Error("Actual orphan bytes were not stored");
}

Object.assign(globalThis, {
	async sweepCloseStart() {
		await family.open();
		await seedOrphan();
		const before = await orphanRows();
		const bindingsUrl = "/real-core-bindings.js";
		const bindings = (await import(bindingsUrl)) as RuntimeWasm & {
			default(options: { module_or_path: string }): Promise<void>;
		};
		await bindings.default({ module_or_path: "/real-core.wasm" });
		const construct =
			bindings.WebClientRuntime.withConfiguredAttachmentMovePreparation;
		if (construct === undefined)
			throw new Error("Configured actual WASM is required");
		const replica = new IndexedDbReplicaExecutor();
		const platform = new WebPlatformStorageHost();
		const downloads = new WebAttachmentDownloadSinkRegistry();
		const uploads = new WebAttachmentUploadSourceRegistry();
		const imageSources = new WebVaultImageSourceRegistry();
		const incarnation = "sweep-close-runtime";
		await prepareWebAttachmentDownloadRuntimeIncarnation(
			downloads,
			incarnation,
		);
		await commitWebAttachmentDownloadRuntimeIncarnation(downloads, incarnation);
		await prepareWebAttachmentUploadRuntimeIncarnation(uploads, incarnation);
		await commitWebAttachmentUploadRuntimeIncarnation(uploads, incarnation);
		await activateWebVaultImageSourceRegistry(imageSources, incarnation);
		runtime = construct.call(
			bindings.WebClientRuntime,
			(json) => family.runNormal(() => replica.invoke(json)),
			platform.invoke.bind(platform),
			async () => '{"type":"networkFailure"}',
			() => undefined,
			{
				invoke: (json: string, bytes?: Uint8Array) =>
					family.runNormal(async () => {
						const request = JSON.parse(json) as {
							type: string;
							token?: Partial<typeof orphan>;
						};
						if (
							request.type === "deleteProvisionalGeneration" &&
							Object.entries(orphan).every(
								([key, value]) =>
									request.token?.[key as keyof typeof orphan] === value,
							) &&
							!deletionEntered
						) {
							// The real Rust sweep has invoked this deletion. Only its host
							// continuation is delayed; cancellation cannot undo this Promise.
							deletionEntered = true;
							await heldDeletion;
							try {
								return await artifacts.invoke(json, bytes);
							} finally {
								deletionSettled = true;
							}
						}
						return artifacts.invoke(json, bytes);
					}),
			},
			new WebBinaryTransferExecutor(),
			leases,
			"sweep-close-chromium",
			"web",
			"1",
			(error) => errors.push(error),
			{ invoke: (json, bytes) => downloads.invoke(json, bytes, incarnation) },
			{ invoke: (json) => uploads.invoke(json, incarnation) },
			takeFullOwnedUint8ArrayIntrinsic,
			{
				invoke: async (json, bytes) => {
					const response = await family.runNormal(() =>
						images.invoke(JSON.parse(json), bytes),
					);
					return { controlResponseJson: JSON.stringify(response) };
				},
			},
			{
				invoke: async (json) => {
					const { binaryChunk, ...control } = await imageSources.invoke(
						json,
						incarnation,
					);
					return {
						controlResponseJson: JSON.stringify(control),
						...(binaryChunk === undefined ? {} : { binaryChunk }),
					};
				},
			},
			incarnation,
		) as SweepRuntime;
		await runtime.open();
		await runtime.seedAttachmentSweepTestAuthority(location.origin);
		return before;
	},
	sweepCloseState() {
		return { deletionEntered, deletionSettled, closeSettled, errors };
	},
	sweepCloseBegin() {
		if (runtime === undefined) throw new Error("Runtime is not installed");
		closeTask ??= runtime
			.close()
			.then(() => family.close())
			.then(() => {
				closeSettled = true;
			});
		void closeTask.catch((error: unknown) => errors.push(String(error)));
	},
	async sweepCloseRelease() {
		releaseDeletion();
		await closeTask;
		return { rows: await orphanRows(), deletionSettled, closeSettled, errors };
	},
	async sweepCloseOpenCompetitor() {
		await family.open();
	},
	async sweepCloseTryAcquire() {
		competitor ??= await leases.acquire(accountId);
		return competitor !== null;
	},
	async sweepCloseCleanup() {
		releaseDeletion();
		competitor?.release();
		competitor = null;
		if (closeTask !== undefined) await closeTask;
		else await runtime?.close();
		await family.close();
	},
});
