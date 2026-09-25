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
	requireCompleteLifecycleOutcome,
} from "@bittery/core/services/account-lifecycle";
import { lifecycleDeps } from "../../lifecycle";
import { nativeMessagingClient } from "../../native-messaging-client";
import type {
	InvalidatedSession,
	SessionInvalidationTarget,
	VaultLifecyclePort,
} from "../ports";

export interface LifecycleAdapterOptions {
	delivery?: Pick<typeof nativeMessagingClient, "withLifecycleCleanup">;
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
	const delivery = options.delivery ?? nativeMessagingClient;

	return {
		async lockAll(): Promise<void> {
			await delivery.withLifecycleCleanup(async () => {
				requireCompleteLifecycleOutcome(await lockAll(deps), {
					operation: "Extension lockAllAccounts",
				});
			}, "all");
		},

		async invalidateSession(
			target: SessionInvalidationTarget,
			fallbackAccountId?: string | null,
		): Promise<InvalidatedSession> {
			const accountId =
				fallbackAccountId ?? options.resolveFallbackAccountId?.() ?? null;
			const resolved = accountId
				? ({ accountId } satisfies InvalidationTarget)
				: toCoreTarget(target, null);

			const outcome = await delivery.withLifecycleCleanup(
				async () => {
					const outcome = await invalidate(resolved, deps);
					requireCompleteLifecycleOutcome(outcome, {
						operation: "Extension lockInvalidSession",
						requireAffected: true,
					});
					return outcome;
				},
				(completed) => completed.affected.map((account) => account.accountId),
				typeof resolved === "object" && "accountId" in resolved
					? resolved.accountId
					: undefined,
			);
			return project(outcome);
		},
	};
}
