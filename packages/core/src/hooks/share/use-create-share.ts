import { useApiClient } from "@bittery/shared/api";
import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { useMutation } from "@tanstack/react-query";
import {
	useCoreContext,
	useQueryInvalidator,
} from "../../context/platform-context";
import { getItemAccountEmail } from "../../services/account-resolver";
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
	const defaultClient = useApiClient();
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
