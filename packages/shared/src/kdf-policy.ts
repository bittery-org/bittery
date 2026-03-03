export interface KdfParamsPolicyInput {
	schemaVersion: 1;
	algorithm: "pbkdf2-sha256";
	iterations: number;
	salt: string;
}

const REQUIRED_KDF_SCHEMA_VERSION = 1;
const REQUIRED_KDF_ALGORITHM = "pbkdf2-sha256";
const MIN_KDF_ITERATIONS = 310_000;
const MIN_KDF_SALT_BYTES = 16;

function isHex(value: string): boolean {
	return /^[0-9a-fA-F]+$/.test(value);
}

/**
 * Validate server-provided login KDF params against minimum policy
 * and optional pinned values.
 */
export function validateServerKdfParamsOrThrow(
	serverParams: KdfParamsPolicyInput,
	pinnedParams?: KdfParamsPolicyInput | null,
): void {
	if (serverParams.schemaVersion !== REQUIRED_KDF_SCHEMA_VERSION) {
		throw new Error("Unsupported KDF schema version");
	}
	if (serverParams.algorithm !== REQUIRED_KDF_ALGORITHM) {
		throw new Error("Unsupported KDF algorithm");
	}
	if (serverParams.iterations < MIN_KDF_ITERATIONS) {
		throw new Error("KDF iterations below minimum");
	}
	if (!isHex(serverParams.salt) || serverParams.salt.length % 2 !== 0) {
		throw new Error("Invalid KDF salt format");
	}
	if (serverParams.salt.length / 2 < MIN_KDF_SALT_BYTES) {
		throw new Error("KDF salt too short");
	}

	if (!pinnedParams) {
		return;
	}

	if (serverParams.schemaVersion !== pinnedParams.schemaVersion) {
		throw new Error("KDF schema version changed from pinned value");
	}
	if (serverParams.algorithm !== pinnedParams.algorithm) {
		throw new Error("KDF algorithm changed from pinned value");
	}
	if (serverParams.iterations < pinnedParams.iterations) {
		throw new Error("KDF iterations downgraded from pinned value");
	}
	if (serverParams.salt !== pinnedParams.salt) {
		throw new Error("KDF salt changed from pinned value");
	}
}
