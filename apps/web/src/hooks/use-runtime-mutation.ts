import { useRuntimeClient } from "@bittery/client-runtime/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { observeAccountDeparture } from "@/lib/runtime-account-presentation";

interface Callbacks<Input, Output> {
	onSuccess?: (output: Output, input: Input) => unknown;
	onError?: (error: unknown) => unknown;
	onSettled?: () => unknown;
}

/** Pending UI only: plaintext inputs/results never enter a query or mutation cache. */
export function useRuntimeMutation<Input, Output>({
	accountId,
	mutationFn,
}: {
	accountId: (input: Input) => string | null | undefined;
	mutationFn: (input: Input, signal: AbortSignal) => Promise<Output>;
}) {
	const runtime = useRuntimeClient();
	const active = useRef(new Set<AbortController>());
	const mounted = useRef(true);
	const [pending, setPending] = useState(0);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			for (const attempt of active.current) attempt.abort();
			active.current.clear();
		};
	}, []);
	const mutateAsync = useCallback(
		async (input: Input, callbacks?: Callbacks<Input, Output>) => {
			if (!mounted.current)
				throw new DOMException("Mutation presentation detached", "AbortError");
			const owner = accountId(input);
			if (!owner) throw new Error("Runtime Account authority is unavailable");
			const attempt = new AbortController();
			active.current.add(attempt);
			const release = observeAccountDeparture(runtime, owner, () =>
				attempt.abort(),
			);
			if (mounted.current) setPending((count) => count + 1);
			try {
				attempt.signal.throwIfAborted();
				const output = await mutationFn(input, attempt.signal);
				attempt.signal.throwIfAborted();
				await callbacks?.onSuccess?.(output, input);
				return output;
			} catch (error) {
				if (!attempt.signal.aborted) await callbacks?.onError?.(error);
				throw error;
			} finally {
				release();
				active.current.delete(attempt);
				if (mounted.current) {
					setPending((count) => count - 1);
					await callbacks?.onSettled?.();
				}
			}
		},
		[runtime, accountId, mutationFn],
	);
	return {
		isPending: pending > 0,
		mutateAsync,
		mutate: (input: Input, callbacks?: Callbacks<Input, Output>) => {
			void mutateAsync(input, callbacks).catch(() => {});
		},
	};
}
