import { expect, test } from "@playwright/test";
import { appNavItems, filterNavItems } from "./nav-config";

function getPaths(paths: { path: string }[]) {
	return paths.map((item) => item.path);
}

test.describe("Navigation visibility filter", () => {
	test("shows cloud billing and sentinel when entitled", () => {
		const result = filterNavItems(appNavItems, {
			mode: "cloud",
			entitlements: { sentinel: true },
		});

		expect(getPaths(result)).toContain("/billing");
		expect(getPaths(result)).toContain("/security");
	});

	test("hides sentinel when entitlement is missing", () => {
		const result = filterNavItems(appNavItems, {
			mode: "cloud",
			entitlements: { sentinel: false },
		});

		expect(getPaths(result)).toContain("/billing");
		expect(getPaths(result)).not.toContain("/security");
	});

	test("hides cloud-only nav in self-hosted mode", () => {
		const result = filterNavItems(appNavItems, {
			mode: "self-hosted",
			entitlements: { sentinel: true },
		});

		expect(getPaths(result)).not.toContain("/billing");
		expect(getPaths(result)).not.toContain("/security");
		expect(getPaths(result)).toContain("/vaults");
		expect(getPaths(result)).toContain("/team");
	});
});
