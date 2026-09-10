import type { WorkerChannelService } from "@bittery/client-runtime/worker";
import type { KeyHandleLike } from "@bittery/crypto-wasm";
import type { CryptoPortCall, WorkerKeyToken } from "./adapters/wasm-worker";
import {
	BackendFailure,
	classify,
	memoizedBackendLoader,
	type UniffiBackend,
} from "./uniffi-bindings";

/** The side-effect-free Crypto channel; its caller owns Worker registration. */
export function createCryptoWorkerService(
	loadBackend: () => Promise<UniffiBackend<KeyHandleLike>>,
): WorkerChannelService {
	const ensureBackend = memoizedBackendLoader(loadBackend);
	const keys = new Map<number, KeyHandleLike>();
	let nextKeyId = 0;

	function isWorkerKeyToken(value: object): value is WorkerKeyToken {
		return (
			Object.getPrototypeOf(value) === Object.prototype &&
			Object.keys(value).length === 1 &&
			typeof (value as Partial<WorkerKeyToken>).__bitteryWorkerKey === "number"
		);
	}

	function toBackend(value: unknown): unknown {
		if (typeof value !== "object" || value === null) return value;
		if (value instanceof Uint8Array) return value;
		if (Array.isArray(value)) return value.map(toBackend);
		if (isWorkerKeyToken(value)) {
			const key = keys.get(value.__bitteryWorkerKey);
			if (key === undefined) {
				throw new BackendFailure(
					"invalid-key-ref",
					"The worker does not own this key reference.",
				);
			}
			return key;
		}
		if (Object.getPrototypeOf(value) === Object.prototype) {
			return Object.fromEntries(
				Object.entries(value).map(([key, member]) => [key, toBackend(member)]),
			);
		}
		throw new BackendFailure(
			"invalid-input",
			"A non-cloneable object reached the crypto worker.",
		);
	}

	function fromBackend(value: unknown): unknown {
		if (typeof value !== "object" || value === null) return value;
		if (value instanceof Uint8Array) return value;
		if (Array.isArray(value)) return value.map(fromBackend);
		if (Object.getPrototypeOf(value) === Object.prototype) {
			return Object.fromEntries(
				Object.entries(value).map(([key, member]) => [
					key,
					fromBackend(member),
				]),
			);
		}
		const token = { __bitteryWorkerKey: nextKeyId } satisfies WorkerKeyToken;
		keys.set(nextKeyId, value as KeyHandleLike);
		nextKeyId += 1;
		return token;
	}

	return {
		async request(payload) {
			const request = payload as CryptoPortCall;
			try {
				const ready = await ensureBackend();
				if (
					typeof request !== "object" ||
					request === null ||
					!Array.isArray(request.args) ||
					typeof ready[request.method] !== "function"
				) {
					throw new BackendFailure(
						"invalid-input",
						`Unknown crypto port member "${String(request.method)}".`,
					);
				}
				const member = ready[request.method] as unknown as (
					...args: readonly unknown[]
				) => Promise<unknown>;
				const args = request.args.map(toBackend);
				const destroyedToken =
					request.method === "destroyKey"
						? (request.args[0] as WorkerKeyToken)
						: null;
				const value = await member(...args);
				if (destroyedToken !== null) {
					keys.delete(destroyedToken.__bitteryWorkerKey);
				}
				return fromBackend(value);
			} catch (error) {
				const failure = classify(error);
				throw Object.assign(new Error(failure.message), { code: failure.code });
			}
		},
	};
}
