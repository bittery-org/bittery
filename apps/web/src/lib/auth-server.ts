import { normalizeServerUrl } from "@bittery/shared/server-url";

/**
 * Returns the server URL from the VITE_SERVER_URL environment variable.
 * Falls back to the current origin or localhost if not set.
 */
export function getServerUrl(): string {
	const configured = import.meta.env.VITE_SERVER_URL;
	if (configured?.trim()) {
		const normalized = normalizeServerUrl(configured);
		if (!normalized) {
			throw new TypeError(
				"Configured server URL is invalid or remote HTTP transport is not authorized.",
			);
		}
		return normalized;
	}
	if (typeof window !== "undefined") {
		const normalized = normalizeServerUrl(window.location.origin);
		if (!normalized) {
			throw new TypeError(
				"Web origin is remote HTTP and insecure transport is not authorized.",
			);
		}
		return normalized;
	}
	return "http://localhost:3000";
}
