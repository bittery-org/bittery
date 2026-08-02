/**
 * The only file in `vault-session/` importing the C1 lifecycle service.
 *
 * Neither C1 entry point ever rejects — a failed step lands in
 * `outcome.failures` — so this adapter reports failures rather than
 * translating them, and the machine's `.catch` guards are belt-and-braces.
 */

import {
	type InvalidationTarget,
	invalidateAccountSession,
	type LifecycleDeps,
	type LifecycleOutcome,
	lockAllAccounts,
} from "@bittery/core/services/account-lifecycle";
import { lifecycleDeps } from "../../lifecycle";
import type {
	InvalidatedSession,
	SessionInvalidationTarget,
	VaultLifecyclePort,
} from "../ports";

export interface LifecycleAdapterOptions {
	deps?: LifecycleDeps;
	lockAll?: (deps: LifecycleDeps) => Promise<LifecycleOutcome>;
	invalidate?: (
		target: InvalidationTarget,
		deps: LifecycleDeps,
	) => Promise<LifecycleOutcome>;
	/**
	 * Identity of the connection whose session was revoked. The SSE payload
	 * carries no account, so this is the only way to name one when the
	 * `sessionId` matches nothing on the device.
	 */
	resolveFallbackEmail?: () => string | null;
}

function reportFailures(scope: string, outcome: LifecycleOutcome): void {
	if (outcome.failures.length > 0) {
		console.error(`[vault-session] ${scope} incomplete:`, outcome.failures);
	}
}

function project(outcome: LifecycleOutcome): InvalidatedSession {
	const account = outcome.affected[0];
	return {
		accountId: account?.accountId ?? null,
		email: account?.email ?? null,
		wasActive: outcome.wasActive,
	};
}

function toCoreTarget(
	target: SessionInvalidationTarget,
	fallbackEmail: string | null,
): InvalidationTarget {
	if (target === "active") {
		return fallbackEmail ? { email: fallbackEmail } : "active";
	}
	return target;
}

export function createLifecycleAdapter(
	options: LifecycleAdapterOptions = {},
): VaultLifecyclePort {
	const deps = options.deps ?? lifecycleDeps;
	const lockAll = options.lockAll ?? lockAllAccounts;
	const invalidate = options.invalidate ?? invalidateAccountSession;

	return {
		async lockAll(): Promise<void> {
			reportFailures("lockAllAccounts", await lockAll(deps));
		},

		async invalidateSession(
			target: SessionInvalidationTarget,
			fallbackEmail?: string | null,
		): Promise<InvalidatedSession> {
			const email = fallbackEmail ?? options.resolveFallbackEmail?.() ?? null;
			const resolved = toCoreTarget(target, email);

			let outcome = await invalidate(resolved, deps);
			// `StoredSessionData.sessionId` is optional, so an id that matches no
			// stored session returns `affected: []` with `failures: []` — success and
			// "never found it" are the same value. Retrying by email closes that.
			if (
				outcome.affected.length === 0 &&
				email &&
				!(typeof resolved === "object" && "email" in resolved)
			) {
				outcome = await invalidate({ email }, deps);
			}

			reportFailures("invalidateAccountSession", outcome);
			return project(outcome);
		},
	};
}
