import {
	useRuntimeItems as useRuntimeItemsSnapshot,
	useRuntimeSession,
} from "@bittery/client-runtime/react";
import { useMemo } from "react";
import {
	deriveRuntimeItemsView,
	type RuntimeItemsView,
} from "@/lib/runtime-items";

/**
 * Observe Runtime Items for the Account the Device session points at, in the shape the
 * existing ItemList reads.
 *
 * Nothing here subscribes. The Device session and the Items observation are both the
 * package's hooks, their identity and lifetime belong to the Runtime client's registry, and
 * this hook only folds the two into one answer.
 */
export function useRuntimeItems(): RuntimeItemsView {
	const session = useRuntimeSession();
	const snapshot = useRuntimeItemsSnapshot(
		session.state === "unlocked" ? session.accountId : null,
	);
	return useMemo(
		() => deriveRuntimeItemsView(session, snapshot),
		[session, snapshot],
	);
}
