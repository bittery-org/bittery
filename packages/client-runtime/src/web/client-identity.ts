/**
 * How the Web host tells its Worker who this client is.
 *
 * The Server persists `client_id` on the Session and groups Sessions by it, so it decides
 * "is this the current device" and what the Devices screen can revoke. A constant would
 * collapse every browser into one device. The per-browser id lives in the host's storage,
 * and a Worker cannot reach `localStorage` or `sessionStorage` at all — so the host passes
 * the identity through the one channel a Worker can read before its first message: the
 * `name` it was constructed with.
 */

import type { RuntimeAuthClientConfig } from "../worker-runtime";

const PREFIX = "bittery-runtime-client:";

/** Encodes the identity for the Worker constructor's `name` option. */
export function encodeRuntimeClientIdentity(
	identity: RuntimeAuthClientConfig,
): string {
	return `${PREFIX}${JSON.stringify(identity)}`;
}

/**
 * Reads the identity back inside the Worker. A Worker that was given no identity — a test
 * double, or a host that has not been updated — gets none rather than a fabricated one, and
 * the Runtime then falls back to its own unconfigured construction.
 */
export function decodeRuntimeClientIdentity(
	name: string | undefined,
): RuntimeAuthClientConfig | undefined {
	if (name === undefined || !name.startsWith(PREFIX)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(name.slice(PREFIX.length));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { clientId, platform, version } = parsed as Record<string, unknown>;
	if (
		typeof clientId !== "string" ||
		typeof platform !== "string" ||
		typeof version !== "string" ||
		clientId === "" ||
		platform === "" ||
		version === ""
	) {
		return undefined;
	}
	return { clientId, platform, version };
}
