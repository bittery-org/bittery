import type { RecoveryControlResponse } from "../generated/recovery-control/contract";
import { validateRecoveryControlRequest } from "../generated/recovery-control/validator";
import {
	openRecoverySpoolDirectory,
	RecoverySpool,
} from "./opfs-recovery-spool";
import { waitRecovery } from "./recovery-cancellation";
import { RecoveryLimitError } from "./recovery-limit";
import type { RecoveryTransfer } from "./web-recovery-executor";
import {
	acquireStorageFamilyLease,
	StorageMaintenanceError,
} from "./web-storage-maintenance";

type Reply = { control: RecoveryControlResponse; binaryChunk?: Uint8Array };
export type RecoveryFileState = "prepared" | "downloadRequested";
type Grant = {
	accountId: string;
	incarnation: string;
	recoveryId?: string;
	state: "granted" | "active" | RecoveryFileState | "closed";
	file?: File;
	offset: number;
	kind: "source" | "sink";
	cancellation?: AbortController;
};
export type RecoveryTransferHostRequest = {
	type: "recoveryTransfer";
	runtimeIncarnation: string;
	controlRequestJson: string;
};
export type RecoveryCancelHostRequest = {
	type: "recoveryCancel";
	runtimeIncarnation: string;
	recoveryId: string;
};
export function isRecoveryCancelHostRequest(
	value: unknown,
): value is RecoveryCancelHostRequest {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return (
		Object.keys(row).sort().join(",") ===
			"recoveryId,runtimeIncarnation,type" &&
		row.type === "recoveryCancel" &&
		typeof row.recoveryId === "string" &&
		typeof row.runtimeIncarnation === "string"
	);
}
export function isRecoveryTransferHostRequest(
	value: unknown,
): value is RecoveryTransferHostRequest {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return (
		Object.keys(row).sort().join(",") ===
			"controlRequestJson,runtimeIncarnation,type" &&
		row.type === "recoveryTransfer" &&
		typeof row.runtimeIncarnation === "string" &&
		typeof row.controlRequestJson === "string"
	);
}

