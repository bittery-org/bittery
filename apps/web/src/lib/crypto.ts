/**
 * The web app's Worker composition: one Worker, one `CryptoPort`, one Runtime.
 *
 * Built here rather than inside a component because `AccountStore` needs it before React
 * mounts, and because a second instance would mean a second key table — a `KeyRef` minted
 * by one port is rejected by the other.
 */

import {
	createMemoryActiveAccountStorage,
	createRuntimeClient,
	createWebActiveAccountStorage,
} from "@bittery/client-runtime/client";
import {
	createWebClientRuntime,
	encodeRuntimeClientIdentity,
} from "@bittery/client-runtime/web";
import { createWasmWorkerCryptoPort } from "@bittery/crypto-port/adapters/wasm-worker";
import { getOrCreateClientId } from "@bittery/sync";

/**
 * Who this browser is on the Server.
 *
 * The Server persists `client_id` on the Session and groups Sessions by it, so a constant
 * would make every browser one device and leave "revoke other sessions" unable to tell them
 * apart. `localStorage`, not `sessionStorage`: a device outlives a tab, and the Runtime's
 * Session must keep the same identity across tabs and restarts. The transitional sync
 * client id stays per-tab, which is what echo suppression wants; these are different jobs.
 */
function runtimeClientIdentity(): string {
	return encodeRuntimeClientIdentity({
		clientId: getOrCreateClientId(window.localStorage),
		platform: "web",
		version: import.meta.env.VITE_APP_VERSION ?? "0.0.0",
	});
}

// The `new URL(..., import.meta.url)` literal has to sit inside `new Worker(...)` here: it
// resolves against this file, and it is the only form Vite recognises as a Worker entry. The
// identity travels as the Worker's `name` because a Worker can read no browser storage.
const composition = createWebClientRuntime({
	createWorker: () =>
		new Worker(new URL("./runtime.worker.ts", import.meta.url), {
			type: "module",
			name: runtimeClientIdentity(),
		}),
});

export const webWorkerOwner = composition.workerOwner;
export const crypto = createWasmWorkerCryptoPort(composition.cryptoChannel);
/** Shared Worker Runtime. Web Items observation consumes `observe(Items)`. */
export const runtime = composition.runtime;
/**
 * The typed host binding over that Worker. Built here, above React, because the
 * observation registry inside it owns observation identity and lifetime: a client built
 * inside a component would restart every observation on every remount.
 */
export const runtimeClient = createRuntimeClient({
	transport: runtime,
	activeAccount:
		typeof window === "undefined"
			? createMemoryActiveAccountStorage()
			: createWebActiveAccountStorage(window.localStorage),
});

// Spawning the worker and instantiating WASM costs the first sign-in about as much as the
// key derivation itself, so it is started at load. A failed load is not memoised, so the
// first real call still retries and reports.
if (typeof window !== "undefined") {
	void crypto.initialize().catch(() => undefined);
	// One Device-wide status observation, opened once and never torn down. Device-wide on
	// purpose: `status(accountId)` answers ACCOUNT_MISSING for an Account this Device has
	// not installed, while this form never fails, so it survives sign-in, sign-out, lock,
	// and Account switch. The route guard reads it before React mounts, so it cannot be a
	// component's subscription.
	runtimeClient.session().subscribe(() => undefined);
}
