import type { RuntimeErrorCode } from "../../generated/runtime-protocol/contract";

/**
 * The one seam every host substitutes: a Worker channel on Web, a Tauri bridge on Desktop,
 * an MV3 port in the Extension. It carries strings only, because that is the widest shape
 * every one of those channels can pass, and today's `WorkerRuntime` satisfies it structurally.
 */
export interface RuntimeTransport {
	request(
		requestId: string,
		requestJson: string,
		options?: { signal?: AbortSignal },
	): Promise<string>;
	observe(
		observationId: string,
		requestJson: string,
		listener: (projectionJson: string) => void,
		options?: { signal?: AbortSignal },
	): Promise<void>;
	unobserve(observationId: string): Promise<void>;
	close(): Promise<void>;
}

/**
 * A failed Runtime request or observation. `code` is the semantic outcome the UI branches
 * on. `detail` is Rust diagnostic text: it stays off `message` so no host can render it to
 * a person by accident.
 */
export class RuntimeRequestError extends Error {
	readonly code: RuntimeErrorCode;
	readonly detail: string;

	constructor(code: RuntimeErrorCode, detail: string) {
		super(`The Runtime rejected the call: ${code}`);
		this.name = "RuntimeRequestError";
		this.code = code;
		this.detail = detail;
	}
}

/**
 * Classifies a transport rejection. The transport's own failures are not Runtime outcomes,
 * so only its two declared codes map across; anything else is a defect, not a semantic answer.
 */
export function transportErrorCode(error: unknown): RuntimeErrorCode {
	if (error instanceof RuntimeRequestError) return error.code;
	const code = (error as { code?: unknown } | null)?.code;
	if (code === "closed") return "RUNTIME_CLOSED";
	if (code === "cancelled") return "CANCELLED";
	return "INVARIANT_VIOLATION";
}
