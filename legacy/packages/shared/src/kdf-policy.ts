import type { KdfProfile } from "@bittery/crypto-port";
import policy from "../../crypto/kdf-policy.json";

type UntrustedKdfProfile = {
	schemaVersion: unknown;
	algorithm: unknown;
	iterations: unknown;
};

export const DEFAULT_KDF_ITERATIONS = policy.defaultIterations;

export function currentKdfProfile(): KdfProfile {
	return {
		schemaVersion: policy.schemaVersion,
		algorithm: policy.algorithm,
		iterations: policy.defaultIterations,
	} as KdfProfile;
}

export function validateKdfProfileOrThrow(
	profile: UntrustedKdfProfile,
	pinnedProfile?: UntrustedKdfProfile | null,
): asserts profile is KdfProfile {
	validateBaseline(profile);

	if (pinnedProfile) {
		validateBaseline(pinnedProfile);
		if (profile.schemaVersion !== pinnedProfile.schemaVersion) {
			throw new Error("KDF schema version changed from pinned value");
		}
		if (profile.algorithm !== pinnedProfile.algorithm) {
			throw new Error("KDF algorithm changed from pinned value");
		}
		if (profile.iterations < pinnedProfile.iterations) {
			throw new Error("KDF iterations downgraded from pinned value");
		}
	}
}

export function isCurrentKdfProfile(profile: UntrustedKdfProfile): boolean {
	try {
		validateKdfProfileOrThrow(profile);
		return (
			profile.schemaVersion === policy.schemaVersion &&
			profile.algorithm === policy.algorithm &&
			profile.iterations === policy.defaultIterations
		);
	} catch {
		return false;
	}
}

function validateBaseline(
	profile: UntrustedKdfProfile,
): asserts profile is KdfProfile {
	if (profile.schemaVersion !== policy.schemaVersion) {
		throw new Error("Unsupported KDF schema version");
	}
	if (profile.algorithm !== policy.algorithm) {
		throw new Error("Unsupported KDF algorithm");
	}
	if (
		typeof profile.iterations !== "number" ||
		!Number.isFinite(profile.iterations) ||
		!Number.isInteger(profile.iterations) ||
		profile.iterations < policy.minimumIterations ||
		profile.iterations > policy.maximumIterations
	) {
		throw new Error("KDF iterations outside supported range");
	}
}
