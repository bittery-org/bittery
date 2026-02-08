/**
 * useCreateShare Hook
 *
 * Creates a secure share link for a vault item.
 */

import {
	buildShareUrl as buildShareUrlCore,
	type ShareAccessMode,
	type ShareExpirationOption,
} from "../../services/share-service";
import { useTRPCClient } from "@bittery/shared/trpc";
import type { DecryptedItem } from "@bittery/shared/types";
import { useMutation } from "@tanstack/react-query";
import {
	useCoreContext,
	useQueryInvalidator,
} from "../../context/platform-context";
import { useItems } from "../use-items";

export type { ShareAccessMode, ShareExpirationOption };

/**
 * Input for creating a share link
 */
export interface CreateShareInput {
	item: DecryptedItem;
	accessMode: ShareAccessMode;
	expiresIn: ShareExpirationOption;
	isOneTimeUse: boolean;
	allowedEmails?: string[];
}

/**
 * Result from share creation
 */
export interface CreateShareResult {
	token: string;
	shareKeyBase64: string;
	expiresAt: string;
	baseShareUrl: string;
}

/**
 * Build the full share URL from a CreateShareResult.
 */
export function buildShareUrl(result: CreateShareResult): string {
	return buildShareUrlCore(result);
}

/**
 * Hook for creating a secure share link for a vault item.
 */
export function useCreateShare() {
	const defaultClient = useTRPCClient();
	const { items } = useItems();
	const core = useCoreContext();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: CreateShareInput): Promise<CreateShareResult> => {
			const accountEmail = core.accounts.findAccountForItem(
				input.item.id,
				items,
			);
			return core.shares.createShare(
				{
					...input,
					accountEmail,
				},
				defaultClient,
			);
		},
		onSuccess: async () => {
			await invalidator.invalidateShare();
		},
	});
}
