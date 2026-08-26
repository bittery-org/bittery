/** Reads the locally held decryption key from a Share URL fragment. */
export function readShareKeyFromUrl(url: string): string | null {
	const fragmentStart = url.indexOf("#");
	if (fragmentStart === -1) return null;
	return url.slice(fragmentStart + 1) || null;
}
