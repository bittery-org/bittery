/**
 * Every rejection an adapter produces is a `CryptoPortError` carrying one of these codes.
 *
 * Four backends fail in four unrelated shapes — a `JsError` from wasm-bindgen, a `string`
 * from a Tauri command, a `CryptoError` from the Expo module, and a structured clone of any
 * of them from a worker. Callers above the seam cannot branch on that, so translating into
 * this closed set is the adapter's job and is one of the things `port-conformance` pins.
 *
 * The first two are always a caller bug; the rest are data or environment. Nothing wider is
 * allowed: a new failure mode either fits one of these or the seam is carrying policy it
 * shouldn't.
 */
export const CRYPTO_PORT_ERROR_CODES = [
	/** The `KeyRef` was never minted by this port (or is not a `KeyRef` at all). */
	"invalid-key-ref",
	/** The `KeyRef` was minted by this port and has since been destroyed. */
	"key-destroyed",
	/** Wrong key, wrong AAD context, or tampered ciphertext. Indistinguishable, by design. */
	"decryption-failed",
	/** The SRP server failed to prove it holds the verifier. */
	"verification-failed",
	/** Malformed argument: bad base64, wrong key length, unparseable PEM. */
	"invalid-input",
	/** The backend itself failed — WASM not initialised, IPC lost, native module missing. */
	"backend-failure",
] as const;

export type CryptoPortErrorCode = (typeof CRYPTO_PORT_ERROR_CODES)[number];

export class CryptoPortError extends Error {
	readonly code: CryptoPortErrorCode;

	constructor(
		code: CryptoPortErrorCode,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "CryptoPortError";
		this.code = code;
	}
}

export function isCryptoPortError(value: unknown): value is CryptoPortError {
	return value instanceof CryptoPortError;
}
