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
	isAttachmentDownloadSinkCleanupHostRequest,
	isAttachmentDownloadSinkHostRequest,
	isAttachmentDownloadSinkRuntimeScopeRequest,
	WebAttachmentDownloadSinkRegistry,
} from "../web-attachment-download-sink";
import {
	isAttachmentUploadSourceHostRequest,
	WebAttachmentUploadSourceRegistry,
} from "../web-attachment-upload-source";
import {
	isVaultImageSourceHostRequest,
	type VaultImageSourceGrant,
} from "../web-vault-image-source";

export type {
	AtomicAttachmentDownloadSink,
	AttachmentDownloadSinkGrant,
} from "../web-attachment-download-sink";
export type {
	AtomicAttachmentUploadSource,
	AttachmentUploadSourceGrant,
} from "../web-attachment-upload-source";

import { WebPlatformStorageHost } from "../web-platform-storage-host";
import {
	createSharedWorkerOwner,
	type SharedWorkerHandle,
	type SharedWorkerOwner,
	type WorkerRpcChannel,
} from "../worker/owner";
import { createWorkerRuntime, type WorkerRuntime } from "../worker-runtime";
import { createAttachmentRuntimeIncarnationTransitions } from "./attachment-runtime-incarnation";
import { createVaultImageSourceRegistryOwner } from "./vault-image-runtime-incarnation";

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
	attachmentUploads: WebAttachmentUploadSourceRegistry;
	/** Narrow host-neutral grants; lifecycle and registry authority remain private. */
	vaultImageSources: VaultImageSourceGrants;
	workerOwner: SharedWorkerOwner;
	close(): Promise<void>;
}

export interface VaultImageSourceGrants {
	grant(source: VaultImageSourceGrant): string;
}

export function createWebClientRuntime(
	deps: WebClientRuntimeDeps,
): WebClientRuntime {
	const platformStorage = new WebPlatformStorageHost();
	const attachmentDownloads = new WebAttachmentDownloadSinkRegistry();
	const attachmentUploads = new WebAttachmentUploadSourceRegistry();
	const vaultImages = createVaultImageSourceRegistryOwner();
	const vaultImageSources: VaultImageSourceGrants = vaultImages.grants;
	const fallbackHostRequest =
		deps.handleHostRequest ?? platformStorage.invoke.bind(platformStorage);
	const transitionAttachmentRuntimeIncarnation =
		createAttachmentRuntimeIncarnationTransitions(
			attachmentDownloads,
			attachmentUploads,
		);
	const workerOwner = createSharedWorkerOwner({
		createWorker: deps.createWorker,
		handleHostRequest: (payload, signal) => {
			if (isAttachmentDownloadSinkRuntimeScopeRequest(payload)) {
				return Promise.all([
					transitionAttachmentRuntimeIncarnation(
						payload.phase,
						payload.runtimeIncarnation,
					),
					payload.phase === "prepare"
						? vaultImages.prepare(payload.runtimeIncarnation)
						: Promise.resolve(),
				]).then(() => undefined);
			}
			if (isVaultImageSourceHostRequest(payload)) {
				if (signal.aborted)
					return Promise.reject(new Error("Vault-image request cancelled"));
				return vaultImages
					.invoke(payload.controlRequestJson, payload.runtimeIncarnation)
					.then(({ binaryChunk, ...control }) => ({
						controlResponseJson: JSON.stringify(control),
						...(binaryChunk === undefined ? {} : { binaryChunk }),
					}));
			}
			if (isAttachmentUploadSourceHostRequest(payload)) {
				if (signal.aborted)
					return Promise.reject(new Error("Source request cancelled"));
				return attachmentUploads.invoke(
					payload.controlRequestJson,
					payload.runtimeIncarnation,
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
				return transitionAttachmentRuntimeIncarnation(
					payload.phase,
					payload.runtimeIncarnation,
				);
			}
			if (isVaultImageSourceHostRequest(payload) && !signal.aborted)
				return vaultImages
					.invoke(payload.controlRequestJson, payload.runtimeIncarnation)
					.then(({ binaryChunk, ...control }) => ({
						controlResponseJson: JSON.stringify(control),
						...(binaryChunk === undefined ? {} : { binaryChunk }),
					}));
			if (isAttachmentUploadSourceHostRequest(payload) && !signal.aborted)
				return attachmentUploads.invoke(
					payload.controlRequestJson,
					payload.runtimeIncarnation,
				);
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
		beforeWorkerTerminate: () =>
			Promise.all([
				attachmentDownloads.drainClose(),
				attachmentUploads.drainClose(),
				vaultImages.drainClose(),
			]).then(() => undefined),
		preserveHostRequestDuringClose: (payload) =>
			isAttachmentDownloadSinkHostRequest(payload) ||
			isAttachmentDownloadSinkRuntimeScopeRequest(payload) ||
			isAttachmentUploadSourceHostRequest(payload) ||
			isVaultImageSourceHostRequest(payload),
	});
	let closeTask: Promise<void> | undefined;
	const close = (): Promise<void> => {
		attachmentDownloads.beginClose();
		attachmentUploads.beginClose();
		vaultImages.beginClose();
		if (closeTask !== undefined) return closeTask;
		const closing = workerOwner.close().then(
			() =>
				Promise.all([
					attachmentDownloads.drainClose(),
					attachmentUploads.drainClose(),
					vaultImages.drainClose(),
				]).then(() => undefined),
			async (error) => {
				await attachmentDownloads.drainClose();
				await attachmentUploads.drainClose();
				await vaultImages.drainClose();
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
		attachmentUploads,
		vaultImageSources,
		cryptoChannel: workerOwner.channel("crypto"),
		runtime,
		normalizeAccountEmail: runtime.normalizeAccountEmail,
		close,
	};
}
