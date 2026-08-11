import { normalizeServerUrl } from "@bittery/shared/server-url";

const BOOTSTRAP_TRANSPORT_POLICY = {
	operatorEnabled: true,
	accountConfirmed: true,
} as const;

export function resolveAuthBootstrapServerUrl(value: string): string {
	const normalized = normalizeServerUrl(value, BOOTSTRAP_TRANSPORT_POLICY);
	if (!normalized) {
		throw new TypeError("Configured server URL is invalid.");
	}
	return normalized;
}

/**
 * Returns the server URL from the VITE_SERVER_URL environment variable.
 * Falls back to the current origin or localhost if not set.
 */
export function getServerUrl(): string {
	const configured = import.meta.env.VITE_SERVER_URL;
	if (configured?.trim()) {
		return resolveAuthBootstrapServerUrl(configured);
	}
	if (typeof window !== "undefined") {
		return resolveAuthBootstrapServerUrl(window.location.origin);
	}
	return "http://localhost:3000";
}
