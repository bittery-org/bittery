/**
 * useCreateShare Hook
 *
 * Creates a secure share link for a vault item.
 */

import { useRPCClient } from "@bittery/shared/rpc";
import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { useMutation } from "@tanstack/react-query";
import {
	useCoreContext,
	useQueryInvalidator,
} from "../../context/platform-context";
import { getItemAccountEmail } from "../../services/account-resolver";
import {
	buildShareUrl as buildShareUrlCore,
	type ShareAccessMode,
	type ShareExpirationOption,
} from "../../services/share-service";

export type { ShareAccessMode, ShareExpirationOption };

/**
 * Input for creating a share link
 */
export interface CreateShareInput {
	item: DecryptedItemWithContext;
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
	const defaultClient = useRPCClient();
	const core = useCoreContext();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: CreateShareInput): Promise<CreateShareResult> => {
			const coordinatedItem = core.vaultCoordinator.getById(input.item.id);
			const accountEmail =
				getItemAccountEmail(input.item) ??
				coordinatedItem?.accountEmail ??
				coordinatedItem?.account?.email;
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
