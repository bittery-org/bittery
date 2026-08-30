import { takeFullOwnedUint8ArrayIntrinsic } from "../src/binary-intrinsics";
import { IndexedDbAttachmentArtifactExecutor } from "../src/indexeddb-attachment-artifact-executor";
import { IndexedDbReplicaExecutor } from "../src/indexeddb-executor";
import { createWebClientRuntime } from "../src/web/composition";
import { WebAccountLeaseExecutor } from "../src/web-account-lease-executor";
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

type SinkState = {
	provisional: number[];
	published?: number[];
	discards: number;
	publishedDuringWrite: boolean;
	retained: Uint8Array[];
};

function sink(state: SinkState) {
	return {
		write: async (bytes: Uint8Array) => {
			state.retained.push(bytes);
			state.publishedDuringWrite ||= state.published !== undefined;
			state.provisional.push(...bytes);
		},
		commit: async () => {
			state.published = [...state.provisional];
			state.provisional.length = 0;
		},
		discard: async () => {
			state.provisional.length = 0;
			state.discards += 1;
		},
	};
}

Object.assign(globalThis, {
	async exerciseAttachmentDownloadOpenFailureWipe() {
		const bindingsUrl = "/real-core-bindings.js";
		const bindings = await import(bindingsUrl);
		await bindings.default({ module_or_path: "/real-core.wasm" });
		localStorage.setItem(
			"bittery:runtime:platform-storage:device-catalog",
			JSON.stringify({
				version: 1,
				accounts: [
					{
						accountId: "wedged-account",
						activeIncarnation: "wedged-incarnation",
						pendingInstall: null,
					},
				],
			}),
		);
		const replica = new IndexedDbReplicaExecutor();
		const platform = new WebPlatformStorageHost();
		const registry = new WebAttachmentDownloadSinkRegistry();
		const uploadRegistry = new WebAttachmentUploadSourceRegistry();
		const construct = async (scope: string) => {
			await prepareWebAttachmentDownloadRuntimeIncarnation(registry, scope);
			await prepareWebAttachmentUploadRuntimeIncarnation(uploadRegistry, scope);
			return bindings.WebClientRuntime.withConfiguredAttachmentMovePreparation(
				replica.invoke.bind(replica),
				platform.invoke.bind(platform),
				async () => '{"type":"networkFailure"}',
				() => undefined,
				new IndexedDbAttachmentArtifactExecutor(),
				new WebBinaryTransferExecutor(),
				new WebAccountLeaseExecutor(),
				"chromium-real-core",
				"web",
				"1",
				() => undefined,
				{
					invoke: (controlRequestJson: string, binaryChunk?: Uint8Array) =>
						registry.invoke(controlRequestJson, binaryChunk, scope),
				},
				{
					invoke: (controlRequestJson: string) =>
						uploadRegistry.invoke(controlRequestJson, scope),
				},
				takeFullOwnedUint8ArrayIntrinsic,
			);
		};
		const wedged = await construct("real-core-one");
		let openFailed = false;
		try {
			await wedged.open();
		} catch {
			openFailed = true;
		}
		const wipe = JSON.parse(
			await wedged.request_json("wipe", '{"type":"wipe"}'),
		) as {
			type: string;
			value?: { type: string; status: string };
		};
		await wedged.close();
		const fresh = await construct("real-core-two");
		await fresh.open();
		await commitWebAttachmentDownloadRuntimeIncarnation(
			registry,
			"real-core-two",
		);
		await commitWebAttachmentUploadRuntimeIncarnation(
			uploadRegistry,
			"real-core-two",
		);
		const freshProjection = await new Promise<Record<string, unknown>>(
			(resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error("fresh Runtime observation timed out")),
					1_000,
				);
				fresh.observe_json(
					"fresh-device",
					'{"type":"runtimeStatus","accountId":null}',
					(projectionJson: string) => {
						clearTimeout(timeout);
						resolve(JSON.parse(projectionJson) as Record<string, unknown>);
					},
				);
			},
		);
		fresh.unobserve("fresh-device");
		let grantSucceeded = true;
		let uploadGrantSucceeded = true;
		try {
			registry.grant({
				accountId: "account-one",
				attachmentId: "attachment-one",
				sink: sink({
					provisional: [],
					discards: 0,
					publishedDuringWrite: false,
					retained: [],
				}),
			});
		} catch {
			grantSucceeded = false;
		}
		try {
			uploadRegistry.grant({
				accountId: "account-one",
				itemId: "item-one",
				name: "report.txt",
				contentType: "text/plain",
				expectedBytes: 1n,
				source: { read: async () => null, close: async () => {} },
			});
		} catch {
			uploadGrantSucceeded = false;
		}
		await fresh.close();
		const freshStatus = freshProjection.value as
			| Record<string, unknown>
			| undefined;
		return {
			wipeComplete:
				openFailed &&
				wipe.type === "succeeded" &&
				wipe.value?.type === "teardown" &&
				wipe.value.status === "complete",
			freshDeviceState:
				freshProjection.type === "runtimeStatus" &&
				Array.isArray(freshStatus?.accounts) &&
				freshStatus.accounts.length === 0 &&
				freshStatus.closed === false,
			grantSucceeded: grantSucceeded && uploadGrantSucceeded,
		};
	},
	async exerciseAttachmentDownloadTimerProbe(mode: string) {
		const composition = createWebClientRuntime({
			createWorker: () =>
				new Worker(`/worker.js?timer=${encodeURIComponent(mode)}`, {
					type: "module",
				}),
		});
		let settled = false;
		const warmup = composition.runtime
			.request("warmup", "warmup")
			.finally(() => {
				settled = true;
			});
		if (mode === "noop") {
			await new Promise((resolve) => setTimeout(resolve, 100));
			const pendingBeforeClose = !settled;
			let closeCompleted = false;
			await Promise.race([
				composition.close().then(() => {
					closeCompleted = true;
				}),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("close timed out")), 1_000),
				),
			]);
			await warmup.catch(() => undefined);
			let grantRejected = false;
			try {
				composition.attachmentDownloads.grant({
					accountId: "account-one",
					attachmentId: "attachment-one",
					sink: sink({
						provisional: [],
						discards: 0,
						publishedDuringWrite: false,
						retained: [],
					}),
				});
			} catch {
				grantRejected = true;
			}
			return { pendingBeforeClose, closeCompleted, grantRejected };
		}
		let rejected = false;
		try {
			await warmup;
		} catch {
			rejected = true;
		}
		let grantRejected = false;
		try {
			composition.attachmentDownloads.grant({
				accountId: "account-one",
				attachmentId: "attachment-one",
				sink: sink({
					provisional: [],
					discards: 0,
					publishedDuringWrite: false,
					retained: [],
				}),
			});
		} catch {
			grantRejected = true;
		}
		await composition.close();
		return { rejected, grantRejected };
	},
	async exerciseAttachmentDownloadSink(downloadUrl: string) {
		const composition = createWebClientRuntime({
			createWorker: () => new Worker("/worker.js", { type: "module" }),
		});
		const state: SinkState = {
			provisional: [],
			discards: 0,
			publishedDuringWrite: false,
			retained: [],
		};
		await composition.runtime.request("warmup", "warmup");
		const capabilityId = composition.attachmentDownloads.grant({
			accountId: "account-one",
			attachmentId: "attachment-one",
			sink: sink(state),
		});
		const response = JSON.parse(
			await composition.runtime.request(
				"download-one",
				JSON.stringify({
					type: "downloadAttachment",
					accountId: "account-one",
					attachmentId: "attachment-one",
					sinkCapabilityId: capabilityId,
					downloadUrl,
				}),
			),
		);
		const unpublishedDuringWrites = !state.publishedDuringWrite;
		const mainChunksWiped = state.retained.every((bytes) =>
			bytes.every((byte) => byte === 0),
		);
		const cleanup: SinkState = {
			provisional: [],
			discards: 0,
			publishedDuringWrite: false,
			retained: [],
		};
		const cleanupCapabilityId = composition.attachmentDownloads.grant({
			accountId: "account-one",
			attachmentId: "attachment-two",
			sink: sink(cleanup),
		});
		const cancelled = composition.runtime
			.request(
				"download-cancelled",
				JSON.stringify({
					type: "downloadAttachment",
					accountId: "account-one",
					attachmentId: "attachment-two",
					sinkCapabilityId: cleanupCapabilityId,
					downloadUrl: `${new URL(downloadUrl).origin}/held`,
				}),
			)
			.catch(() => undefined);
		await new Promise((resolve) => setTimeout(resolve, 25));
		await composition.close();
		await cancelled;
		return {
			response,
			published: state.published,
			provisional: state.provisional,
			discards: state.discards,
			unpublishedDuringWrites,
			mainChunksWiped,
			cleanupDiscards: cleanup.discards,
			cleanupProvisional: cleanup.provisional,
		};
	},
});

declare global {
	var exerciseAttachmentDownloadSink: (downloadUrl: string) => Promise<unknown>;
	var exerciseAttachmentDownloadTimerProbe: (mode: string) => Promise<unknown>;
	var exerciseAttachmentDownloadOpenFailureWipe: () => Promise<unknown>;
}
