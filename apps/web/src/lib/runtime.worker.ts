import { IndexedDbReplicaExecutor } from "@bittery/client-runtime/indexeddb-executor";
import { createRuntimeWorkerService } from "@bittery/client-runtime/worker-runtime";
import {
	createCryptoUniffiBackend,
	createCryptoWorkerService,
	createWorkerHostRpc,
	loadCombinedWebWasm,
	serveWorkerChannels,
	type WorkerRouterScope,
} from "@bittery/crypto-port/worker";

const scope = globalThis as unknown as WorkerRouterScope;
const hostRpc = createWorkerHostRpc(scope);

serveWorkerChannels(scope, {
	crypto: createCryptoWorkerService(async () =>
		createCryptoUniffiBackend(await loadCombinedWebWasm()),
	),
	runtime: createRuntimeWorkerService({
		executor: new IndexedDbReplicaExecutor(),
		platformStorageExecutor: {
			invoke: (requestJson) => hostRpc.request<string>(requestJson),
		},
		loadWasm: loadCombinedWebWasm,
	}),
});
