import { useRuntimeItems as useRuntimeItemsSnapshot } from "@bittery/client-runtime/react";
import type { UnifiedItem } from "@bittery/core/hooks";
import { useMemo, useSyncExternalStore } from "react";
import {
	getRuntimeAccountId,
	subscribeRuntimeAccount,
} from "@/lib/runtime-auth";
import { mapRuntimeItemsProjection } from "@/lib/runtime-items";

const NO_ITEMS: UnifiedItem[] = [];

/**
 * Observe Runtime Items for the Account the last Runtime Sign-in installed, in the shape
 * the existing ItemList reads. The observation's identity and lifetime belong to the
 * Runtime client's registry, so every page and the layout around it share one, and this
 * hook only maps.
 */
export function useRuntimeItems(): {
	items: UnifiedItem[];
	isLoading: boolean;
} {
	const accountId = useSyncExternalStore(
		subscribeRuntimeAccount,
		getRuntimeAccountId,
		getRuntimeAccountId,
	);
	const snapshot = useRuntimeItemsSnapshot(accountId);
	const items = useMemo(
		() =>
			snapshot.state === "ready"
				? mapRuntimeItemsProjection(snapshot.value)
				: NO_ITEMS,
		[snapshot],
	);

	return {
		items,
		// No Account means nothing to load. A failed observation has an answer, even
		// though the answer is empty.
		isLoading:
			accountId !== null &&
			snapshot.state !== "ready" &&
			snapshot.state !== "failed",
	};
}
