import { DEFAULT_SESSION_EXPIRY_MS } from "./types";

export type SessionExpiryInput = string | Date | number;

export function resolveStoredSessionExpiryTimestamp(
	expiresAt: SessionExpiryInput | undefined,
	createdAt: number,
): number {
	if (expiresAt === undefined) {
		return createdAt + DEFAULT_SESSION_EXPIRY_MS;
	}

	if (typeof expiresAt === "number") {
		return expiresAt > 1_000_000_000_000 ? expiresAt : createdAt + expiresAt;
	}

	const parsed =
		typeof expiresAt === "string"
			? new Date(expiresAt).getTime()
			: expiresAt.getTime();

	return Number.isFinite(parsed)
		? parsed
		: createdAt + DEFAULT_SESSION_EXPIRY_MS;
}
