/**
 * Background Message Router Types
 *
 * Handler-side projections of `contract.ts`. Nothing here restates a route's
 * shape: `RouteDefinition<K>` reads the payload and response straight out of
 * the contract, and `RouteRegistry` is a total map over its keys, so a route
 * that exists in only one of the two places is a compile error.
 */

import type {
	handlePasskeyCancel,
	handlePasskeyCreate,
	handlePasskeyGet,
} from "../passkey-handlers";
import type { RouteKey, RoutePayload, RouteResponse } from "./contract";

export interface PasskeyHandlers {
	handlePasskeyCreate: typeof handlePasskeyCreate;
	handlePasskeyGet: typeof handlePasskeyGet;
	handlePasskeyCancel: typeof handlePasskeyCancel;
}

/**
 * Test seam: callers (e.g. unit tests) can override individual passkey
 * handlers without needing to mock the whole `passkey-handlers` module.
 */
export type PasskeyRouteOverrides = Partial<PasskeyHandlers>;

export interface RouteContext {
	passkeyHandlers: PasskeyHandlers;
}

export interface RouteDefinition<K extends RouteKey> {
	handle(
		payload: RoutePayload<K>,
		ctx: RouteContext,
	): Promise<RouteResponse<K>> | RouteResponse<K>;
	/**
	 * When truthy (or when the predicate returns true for the route's
	 * response), `ensureSyncInitialized` runs after `handle` resolves.
	 */
	syncInitOnSuccess?: boolean | ((response: RouteResponse<K>) => boolean);
	/** Runs before `handle`, e.g. to disconnect/cleanup sync as a side effect. */
	before?: (ctx: RouteContext) => void | Promise<void>;
}

/** Total over `RouteKey`: a missing route and an unknown route both fail here. */
export type RouteRegistry = { [K in RouteKey]: RouteDefinition<K> };
