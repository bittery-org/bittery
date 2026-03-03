import { expect, test } from "@playwright/test";
import { evaluateRouteAccess } from "./route-guards";

test.describe("Route guard access evaluation", () => {
	test("redirects cloud users without entitlement to billing", () => {
		const redirect = evaluateRouteAccess({
			routePath: "/security",
			snapshot: {
				mode: "cloud",
				entitlements: { sentinel: false },
			},
			rules: {
				requiresEntitlements: ["sentinel"],
			},
		});

		expect(redirect).toBe("/billing");
	});

	test("redirects self-hosted entitlement failures to home", () => {
		const redirect = evaluateRouteAccess({
			routePath: "/security",
			snapshot: {
				mode: "self-hosted",
				entitlements: { sentinel: false },
			},
			rules: {
				requiresEntitlements: ["sentinel"],
			},
		});

		expect(redirect).toBe("/home");
	});

	test("redirects mode mismatch to home", () => {
		const redirect = evaluateRouteAccess({
			routePath: "/billing",
			snapshot: {
				mode: "self-hosted",
				entitlements: {},
			},
			rules: {
				requiresMode: "cloud",
			},
		});

		expect(redirect).toBe("/home");
	});

	test("allows access when all requirements are met", () => {
		const redirect = evaluateRouteAccess({
			routePath: "/security",
			snapshot: {
				mode: "cloud",
				entitlements: { sentinel: true },
			},
			rules: {
				requiresMode: "cloud",
				requiresEntitlements: ["sentinel"],
			},
		});

		expect(redirect).toBeNull();
	});
});
