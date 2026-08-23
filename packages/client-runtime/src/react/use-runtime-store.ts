import { useSyncExternalStore } from "react";
import type { RuntimeSnapshot, RuntimeStore } from "../client";

const IDLE: RuntimeSnapshot<never> = Object.freeze({ state: "idle" });

/** Stands in for an absent store, so the subscription primitive stays unconditional. */
const IDLE_STORE: RuntimeStore<never> = {
	subscribe: () => () => undefined,
	getSnapshot: () => IDLE,
};

function serverSnapshot(): RuntimeSnapshot<never> {
	return IDLE;
}

/**
 * The only subscription in this package. Every feature hook derives from it, so there is
 * one place where React meets the Runtime and one place a lifetime bug can hide.
 *
 * `null` means "no observation yet" — an Account the host has not chosen. The server
 * snapshot is always idle: the Web build prerenders, and a prerender has no Worker.
 */
export function useRuntimeStore<T>(
	store: RuntimeStore<T> | null,
): RuntimeSnapshot<T> {
	const bound = (store ?? IDLE_STORE) as RuntimeStore<T>;
	return useSyncExternalStore(
		bound.subscribe,
		bound.getSnapshot,
		serverSnapshot as () => RuntimeSnapshot<T>,
	);
}
