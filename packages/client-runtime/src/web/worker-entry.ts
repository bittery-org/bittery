/**
 * The Web Worker composition root.
 *
 * The Worker owns the Runtime and, for now, the Crypto backend. The Crypto channel arrives
 * injected rather than imported: `crypto-port` still hosts Desktop's and Mobile's own Worker
 * roots and therefore still imports this package's transport, so an import the other way
 * would close a package cycle. Ticket 22 removes the Crypto channel entirely.
 */

import { IndexedDbReplicaExecutor } from "../indexeddb-executor";
import { WebHttpTransportExecutor } from "../web-http-transport-executor";
import { createWorkerHostRpc } from "../worker/host-rpc";
import {
	serveWorkerChannels,
	type WorkerChannelService,
	type WorkerRouterScope,
} from "../worker/router";
import {
	createRuntimeWorkerService,
	type RuntimeAuthClientConfig,
	type RuntimeWasm,
} from "../worker-runtime";

export interface WebRuntimeWorkerScope extends WorkerRouterScope {}

export interface WebRuntimeWorkerDeps {
	/** The combined WASM module. The host supplies it; only it may import the bindings. */
	loadWasm(): Promise<RuntimeWasm>;
	authClient: RuntimeAuthClientConfig;
	/** The Crypto channel, or none. Ticket 22 deletes this branch. */
	crypto?: WorkerChannelService;
}

/** Registers every channel this Worker serves. Nothing is loaded until a request arrives. */
export function serveWebRuntimeWorker(
	scope: WebRuntimeWorkerScope,
	deps: WebRuntimeWorkerDeps,
): void {
	const hostRpc = createWorkerHostRpc(scope);
	serveWorkerChannels(scope, {
		...(deps.crypto === undefined ? {} : { crypto: deps.crypto }),
		runtime: createRuntimeWorkerService({
			executor: new IndexedDbReplicaExecutor(),
			platformStorageExecutor: {
				invoke: (requestJson) => hostRpc.request<string>(requestJson),
			},
			httpExecutor: new WebHttpTransportExecutor(),
			loadWasm: deps.loadWasm,
			authClient: deps.authClient,
		}),
	});
}
