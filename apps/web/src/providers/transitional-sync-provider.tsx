import {
	createQueryInvalidator,
	type IPendingMutationQueue,
	type ISyncContext,
	type QueryInvalidator,
} from "@bittery/sync";
import type { QueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useMemo } from "react";

/**
 * What is left of Sync on Web: nothing that runs.
 *
 * The Runtime owns Sync ownership for every Account it signs in, and the spec forbids two
 * active writers for one Account. Web therefore owns no Sync loop at all after the cutover —
 * `useWebSync`, its `AccountSyncLifecycle`, its assembled `SyncSource` and its SSE
 * connection are deleted, not disabled, so no configuration can bring them back.
 *
 * Two things still need a context in their shape:
 *
 *   - React Query invalidation for the transitional REST surfaces still on the page
 *     (Teams, invitations, Vault members, billing). Those never went through Sync events;
 *     they only ever needed the invalidator, which is a plain function over the client.
 *   - `PlatformProvider`, which refuses to build item mutations without a Sync capability.
 *     The remaining transitional write kinds move in ticket 28. Until then they keep the
 *     behaviour ticket 22's decision accepted: they apply to the transitional repository
 *     the vault pages no longer read, and go nowhere.
 */

/**
 * The capability plus the concrete invalidator.
 *
 * `ISyncContext` narrows the invalidator to the eight methods the shared hooks call. The
 * Web components below it also invalidate by event, so the context keeps the wider type.
 */
interface TransitionalSync extends ISyncContext {
	readonly invalidator: QueryInvalidator;
}

/** A queue that stages nothing, because nothing drains it. */
export const INERT_OUTBOUND_QUEUE: IPendingMutationQueue = {
	// The optimistic projection still runs, so a transitional write behaves exactly as it
	// did before the loop was deleted: it lands locally and is never dispatched. Refusing
	// here would be the gating UI ticket 22 decided not to build and ticket 28 replaces.
	async enqueue(_command, applyOptimistic) {
		await applyOptimistic?.();
	},
	getPendingCount: () => 0,
	hasPendingForItem: () => false,
	getCommands: () => [],
};

const TransitionalSyncContext = createContext<TransitionalSync | null>(null);

/**
 * Publishes the invalidator and the inert capability. Named for what it is so nobody
 * looks here for a Sync loop.
 */
export function TransitionalSyncProvider({
	children,
	queryClient,
}: {
	children: ReactNode;
	queryClient: QueryClient;
}) {
	const value = useMemo<TransitionalSync>(
		() => ({
			// No connection exists, so there is no client identity to publish and nothing
			// this Device could be connected to.
			clientId: "",
			isConnected: false,
			isOnline: false,
			invalidator: createQueryInvalidator({ queryClient }),
			outboundQueue: INERT_OUTBOUND_QUEUE,
		}),
		[queryClient],
	);
	return (
		<TransitionalSyncContext.Provider value={value}>
			{children}
		</TransitionalSyncContext.Provider>
	);
}

/** The capability `PlatformProvider` needs from a host. */
export function useTransitionalSync(): TransitionalSync {
	const context = useContext(TransitionalSyncContext);
	if (!context) {
		throw new Error(
			"useTransitionalSync must be used within a TransitionalSyncProvider",
		);
	}
	return context;
}

/** Invalidate the React Query caches behind the transitional REST reads. */
export function useQueryInvalidator(): QueryInvalidator {
	return useTransitionalSync().invalidator;
}
