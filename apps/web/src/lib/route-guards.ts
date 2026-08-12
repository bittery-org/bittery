import { apiQueries } from "@bittery/shared/api-query";
import type { EntitlementKey } from "@bittery/shared/billing";
import { redirect } from "@tanstack/react-router";
import {
	normalizeDeploymentMode,
	normalizeEntitlements,
} from "@/lib/api-normalizers";
import type { RouterAppContext } from "../routes/__root";

export type DeploymentMode = "cloud" | "self-hosted";
export type GuardRedirectPath = "/billing" | "/home";

export interface EntitlementSnapshot {
	mode: DeploymentMode;
	entitlements: Partial<Record<EntitlementKey, boolean>>;
}

export interface RouteGuardRules {
	requiresMode?: DeploymentMode;
	requiresEntitlements?: readonly EntitlementKey[];
}

interface EvaluateRouteAccessInput {
	routePath: string;
	snapshot: EntitlementSnapshot;
	rules: RouteGuardRules;
}

function getEntitlementFailureRedirect(
	mode: DeploymentMode,
	routePath: string,
): GuardRedirectPath {
	if (mode === "cloud" && routePath !== "/billing") {
		return "/billing";
	}
	return "/home";
}

export function evaluateRouteAccess({
	routePath,
	snapshot,
	rules,
}: EvaluateRouteAccessInput): GuardRedirectPath | null {
	if (rules.requiresMode && snapshot.mode !== rules.requiresMode) {
		return "/home";
	}

	if (!rules.requiresEntitlements?.length) {
		return null;
	}

	for (const entitlement of rules.requiresEntitlements) {
		if (!snapshot.entitlements[entitlement]) {
			return getEntitlementFailureRedirect(snapshot.mode, routePath);
		}
	}

	return null;
}

interface GuardBeforeLoadInput {
	context: RouterAppContext;
	location: {
		pathname: string;
	};
}

export function createRouteGuard(rules: RouteGuardRules) {
	return async ({ context, location }: GuardBeforeLoadInput) => {
		const access = await context.queryClient.ensureQueryData(
			apiQueries.billing.entitlements(context.api),
		);

		const redirectPath = evaluateRouteAccess({
			routePath: location.pathname,
			snapshot: {
				mode: normalizeDeploymentMode(access.mode),
				entitlements: normalizeEntitlements(access.entitlements),
			},
			rules,
		});

		if (redirectPath && location.pathname !== redirectPath) {
			throw redirect({ to: redirectPath });
		}
	};
}
