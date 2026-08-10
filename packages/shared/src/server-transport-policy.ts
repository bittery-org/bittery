import type { InsecureTransportPolicy } from "@bittery/api-contract";

export const INSECURE_HTTP_CAPABILITY = "insecure-http";

export class InsecureTransportError extends Error {
	constructor(
		readonly reason:
			| "ACCOUNT_CONFIRMATION_REQUIRED"
			| "OPERATOR_DISABLED"
			| "INVALID_SERVER_URL"
			| "METADATA_UNAVAILABLE",
	) {
		super(`Remote HTTP transport denied: ${reason}`);
		this.name = "InsecureTransportError";
	}
}

export function parseServerUrlForDiscovery(value: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new InsecureTransportError("INVALID_SERVER_URL");
	}
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		parsed.search ||
		parsed.hash
	) {
		throw new InsecureTransportError("INVALID_SERVER_URL");
	}
	return parsed;
}

export function isRemoteHttpServer(value: string): boolean {
	const parsed = parseServerUrlForDiscovery(value);
	const hostname = parsed.hostname.toLowerCase();
	const loopback =
		hostname === "localhost" ||
		hostname === "::1" ||
		hostname === "[::1]" ||
		/^127(?:\.\d{1,3}){3}$/.test(hostname);
	return parsed.protocol === "http:" && !loopback;
}

export async function resolveInsecureTransportPolicy(options: {
	serverUrl: string;
	accountConfirmed: boolean;
	fetch?: (request: Request) => Promise<Response>;
}): Promise<InsecureTransportPolicy | undefined> {
	const server = parseServerUrlForDiscovery(options.serverUrl);
	if (!isRemoteHttpServer(server.toString())) return undefined;
	if (!options.accountConfirmed) {
		throw new InsecureTransportError("ACCOUNT_CONFIRMATION_REQUIRED");
	}

	const metadataUrl = new URL(
		`${server.toString().replace(/\/$/, "")}/api/meta`,
	);
	let response: Response;
	try {
		response = await (options.fetch ?? globalThis.fetch)(
			new Request(metadataUrl, { headers: { Accept: "application/json" } }),
		);
	} catch {
		throw new InsecureTransportError("METADATA_UNAVAILABLE");
	}
	if (!response.ok) {
		throw new InsecureTransportError("METADATA_UNAVAILABLE");
	}
	const value: unknown = await response.json();
	const capabilities =
		typeof value === "object" && value !== null && "capabilities" in value
			? (value as { capabilities?: unknown }).capabilities
			: null;
	const operatorEnabled =
		Array.isArray(capabilities) &&
		capabilities.includes(INSECURE_HTTP_CAPABILITY);
	if (!operatorEnabled) {
		throw new InsecureTransportError("OPERATOR_DISABLED");
	}
	return { operatorEnabled, accountConfirmed: true };
}
