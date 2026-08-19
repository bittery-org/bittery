import type { KdfProfile } from "@bittery/crypto-port";
import { validateKdfProfileOrThrow } from "@bittery/shared/kdf-policy";

/** Parse an account-scoped pin without trusting its persisted JSON shape. */
export function parseStoredKdfProfile(stored: unknown): KdfProfile | null {
	if (typeof stored !== "string") {
		return null;
	}

	try {
		const profile = JSON.parse(stored) as Record<string, unknown>;
		if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
			return null;
		}
		validateKdfProfileOrThrow({
			schemaVersion: profile.schemaVersion,
			algorithm: profile.algorithm,
			iterations: profile.iterations,
		});
		return profile as unknown as KdfProfile;
	} catch {
		return null;
	}
}
