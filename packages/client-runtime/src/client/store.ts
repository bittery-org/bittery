import type { RuntimeErrorCode } from "../../generated/runtime-protocol/contract";

/**
 * What a host knows about one observation. Four states, not a boolean pair: `idle` is
 * "nobody is watching", which a loading flag cannot express, and `failed` carries the code
 * the UI has to branch on.
 */
export type RuntimeSnapshot<T> =
	| { readonly state: "idle" }
	| { readonly state: "loading" }
	| { readonly state: "ready"; readonly value: T }
	| { readonly state: "failed"; readonly code: RuntimeErrorCode };

/**
 * A `useSyncExternalStore`-shaped handle, not a callback and not an `AsyncIterable`. The
 * protocol publishes full coalescible snapshots, so the newest value is the whole truth and
 * a late consumer misses nothing by skipping the ones before it.
 *
 * `getSnapshot` returns the same frozen object until the next publish. React 19 warns and
 * can re-render forever if a snapshot getter allocates.
 */
export interface Subscribable<T> {
	subscribe(onStoreChange: () => void): () => void;
	getSnapshot(): T;
}

/** One observation's four-state snapshot, in that shape. */
export type RuntimeStore<T> = Subscribable<RuntimeSnapshot<T>>;

export const IDLE_SNAPSHOT: RuntimeSnapshot<never> = Object.freeze({
	state: "idle",
});
export const LOADING_SNAPSHOT: RuntimeSnapshot<never> = Object.freeze({
	state: "loading",
});

export function readySnapshot<T>(value: T): RuntimeSnapshot<T> {
	return Object.freeze({ state: "ready", value } as const);
}

export function failedSnapshot<T>(code: RuntimeErrorCode): RuntimeSnapshot<T> {
	return Object.freeze({ state: "failed", code } as const);
}
