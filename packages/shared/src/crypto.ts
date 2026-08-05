/**
 * Convert Uint8Array to base64 for storage/transmission
 */
export function arrayBufferToBase64(buffer: Uint8Array): string {
	const binary = String.fromCharCode(...buffer);
	return btoa(binary);
}

/**
 * Convert base64 to Uint8Array
 */
export function base64ToArrayBuffer(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/**
 * The first two segments of a formatted key, shown so a user can recognise which key they
 * are holding. Both hints are string splitting rather than crypto, which is why they live
 * beside the base64 helpers and not on `CryptoPort`.
 */
function formattedKeyHint(key: string): string {
	const parts = key.split("-");
	if (parts.length >= 2) {
		return `${parts[0]}-${parts[1]}`;
	}
	return "";
}

/** `A3-XXXXXX-…` → `A3-XXXXXX`. Mirrors `secret_key.rs`'s `get_secret_key_hint`. */
export function getSecretKeyHint(secretKey: string): string {
	return formattedKeyHint(secretKey);
}

/** `R1-XXXXXX-…` → `R1-XXXXXX`. */
export function getRecoveryKeyHint(recoveryKey: string): string {
	return formattedKeyHint(recoveryKey);
}
