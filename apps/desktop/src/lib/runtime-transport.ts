import {
	RuntimeRequestError,
	type RuntimeTransport,
} from "@bittery/client-runtime/client";
import {
	validateRuntimeOutcome,
	validateRuntimeProjection,
} from "@bittery/client-runtime/protocol-validation";
import type { RuntimeBridgeMessage } from "../generated/tauri-commands";
import * as native from "./tauri-commands";

export type DesktopRuntimeBridge = Pick<
	typeof native,
	| "runtimeAttach"
	| "runtimeRequest"
	| "runtimeObserve"
	| "runtimeCancel"
	| "runtimeUnobserve"
	| "runtimeDetach"
	| "listenRuntimeBridge"
>;

function error(code: "CANCELLED" | "RUNTIME_CLOSED" | "INVARIANT_VIOLATION") {
	return new RuntimeRequestError(
		code,
		"Desktop Runtime caller transport failed",
	);
}

function nativeError(value: unknown): RuntimeRequestError {
	if (value instanceof RuntimeRequestError) return value;
	const outcome = { type: "failed", value };
	if (validateRuntimeOutcome(outcome) && outcome.type === "failed") {
		return new RuntimeRequestError(
			outcome.value.code,
			outcome.value.message,
			outcome.value.recoveryBound ?? undefined,
		);
	}
	return error("INVARIANT_VIOLATION");
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

interface Caller {
	key: string;
	wireId: string;
	kind: "response" | "projection";
	admission: ReturnType<typeof deferred<void>>;
	fail: (reason: unknown) => void;
	deliver: (json: string) => void;
	removeAbort: () => void;
}

/** Attaches a renderer to the existing native owner. Closing retires only this connection. */
export async function connectDesktopRuntime(
	bridge: DesktopRuntimeBridge = native,
): Promise<RuntimeTransport> {
	let attachment: Awaited<ReturnType<DesktopRuntimeBridge["runtimeAttach"]>>;
	try {
		attachment = await bridge.runtimeAttach();
	} catch (cause) {
		throw nativeError(cause);
	}
	const callers = new Map<string, Caller>();
	const occupied = new Map<string, Caller>();
	let sequence = 0;
	let closed = false;
	let closing: Promise<void> | undefined;
	let unlisten: () => void;

	function remove(caller: Caller) {
		if (callers.get(caller.wireId) !== caller) return;
		callers.delete(caller.wireId);
		occupied.delete(caller.key);
		caller.removeAbort();
	}

	function receive(message: RuntimeBridgeMessage) {
		if (closed || message.connectionId !== attachment.connectionId) return;
		const caller = callers.get(message.callId);
		if (!caller || caller.kind !== message.kind) return;
		let payload: unknown;
		try {
			payload = JSON.parse(message.payloadJson);
		} catch {
			payload = undefined;
		}
		if (caller.kind === "response") {
			remove(caller);
			if (!validateRuntimeOutcome(payload))
				caller.fail(error("INVARIANT_VIOLATION"));
			else caller.deliver(message.payloadJson);
		} else if (validateRuntimeProjection(payload)) {
			caller.deliver(message.payloadJson);
		}
	}

	try {
		unlisten = await bridge.listenRuntimeBridge(attachment.eventName, receive);
	} catch (cause) {
		await bridge
			.runtimeDetach({ connectionId: attachment.connectionId })
			.catch(() => undefined);
		throw nativeError(cause);
	}

	function stopNative(caller: Caller): Promise<void> {
		// Admission is synchronous in native code, but its IPC acknowledgement can arrive later.
		// Sending cancellation first could miss a call the native command has not admitted yet.
		return caller.admission.promise.then(
			() => {
				const args = {
					connectionId: attachment.connectionId,
					callId: caller.wireId,
				};
				return caller.kind === "response"
					? bridge.runtimeCancel(args)
					: bridge.runtimeUnobserve(args);
			},
			() => undefined,
		);
	}

	function start(
		kind: Caller["kind"],
		id: string,
		json: string,
		deliver: Caller["deliver"],
		fail: Caller["fail"],
		signal?: AbortSignal,
	): Caller {
		if (closed) throw error("RUNTIME_CLOSED");
		if (signal?.aborted) throw error("CANCELLED");
		const key = `${kind}:${id}`;
		if (occupied.has(key)) throw error("INVARIANT_VIOLATION");
		const caller: Caller = {
			key,
			kind,
			wireId: `caller-${++sequence}`,
			admission: deferred<void>(),
			deliver,
			fail,
			removeAbort: () => undefined,
		};
		// Never reuse a wire ID, even if the public caller ID is immediately reused after abort.
		callers.set(caller.wireId, caller);
		occupied.set(key, caller);
		const abort = () => {
			remove(caller);
			fail(error("CANCELLED"));
			void stopNative(caller).catch(() => undefined);
		};
		signal?.addEventListener("abort", abort, { once: true });
		caller.removeAbort = () => signal?.removeEventListener("abort", abort);
		const args = {
			connectionId: attachment.connectionId,
			callId: caller.wireId,
			payloadJson: json,
		};
		try {
			const admission =
				kind === "response"
					? bridge.runtimeRequest(args)
					: bridge.runtimeObserve(args);
			void admission.then(caller.admission.resolve, caller.admission.reject);
		} catch (cause) {
			caller.admission.reject(cause);
		}
		void caller.admission.promise.catch((cause) => {
			remove(caller);
			fail(nativeError(cause));
		});
		return caller;
	}

	return {
		request(id, json, options) {
			const result = deferred<string>();
			try {
				start(
					"response",
					id,
					json,
					result.resolve,
					result.reject,
					options?.signal,
				);
			} catch (cause) {
				result.reject(cause);
			}
			return result.promise;
		},
		observe(id, json, listener, options) {
			const result = deferred<void>();
			try {
				const caller = start(
					"projection",
					id,
					json,
					listener,
					result.reject,
					options?.signal,
				);
				void caller.admission.promise.then(
					() => result.resolve(),
					() => undefined,
				);
			} catch (cause) {
				result.reject(cause);
			}
			return result.promise;
		},
		async unobserve(id) {
			const caller = occupied.get(`projection:${id}`);
			if (!caller) return;
			remove(caller);
			try {
				await stopNative(caller);
			} catch (cause) {
				throw nativeError(cause);
			}
		},
		close() {
			if (closing) return closing;
			closed = true;
			for (const caller of callers.values()) {
				remove(caller);
				caller.fail(error("RUNTIME_CLOSED"));
			}
			unlisten();
			closing = bridge
				.runtimeDetach({ connectionId: attachment.connectionId })
				.catch((cause) => {
					throw nativeError(cause);
				});
			return closing;
		},
	};
}
