/**
 * Returns a fully-qualified URL pointing to the Bittery web app.
 *
 * @param path  – route path, e.g. "/signup"
 * @param params – optional query params, e.g. { plan: "personal" }
 */
export function webappUrl(path = "/", params?: Record<string, string>): string {
	const base = (
		import.meta.env.VITE_WEBAPP_URL ?? "https://app.bittery.com"
	).replace(/\/+$/, "");
	const url = new URL(path, base);
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			url.searchParams.set(key, value);
		}
	}
	return url.toString();
}

/** Convenience: signup URL, optionally with a pre-selected plan. */
export function signupUrl(plan?: string): string {
	return webappUrl("/signup", plan ? { plan } : undefined);
}

export function billingMarketingEnabled(): boolean {
	const value = import.meta.env.VITE_BILLING_MARKETING_ENABLED;
	return ["1", "true", "yes", "on"].includes(value?.toLowerCase?.() ?? "");
}

export function serverUrl(path = "/"): string {
	const base = (
		import.meta.env.VITE_SERVER_URL ?? "https://api.bittery.com"
	).replace(/\/+$/, "");
	return new URL(path, base).toString();
}

export function waitlistUrl(): string {
	return serverUrl("/waitlist");
}
