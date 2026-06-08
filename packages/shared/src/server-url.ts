const LOCAL_HOST_PATTERN = /^(localhost|127\.|0\.0\.0\.0|::1)(:|$)/i;
const RPC_PATH_SUFFIXES = ["/rpc"] as const;

function stripRpcPathSuffix(pathname: string): string {
	let normalized = pathname.replace(/\/+$/, "");

	for (const suffix of RPC_PATH_SUFFIXES) {
		if (normalized.toLowerCase().endsWith(suffix)) {
			normalized = normalized.slice(0, -suffix.length);
			break;
		}
	}

	return normalized.replace(/\/+$/, "");
}

function ensureProtocol(value: string): string {
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
		return value;
	}
	const protocol = LOCAL_HOST_PATTERN.test(value) ? "http" : "https";
	return `${protocol}://${value}`;
}

export function normalizeServerUrl(value?: string | null): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;

	let parsed: URL;
	try {
		parsed = new URL(ensureProtocol(trimmed));
	} catch {
		return null;
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return null;
	}

	const pathname = stripRpcPathSuffix(parsed.pathname);
	parsed.pathname = pathname || "/";
	parsed.search = "";
	parsed.hash = "";

	return parsed.toString().replace(/\/$/, "");
}

export function buildRpcUrl(baseUrl: string, requestUrl: string): string {
	const normalizedBase = normalizeServerUrl(baseUrl);
	if (!normalizedBase) {
		return requestUrl;
	}

	let request: URL;
	try {
		request = new URL(requestUrl);
	} catch {
		return requestUrl;
	}

	const base = new URL(normalizedBase);
	const basePath =
		base.pathname === "/" ? "" : base.pathname.replace(/\/$/, "");
	const requestPath = request.pathname.startsWith("/")
		? request.pathname
		: `/${request.pathname}`;
	base.pathname = `${basePath}${requestPath}`;
	base.search = request.search;
	base.hash = "";

	return base.toString();
}
