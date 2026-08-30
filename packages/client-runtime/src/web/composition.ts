/**
 * The Web main-thread composition root: one Worker, one owner, every channel.
 *
 * A second owner would mean a second Worker and therefore a second Crypto key table, and a
 * `KeyRef` minted by one table is rejected by the other. The host keeps exactly one of these
 * at module scope, above React, and hands out this owner's channels.
 *
 * Nothing here starts the Worker. `createSharedWorkerOwner` spawns it on the first request,
 * which is what lets the Web build prerender its HTML without a Worker global.
 */

import {
	commitWebAttachmentDownloadRuntimeIncarnation,
	isAttachmentDownloadSinkCleanupHostRequest,
	isAttachmentDownloadSinkHostRequest,
	isAttachmentDownloadSinkRuntimeScopeRequest,
	prepareWebAttachmentDownloadRuntimeIncarnation,
	WebAttachmentDownloadSinkRegistry,
} from "../web-attachment-download-sink";

export type {
	AtomicAttachmentDownloadSink,
	AttachmentDownloadSinkGrant,
} from "../web-attachment-download-sink";

import { WebPlatformStorageHost } from "../web-platform-storage-host";
import {
	createSharedWorkerOwner,
	type SharedWorkerHandle,
	type SharedWorkerOwner,
	type WorkerRpcChannel,
} from "../worker/owner";
import { createWorkerRuntime, type WorkerRuntime } from "../worker-runtime";

export {
	decodeRuntimeClientIdentity,
	encodeRuntimeClientIdentity,
} from "./client-identity";

export interface WebClientRuntimeDeps {
	/**
	 * Spawns the Worker. The host passes a factory rather than a URL because a bundler only
	 * recognises a Worker entry when `new URL("./entry.ts", import.meta.url)` appears
	 * literally inside `new Worker(...)`; behind a variable it emits no chunk and the URL
	 * resolves to nothing. The literal therefore stays in the host module that owns the
	 * entry, and a test passes an in-process double through the same seam.
	 */
	createWorker: () => SharedWorkerHandle;
	/** Overrides the platform-storage reverse RPC. Tests use it; production does not. */
	handleHostRequest?: (
		payload: unknown,
		signal: AbortSignal,
	) => Promise<unknown>;
}

export interface WebClientRuntime {
	runtime: WorkerRuntime;
	/** Shared Rust identity normalization, executed by the existing Runtime Worker WASM. */
	normalizeAccountEmail(value: string): Promise<string>;
	/** The Crypto channel. The host wraps it in a `CryptoPort`; ticket 22 removes it. */
	cryptoChannel: WorkerRpcChannel;
	attachmentDownloads: WebAttachmentDownloadSinkRegistry;
	workerOwner: SharedWorkerOwner;
	close(): Promise<void>;
}

export function createWebClientRuntime(
	deps: WebClientRuntimeDeps,
): WebClientRuntime {
	const platformStorage = new WebPlatformStorageHost();
	const attachmentDownloads = new WebAttachmentDownloadSinkRegistry();
	const fallbackHostRequest =
		deps.handleHostRequest ?? platformStorage.invoke.bind(platformStorage);
	const workerOwner = createSharedWorkerOwner({
		createWorker: deps.createWorker,
		handleHostRequest: (payload, signal) => {
			if (isAttachmentDownloadSinkRuntimeScopeRequest(payload)) {
				const transition =
					payload.phase === "prepare"
						? prepareWebAttachmentDownloadRuntimeIncarnation
						: commitWebAttachmentDownloadRuntimeIncarnation;
				return transition(attachmentDownloads, payload.runtimeIncarnation).then(
					() => payload.phase,
				);
			}
			if (isAttachmentDownloadSinkHostRequest(payload)) {
				if (signal.aborted)
					return Promise.reject(new Error("Sink request cancelled"));
				return attachmentDownloads.invoke(
					payload.controlRequestJson,
					payload.binaryChunk,
					payload.runtimeIncarnation,
				);
			}
			return fallbackHostRequest(payload, signal);
		},
		handleClosingHostRequest: (payload, signal) => {
			if (isAttachmentDownloadSinkRuntimeScopeRequest(payload)) {
				const transition =
					payload.phase === "prepare"
						? prepareWebAttachmentDownloadRuntimeIncarnation
						: commitWebAttachmentDownloadRuntimeIncarnation;
				return transition(attachmentDownloads, payload.runtimeIncarnation).then(
					() => payload.phase,
				);
			}
			if (
				!isAttachmentDownloadSinkCleanupHostRequest(payload) ||
				signal.aborted
			)
				return Promise.reject(new Error("Host request is fenced by close"));
			return attachmentDownloads.invoke(
				payload.controlRequestJson,
				undefined,
				payload.runtimeIncarnation,
			);
		},
		beforeWorkerTerminate: () => attachmentDownloads.drainClose(),
		preserveHostRequestDuringClose: (payload) =>
			isAttachmentDownloadSinkHostRequest(payload) ||
			isAttachmentDownloadSinkRuntimeScopeRequest(payload),
	});
	let closeTask: Promise<void> | undefined;
	const close = (): Promise<void> => {
		attachmentDownloads.beginClose();
		if (closeTask !== undefined) return closeTask;
		const closing = workerOwner.close().then(
			() => attachmentDownloads.drainClose(),
			async (error) => {
				await attachmentDownloads.drainClose();
				throw error;
			},
		);
		closeTask = closing;
		void closing.catch(() => {
			if (closeTask === closing) closeTask = undefined;
		});
		return closing;
	};
	const runtime = createWorkerRuntime(workerOwner.channel("runtime"), close);
	return {
		workerOwner,
		attachmentDownloads,
		cryptoChannel: workerOwner.channel("crypto"),
		runtime,
		normalizeAccountEmail: runtime.normalizeAccountEmail,
		close,
	};
}
