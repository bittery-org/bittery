import { useQuery } from "@tanstack/react-query";
import type { RouteResponse } from "@/background/router/contract";
import { sendMessage } from "@/lib/messaging";

/** `null` when the worker answered without a snapshot — treat as "unknown". */
export type SessionStatus = Extract<
	RouteResponse<"GET_SESSION_STATUS">,
	{ success: true }
>;

/**
 * The worker's snapshot is the only answer to "is the vault unlocked, and who
 * owns it?". One query key means every popup surface reads the same revision.
 *
 * 5s matches the `CHECK_DESKTOP_STATUS` poll sitting next to it: the lock button
 * and the desktop-only buttons must not disagree for a whole extra interval, and
 * this handler is an in-memory read rather than a native round trip.
 */
export function useSessionStatus() {
	return useQuery<SessionStatus | null>({
		queryKey: ["session-status"],
		queryFn: async () => {
			const response = await sendMessage({ type: "GET_SESSION_STATUS" });
			return response.success ? response : null;
		},
		refetchInterval: 5000,
	});
}
