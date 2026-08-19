export type TeamRotationErrorCode =
	| "MASTER_UNLOCK_KEY_MISSING"
	| "SESSION_DATA_MISSING"
	| "VAULT_KEY_DECRYPT_FAILED";

interface TeamRotationErrorParams {
	vaultName?: string;
}

export class TeamRotationError extends Error {
	public readonly code: TeamRotationErrorCode;
	public readonly params: TeamRotationErrorParams;

	constructor(
		code: TeamRotationErrorCode,
		params: TeamRotationErrorParams = {},
	) {
		super(code);
		this.name = "TeamRotationError";
		this.code = code;
		this.params = params;
	}
}
