/**
 * The generic Worker transport. It carries correlation, cancellation, lifetime and a
 * clone-safe wire vocabulary, and knows nothing about what any channel transports.
 */

export {
	createWorkerHostRpc,
	type WorkerHostRpc,
	type WorkerHostRpcScope,
} from "./host-rpc";
export {
	createSharedWorkerOwner,
	type SharedWorkerHandle,
	type SharedWorkerOwner,
	type SharedWorkerOwnerDeps,
	type WorkerRpcChannel,
} from "./owner";
export {
	serveWorkerChannels,
	type WorkerChannelService,
	type WorkerRouterScope,
} from "./router";
export {
	copyWorkerValue,
	isWorkerChannelName,
	isWorkerReply,
	isWorkerRequest,
	WORKER_CHANNELS,
	type WorkerChannelName,
	type WorkerReply,
	type WorkerRequest,
	WorkerRpcError,
} from "./wire";
