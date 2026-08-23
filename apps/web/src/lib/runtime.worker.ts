import {
	decodeRuntimeClientIdentity,
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
//
// The client identity arrives as the Worker's `name`: this scope can read no `localStorage`
// and no `sessionStorage`, so the host is the only place the per-browser id exists.
const identity = decodeRuntimeClientIdentity(self.name);

serveWebRuntimeWorker(globalThis as unknown as WebRuntimeWorkerScope, {
	loadWasm: loadCombinedWebWasm,
	crypto: createCryptoWorkerService(async () =>
		createCryptoUniffiBackend(await loadCombinedWebWasm()),
	),
	...(identity === undefined ? {} : { authClient: identity }),
});
