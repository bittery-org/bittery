import { useMemo } from "react";
import type { ISyncContext } from "./capabilities";

/**
 * Narrow a sync context to the capability `@bittery/core`'s `PlatformProvider`
 * consumes, with a stable identity.
 *
 * Every frontend published a superset — web and desktop add `status`,
 * `reconnect` and `disconnect`; desktop and mobile add `isInitialized`; the
 * extension publishes the worker's `ConnectionStatus` instead — and every one of
 * them then hand-wrote the same five-field `useMemo` to strip it back down.
 *
 * The memo is the point, not the narrowing: without it the object identity
 * changes on every render of the sync provider, and `PlatformProvider` puts it
 * straight into a context value, so every consumer of the platform context would
 * re-render whenever any unrelated sync field moved.
 */
export function useSyncCapability(source: ISyncContext): ISyncContext {
	const { clientId, isConnected, isOnline, invalidator, outboundQueue } =
		source;

	return useMemo(
		() => ({ clientId, isConnected, isOnline, invalidator, outboundQueue }),
		[clientId, isConnected, isOnline, invalidator, outboundQueue],
	);
}
