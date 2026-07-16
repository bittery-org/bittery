/**
 * Background Message Router
 *
 * Keeps runtime message handling isolated from service-worker bootstrap
 * wiring. Runtime message types are preserved for popup/content
 * compatibility. Routing itself is data-driven; see `registry.ts` for the
 * `message.type -> RouteDefinition` table.
 */

import {
	handlePasskeyCancel,
	handlePasskeyCreate,
	handlePasskeyGet,
} from "../passkey-handlers";
import type { MessageResponse } from "../types";
import { routeRegistry } from "./registry";
import { ensureSyncInitialized } from "./sync-effects";
import type {
	PasskeyRouteOverrides,
	RouteContext,
	RouteDefinition,
	RuntimeMessage,
} from "./types";

function shouldInitSync(route: RouteDefinition, response: unknown): boolean {
	if (!route.syncInitOnSuccess) {
		return false;
	}

	const messageResponse = response as MessageResponse;
	if (typeof route.syncInitOnSuccess === "function") {
		return route.syncInitOnSuccess(messageResponse);
	}

	return Boolean(messageResponse?.success);
}

export async function routeRuntimeMessage(
	message: RuntimeMessage,
	overrides?: PasskeyRouteOverrides,
): Promise<unknown> {
	const ctx: RouteContext = {
		passkeyHandlers: {
			handlePasskeyCreate,
			handlePasskeyGet,
			handlePasskeyCancel,
			...overrides,
		},
	};

	const route = routeRegistry[message.type];
	if (!route) {
		console.warn("[Background router] Unknown message type:", message);
		return {
			success: false,
			error: "Unknown message type",
		};
	}

	await route.before?.(ctx);
	const response = await route.handle(message.payload, ctx);

	if (shouldInitSync(route, response)) {
		ensureSyncInitialized(message.type);
	}

	return response;
}

export function registerBackgroundMessageRouter(): void {
	chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
		const runtimeMessage = message as RuntimeMessage;
		void (async () => {
			try {
				const response = await routeRuntimeMessage(runtimeMessage);
				sendResponse(response);
			} catch (error) {
				console.error("[Background router] Handler error:", error);
				sendResponse({
					success: false,
					error: String(error),
				});
			}
		})();

		return true; // Keep channel open for async response.
	});
}
