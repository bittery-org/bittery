import { type UseMutationResult, useMutation } from "@tanstack/react-query";
import type {
	ItemsProjection,
	PendingShareResultsProjection,
	RuntimeStatusProjection,
} from "../../generated/runtime-protocol/contract";
import {
	type CreateItemInput,
	IDLE_SNAPSHOT,
	LOADING_SESSION,
	type QuickUnlockInput,
	type RuntimeAccepted,
	type RuntimeAccessChanged,
	type RuntimeSessionSnapshot,
	type RuntimeSignedIn,
	type RuntimeSnapshot,
	type SignInInput,
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
	return useRuntimeStore(
		accountId == null ? null : client.items(accountId),
		IDLE_SNAPSHOT as RuntimeSnapshot<ItemsProjection>,
	);
}

export function useRuntimePendingShareResults(
	accountId: string | null | undefined,
): RuntimeSnapshot<PendingShareResultsProjection> {
	const client = useRuntimeClient();
	return useRuntimeStore(
		accountId == null ? null : client.pendingShareResults(accountId),
		IDLE_SNAPSHOT as RuntimeSnapshot<PendingShareResultsProjection>,
	);
}

/** One Account's status, or the Device aggregate when no Account is named. */
export function useRuntimeStatus(
	accountId?: string | null,
): RuntimeSnapshot<RuntimeStatusProjection> {
	const client = useRuntimeClient();
	return useRuntimeStore(
		client.status(accountId),
		IDLE_SNAPSHOT as RuntimeSnapshot<RuntimeStatusProjection>,
	);
}

/**
 * The Device session: which Account the host is pointing at and how far it is open. One
 * Device-wide observation stands behind every caller, so it survives sign-in, sign-out,
 * lock, and Account switch without a teardown.
 */
export function useRuntimeSession(): RuntimeSessionSnapshot {
	const client = useRuntimeClient();
	return useRuntimeStore(client.session(), LOADING_SESSION);
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

export function useRuntimeSignOut(): UseMutationResult<
	RuntimeAccessChanged,
	Error,
	string
> {
	const client = useRuntimeClient();
	return useMutation({
		mutationFn: (accountId: string) => client.signOut(accountId),
	});
}

export function useRuntimeLock(): UseMutationResult<
	RuntimeAccessChanged,
	Error,
	string
> {
	const client = useRuntimeClient();
	return useMutation({
		mutationFn: (accountId: string) => client.lock(accountId),
	});
}

export function useCreateItem(): UseMutationResult<
	RuntimeAccepted,
	Error,
	CreateItemInput
> {
	const client = useRuntimeClient();
	return useMutation({
		mutationFn: (input: CreateItemInput) => client.createItem(input),
	});
}