/** The main thread owns immutable user-selected Files and explicit prepared-file presentation. */
export class RecoveryFileRegistry {
	#incarnation?: string;
	readonly #grants = new Map<string, Grant>();
	prepare(incarnation: string): void {
		if (this.#incarnation === incarnation) return;
		for (const id of this.#grants.keys()) this.discardGrant(id);
		this.#incarnation = incarnation;
	}
	grantSource(accountId: string, file: File): string {
		if (!(file instanceof File) || file.size === 0)
			throw new Error("Recovery source File is invalid");
		if (file.size > 1024 * 1024 * 1024 + 1024 * 1024)
			throw new RecoveryLimitError("archiveBytes");
		return this.#grant(accountId, "source", file);
	}
	discardGrant(capabilityId: string): void {
		const entry = this.#grants.get(capabilityId);
		if (
			entry === undefined ||
			entry.state === "prepared" ||
			entry.state === "downloadRequested"
		)
			return;
		entry.cancellation?.abort();
		entry.file = undefined;
		entry.state = "closed";
		this.#grants.delete(capabilityId);
	}
	grantSink(accountId: string): string {
		return this.#grant(accountId, "sink");
	}
	#grant(accountId: string, kind: "source" | "sink", file?: File): string {
		if (
			this.#incarnation === undefined ||
			accountId.length === 0 ||
			this.#grants.size >= 128
		)
			throw new Error("Recovery file capability is unavailable");
		const capabilityId = crypto.randomUUID();
		this.#grants.set(capabilityId, {
			accountId,
			incarnation: this.#incarnation,
			state: "granted",
			file,
			offset: 0,
			kind,
		});
		return capabilityId;
	}
	cancel(message: RecoveryCancelHostRequest): void {
		if (message.runtimeIncarnation !== this.#incarnation) return;
		for (const entry of this.#grants.values())
			if (
				entry.incarnation === message.runtimeIncarnation &&
				entry.recoveryId === message.recoveryId
			)
				entry.cancellation?.abort();
	}
	async invoke(message: RecoveryTransferHostRequest): Promise<Reply> {
		const parsed: unknown = JSON.parse(message.controlRequestJson);
		if (!validateRecoveryControlRequest(parsed) || !("capabilityId" in parsed))
			throw new Error("Invalid recovery transfer control");
		const request = parsed;
		const entry = this.#grants.get(request.capabilityId);
		if (entry === undefined && request.type === "sourceClose")
			return { control: { type: "sourceClosed" } };
		if (entry === undefined && request.type === "sinkDiscard")
			return { control: { type: "sinkDiscarded" } };
		if (
			entry === undefined ||
			entry.incarnation !== message.runtimeIncarnation ||
			this.#incarnation !== entry.incarnation ||
			entry.accountId !== request.accountId ||
			entry.state === "closed" ||
			(entry.recoveryId !== undefined &&
				entry.recoveryId !== request.recoveryId)
		)
			throw new Error("Recovery file scope is unavailable");
		const source =
			request.type === "sourceRead" ||
			request.type === "sourceRewind" ||
			request.type === "sourceClose";
		if ((entry.kind === "source") !== source)
			throw new Error("Recovery file purpose is invalid");
		entry.recoveryId = request.recoveryId;
		entry.cancellation ??= new AbortController();
		const signal = entry.cancellation.signal;
		if (request.type !== "sourceClose" && request.type !== "sinkDiscard")
			signal.throwIfAborted();
		if (entry.state === "granted") entry.state = "active";
		switch (request.type) {
			case "sourceRead": {
				if (
					entry.file === undefined ||
					!Number.isInteger(request.maxBytes) ||
					request.maxBytes < 1 ||
					request.maxBytes > 262144
				)
					throw new Error("Recovery source read is invalid");
				if (entry.offset === entry.file.size)
					return { control: { type: "sourceEnded" } };
				const offset = entry.offset;
				const bytes = new Uint8Array(
					await waitRecovery(
						entry.file.slice(offset, offset + request.maxBytes).arrayBuffer(),
						signal,
						(buffer) => new Uint8Array(buffer).fill(0),
					),
				);
				if (
					entry.state !== "active" ||
					entry.incarnation !== this.#incarnation ||
					bytes.byteLength === 0
				) {
					bytes.fill(0);
					throw new Error("Recovery source was retired");
				}
				entry.offset += bytes.byteLength;
				return { control: { type: "sourceChunk" }, binaryChunk: bytes };
			}
			case "sourceRewind":
				if (entry.file === undefined)
					throw new Error("Recovery source was retired");
				entry.offset = 0;
				return { control: { type: "sourceRewound" } };
			case "sourceClose":
				entry.file = undefined;
				entry.state = "closed";
				this.#grants.delete(request.capabilityId);
				return { control: { type: "sourceClosed" } };
			case "sinkWrite":
				if (entry.state !== "active")
					throw new Error("Recovery sink is not writable");
				return { control: { type: "sinkWritten" } };
			case "sinkCommit": {
				if (entry.state !== "active")
					throw new Error("Recovery sink cannot be prepared");
				const file = await RecoverySpool.preparedFile(
					await openRecoverySpoolDirectory(),
					request.capabilityId,
				);
				if (entry.state !== "active" || entry.incarnation !== this.#incarnation)
					throw new Error("Recovery sink was retired");
				signal.throwIfAborted();
				entry.file = file;
				entry.state = "prepared";
				return { control: { type: "sinkCommitted" } };
			}
			case "sinkDiscard":
				this.discardGrant(request.capabilityId);
				return { control: { type: "sinkDiscarded" } };
		}
	}
	/** Fixed encrypted spool only. An old file is evidence, never an inferred complete export. */
	async listRetained(): Promise<{
		files: Array<{
			capabilityId: string;
			byteLength: string;
			state: RecoveryFileState;
		}>;
		limited: boolean;
	}> {
		return withRetainedFiles(async () => {
			const directory = await openRecoverySpoolDirectory();
			if (directory.entries === undefined)
				throw new Error("Recovery file listing is unavailable");
			const files: Array<{
				capabilityId: string;
				byteLength: string;
				state: RecoveryFileState;
			}> = [];
			let examined = 0;
			let limited = false;
			for await (const [name, handle] of directory.entries()) {
				if (++examined > 1024 || files.length >= 128) {
					limited = true;
					break;
				}
				const match = /^([A-Za-z0-9_-]{1,128})\.btrrec$/.exec(name);
				const capabilityId = match?.[1];
				if (handle.kind !== "file" || capabilityId === undefined) continue;
				const existing = this.#grants.get(capabilityId);
				if (
					existing !== undefined &&
					existing.state !== "prepared" &&
					existing.state !== "downloadRequested"
				)
					continue;
				if (existing === undefined && this.#grants.size >= 128) {
					limited = true;
					break;
				}
				const file = await RecoverySpool.preparedFile(directory, capabilityId);
				const state =
					existing?.state === "downloadRequested"
						? "downloadRequested"
						: "prepared";
				if (existing === undefined)
					this.#grants.set(capabilityId, {
						accountId: "",
						incarnation: this.#incarnation ?? "",
						state,
						file,
						offset: 0,
						kind: "sink",
					});
				else existing.file = file;
				files.push({ capabilityId, byteLength: String(file.size), state });
			}
			return { files, limited };
		});
	}

	prepared(capabilityId: string): { file: File; state: RecoveryFileState } {
		const entry = this.#grants.get(capabilityId);
		if (
			entry?.file === undefined ||
			(entry.state !== "prepared" && entry.state !== "downloadRequested")
		)
			throw new Error("Recovery file has not been prepared");
		return { file: entry.file, state: entry.state };
	}
	downloadRequested(capabilityId: string): void {
		this.prepared(capabilityId);
		const entry = this.#grants.get(capabilityId);
		if (entry) entry.state = "downloadRequested";
	}
	async release(capabilityId: string): Promise<void> {
		this.prepared(capabilityId);
		await withRetainedFiles(async () =>
			RecoverySpool.release(await openRecoverySpoolDirectory(), capabilityId),
		);
		this.#grants.delete(capabilityId);
	}
	retire(): void {
		this.#incarnation = undefined;
		for (const id of this.#grants.keys()) this.discardGrant(id);
	}
}

/** Only encrypted output crosses into OPFS. The existing Worker owns the synchronous handle. */
export class RecoveryWorkerFiles {
	readonly #sinks = new Map<
		string,
		{ accountId: string; recoveryId: string; spool: RecoverySpool }
	>();
	#closed = false;
	constructor(
		private readonly incarnation: string,
		private readonly host: (
			message: RecoveryTransferHostRequest | RecoveryCancelHostRequest,
		) => Promise<Reply | undefined>,
	) {}
	readonly invoke: RecoveryTransfer = async (request, binaryChunk, signal) => {
		if (this.#closed) throw new Error("Recovery file owner is closed");
		const remote = async () => {
			const cancel = () => {
				void this.host({
					type: "recoveryCancel",
					runtimeIncarnation: this.incarnation,
					recoveryId: request.recoveryId,
				}).catch(() => undefined);
			};
			signal?.throwIfAborted();
			signal?.addEventListener("abort", cancel, { once: true });
			try {
				const reply = await waitRecovery(
					this.host({
						type: "recoveryTransfer",
						runtimeIncarnation: this.incarnation,
						controlRequestJson: JSON.stringify(request),
					}),
					signal,
					(value) => value?.binaryChunk?.fill(0),
				);
				if (reply === undefined)
					throw new Error("Recovery transfer response is missing");
				return reply;
			} finally {
				signal?.removeEventListener("abort", cancel);
			}
		};
		if (
			request.type === "sourceRead" ||
			request.type === "sourceRewind" ||
			request.type === "sourceClose"
		)
			return remote();
		let entry = this.#sinks.get(request.capabilityId);
		if (
			entry !== undefined &&
			(entry.accountId !== request.accountId ||
				entry.recoveryId !== request.recoveryId)
		)
			throw new Error("Recovery sink scope changed");
		if (request.type === "sinkWrite") {
			if (binaryChunk === undefined)
				throw new Error("Recovery sink chunk is missing");
			if (entry === undefined) {
				const granted = await remote();
				if (granted.control.type !== "sinkWritten")
					throw new Error("Recovery sink was refused");
				const spool = await waitRecovery(
					RecoverySpool.create(
						await openRecoverySpoolDirectory(),
						request.capabilityId,
					),
					signal,
					(late) => {
						void late.discard().catch(() => undefined);
					},
				);
				if (this.#closed || signal?.aborted) {
					await spool.discard();
					throw new Error("Recovery file owner closed");
				}
				entry = {
					accountId: request.accountId,
					recoveryId: request.recoveryId,
					spool,
				};
				this.#sinks.set(request.capabilityId, entry);
			}
			await entry.spool.write(binaryChunk, signal);
			return { control: { type: "sinkWritten" } };
		}
		if (request.type === "sinkCommit") {
			if (entry === undefined) throw new Error("Recovery sink never started");
			await entry.spool.prepare(signal);
			const reply = await remote();
			this.#sinks.delete(request.capabilityId);
			return reply;
		}
		await entry?.spool.discard();
		this.#sinks.delete(request.capabilityId);
		return remote();
	};
	async close(): Promise<void> {
		this.#closed = true;
		await Promise.all(
			[...this.#sinks.values()].map((entry) => entry.spool.discard()),
		);
		this.#sinks.clear();
	}
}

/** A shared family lease excludes every live recovery writer while inspecting/removing old spools. */
async function withRetainedFiles<T>(action: () => Promise<T>): Promise<T> {
	const lease = await acquireStorageFamilyLease("normal");
	if (lease === undefined) throw new StorageMaintenanceError("unsupported");
	try {
		return await action();
	} finally {
		await lease.release();
	}
}
