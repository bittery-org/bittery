type TimerBindings = {
	default(options: { module_or_path: string }): Promise<void>;
	WebClientRuntime: {
		sleepDeviceTimerForTest(
			delay: string,
			cancellation: Promise<void>,
		): Promise<boolean>;
	};
};
const url = "/real-core-bindings.js";
const bindings = (await import(url)) as TimerBindings;
await bindings.default({ module_or_path: "/real-core.wasm" });

export async function timerProbe(delay: string, releaseFirstChunk = false) {
	const realSet = globalThis.setTimeout.bind(globalThis);
	const realClear = globalThis.clearTimeout.bind(globalThis);
	const waits: { delay: number; id: number }[] = [];
	const cleared: number[] = [];
	let cancellationId: number | undefined;
	let releaseId: number | undefined;
	globalThis.setTimeout = ((
		callback: TimerHandler,
		milliseconds?: number,
		...args: unknown[]
	) => {
		const id = realSet(callback, milliseconds, ...args);
		waits.push({ delay: milliseconds ?? 0, id });
		if (releaseFirstChunk && waits.length === 1) {
			// Advance just the first host callback; the remainder still uses a real timer.
			// This proves chunk sequencing without a 24-day wall-clock test.
			releaseId = realSet(() => {
				realClear(id);
				if (typeof callback !== "function")
					throw new Error("Expected timer callback");
				callback(...args);
			}, 0);
		}
		return id;
	}) as typeof setTimeout;
	globalThis.clearTimeout = (id) => {
		if (id !== undefined) cleared.push(id);
		realClear(id);
	};
	try {
		const cancellation = new Promise<void>((resolve) => {
			cancellationId = realSet(resolve, 40);
		});
		const completed = await bindings.WebClientRuntime.sleepDeviceTimerForTest(
			delay,
			cancellation,
		);
		return { completed, waits, cleared };
	} finally {
		realClear(cancellationId);
		realClear(releaseId);
		globalThis.setTimeout = realSet;
		globalThis.clearTimeout = realClear;
	}
}

Object.assign(globalThis, { timerProbe });
