/**
 * Background Message Router Types
 */

import type {
	handlePasskeyCancel,
	handlePasskeyCreate,
	handlePasskeyGet,
} from "../passkey-handlers";
import type { MessageResponse } from "../types";

export type RuntimeMessage = {
	type: string;
	payload?: unknown;
};

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

export function getPayload<TPayload>(message: RuntimeMessage): TPayload {
	return message.payload as TPayload;
}

export interface RouteDefinition<P = unknown> {
	handle(
		payload: P,
		ctx: RouteContext,
	): Promise<MessageResponse> | MessageResponse;
	/**
	 * When truthy (or when the predicate returns true for the route's
	 * response), `ensureSyncInitialized` runs after `handle` resolves.
	 */
	syncInitOnSuccess?: boolean | ((response: MessageResponse) => boolean);
	/** Runs before `handle`, e.g. to disconnect/cleanup sync as a side effect. */
	before?: (ctx: RouteContext) => void | Promise<void>;
}

export type RouteRegistry = Record<string, RouteDefinition<any>>;
