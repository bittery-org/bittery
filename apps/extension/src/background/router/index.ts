/**
 * Background Message Router
 *
 * Keeps runtime message handling isolated from service-worker bootstrap
 * wiring. Runtime message types are preserved for popup/content
 * compatibility. Routing itself is data-driven; see `registry.ts` for the
 * `message.type -> RouteDefinition` table and `contract.ts` for the payload /
 * response pairing both sides are checked against.
 */

import {
	handlePasskeyCancel,
	handlePasskeyCreate,
	handlePasskeyGet,
} from "../passkey-handlers";
import { ensureBackgroundServicesReady } from "../services/service-worker-lifecycle";
import type {
	AnyRouteResponse,
	RouteFailure,
	RouteKey,
	RoutePayload,
	RouteResponse,
	RuntimeMessage,
} from "./contract";
import { routeRegistry } from "./registry";
import { ensureSyncInitialized } from "./sync-effects";
import type {
	PasskeyRouteOverrides,
	RouteContext,
	RouteDefinition,
} from "./types";

const ROUTE_KEYS: ReadonlySet<string> = new Set(Object.keys(routeRegistry));

/**
 * The runtime can hand us anything, so the discriminant is checked rather than
 * asserted. Payloads are not re-validated: `chrome.runtime` only delivers
 * messages from this extension's own contexts, which are compile-checked
 * against the same contract by `lib/messaging`.
 */
export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
	if (typeof value !== "object" || value === null || !("type" in value)) {
		return false;
	}

	const type: unknown = value.type;
	return typeof type === "string" && ROUTE_KEYS.has(type);
}

/** Reads `success` through the constraint shared by every route response. */
function isSuccess(response: { success: boolean }): boolean {
	return response.success;
}

function shouldInitSync<K extends RouteKey>(
	route: RouteDefinition<K>,
	response: RouteResponse<K>,
): boolean {
	if (!route.syncInitOnSuccess) {
		return false;
	}

	if (typeof route.syncInitOnSuccess === "function") {
		return route.syncInitOnSuccess(response);
	}

	return isSuccess(response);
}

/**
 * Generic in the route key so payload, handler and response stay bound to one
 * another. Resolving `K` to the whole union here instead would collapse the
 * handler signatures into an uncallable intersection.
 */
async function dispatchRoute<K extends RouteKey>(
	type: K,
	payload: RoutePayload<K>,
	ctx: RouteContext,
): Promise<RouteResponse<K>> {
	const route = routeRegistry[type];

	await route.before?.(ctx);
	const response = await route.handle(payload, ctx);

	if (shouldInitSync(route, response)) {
		ensureSyncInitialized(type);
	}

	return response;
}

export async function routeRuntimeMessage(
	message: unknown,
	overrides?: PasskeyRouteOverrides,
): Promise<AnyRouteResponse | RouteFailure> {
	if (!isRuntimeMessage(message)) {
		console.warn("[Background router] Unknown message type:", message);
		return {
			success: false,
			error: "Unknown message type",
		};
	}

	const ctx: RouteContext = {
		passkeyHandlers: {
			handlePasskeyCreate,
			handlePasskeyGet,
			handlePasskeyCancel,
			...overrides,
		},
	};

	return dispatchRoute(message.type, message.payload, ctx);
}

export function registerBackgroundMessageRouter(): void {
	chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
		void (async () => {
			try {
				// A message can arrive on a freshly woken service worker whose in-memory
				// master-unlock-key cache is still empty. Waiting for the startup routine
				// means no handler ever reads a half-restored unlock state.
				await ensureBackgroundServicesReady();
				const response = await routeRuntimeMessage(message);
				sendResponse(response);
			} catch (error) {
				console.error("[Background router] Handler error:", error);
				sendResponse({
					success: false,
					error: String(error),
				} satisfies RouteFailure);
			}
		})();

		return true; // Keep channel open for async response.
	});
}
