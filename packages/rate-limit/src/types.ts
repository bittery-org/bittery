export interface RateLimitState {
	namespace: string;
	key: string;
	subject: string | null;
	attempts: number;
	count: number;
	lockedUntil: Date | null;
	windowStartAt: Date | null;
}

export interface WindowIncrementResult {
	allowed: boolean;
	count: number;
	limit: number;
}

export interface FailureBackoffInput {
	namespace: string;
	key: string;
	subject: string;
	now: Date;
	freeAttempts: number;
	maxLockMinutes: number;
}

export interface WindowIncrementInput {
	namespace: string;
	key: string;
	subject?: string;
	now: Date;
	windowStart: Date;
	limit: number;
}

export interface RateLimitAdapter {
	get(namespace: string, key: string): Promise<RateLimitState | null>;
	recordFailure(input: FailureBackoffInput): Promise<RateLimitState>;
	clear(namespace: string, key: string): Promise<void>;
	clearBySubject(namespace: string, subject: string): Promise<void>;
	incrementWithinWindow(
		input: WindowIncrementInput,
	): Promise<WindowIncrementResult>;
	close(): Promise<void>;
}
