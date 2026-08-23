import type { UnifiedItem } from "@bittery/core/hooks";
import { useEffect, useState, useSyncExternalStore } from "react";
import { runtime } from "@/lib/crypto";
import {
	getRuntimeAccountId,
	subscribeRuntimeAccount,
} from "@/lib/runtime-auth";
import { bindRuntimeItemsObservation } from "@/lib/runtime-items";

/**
 * Observe Runtime Items for the Account the last Runtime Sign-in installed.
 * Filter, sort, and render stay in the host ItemList.
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
	const [items, setItems] = useState<UnifiedItem[]>([]);
	const [isLoading, setIsLoading] = useState(true);

	useEffect(() => {
		if (!accountId) {
			setItems([]);
			setIsLoading(false);
			return;
		}
		let cancelled = false;
		setIsLoading(true);
		const stop = bindRuntimeItemsObservation(
			runtime,
			accountId,
			(nextItems) => {
				if (cancelled) {
					return;
				}
				setItems(nextItems);
				setIsLoading(false);
			},
			() => {
				if (!cancelled) {
					setIsLoading(false);
				}
			},
		);
		return () => {
			cancelled = true;
			stop();
		};
	}, [accountId]);

	return { items, isLoading };
}
