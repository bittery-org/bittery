import { useSyncExternalStore } from "react";
import type { Subscribable } from "../client";

const noopSubscribe = () => () => undefined;

/**
 * The only subscription in this package. Every feature hook derives from it, so there is
 * one place where React meets the Runtime and one place a lifetime bug can hide.
 *
 * `null` means "no observation yet" — an Account the host has not chosen — and `absent` is
 * what the host renders instead. `absent` is also the server snapshot: the Web build
 * prerenders, and a prerender has no Worker. It must be a stable reference; React 19 warns
 * and can re-render forever if a snapshot getter allocates.
 */
export function useRuntimeStore<T>(
	store: Subscribable<T> | null,
	absent: T,
): T {
	const subscribe = store === null ? noopSubscribe : store.subscribe;
	const getSnapshot = store === null ? () => absent : store.getSnapshot;
	return useSyncExternalStore(subscribe, getSnapshot, () => absent);
}
