const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function normalizeOriginValue(value: string): string {
	return value.trim();
}

function isLocalhostOrigin(url: URL): boolean {
	return LOCALHOST_HOSTS.has(url.hostname);
}

function assertValidOrigin(value: string): string {
	if (value === "*") {
		throw new Error("CORS_ORIGIN must not contain '*'");
	}

	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`CORS_ORIGIN contains an invalid origin: ${value}`);
	}

	if (parsed.username || parsed.password) {
		throw new Error(`CORS_ORIGIN must not include credentials: ${value}`);
	}

	if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
		throw new Error(
			`CORS_ORIGIN must be a bare origin without path, query, or hash: ${value}`,
		);
	}

	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error(`CORS_ORIGIN must use http or https: ${value}`);
	}

	if (parsed.protocol === "http:" && !isLocalhostOrigin(parsed)) {
		throw new Error(
			`CORS_ORIGIN must use https outside localhost development: ${value}`,
		);
	}

	return parsed.origin;
}

export function parseCorsOrigins(
	rawValue: string | undefined | null,
): string[] {
	if (!rawValue?.trim()) {
		return [];
	}

	const normalized = rawValue
		.split(",")
		.map(normalizeOriginValue)
		.filter(Boolean);

	const seen = new Set<string>();
	const parsedOrigins: string[] = [];

	for (const origin of normalized) {
		const parsedOrigin = assertValidOrigin(origin);
		if (seen.has(parsedOrigin)) {
			throw new Error(
				`CORS_ORIGIN contains a duplicate origin: ${parsedOrigin}`,
			);
		}
		seen.add(parsedOrigin);
		parsedOrigins.push(parsedOrigin);
	}

	return parsedOrigins;
}

export function getPrimaryCorsOrigin(
	rawValue: string | undefined | null,
): string | null {
	return parseCorsOrigins(rawValue)[0] ?? null;
}
