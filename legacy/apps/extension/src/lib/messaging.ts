/**
 * Typed runtime messaging
 *
 * The single sanctioned way to talk to the background router. `chrome.runtime`
 * is untyped by construction (`sendMessage` is declared to resolve `any`), so
 * the one cast the protocol needs lives here and nowhere else: callers get the
 * response type the contract pairs with the message they actually sent.
 */

import type {
	RouteResponse,
	RuntimeMessage,
} from "../background/router/contract";

/**
 * Generic in the message rather than the route key so `M` is inferred from the
 * object literal — `sendMessage({ type: "GET_VAULT_ITEM", payload: { itemId } })`
 * reads as before but is checked against the contract, and resolves to that
 * route's response.
 */
export function sendMessage<M extends RuntimeMessage>(
	message: M,
): Promise<RouteResponse<M["type"]>> {
	return chrome.runtime.sendMessage(message) as Promise<
		RouteResponse<M["type"]>
	>;
}
