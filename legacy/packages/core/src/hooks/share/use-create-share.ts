import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { useMutation } from "@tanstack/react-query";
import {
	useCoreContext,
	useQueryInvalidator,
} from "../../context/platform-context";
import type {
	CreateShareResult,
	ShareAccessMode,
	ShareExpirationOption,
} from "../../services/share-service";

export type { CreateShareResult, ShareAccessMode, ShareExpirationOption };

export interface CreateShareInput {
	item: DecryptedItemWithContext;
	accessMode: ShareAccessMode;
	expiresIn: ShareExpirationOption;
	isOneTimeUse: boolean;
	allowedEmails?: string[];
}

export function useCreateShare() {
	const core = useCoreContext();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: CreateShareInput): Promise<CreateShareResult> => {
			const coordinatedItem = core.vaultRepository.getById(input.item.id);
			const accountId =
				input.item.accountId ??
				input.item.account?.accountId ??
				coordinatedItem?.accountId ??
				coordinatedItem?.account?.accountId;
			if (!accountId) {
				throw new Error("Account context is required to create a share");
			}
			return core.shares.createShare({
				...input,
				accountId,
			});
		},
		onSuccess: async (_result, input) => {
			await invalidator.invalidateShare(input.item.id);
		},
	});
}
