import type { RefreshSessionResponse } from "@bittery/api-contract";

export interface SessionSnapshot {
	token: string | null;
	issuedAt: number | null;
	expiresAt: number | null;
}

/**
 * Derived, not restated. This is exactly what `auth.sessions.refresh()` returns —
 * `api-session-refresh.ts` hands the parsed response straight to
 * `storeRefreshedSession` — so restating it meant a server-side rename would
 * silently stop populating a field instead of failing here. ADR 0012.
 */
export type RefreshResult = RefreshSessionResponse;
