import { describe, expect, test } from "bun:test";
import { IndexedDbAttachmentArtifactExecutor } from "../indexeddb-attachment-artifact-executor";
import { WebBinaryTransferExecutor } from "../web-binary-transfer-executor";
import type { RuntimeWasm } from "../worker-runtime";
import {
	serveWebRuntimeWorker,
	type WebRuntimeWorkerScope,
} from "./worker-entry";

class ScopeDouble implements WebRuntimeWorkerScope {
	readonly listeners: Array<(event: { data: unknown }) => void> = [];
	readonly posts: unknown[] = [];

	addEventListener(
		_type: "message",
		listener: (event: { data: unknown }) => void,
	): void {
		this.listeners.push(listener);
	}

	postMessage(message: unknown): void {
		this.posts.push(message);
	}

	dispatch(data: unknown): void {
		for (const listener of this.listeners) listener({ data });
	}
}

class RuntimeDouble {
	cancel(): void {}
	async close(): Promise<void> {}
	async open(): Promise<void> {}
	observe_json(): void {}
	request_json(): Promise<string> {
		return Promise.resolve("{}");
	}
	unobserve(): void {}
}

describe("Web Runtime Worker composition", () => {
	test("constructs the authenticated Runtime with the fixed artifact, binary, and lease executors", async () => {
		const scope = new ScopeDouble();
		const runtime = new RuntimeDouble();
		let ports: unknown[] = [];
		serveWebRuntimeWorker(scope, {
			authClient: { clientId: "client", platform: "web", version: "1" },
			loadWasm: async () =>
				({
					WebClientRuntime: {
						withExecutors: () => runtime,
						withConfiguredAttachmentMovePreparation(
							_replica: unknown,
							_platformStorage: unknown,
							_http: unknown,
							_httpCancel: unknown,
							artifact: unknown,
							binary: unknown,
							lease: unknown,
						) {
							ports = [artifact, binary, lease];
							return runtime;
						},
					},
				}) as unknown as RuntimeWasm,
		});

		scope.dispatch({
			type: "request",
			channel: "runtime",
			id: 1,
			payload: { type: "request", requestId: "start", requestJson: "{}" },
		});
		for (let turn = 0; ports.length === 0 && turn < 20; turn += 1) {
			await Promise.resolve();
		}

		expect(ports[0]).toBeInstanceOf(IndexedDbAttachmentArtifactExecutor);
		expect(ports[1]).toBeInstanceOf(WebBinaryTransferExecutor);
		expect(Reflect.ownKeys(ports[2] ?? {})).toEqual(["acquire"]);
	});

	test("reconstruction replaces the concrete binary executor closed by the prior wrapper", async () => {
		const scope = new ScopeDouble();
		const binaries: WebBinaryTransferExecutor[] = [];
		const lifecycleErrors: Array<(errorJson: string) => void> = [];
		const runtimes = [new RuntimeDouble(), new RuntimeDouble()];
		let loads = 0;
		serveWebRuntimeWorker(scope, {
			authClient: { clientId: "client", platform: "web", version: "1" },
			loadWasm: async () => {
				const runtime = runtimes[loads++];
				if (runtime === undefined) throw new Error("unexpected reconstruction");
				return {
					WebClientRuntime: {
						withExecutors: () => runtime,
						withConfiguredAttachmentMovePreparation(
							_replica: unknown,
							_platformStorage: unknown,
							_http: unknown,
							_httpCancel: unknown,
							_artifact: unknown,
							binary: WebBinaryTransferExecutor,
							_lease: unknown,
							_clientId: string,
							_platform: string,
							_version: string,
							onLifecycleError: (errorJson: string) => void,
						) {
							binaries.push(binary);
							lifecycleErrors.push(onLifecycleError);
							runtime.close = async () => binary.close();
							return runtime;
						},
					},
				};
			},
		});
		const dispatch = (id: number, requestId: string) => {
			scope.dispatch({
				type: "request",
				channel: "runtime",
				id,
				payload: { type: "request", requestId, requestJson: "{}" },
			});
		};
		const response = async (id: number) => {
			for (let turn = 0; turn < 100; turn += 1) {
				const found = scope.posts.find(
					(post) =>
						typeof post === "object" &&
						post !== null &&
						(post as { type?: unknown }).type === "response" &&
						(post as { id?: unknown }).id === id,
				);
				if (found !== undefined) return found as { ok: boolean };
				await Promise.resolve();
			}
			throw new Error(`Worker response ${id} did not arrive.`);
		};

		dispatch(1, "first");
		expect((await response(1)).ok).toBe(true);
		lifecycleErrors[0]?.("{}");
		dispatch(2, "failure");
		expect((await response(2)).ok).toBe(false);
		dispatch(3, "replacement");
		expect((await response(3)).ok).toBe(true);

		expect(binaries).toHaveLength(2);
		expect(binaries[1]).not.toBe(binaries[0]);
		await expect(
			binaries[0]?.invoke('{"type":"cancelTransfer","transferId":"old"}'),
		).rejects.toThrow();
		await expect(
			binaries[1]?.invoke('{"type":"cancelTransfer","transferId":"new"}'),
		).resolves.toEqual({ controlResponseJson: '{"type":"cancelled"}' });
	});
});
