/** Test doubles and package-internal storage fault seams for the host binding. */

import type {
	ObservationRequest,
	RuntimeError,
	RuntimeOutcome,
	RuntimeProjection,
	RuntimeRequest,
} from "../../generated/runtime-protocol/contract";
import type { RuntimeTransport, Schedule } from "../client";
import { RuntimeRequestError } from "../client";
import {
	ConfigurableIndexedDbReplicaExecutor,
	type IndexedDbReplicaExecutorTestOptions,
} from "../indexeddb-executor-internal.ts";

export interface TestIndexedDbReplicaExecutor {
	invoke(requestJson: string): Promise<string>;
}

export function createTestIndexedDbReplicaExecutor(
	options: IndexedDbReplicaExecutorTestOptions,
): TestIndexedDbReplicaExecutor {
	return new ConfigurableIndexedDbReplicaExecutor(options);
}

export type FakeTransportCall =
	| {
			readonly type: "request";
			readonly requestId: string;
			readonly requestJson: string;
	  }
	| {
			readonly type: "observe";
			readonly observationId: string;
			readonly requestJson: string;
	  }
	| { readonly type: "unobserve"; readonly observationId: string }
	| { readonly type: "close" };

export interface FakeOpenObservation {
	readonly observationId: string;
	readonly request: ObservationRequest;
}

export interface FakePendingRequest {
	readonly requestId: string;
	readonly request: RuntimeRequest;
}

export interface FakeRuntimeTransport extends RuntimeTransport {
	/** Every call this transport received, in order. */
	readonly calls: readonly FakeTransportCall[];
	openObservations(): readonly FakeOpenObservation[];
	pendingRequests(): readonly FakePendingRequest[];
	/**
	 * Publishes to one observation by id, or to every open observation the projection
	 * belongs to.
	 */
	publish(projection: RuntimeProjection, observationId?: string): void;
	/** Answers the oldest unanswered request, or the next one to arrive. */
	answer(outcome: RuntimeOutcome): void;
	/** Makes every later `observe` reject, as a closed or missing Account would. */
	failObservations(error: RuntimeError | null): void;
	/** Releases the `unobserve` calls held back by `deferUnobserve`. */
	resolveUnobserve(): void;
	/** Settles the transport's own promises and the client's queued work. */
	settled(): Promise<void>;
}

export interface FakeRuntimeTransportOptions {
	/** Holds `unobserve` open, so a test can land a retain while one is in flight. */
	deferUnobserve?: boolean;
}

interface OpenObservation {
	readonly request: ObservationRequest;
	readonly listener: (projectionJson: string) => void;
}

export function createFakeRuntimeTransport(
	options: FakeRuntimeTransportOptions = {},
): FakeRuntimeTransport {
	const calls: FakeTransportCall[] = [];
	const observations = new Map<string, OpenObservation>();
	const pending: Array<{
		requestId: string;
		request: RuntimeRequest;
		settle(outcome: RuntimeOutcome): void;
	}> = [];
	const queuedAnswers: RuntimeOutcome[] = [];
	const heldUnobserves: Array<() => void> = [];
	let observationFailure: RuntimeError | null = null;
	let closed = false;

	function drainAnswers(): void {
		while (pending.length > 0 && queuedAnswers.length > 0) {
			const next = pending.shift();
			const outcome = queuedAnswers.shift();
			if (next === undefined || outcome === undefined) return;
			next.settle(outcome);
		}
	}

	return {
		calls,
		openObservations() {
			return [...observations].map(([observationId, open]) => ({
				observationId,
				request: open.request,
			}));
		},
		pendingRequests() {
			return pending.map(({ requestId, request }) => ({ requestId, request }));
		},
		publish(projection, observationId) {
			if (observationId !== undefined) {
				// An unknown id is a closed observation, exactly as the real facade sees it.
				observations.get(observationId)?.listener(JSON.stringify(projection));
				return;
			}
			for (const open of observations.values()) {
				if (!matches(open.request, projection)) continue;
				open.listener(JSON.stringify(projection));
			}
		},
		answer(outcome) {
			queuedAnswers.push(outcome);
			drainAnswers();
		},
		failObservations(error) {
			observationFailure = error;
		},
		resolveUnobserve() {
			while (heldUnobserves.length > 0) heldUnobserves.shift()?.();
		},
		async settled() {
			// Four turns clear the registry's queue chain: schedule, open, deliver, publish.
			for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
		},
		request(requestId, requestJson) {
			calls.push({ type: "request", requestId, requestJson });
			if (closed) return Promise.reject(closedError());
			return new Promise<string>((resolve) => {
				pending.push({
					requestId,
					request: JSON.parse(requestJson) as RuntimeRequest,
					settle: (outcome) => resolve(JSON.stringify(outcome)),
				});
				drainAnswers();
			});
		},
		async observe(observationId, requestJson, listener) {
			calls.push({ type: "observe", observationId, requestJson });
			if (closed) throw closedError();
			if (observationFailure !== null) {
				const { code, message } = observationFailure;
				throw new RuntimeRequestError(code, message);
			}
			// The real transport rejects a duplicate id rather than replacing the listener.
			if (observations.has(observationId)) {
				throw new Error(`Observation ${observationId} is already open.`);
			}
			observations.set(observationId, {
				request: JSON.parse(requestJson) as ObservationRequest,
				listener,
			});
		},
		async unobserve(observationId) {
			calls.push({ type: "unobserve", observationId });
			observations.delete(observationId);
			if (options.deferUnobserve !== true) return;
			await new Promise<void>((resolve) => heldUnobserves.push(resolve));
		},
		async close() {
			calls.push({ type: "close" });
			closed = true;
			observations.clear();
		},
	};
}

function matches(
	request: ObservationRequest,
	projection: RuntimeProjection,
): boolean {
	if (request.type !== projection.type) return false;
	if (projection.type === "items") {
		return (
			request.type === "items" &&
			request.accountId === projection.value.accountId
		);
	}
	return true;
}

function closedError(): Error {
	return Object.assign(new Error("The fake transport is closed."), {
		code: "closed",
	});
}

export interface ManualClock {
	/** Drop-in {@link Schedule} for a client under test. */
	readonly schedule: Schedule;
	/** Runs every deferred callback that has not been cancelled. */
	runPending(): void;
	pendingCount(): number;
}

/**
 * A clock a test advances by hand. The registry's grace window is a decision, not a
 * duration, so a test states when it elapses instead of sleeping through it.
 */
export function createManualClock(): ManualClock {
	const pending = new Set<() => void>();
	return {
		schedule: (run) => {
			pending.add(run);
			return () => pending.delete(run);
		},
		runPending() {
			const due = [...pending];
			pending.clear();
			for (const run of due) run();
		},
		pendingCount() {
			return pending.size;
		},
	};
}
