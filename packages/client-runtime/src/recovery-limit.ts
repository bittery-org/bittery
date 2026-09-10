import type { RecoveryBound } from "../generated/runtime-protocol/contract";

/** Physical admission reports a closed bound; Core decides the recovery outcome. */
export class RecoveryLimitError extends Error {
	readonly code = "SIZE_REJECTED";
	constructor(readonly recoveryBound: RecoveryBound) {
		super("Recovery exceeds a resource bound");
		this.name = "RecoveryLimitError";
	}
}
