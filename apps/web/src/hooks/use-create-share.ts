import type {
	RuntimeClient,
	RuntimeStore,
} from "@bittery/client-runtime/client";
import type {
	PendingShareResult,
	ShareAccessMode,
	ShareExpiration,
} from "@bittery/client-runtime/protocol";
import {
	useRuntimeClient,
	useRuntimePendingShareResults,
} from "@bittery/client-runtime/react";
import { useQueryInvalidator } from "@bittery/core/hooks";
import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { useMutation } from "@tanstack/react-query";

export interface CreateShareInput {
	item: DecryptedItemWithContext;
	accessMode: ShareAccessMode;
	expiresIn: ShareExpiration;
	isOneTimeUse: boolean;
	allowedEmails?: string[];
}

export type CreateShareResult = PendingShareResult & { accountId: string };

function pendingResult(
	store: RuntimeStore<{
		accountId: string;
		replicaRevision: string;
		results: PendingShareResult[];
	}>,
	operationId: string,
): PendingShareResult | undefined {
	const snapshot = store.getSnapshot();
	return snapshot.state === "ready"
		? snapshot.value.results.find(
				(result) => result.operationId === operationId,
			)
		: undefined;
}

/** Waits without a transport-attempt bound; only Runtime semantic resolution can finish it. */
export function waitForPendingShareResult(
	client: RuntimeClient,
	accountId: string,
	operationId: string,
): Promise<PendingShareResult> {
	const store = client.pendingShareResults(accountId);
	const existing = pendingResult(store, operationId);
	if (existing) return Promise.resolve(existing);
	return new Promise((resolve, reject) => {
		let unsubscribe: () => void = () => undefined;
		const inspect = () => {
			const snapshot = store.getSnapshot();
			if (snapshot.state === "failed") {
				unsubscribe();
				reject(new Error(`Share result observation failed: ${snapshot.code}`));
				return;
			}
			const result = pendingResult(store, operationId);
			if (result) {
				unsubscribe();
				resolve(result);
			}
		};
		unsubscribe = store.subscribe(inspect);
		inspect();
	});
}

export async function createShareWithRuntime(
	runtime: RuntimeClient,
	input: CreateShareInput,
): Promise<CreateShareResult> {
	const accountId = input.item.accountId ?? input.item.account?.accountId;
	if (!accountId) {
		throw new Error("Account context is required to create a share");
	}
	const accepted = await runtime.createShare({
		accountId,
		itemId: input.item.id,
		draft: {
			accessMode: input.accessMode,
			expiresIn: input.expiresIn,
			isOneTimeUse: input.isOneTimeUse,
			allowedEmails: input.allowedEmails,
		},
	});
	return {
		...(await waitForPendingShareResult(
			runtime,
			accountId,
			accepted.operationId,
		)),
		accountId,
	};
}

export function useCreateShare() {
	const runtime = useRuntimeClient();
	const invalidator = useQueryInvalidator();
	return useMutation({
		mutationFn: (input: CreateShareInput) =>
			createShareWithRuntime(runtime, input),
		onSuccess: async (_result, input) => {
			await invalidator.invalidateShare(input.item.id);
		},
	});
}

export function usePendingShareResults(accountId: string | null | undefined) {
	return useRuntimePendingShareResults(accountId);
}
