/**
 * The two runtime halves of the push protocol: the emitter every background
 * sender goes through, and the guard every UI listener starts with. See
 * `./contract.ts` for the union both are checked against.
 */

import type { BackgroundEvent, BackgroundEventKey } from "./contract";

/**
 * The keys as a runtime value. `satisfies Record<BackgroundEventKey, true>`
 * makes this table and the contract the same set: a missing key and a stray key
 * are both compile errors, so the guard below can never fall behind the union.
 */
const BACKGROUND_EVENT_TABLE = {
	VAULT_LOCKED: true,
	DESKTOP_LOCKED: true,
	DESKTOP_UNLOCKED: true,
	SESSION_REVOKED: true,
	THEME_CHANGED: true,
	ACTIVE_ACCOUNT_CHANGED: true,
	SYNC_STATUS_CHANGED: true,
	SYNC_FULL_REFRESH_REQUIRED: true,
	SYNC_COMMAND_STATUS_CHANGED: true,
	SYNC_ITEM_COMMAND_ACKNOWLEDGED: true,
} satisfies Record<BackgroundEventKey, true>;

const BACKGROUND_EVENT_KEYS: ReadonlySet<string> = new Set(
	Object.keys(BACKGROUND_EVENT_TABLE),
);

/**
 * The runtime hands listeners `any`, so the discriminant is checked rather than
 * asserted — the same trade `isRuntimeMessage` makes for the request direction.
 * Payloads are not re-validated: every sender is compile-checked against the
 * same contract by `emitBackgroundEvent`.
 */
export function isBackgroundEvent(value: unknown): value is BackgroundEvent {
	if (typeof value !== "object" || value === null || !("type" in value)) {
		return false;
	}

	const type: unknown = value.type;
	return typeof type === "string" && BACKGROUND_EVENT_KEYS.has(type);
}

/**
 * Broadcast one event to whatever UI context is listening, if any.
 *
 * Delivery is best-effort by design: with the popup closed there is no
 * receiver, and `chrome.runtime.sendMessage` rejects. Callers that need to
 * sequence work after delivery may await the returned promise; it never
 * rejects. The `chrome` guard keeps this callable from the reducer's adapter in
 * environments (tests, the desktop bridge) where the API is absent.
 */
export function emitBackgroundEvent(event: BackgroundEvent): Promise<void> {
	if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
		return Promise.resolve();
	}

	try {
		// A mocked or MV2-style `sendMessage` may return undefined rather than a
		// promise, so the result is normalised before it is awaited.
		return Promise.resolve(chrome.runtime.sendMessage(event)).then(
			() => undefined,
			() => undefined,
		);
	} catch {
		return Promise.resolve();
	}
}

export type {
	BackgroundEvent,
	BackgroundEventKey,
	BackgroundEventOf,
	BackgroundEventPayload,
} from "./contract";
