import type {
	RuntimeClient,
	RuntimeStore,
} from "@bittery/client-runtime/client";
import type {
	PendingShareResult,
	ShareAccessMode,
	ShareExpiration,
} from "@bittery/client-runtime/protocol";
import { useRuntimeClient } from "@bittery/client-runtime/react";
import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { observeAccountDeparture } from "@/lib/runtime-account-presentation";
import { useRuntimeMutation } from "./use-runtime-mutation";

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

/** Observe semantic resolution; detaching presentation leaves accepted work in Runtime. */
export function waitForPendingShareResult(
	client: RuntimeClient,
	accountId: string,
	operationId: string,
	signal?: AbortSignal,
): Promise<PendingShareResult> {
	const results = client.pendingShareResults(accountId);
	const operations = client.operations(accountId);
	return new Promise((resolve, reject) => {
		const releases: Array<() => void> = [];
		let settled = false;
		const finish = (result?: PendingShareResult, error?: Error) => {
			if (settled) return;
			settled = true;
			for (const release of releases) release();
			signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else if (result) resolve(result);
		};
		const abort = () =>
			finish(
				undefined,
				new DOMException("Share presentation detached", "AbortError"),
			);
		const inspect = () => {
			if (settled) return;
			if (signal?.aborted) return abort();
			const result = pendingResult(results, operationId);
			if (result) return finish(result);
			for (const store of [results, operations]) {
				const snapshot = store.getSnapshot();
				if (snapshot.state === "failed")
					return finish(
						undefined,
						new Error(`Share result observation failed: ${snapshot.code}`),
					);
			}
			const snapshot = operations.getSnapshot();
			const operation =
				snapshot.state === "ready"
					? snapshot.value.operations.find(
							(entry) => entry.operationId === operationId,
						)
					: undefined;
			if (operation?.resolution === "rejected")
				finish(
					undefined,
					new Error(
						`Share Operation rejected: ${operation.rejectionCode ?? "unknown"}`,
					),
				);
		};
		signal?.addEventListener("abort", abort, { once: true });
		for (const store of [results, operations]) {
			if (settled) break;
			const release = store.subscribe(inspect);
			if (settled) release();
			else releases.push(release);
		}
		inspect();
	});
}

export async function createShareWithRuntime(
	runtime: RuntimeClient,
	input: CreateShareInput,
	signal?: AbortSignal,
): Promise<CreateShareResult> {
	const accountId = input.item.accountId ?? input.item.account?.accountId;
	if (!accountId) {
		throw new Error("Account context is required to create a share");
	}
	const attempt = new AbortController();
	const abort = () => attempt.abort();
	const release = observeAccountDeparture(runtime, accountId, abort);
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	try {
		attempt.signal.throwIfAborted();
		const accepted = await runtime.createShare(
			{
				accountId,
				itemId: input.item.id,
				draft: {
					accessMode: input.accessMode,
					expiresIn: input.expiresIn,
					isOneTimeUse: input.isOneTimeUse,
					allowedEmails: input.allowedEmails,
				},
			},
			{ signal: attempt.signal },
		);
		return {
			...(await waitForPendingShareResult(
				runtime,
				accountId,
				accepted.operationId,
				attempt.signal,
			)),
			accountId,
		};
	} finally {
		release();
		signal?.removeEventListener("abort", abort);
	}
}

export function useCreateShare() {
	const runtime = useRuntimeClient();
	// The shared presentation adapter retires callbacks; Runtime keeps accepted work.
	return useRuntimeMutation({
		accountId: (input: CreateShareInput) =>
			input.item.accountId ?? input.item.account?.accountId,
		mutationFn: (input: CreateShareInput, signal) =>
			createShareWithRuntime(runtime, input, signal),
	});
}
