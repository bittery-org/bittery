import type { WebVaultCapabilityScope } from "../web-vault-capability-scopes";
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
	isRecoveryCancelHostRequest,
	isRecoveryTransferHostRequest,
	RecoveryFileRegistry,
} from "../web-recovery-files";
import {
	isVaultImageSourceHostRequest,
	type VaultImageSourceGrant,
} from "../web-vault-image-source";

export type {
	AtomicAttachmentDownloadSink,
	AttachmentDownloadSinkGrant,
} from "../web-attachment-download-sink";

import type { AttachmentDownloadSinkGrant } from "../web-attachment-download-sink";

export type {
	AtomicAttachmentUploadSource,
	AttachmentUploadSourceGrant,
} from "../web-attachment-upload-source";

import type { AttachmentUploadSourceGrant } from "../web-attachment-upload-source";

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
	recoveryFiles: Pick<
		RecoveryFileRegistry,
		| "grantSource"
		| "grantSink"
		| "discardGrant"
		| "listRetained"
		| "prepared"
		| "downloadRequested"
		| "release"
	>;
	runtime: WorkerRuntime;
	/** Shared Rust identity normalization, executed by the existing Runtime Worker WASM. */
	normalizeAccountEmail(value: string): Promise<string>;
	/** The Crypto channel. The host wraps it in a `CryptoPort`; ticket 22 removes it. */
	cryptoChannel: WorkerRpcChannel;
	attachmentDownloadSinks: AttachmentDownloadSinkGrants;
	/**
	 * The only Upload-source authority a JavaScript host receives. Runtime-incarnation,
	 * reverse-RPC, retirement, and cleanup remain private to this composition root.
	 */
	attachmentUploadSources: AttachmentUploadSourceGrants;
	/** Narrow host-neutral grants; lifecycle and registry authority remain private. */
	vaultImageSources: VaultImageSourceGrants;
	workerOwner: SharedWorkerOwner;
	close(): Promise<void>;
}

/** A reusable JavaScript-host facade for granting one plaintext Upload source. */
export interface AttachmentUploadSourceGrants {
	captureScope(accountId: string, vaultId: string): WebVaultCapabilityScope;
	release(capabilityId: string): Promise<void>;
	grant(source: AttachmentUploadSourceGrant): string;
}

/** A reusable JavaScript-host facade for granting one atomic plaintext Download sink. */
export interface AttachmentDownloadSinkGrants {
	captureScope(accountId: string, vaultId: string): WebVaultCapabilityScope;
	release(capabilityId: string): Promise<void>;
	grant(sink: AttachmentDownloadSinkGrant): string;
}
export interface VaultImageSourceGrants {
	captureScope(accountId: string, vaultId?: string): WebVaultCapabilityScope;
	grant(source: VaultImageSourceGrant): string;
	discard(capabilityId: string): Promise<void>;
}

export function createWebClientRuntime(
	deps: WebClientRuntimeDeps,
): WebClientRuntime {
	const platformStorage = new WebPlatformStorageHost();
	const recoveryFiles = new RecoveryFileRegistry();
	const attachmentDownloads = new WebAttachmentDownloadSinkRegistry();
	const attachmentDownloadSinks: AttachmentDownloadSinkGrants = {
		captureScope: (accountId, vaultId) =>
			attachmentDownloads.captureScope(accountId, vaultId),
		release: (id) => attachmentDownloads.release(id),
		grant: (sink) => attachmentDownloads.grant(sink),
	};
	const attachmentUploads = new WebAttachmentUploadSourceRegistry();
	const vaultImages = createVaultImageSourceRegistryOwner();
	const vaultImageSources: VaultImageSourceGrants = vaultImages.grants;
	const attachmentUploadSources: AttachmentUploadSourceGrants = {
		captureScope: (accountId, vaultId) =>
			attachmentUploads.captureScope(accountId, vaultId),
		release: (id) => attachmentUploads.release(id),
		grant: (source) => attachmentUploads.grant(source),
	};
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
			if (isRecoveryRuntimeScope(payload)) {
				recoveryFiles.prepare(payload.runtimeIncarnation);
				return Promise.resolve();
			}
			if (isRecoveryCancelHostRequest(payload)) {
				recoveryFiles.cancel(payload);
				return Promise.resolve();
			}
			if (isRecoveryTransferHostRequest(payload)) {
				if (signal.aborted)
					return Promise.reject(new Error("Recovery transfer cancelled"));
				return recoveryFiles.invoke(payload);
			}
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
			if (isRecoveryCancelHostRequest(payload)) {
				recoveryFiles.cancel(payload);
				return Promise.resolve();
			}
			if (isRecoveryTransferHostRequest(payload)) {
				const control = JSON.parse(payload.controlRequestJson);
				if (control.type === "sourceClose" || control.type === "sinkDiscard")
					return recoveryFiles.invoke(payload);
				return Promise.reject(new Error("Recovery transfer fenced by close"));
			}
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
			]).then(() => recoveryFiles.retire()),
		preserveHostRequestDuringClose: (payload) =>
			isRecoveryTransferHostRequest(payload) ||
			isRecoveryCancelHostRequest(payload) ||
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
		recoveryFiles: {
			grantSource: recoveryFiles.grantSource.bind(recoveryFiles),
			grantSink: recoveryFiles.grantSink.bind(recoveryFiles),
			discardGrant: recoveryFiles.discardGrant.bind(recoveryFiles),
			listRetained: recoveryFiles.listRetained.bind(recoveryFiles),
			prepared: recoveryFiles.prepared.bind(recoveryFiles),
			downloadRequested: recoveryFiles.downloadRequested.bind(recoveryFiles),
			release: recoveryFiles.release.bind(recoveryFiles),
		},
		workerOwner,
		attachmentDownloadSinks,
		attachmentUploadSources,
		vaultImageSources,
		cryptoChannel: workerOwner.channel("crypto"),
		runtime,
		normalizeAccountEmail: runtime.normalizeAccountEmail,
		close: runtime.close,
	};
}

function isRecoveryRuntimeScope(
	value: unknown,
): value is { type: "recoveryRuntimeScope"; runtimeIncarnation: string } {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return (
		Object.keys(row).sort().join(",") === "runtimeIncarnation,type" &&
		row.type === "recoveryRuntimeScope" &&
		typeof row.runtimeIncarnation === "string"
	);
}
