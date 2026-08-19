export interface ApiProblemFieldError {
	pointer: string;
	code: string;
}

export interface ApiProblem {
	type: string;
	title: string;
	status: number;
	code: string;
	detail?: string;
	instance?: string;
	requestId?: string;
	retryable?: boolean;
	errors?: readonly ApiProblemFieldError[];
}

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly type: string;
	readonly requestId: string | null;
	readonly retryable: boolean;
	readonly retryAfterSeconds: number | null;
	readonly errors: readonly ApiProblemFieldError[];

	constructor(problem: ApiProblem, retryAfterSeconds: number | null) {
		super(problem.detail ?? problem.title);
		this.name = "ApiError";
		this.status = problem.status;
		this.code = problem.code;
		this.type = problem.type;
		this.requestId = problem.requestId ?? null;
		this.retryable = problem.retryable ?? false;
		this.retryAfterSeconds = retryAfterSeconds;
		this.errors = problem.errors ?? [];
	}
}

export function isApiErrorStatus(
	error: unknown,
	status: number,
): error is ApiError {
	return error instanceof ApiError && error.status === status;
}

export function isUnauthorizedApiError(error: unknown): error is ApiError {
	return isApiErrorStatus(error, 401);
}

function string(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function fieldErrors(
	value: unknown,
): readonly ApiProblemFieldError[] | undefined {
	if (!Array.isArray(value)) return undefined;

	const errors: ApiProblemFieldError[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			return undefined;
		}
		const pointer = string(entry.pointer);
		const code = string(entry.code);
		if (!pointer || !code) return undefined;
		errors.push({ pointer, code });
	}

	return errors;
}

function statusCode(value: unknown): number | undefined {
	return Number.isInteger(value) &&
		(value as number) >= 400 &&
		(value as number) <= 599
		? (value as number)
		: undefined;
}

function problemFrom(value: unknown, response: Response): ApiProblem {
	const fallbackStatus = response.status;
	const fallbackCode = fallbackStatus >= 500 ? "INTERNAL_ERROR" : "HTTP_ERROR";
	const fallbackRequestId =
		response.headers.get("Bittery-Request-Id") ?? undefined;
	const fallback: ApiProblem = {
		type: "https://bittery.com/problems/http-error",
		title: response.statusText || "Request failed",
		status: fallbackStatus,
		code: fallbackCode,
		requestId: fallbackRequestId,
	};

	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return fallback;
	}
	const problem = value as Record<string, unknown>;

	const bodyStatus = statusCode(problem.status);
	const title = string(problem.title);
	const code = string(problem.code);
	const type = string(problem.type);
	if (
		!bodyStatus ||
		bodyStatus !== fallbackStatus ||
		!title ||
		!code ||
		!type
	) {
		return fallback;
	}

	return {
		type,
		title,
		status: fallbackStatus,
		code,
		detail: string(problem.detail),
		instance: string(problem.instance),
		requestId: string(problem.requestId) ?? fallbackRequestId,
		retryable: boolean(problem.retryable),
		errors: fieldErrors(problem.errors),
	};
}

function retryAfterSeconds(value: string | null, now: number): number | null {
	if (!value) return null;
	if (/^\d+$/.test(value)) return Number(value);

	const date = Date.parse(value);
	if (Number.isNaN(date)) return null;
	return Math.max(0, Math.ceil((date - now) / 1_000));
}

export async function normalizeApiError(
	response: Response,
	now = Date.now(),
	parsedBody?: unknown,
): Promise<ApiError> {
	let body = parsedBody;
	if (body === undefined) {
		try {
			body = await response.clone().json();
		} catch {
			body = undefined;
		}
	}

	return new ApiError(
		problemFrom(body, response),
		retryAfterSeconds(response.headers.get("Retry-After"), now),
	);
}
