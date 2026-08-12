import {
	classifyHttpServerUrl,
	type InsecureTransportPolicy,
} from "@bittery/api-contract";

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
	let classification: ReturnType<typeof classifyHttpServerUrl>;
	try {
		classification = classifyHttpServerUrl(value);
	} catch {
		throw new InsecureTransportError("INVALID_SERVER_URL");
	}
	if (classification.url.search || classification.url.hash) {
		throw new InsecureTransportError("INVALID_SERVER_URL");
	}
	return classification.url;
}

export function isRemoteHttpServer(value: string): boolean {
	return classifyHttpServerUrl(parseServerUrlForDiscovery(value).toString())
		.isRemoteHttp;
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
