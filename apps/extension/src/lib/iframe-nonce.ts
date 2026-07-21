/**
 * Iframe nonce helpers.
 *
 * Deliberately dependency-free and separate from `content-script/iframe-messages`
 * (which pulls in zod for the parent-side schemas). The overlay iframes only need
 * to read their own nonce back out of the URL, and every kilobyte in those
 * bundles is latency the user feels the first time a field is focused.
 */

export function createIframeNonce(): string {
	return crypto.randomUUID();
}

export function appendNonceToIframeSrc(src: string, nonce: string): string {
	const url = new URL(src);
	url.searchParams.set("nonce", nonce);
	return url.toString();
}

export function getIframeNonceFromLocation(
	locationHref: string = window.location.href,
): string | null {
	try {
		return new URL(locationHref).searchParams.get("nonce");
	} catch {
		return null;
	}
}
