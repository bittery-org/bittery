import {
	type RuntimeClient,
	RuntimeRequestError,
} from "@bittery/client-runtime/client";

import type { OperationProjection } from "@bittery/client-runtime/protocol";

/** Observe the durable Operation; detaching this waiter never cancels accepted work. */
export function waitForRuntimeOperation(
	client: RuntimeClient,
	accountId: string,
	operationId: string,
	signal: AbortSignal,
) {
	const store = client.operations(accountId);
	return new Promise<OperationProjection>((resolve, reject) => {
		let unsubscribe = () => {};
		let settled = false;
		const cleanup = () => {
			settled = true;
			unsubscribe();
			signal.removeEventListener("abort", abort);
		};
		const abort = () => {
			cleanup();
			reject(new DOMException("Import presentation detached", "AbortError"));
		};
		const read = () => {
			if (settled) return;
			const snapshot = store.getSnapshot();
			if (snapshot.state === "failed") {
				cleanup();
				reject(
					new RuntimeRequestError(
						snapshot.code,
						"Operation observation failed",
					),
				);
				return;
			}
			if (snapshot.state !== "ready") return;
			const operation = snapshot.value.operations.find(
				(entry) => entry.operationId === operationId,
			);
			if (!operation || operation.resolution === "pending") return;
			cleanup();
			if (operation.resolution === "rejected")
				reject(new Error("Import Operation rejected"));
			else resolve(operation);
		};
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		unsubscribe = store.subscribe(read);
		if (settled) unsubscribe();
		else read();
	});
}
