/**
 * useRestoreItem Hook
 *
 * Restores a soft-deleted vault item from trash.
 */

import { useMutation } from "@tanstack/react-query";
import { useItemMutationRuntime } from "./mutation-utils";

/**
 * Input for restoring an item from trash
 */
export interface RestoreItemInput {
	itemId: string;
	vaultId: string;
	accountId: string;
}

/**
 * Hook for restoring a soft-deleted item from trash.
 */
export function useRestoreItem() {
	const { commands } = useItemMutationRuntime();

	return useMutation({
		mutationFn: (input: RestoreItemInput) =>
			commands.execute({ type: "restore", ...input }),
	});
}
