import { type UseMutationResult, useMutation } from "@tanstack/react-query";
import type {
	ItemsProjection,
	RuntimeStatusProjection,
} from "../../generated/runtime-protocol/contract";
import type {
	CreateLoginItemInput,
	QuickUnlockInput,
	RuntimeAccepted,
	RuntimeSignedIn,
	RuntimeSnapshot,
	SignInInput,
} from "../client";
import { useRuntimeClient } from "./context";
import { useRuntimeStore } from "./use-runtime-store";

/**
 * The Items of one Account, or an idle snapshot while the host has no Account. A pure
 * derivation of {@link useRuntimeStore}: it opens nothing, decides nothing, and the
 * registry below it shares one observation between every caller.
 */
export function useRuntimeItems(
	accountId: string | null | undefined,
): RuntimeSnapshot<ItemsProjection> {
	const client = useRuntimeClient();
	return useRuntimeStore(accountId == null ? null : client.items(accountId));
}

/** One Account's status, or the Device aggregate when no Account is named. */
export function useRuntimeStatus(
	accountId?: string | null,
): RuntimeSnapshot<RuntimeStatusProjection> {
	const client = useRuntimeClient();
	return useRuntimeStore(client.status(accountId));
}

export function useRuntimeSignIn(): UseMutationResult<
	RuntimeSignedIn,
	Error,
	SignInInput
> {
	const client = useRuntimeClient();
	return useMutation({
		mutationFn: (input: SignInInput) => client.signIn(input),
	});
}

export function useRuntimeQuickUnlock(): UseMutationResult<
	RuntimeSignedIn,
	Error,
	QuickUnlockInput
> {
	const client = useRuntimeClient();
	return useMutation({
		mutationFn: (input: QuickUnlockInput) => client.quickUnlock(input),
	});
}

export function useCreateLoginItem(): UseMutationResult<
	RuntimeAccepted,
	Error,
	CreateLoginItemInput
> {
	const client = useRuntimeClient();
	return useMutation({
		mutationFn: (input: CreateLoginItemInput) => client.createLoginItem(input),
	});
}
