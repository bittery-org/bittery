import { normalizeServerUrl } from "@bittery/shared/server-url";

/**
 * Returns the server URL from the VITE_SERVER_URL environment variable.
 * Falls back to the current origin or localhost if not set.
 */
export function getServerUrl(): string {
	return (
		normalizeServerUrl(import.meta.env.VITE_SERVER_URL ?? "") ??
		(typeof window !== "undefined"
			? window.location.origin
			: "http://localhost:3000")
	);
}
