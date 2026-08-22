// Generated key handles stay in this worker; only exportKey may return raw bytes.

import { createCryptoWorkerService } from "./crypto-worker-service";
import { loadCryptoWebBackend } from "./uniffi-bindings";
import { serveWorkerChannels, type WorkerRouterScope } from "./worker-router";

export interface CryptoWorkerScope extends WorkerRouterScope {}

export function serveCryptoPort(
	scope: CryptoWorkerScope,
	loadBackend: Parameters<typeof createCryptoWorkerService>[0],
): void {
	serveWorkerChannels(scope, {
		crypto: createCryptoWorkerService(loadBackend),
	});
}

// Compatibility composition root for existing non-Web callers.
serveCryptoPort(
	globalThis as unknown as CryptoWorkerScope,
	loadCryptoWebBackend,
);
