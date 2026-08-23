/**
 * The only file in `vault-session/` importing the C1 lifecycle service.
 *
 * C1 reports incomplete work in `outcome.failures`; the adapter turns that into
 * a rejection so the machine's settled contract cannot project a partial lock as success.
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

function requireComplete(scope: string, outcome: LifecycleOutcome): void {
	if (outcome.failures.length > 0) {
		throw new Error(`[vault-session] ${scope} incomplete`, {
			cause: outcome.failures,
		});
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
			requireComplete("lockAllAccounts", await lockAll(deps));
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

			requireComplete("lockInvalidSession", outcome);
			return project(outcome);
		},
	};
}
