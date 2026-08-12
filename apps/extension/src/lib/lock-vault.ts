import type { RouteResponse } from "@/background/router/contract";
import { sendMessage } from "@/lib/messaging";

export type LockDecision =
	| { ok: true }
	| { ok: false; code?: "desktop_owns_lock" };

/**
 * Locks through the service worker, the only context whose MUK cache actually
 * guards autofill (packages/storage/CONTEXT.md §4.5). Never throws: a rejected
 * sendMessage must read as "not locked", never as success.
 */
export async function lockVaultThroughWorker(): Promise<LockDecision> {
	let response: RouteResponse<"LOCK"> | undefined;
	try {
		response = await sendMessage({ type: "LOCK" });
	} catch (error) {
		console.error("[lock-vault] LOCK message failed:", error);
		return { ok: false };
	}

	if (response?.success === true) return { ok: true };
	if (response?.code === "desktop_owns_lock") {
		return { ok: false, code: "desktop_owns_lock" };
	}
	return { ok: false };
}
