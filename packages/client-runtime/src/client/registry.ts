import type {
	ObservationRequest,
	RuntimeProjection,
} from "../../generated/runtime-protocol/contract";
import {
	failedSnapshot,
	IDLE_SNAPSHOT,
	LOADING_SNAPSHOT,
	type RuntimeSnapshot,
	type RuntimeStore,
	readySnapshot,
} from "./store";
import { type RuntimeTransport, transportErrorCode } from "./transport";

/** Cancels the deferred work it was given. Returns nothing; calling twice is harmless. */
export type ScheduledCancel = () => void;

/**
 * Defers teardown. `setTimeout` in a host, an explicit clock in a test — the registry never
 * reads a real clock itself, so its behaviour is decidable rather than timing-dependent.
 */
export type Schedule = (run: () => void, delayMs: number) => ScheduledCancel;

export const DEFAULT_RELEASE_GRACE_MS = 250;

const defaultSchedule: Schedule = (run, delayMs) => {
	const handle = setTimeout(run, delayMs);
	return () => clearTimeout(handle);
};

interface Subscriber {
	notify(): void;
}

interface Entry<T> {
	readonly requestJson: string;
	readonly projectionType: RuntimeProjection["type"];
	readonly store: RuntimeStore<T>;
	readonly subscribers: Set<Subscriber>;
	snapshot: RuntimeSnapshot<T>;
	refCount: number;
	/** The id of the open transport observation, or none while it is closed. */
	observationId: string | undefined;
	/** The per-key serialisation chain. Every transport call for this key runs on it. */
	queue: Promise<void>;
	cancelTeardown: ScheduledCancel | undefined;
}

export interface ObservationRegistryOptions {
	transport: RuntimeTransport;
	schedule?: Schedule;
	releaseGraceMs?: number;
}

/**
 * Owns observation identity and lifetime outside React.
 *
 * Four properties hold it together. Ids are **minted**, so two consumers of one Account can
 * never collide on a derived name. Entries are **reference counted** by logical observation,
 * so N consumers share one transport observation. Teardown is **deferred and cancellable**,
 * so a StrictMode double-mount and a parent-to-child route handoff produce no traffic at all.
 * Per-key work is **serialised**, so a release/retain pair cannot post `observe` ahead of a
 * pending `unobserve` and lose the race in a last-writer-wins map.
 *
 * Entries outlive their observation on purpose: a store handle is identity, and a host that
 * re-reads `items(accountId)` must get the object it already subscribed to. What the grace
 * window drops is the *snapshot*, because an unobserved projection goes stale.
 */
export class ObservationRegistry {
	readonly #transport: RuntimeTransport;
	readonly #schedule: Schedule;
	readonly #releaseGraceMs: number;
	readonly #entries = new Map<string, Entry<unknown>>();
	#minted = 0;

	constructor(options: ObservationRegistryOptions) {
		this.#transport = options.transport;
		this.#schedule = options.schedule ?? defaultSchedule;
		this.#releaseGraceMs = options.releaseGraceMs ?? DEFAULT_RELEASE_GRACE_MS;
	}

	/**
	 * The store for one logical observation. Same request, same store instance, for the
	 * lifetime of the client. Nothing is sent until something subscribes.
	 */
	store<T>(request: ObservationRequest): RuntimeStore<T> {
		const key = observationKey(request);
		const existing = this.#entries.get(key);
		if (existing !== undefined) return existing.store as RuntimeStore<T>;

		const entry: Entry<T> = {
			requestJson: JSON.stringify(request),
			projectionType: projectionTypeFor(request),
			store: {
				subscribe: (onStoreChange) => this.#subscribe(entry, onStoreChange),
				getSnapshot: () => entry.snapshot,
			},
			subscribers: new Set(),
			snapshot: IDLE_SNAPSHOT as RuntimeSnapshot<T>,
			refCount: 0,
			observationId: undefined,
			queue: Promise.resolve(),
			cancelTeardown: undefined,
		};
		this.#entries.set(key, entry as Entry<unknown>);
		return entry.store;
	}

	#subscribe<T>(entry: Entry<T>, onStoreChange: () => void): () => void {
		const subscriber: Subscriber = { notify: onStoreChange };
		entry.subscribers.add(subscriber);
		this.#retain(entry);
		return () => {
			// A store handle may be unsubscribed twice; only the first release counts.
			if (!entry.subscribers.delete(subscriber)) return;
			this.#release(entry);
		};
	}

	#retain<T>(entry: Entry<T>): void {
		entry.cancelTeardown?.();
		entry.cancelTeardown = undefined;
		entry.refCount += 1;
		if (entry.refCount > 1) return;
		if (entry.snapshot.state === "idle") {
			this.#publish(entry, LOADING_SNAPSHOT as RuntimeSnapshot<T>);
		}
		this.#reconcile(entry);
	}

	#release<T>(entry: Entry<T>): void {
		entry.refCount -= 1;
		if (entry.refCount > 0) return;
		entry.cancelTeardown = this.#schedule(() => {
			entry.cancelTeardown = undefined;
			// The projection is no longer maintained, so it stops being an answer.
			this.#publish(entry, IDLE_SNAPSHOT as RuntimeSnapshot<T>);
			this.#reconcile(entry);
		}, this.#releaseGraceMs);
	}

	/**
	 * Drives the transport toward the refcount, one queued step at a time. Each step reads
	 * the refcount when it runs rather than when it was queued, so a retain that lands while
	 * an `unobserve` is in flight is honoured by the step after it instead of racing it.
	 */
	#reconcile<T>(entry: Entry<T>): void {
		entry.queue = entry.queue.then(async () => {
			const wanted = entry.refCount > 0;
			if (wanted === (entry.observationId !== undefined)) return;
			if (wanted) {
				await this.#open(entry);
				return;
			}
			const observationId = entry.observationId;
			entry.observationId = undefined;
			if (observationId === undefined) return;
			await this.#transport.unobserve(observationId).catch(() => undefined);
		});
	}

	async #open<T>(entry: Entry<T>): Promise<void> {
		this.#minted += 1;
		const observationId = `observation-${this.#minted}`;
		entry.observationId = observationId;
		try {
			await this.#transport.observe(
				observationId,
				entry.requestJson,
				(projectionJson) => {
					// A closed observation may still deliver; the minted id says which one.
					if (entry.observationId !== observationId) return;
					this.#deliver(entry, projectionJson);
				},
			);
		} catch (error) {
			if (entry.observationId !== observationId) return;
			entry.observationId = undefined;
			// Left failed until every consumer leaves: retrying per subscriber would turn one
			// broken Account into a request storm.
			this.#publish(entry, failedSnapshot<T>(transportErrorCode(error)));
		}
	}

	#deliver<T>(entry: Entry<T>, projectionJson: string): void {
		let projection: RuntimeProjection;
		try {
			projection = JSON.parse(projectionJson) as RuntimeProjection;
		} catch {
			return;
		}
		if (projection.type !== entry.projectionType) return;
		this.#publish(entry, readySnapshot(projection.value as T));
	}

	#publish<T>(entry: Entry<T>, snapshot: RuntimeSnapshot<T>): void {
		entry.snapshot = snapshot;
		for (const subscriber of entry.subscribers) subscriber.notify();
	}
}

function observationKey(request: ObservationRequest): string {
	return request.type === "items"
		? `items:${request.accountId}`
		: `runtimeStatus:${request.accountId ?? ""}`;
}

function projectionTypeFor(
	request: ObservationRequest,
): RuntimeProjection["type"] {
	return request.type;
}
