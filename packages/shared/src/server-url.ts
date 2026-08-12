import {
	classifyHttpServerUrl,
	type InsecureTransportPolicy,
} from "@bittery/api-contract";

function ensureProtocol(value: string): string {
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
		return value;
	}
	const protocol = classifyHttpServerUrl(`http://${value}`).shouldInferHttp
		? "http"
		: "https";
	return `${protocol}://${value}`;
}

export function normalizeServerUrl(
	value?: string | null,
	insecureTransport?: InsecureTransportPolicy,
): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;

	let classification: ReturnType<typeof classifyHttpServerUrl>;
	try {
		classification = classifyHttpServerUrl(ensureProtocol(trimmed));
	} catch {
		return null;
	}

	if (
		classification.isRemoteHttp &&
		!(insecureTransport?.operatorEnabled && insecureTransport.accountConfirmed)
	) {
		return null;
	}

	const { url: parsed } = classification;
	const pathname = parsed.pathname.replace(/\/+$/, "");
	parsed.pathname = pathname || "/";
	parsed.search = "";
	parsed.hash = "";

	return parsed.toString().replace(/\/$/, "");
}
