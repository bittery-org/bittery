/**
 * Credential Error Classification
 *
 * Maps a thrown error's message to a stable `errorType` code so callers
 * (background handlers) don't need to duplicate the same regex-style
 * matching. Consumers (e.g. the save prompt iframe) map the stable code to
 * a localized message.
 */

export type CredentialErrorType =
	| "network"
	| "encryption"
	| "auth"
	| "permission"
	| "not_found"
	| "unknown";

export function classifyCredentialError(error: unknown): CredentialErrorType {
	const message = error instanceof Error ? error.message : String(error);

	if (message.includes("network") || message.includes("fetch")) {
		return "network";
	}

	if (message.includes("decrypt") || message.includes("encryption")) {
		return "encryption";
	}

	if (message.includes("unauthorized") || message.includes("auth")) {
		return "auth";
	}

	if (message.includes("permission") || message.includes("access")) {
		return "permission";
	}

	if (message.includes("not found")) {
		return "not_found";
	}

	return "unknown";
}
