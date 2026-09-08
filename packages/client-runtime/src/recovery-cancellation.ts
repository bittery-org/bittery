/** Retire delivery immediately; an uncancellable platform read may finish only to discard its bytes. */
export function waitRecovery<T>(
	task: Promise<T>,
	signal?: AbortSignal,
	discardLate?: (value: T) => void,
): Promise<T> {
	if (signal === undefined) return task;
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const abort = () => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", abort);
			reject(new DOMException("Recovery was cancelled", "AbortError"));
		};
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		void task.then(
			(value) => {
				if (settled) {
					discardLate?.(value);
					return;
				}
				settled = true;
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}
