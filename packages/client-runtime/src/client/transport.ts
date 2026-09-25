import type {
	RecoveryBound,
	RuntimeErrorCode,
	TeamPageProblem,
} from "../../generated/runtime-protocol/contract";

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
		options?: {
			signal?: AbortSignal;
			onControl?: (controlJson: string) => void;
			onError?: (error: unknown) => void;
		},
	): Promise<void>;
	unobserve(observationId: string): Promise<void>;
	/** Fixed Export output capability supplied by a connection that owns these handles. */
	beginVaultExportOutput?(observationId: string): Promise<string>;
	finishVaultExportOutput?(
		observationId: string,
		outputLeaseId: string,
	): Promise<void>;
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
	readonly recoveryBound?: RecoveryBound;
	readonly teamPageProblem?: TeamPageProblem;

	constructor(
		code: RuntimeErrorCode,
		detail: string,
		recoveryBound?: RecoveryBound,
		teamPageProblem?: TeamPageProblem,
	) {
		super(`The Runtime rejected the call: ${code}`);
		this.name = "RuntimeRequestError";
		this.code = code;
		this.detail = detail;
		if (recoveryBound !== undefined) this.recoveryBound = recoveryBound;
		if (teamPageProblem !== undefined) this.teamPageProblem = teamPageProblem;
	}
}

/**
 * Classifies a transport rejection. The transport's own failures are not Runtime outcomes,
 * so only its two declared codes and the Runtime's storage-unavailable startup failure map
 * across; anything else is a defect, not a semantic answer.
 */
export function transportErrorCode(error: unknown): RuntimeErrorCode {
	if (error instanceof RuntimeRequestError) return error.code;
	const code = (error as { code?: unknown } | null)?.code;
	if (code === "closed") return "RUNTIME_CLOSED";
	if (code === "cancelled") return "CANCELLED";
	if (code === "STORAGE_UNAVAILABLE") return "STORAGE_UNAVAILABLE";
	return "INVARIANT_VIOLATION";
}
