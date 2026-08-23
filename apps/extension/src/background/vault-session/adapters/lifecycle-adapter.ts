/**
 * The only file in `vault-session/` importing the C1 lifecycle service.
 *
 * Neither C1 entry point ever rejects — a failed step lands in
 * `outcome.failures` — so this adapter reports failures rather than
 * translating them, and the machine's `.catch` guards are belt-and-braces.
 */

import {
	type InvalidationTarget,
	type LifecycleDeps,
	type LifecycleOutcome,
	lockAllAccounts,
	lockInvalidSession,
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
	 * carries no account, so this names the exact account when the `sessionId`
	 * matches nothing on the device.
	 */
	resolveFallbackAccountId?: () => string | null;
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
	fallbackAccountId: string | null,
): InvalidationTarget {
	if (target === "active") {
		return fallbackAccountId ? { accountId: fallbackAccountId } : "active";
	}
	return target;
}

export function createLifecycleAdapter(
	options: LifecycleAdapterOptions = {},
): VaultLifecyclePort {
	const deps = options.deps ?? lifecycleDeps;
	const lockAll = options.lockAll ?? lockAllAccounts;
	const invalidate = options.invalidate ?? lockInvalidSession;

	return {
		async lockAll(): Promise<void> {
			reportFailures("lockAllAccounts", await lockAll(deps));
		},

		async invalidateSession(
			target: SessionInvalidationTarget,
			fallbackAccountId?: string | null,
		): Promise<InvalidatedSession> {
			const accountId =
				fallbackAccountId ?? options.resolveFallbackAccountId?.() ?? null;
			const resolved = toCoreTarget(target, accountId);

			let outcome = await invalidate(resolved, deps);
			// `StoredSessionData.sessionId` is optional, so an id that matches no
			// stored session returns `affected: []` with `failures: []` — success and
			// "never found it" are the same value. Retrying by accountId closes that.
			if (
				outcome.affected.length === 0 &&
				accountId &&
				!(typeof resolved === "object" && "accountId" in resolved)
			) {
				outcome = await invalidate({ accountId }, deps);
			}

			reportFailures("lockInvalidSession", outcome);
			return project(outcome);
		},
	};
}
