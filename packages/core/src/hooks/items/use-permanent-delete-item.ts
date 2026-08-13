/**
 * usePermanentDeleteItem Hook
 *
 * Permanently deletes a vault item from trash.
 */

import { useMutation } from "@tanstack/react-query";
import { useItemMutationRuntime } from "./mutation-utils";

/**
 * Input for permanently deleting an item
 */
export interface PermanentDeleteItemInput {
	itemId: string;
	vaultId: string;
}

/**
 * Hook for permanently deleting an item from trash.
 */
export function usePermanentDeleteItem() {
	const { commands } = useItemMutationRuntime();

	return useMutation({
		mutationFn: (input: PermanentDeleteItemInput) =>
			commands.execute({ type: "permanent_delete", ...input }),
	});
}
