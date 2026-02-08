const LOCAL_HOST_PATTERN = /^(localhost|127\.|0\.0\.0\.0|::1)(:|$)/i;

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

	let pathname = parsed.pathname.replace(/\/+$/, "");
	if (pathname.toLowerCase().endsWith("/trpc")) {
		pathname = pathname.slice(0, -"/trpc".length);
	}
	pathname = pathname.replace(/\/+$/, "");
	parsed.pathname = pathname || "/";
	parsed.search = "";
	parsed.hash = "";

	return parsed.toString().replace(/\/$/, "");
}

export function buildTrpcUrl(baseUrl: string, requestUrl: string): string {
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
