import { useQuery } from "@tanstack/react-query";
import type { VaultSessionSnapshot } from "@/background/vault-session/types";

/** Partial: the worker may answer before it has a snapshot, or not at all. */
export type SessionStatusResponse = Partial<VaultSessionSnapshot> & {
	success?: boolean;
};

/**
 * The worker's snapshot is the only answer to "is the vault unlocked, and who
 * owns it?". One query key means every popup surface reads the same revision.
 *
 * 5s matches the `CHECK_DESKTOP_STATUS` poll sitting next to it: the lock button
 * and the desktop-only buttons must not disagree for a whole extra interval, and
 * this handler is an in-memory read rather than a native round trip.
 */
export function useSessionStatus() {
	return useQuery<SessionStatusResponse>({
		queryKey: ["session-status"],
		queryFn: async () =>
			chrome.runtime.sendMessage({ type: "GET_SESSION_STATUS" }),
		refetchInterval: 5000,
	});
}
