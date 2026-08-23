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

import { WebPlatformStorageHost } from "../web-platform-storage-host";
import {
	createSharedWorkerOwner,
	type SharedWorkerHandle,
	type SharedWorkerOwner,
	type WorkerRpcChannel,
} from "../worker/owner";
import { createWorkerRuntime, type WorkerRuntime } from "../worker-runtime";

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
	/** The Crypto channel. The host wraps it in a `CryptoPort`; ticket 22 removes it. */
	cryptoChannel: WorkerRpcChannel;
	workerOwner: SharedWorkerOwner;
	close(): Promise<void>;
}

export function createWebClientRuntime(
	deps: WebClientRuntimeDeps,
): WebClientRuntime {
	const platformStorage = new WebPlatformStorageHost();
	const workerOwner = createSharedWorkerOwner({
		createWorker: deps.createWorker,
		handleHostRequest:
			deps.handleHostRequest ?? platformStorage.invoke.bind(platformStorage),
	});
	return {
		workerOwner,
		cryptoChannel: workerOwner.channel("crypto"),
		runtime: createWorkerRuntime(
			workerOwner.channel("runtime"),
			workerOwner.close,
		),
		close: workerOwner.close,
	};
}
