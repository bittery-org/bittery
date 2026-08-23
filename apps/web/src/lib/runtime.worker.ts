import {
	serveWebRuntimeWorker,
	type WebRuntimeWorkerScope,
} from "@bittery/client-runtime/web/worker-entry";
import {
	createCryptoUniffiBackend,
	createCryptoWorkerService,
	loadCombinedWebWasm,
} from "@bittery/crypto-port/worker";

// The Crypto channel is supplied here because only `crypto-port` may import the generated
// bindings. Ticket 22 removes the channel and leaves the Runtime alone in this worker.
serveWebRuntimeWorker(globalThis as unknown as WebRuntimeWorkerScope, {
	loadWasm: loadCombinedWebWasm,
	crypto: createCryptoWorkerService(async () =>
		createCryptoUniffiBackend(await loadCombinedWebWasm()),
	),
	authClient: {
		clientId: "bittery-web",
		platform: "web",
		version: "0.5.2",
	},
});
