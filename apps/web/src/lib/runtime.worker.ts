import { IndexedDbReplicaExecutor } from "@bittery/client-runtime/indexeddb-executor";
import { createRuntimeWorkerService } from "@bittery/client-runtime/worker-runtime";
import {
	createCryptoUniffiBackend,
	createCryptoWorkerService,
	loadCombinedWebWasm,
	serveWorkerChannels,
	type WorkerRouterScope,
} from "@bittery/crypto-port/worker";

serveWorkerChannels(globalThis as unknown as WorkerRouterScope, {
	crypto: createCryptoWorkerService(async () =>
		createCryptoUniffiBackend(await loadCombinedWebWasm()),
	),
	runtime: createRuntimeWorkerService({
		executor: new IndexedDbReplicaExecutor(),
		loadWasm: loadCombinedWebWasm,
	}),
});
