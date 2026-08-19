function toBase64Url(base64: string): string {
	return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function toBase64(base64Url: string): string {
	const normalized = base64Url.replace(/-/g, "+").replace(/_/g, "/");
	const padLength = (4 - (normalized.length % 4)) % 4;
	return `${normalized}${"=".repeat(padLength)}`;
}

export function bytesToBase64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

export function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
	return toBase64Url(bytesToBase64(bytes));
}

export function base64UrlToBytes(base64Url: string): Uint8Array {
	return base64ToBytes(toBase64(base64Url));
}

export function arrayBufferToBase64Url(
	buffer: ArrayBufferLike | Uint8Array,
): string {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	return bytesToBase64Url(bytes);
}
