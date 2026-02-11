export type BitteryMode = "cloud" | "self-hosted";

function normalizeMode(rawMode: string | undefined): string {
	return rawMode?.trim().toLowerCase() || "";
}

export function getBitteryMode(): BitteryMode {
	const mode = normalizeMode(process.env.BITTERY_MODE);

	if (
		mode === "self-hosted" ||
		mode === "self_hosted" ||
		mode === "selfhosted"
	) {
		return "self-hosted";
	}

	return "cloud";
}

export function isSelfHostedMode(): boolean {
	return getBitteryMode() === "self-hosted";
}
