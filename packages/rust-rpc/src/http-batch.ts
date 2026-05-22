import type { HttpOptions, Transport } from "@qubit-rs/client";

/**
 * JSON-RPC 2.0 batch transport for Qubit.
 *
 * Collects all queries and mutations fired in the same microtask into a single
 * HTTP POST containing a JSON-RPC batch array. The server (jsonrpsee) handles
 * batch requests natively — no server-side changes required.
 *
 * Falls back to a single (non-array) request when only one call is queued in
 * a given tick, so the server never receives a pointless `[{…}]` wrapper.
 */

type RpcRequest = {
	jsonrpc: "2.0";
	method: string;
	id: string | number;
	params: unknown;
};

type RpcResponse =
	| { type: "ok"; id: string | number; value: unknown }
	| { type: "error"; id: string | number; value: { code: number; message: string; data?: unknown } }
	| null;

type PendingRequest = {
	payload: RpcRequest;
	resolve: (response: RpcResponse) => void;
};

export interface HttpBatchOptions extends HttpOptions {
	/** Maximum number of requests to include in a single batch. Default: unlimited. */
	maxBatchSize?: number;
}

function parseOneResponse(raw: unknown): RpcResponse {
	try {
		const response =
			typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown>);

		if (response?.jsonrpc !== "2.0") {
			throw new Error("invalid value for `jsonrpc`");
		}

		if (typeof response.id !== "number" && typeof response.id !== "string" && response.id !== null) {
			throw new Error("missing `id` field from response");
		}

		if ("result" in response && !("error" in response)) {
			return { type: "ok", id: response.id as string | number, value: response.result };
		}

		if ("error" in response && !("result" in response)) {
			const err = response.error as Record<string, unknown> | undefined;
			if (typeof err?.code === "number" && typeof err?.message === "string") {
				return {
					type: "error",
					id: response.id as string | number,
					value: err as { code: number; message: string; data?: unknown },
				};
			}
			throw new Error("malformed error object in response");
		}

		throw new Error("invalid response object");
	} catch (e) {
		console.error("Error encountered whilst parsing response", e);
		return null;
	}
}

export function httpBatch(host: string, options?: HttpBatchOptions): Transport {
	const fetchImpl = options?.fetch ?? fetch;
	const maxBatchSize = options?.maxBatchSize ?? Number.POSITIVE_INFINITY;

	let queue: PendingRequest[] = [];
	let scheduled = false;

	function scheduleFlush() {
		if (scheduled) return;
		scheduled = true;

		// Use queueMicrotask so all sync calls in the same tick are collected
		queueMicrotask(() => {
			scheduled = false;
			flush();
		});
	}

	function flush() {
		if (queue.length === 0) return;

		// Drain the queue, respecting maxBatchSize
		while (queue.length > 0) {
			const batch = queue.splice(0, maxBatchSize);
			void sendBatch(batch);
		}
	}

	async function sendBatch(batch: PendingRequest[]) {
		const isSingle = batch.length === 1;
		const body = isSingle
			? JSON.stringify(batch[0].payload)
			: JSON.stringify(batch.map((r) => r.payload));

		try {
			const res = await fetchImpl(host, {
				method: "POST",
				mode: "cors",
				headers: { "Content-Type": "application/json" },
				body,
			});

			const json = (await res.json()) as unknown;

			if (isSingle) {
				// Single request — response is a single object
				batch[0].resolve(parseOneResponse(json));
			} else {
				// Batch response — should be an array
				if (!Array.isArray(json)) {
					// Server didn't return an array — resolve all as errors
					console.error("Expected array response for batch request, got:", typeof json);
					for (const entry of batch) {
						entry.resolve(null);
					}
					return;
				}

				// Build lookup by id for O(1) matching
				const responseMap = new Map<string | number, unknown>();
				for (const item of json) {
					const id = (item as Record<string, unknown>)?.id;
					if (id !== undefined && id !== null) {
						responseMap.set(id as string | number, item);
					}
				}

				for (const entry of batch) {
					const match = responseMap.get(entry.payload.id);
					entry.resolve(match ? parseOneResponse(match) : null);
				}
			}
		} catch (error) {
			// Network error — reject all pending requests
			console.error("Batch request failed:", error);
			for (const entry of batch) {
				entry.resolve(null);
			}
		}
	}

	function enqueue(payload: RpcRequest): Promise<RpcResponse> {
		return new Promise<RpcResponse>((resolve) => {
			queue.push({ payload, resolve });
			scheduleFlush();
		});
	}

	return {
		query: (_id, payload) => enqueue(payload),
		mutate: (_id, payload) => enqueue(payload),
	};
}
