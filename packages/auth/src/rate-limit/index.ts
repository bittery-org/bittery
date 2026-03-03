import { createRateLimitAdapter } from "./create-adapter";
import type {
	RateLimitState,
	WindowIncrementResult,
} from "./types";

let adapterPromise:
	| Promise<import("./types").RateLimitAdapter>
	| null = null;

async function getAdapter(): Promise<import("./types").RateLimitAdapter> {
	if (!adapterPromise) {
		adapterPromise = createRateLimitAdapter();
	}
	return adapterPromise;
}

export async function getRateLimitState(
	namespace: string,
	key: string,
): Promise<RateLimitState | null> {
	const adapter = await getAdapter();
	return adapter.get(namespace, key);
}

export async function recordRateLimitFailure(input: {
	namespace: string;
	key: string;
	subject: string;
	now: Date;
	freeAttempts: number;
	maxLockMinutes: number;
}): Promise<RateLimitState> {
	const adapter = await getAdapter();
	return adapter.recordFailure(input);
}

export async function clearRateLimitState(
	namespace: string,
	key: string,
): Promise<void> {
	const adapter = await getAdapter();
	await adapter.clear(namespace, key);
}

export async function clearRateLimitBySubject(
	namespace: string,
	subject: string,
): Promise<void> {
	const adapter = await getAdapter();
	await adapter.clearBySubject(namespace, subject);
}

export async function incrementRateLimitWindow(input: {
	namespace: string;
	key: string;
	subject?: string;
	now: Date;
	windowStart: Date;
	limit: number;
}): Promise<WindowIncrementResult> {
	const adapter = await getAdapter();
	return adapter.incrementWithinWindow(input);
}

export async function closeRateLimitAdapterForTests(): Promise<void> {
	if (!adapterPromise) {
		return;
	}

	const adapter = await adapterPromise;
	await adapter.close();
	adapterPromise = null;
}
