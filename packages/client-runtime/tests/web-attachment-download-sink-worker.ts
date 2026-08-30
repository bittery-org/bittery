import { serveWebRuntimeWorker } from "../src/web/worker-entry";
import type { RuntimeWasm } from "../src/worker-runtime";

const timerMode = new URL(self.location.href).searchParams.get("timer");
if (timerMode === "missing") {
	Object.defineProperty(globalThis, "setTimeout", {
		configurable: true,
		value: undefined,
	});
} else if (timerMode === "throwing") {
	globalThis.setTimeout = (() => {
		throw new Error("timer rejected");
	}) as typeof globalThis.setTimeout;
} else if (timerMode === "noop") {
	globalThis.setTimeout = (() => 0) as typeof globalThis.setTimeout;
} else if (timerMode === "delayed") {
	const realSetTimeout = globalThis.setTimeout.bind(globalThis);
	globalThis.setTimeout = ((callback: TimerHandler) =>
		realSetTimeout(callback, 1_000)) as typeof globalThis.setTimeout;
}

type SinkExecutor = {
	invoke(json: string, bytes?: Uint8Array): Promise<string>;
};
type BinaryExecutor = {
	invoke(
		json: string,
		bytes?: Uint8Array,
	): Promise<{ controlResponseJson: string; bytes?: ArrayBuffer }>;
	close(): void;
};

class FocusedDownloadRuntime {
	static openAttempts = 0;
	readonly #sink: SinkExecutor;
	readonly #binary: BinaryExecutor;
	readonly #cancelled = new Set<string>();
	readonly #transfers = new Map<string, string>();
	#workerChunksDetached = true;

	constructor(sink: SinkExecutor, binary: BinaryExecutor) {
		this.#sink = sink;
		this.#binary = binary;
	}

	async open(): Promise<void> {
		if (
			timerMode === "open-once" &&
			FocusedDownloadRuntime.openAttempts++ === 0
		)
			throw new Error("focused open failure");
	}
	observe_json(): void {}
	unobserve(): void {}
	cancel(requestId: string): void {
		this.#cancelled.add(requestId);
		const transferId = this.#transfers.get(requestId);
		if (transferId !== undefined) {
			void this.#binary.invoke(
				JSON.stringify({ type: "cancelTransfer", transferId }),
			);
		}
	}
	async close(): Promise<void> {
		for (const requestId of this.#transfers.keys()) this.cancel(requestId);
		this.#binary.close();
		const retired = await this.#sink.invoke('{"type":"retireRuntime"}');
		if (JSON.parse(retired).type !== "retired")
			throw new Error("sink retirement failed");
	}

	async request_json(requestId: string, requestJson: string): Promise<string> {
		if (requestJson === "warmup") return "warmed";
		if (requestJson === '{"type":"wipe"}') return '{"type":"wiped"}';
		const request = JSON.parse(requestJson) as {
			accountId: string;
			attachmentId: string;
			sinkCapabilityId: string;
			downloadUrl: string;
		};
		const capabilityId = request.sinkCapabilityId;
		const begin = await this.#sink.invoke(
			JSON.stringify({
				type: "begin",
				accountId: request.accountId,
				attachmentId: request.attachmentId,
				capabilityId,
				requestScope: capabilityId,
			}),
		);
		if (JSON.parse(begin).type !== "begun")
			throw new Error("sink begin failed");
		const transferId = `download-${requestId}`;
		this.#transfers.set(requestId, transferId);
		try {
			const opened = await this.#binary.invoke(
				JSON.stringify({
					type: "openDownload",
					transferId,
					url: request.downloadUrl,
					headers: [],
					maxResponseBytes: "1024",
					maxChunkBytes: 2,
				}),
			);
			if (JSON.parse(opened.controlResponseJson).type !== "downloadOpened")
				throw new Error("download open failed");
			for (;;) {
				const next = await this.#binary.invoke(
					JSON.stringify({ type: "readDownloadChunk", transferId }),
				);
				const response = JSON.parse(next.controlResponseJson) as {
					type: string;
				};
				if (response.type === "downloadFinished") break;
				if (response.type === "cancelled" || this.#cancelled.has(requestId))
					throw new Error("cancelled");
				if (response.type !== "downloadChunk" || next.bytes === undefined)
					throw new Error("download failed");
				const plaintext = new Uint8Array(next.bytes);
				const written = await this.#sink.invoke(
					JSON.stringify({ type: "write", capabilityId }),
					plaintext,
				);
				this.#workerChunksDetached &&= plaintext.byteLength === 0;
				if (JSON.parse(written).type !== "written")
					throw new Error("sink write failed");
			}
			const committed = await this.#sink.invoke(
				JSON.stringify({ type: "commit", capabilityId }),
			);
			if (JSON.parse(committed).type !== "committed")
				throw new Error("sink commit failed");
			return JSON.stringify({
				type: "attachmentDownloaded",
				accountId: request.accountId,
				attachmentId: request.attachmentId,
				workerChunksDetached: this.#workerChunksDetached,
			});
		} catch (error) {
			await this.#sink.invoke(
				JSON.stringify({ type: "discard", capabilityId }),
			);
			throw error;
		} finally {
			this.#transfers.delete(requestId);
		}
	}
}

const wasm: RuntimeWasm = {
	WebClientRuntime: {
		withExecutors() {
			throw new Error("authenticated constructor required");
		},
		withConfiguredAttachmentMovePreparation(
			_replica,
			_platform,
			_http,
			_cancel,
			_artifact,
			binary,
			_lease,
			_client,
			_platformName,
			_version,
			_lifecycle,
			sink,
		) {
			return new FocusedDownloadRuntime(sink, binary);
		},
	},
};

serveWebRuntimeWorker(self, {
	authClient: { clientId: "chromium-test", platform: "web", version: "1" },
	loadWasm: async () => wasm,
});
