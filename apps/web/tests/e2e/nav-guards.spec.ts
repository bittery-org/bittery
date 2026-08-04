import type { Locator, Page } from "@playwright/test";
import {
	expect,
	generateTestUser,
	signIn,
	signUp,
	type TestUser,
	test,
} from "../fixtures/auth";
import { activateCloudPlan } from "../fixtures/billing";
import { runE2eSql, sqlString } from "../fixtures/e2e-database";
import { uiText } from "../fixtures/messages";
import { gotoRoute, VAULT_READY_TIMEOUT_MS } from "../fixtures/vault";

/**
 * `/home` and the navigation around it: which sidebar entries a plan and a role
 * are allowed to see (`src/components/layout/nav-config.ts`), and what the
 * routes behind the hidden ones do when they are asked for anyway.
 *
 * ONE signup for the whole file, in `beforeAll` on a throwaway context. The plan
 * and the role are then moved underneath that one account rather than bought
 * with new signups: both are single server-side columns, and every check here
 * reads them back through the product's own queries.
 *
 * The plan walk lives in a single test on purpose. `gotoRoute` issues a real
 * document navigation, which rebuilds the router's query client, so a plan
 * written between two navigations is picked up in full - and one sign-in then
 * covers three plans instead of three sign-ins covering one each.
 */

// The plan and the role are moved underneath one shared account, so a test that
// fails to establish them must stop the ones that read them back.
test.describe.configure({ mode: "serial" });

/** One SRP sign-in plus several full route loads. */
const TEST_BUDGET_MS = 240000;

let user: TestUser;

test.beforeAll(async ({ browser }) => {
	test.setTimeout(300000);
	const context = await browser.newContext();
	try {
		user = await signUp(await context.newPage(), generateTestUser());
	} finally {
		await context.close();
	}
});

/**
 * Move one account's team role.
 *
 * WHY THIS IS SQL: a role other than `owner` can only be minted by signing up
 * through an invitation, which costs a second full signup (see
 * `admin.spec.ts`, which pays for one to prove the *route* guard). The nav
 * filter and the `/billing` guard both read nothing but `auth.me().role`, so
 * writing that column reproduces the state exactly, and the assertions below
 * still run through the real query.
 */
function setTeamRole(email: string, role: "owner" | "admin" | "member"): void {
	const result = runE2eSql(
		`UPDATE "user" SET role = '${role}'::team_role WHERE lower(email) = lower('${sqlString(email)}')`,
	);
	if (result !== "UPDATE 1") {
		throw new Error(
			`Expected exactly one user row for ${email}, psql said: ${result}`,
		);
	}
}

/** The desktop sidebar; the mobile `Sheet` copy is not in the DOM at 1280px. */
function sidebar(page: Page): Locator {
	return page.locator('[data-sidebar="sidebar"]');
}

/** Every navigation entry the sidebar currently renders, top to bottom. */
function navLinks(page: Page): Locator {
	return sidebar(page).locator('[data-sidebar="group-content"] a');
}

/** One stat cell's value, which is the paragraph after its label. */
function statValue(strip: Locator, label: string): Locator {
	return strip
		.getByText(label, { exact: true })
		.locator("xpath=following-sibling::p[1]");
}

async function openHome(page: Page): Promise<void> {
	await gotoRoute(
		page,
		"/home",
		page.getByRole("heading", {
			name: uiText("dashboard_home_greeting_named", { name: user.name }),
		}),
	);
}

test("/home renders every card a fresh account has, and none it does not", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);
	await openHome(page);

	await expect(
		page.getByText(uiText("dashboard_home_hero_subtitle")),
	).toBeVisible();
	await expect(
		page.getByRole("link", {
			name: uiText("dashboard_home_button_account_settings"),
			exact: true,
		}),
	).toBeVisible();
	await expect(
		page.getByRole("link", {
			name: uiText("dashboard_home_button_open_vaults"),
			exact: true,
		}),
	).toBeVisible();

	// The strip is the only element that carries the Teams label, which is what
	// separates it from the vault card that repeats "Vaults".
	const strip = page.locator("div.grid").filter({
		has: page.getByText(uiText("dashboard_stats_card_teams_title"), {
			exact: true,
		}),
	});
	// Signup creates one Personal vault, no items, and a team of one.
	await expect(
		statValue(strip, uiText("dashboard_stats_card_vaults_title")),
	).toHaveText("1", { timeout: VAULT_READY_TIMEOUT_MS });
	await expect(
		statValue(strip, uiText("dashboard_stats_card_items_title")),
	).toHaveText("0");
	await expect(
		statValue(strip, uiText("dashboard_stats_card_teams_title")),
	).toHaveText("1");
	// The session count is history, not a fact about a fresh account: the signup
	// in `beforeAll` left one behind and every sign-in adds another, including a
	// CI retry of this test. Asserting it resolved to a number is what separates
	// a rendered count from a stuck skeleton.
	await expect(
		statValue(strip, uiText("dashboard_home_devices_title")),
	).toHaveText(/^[1-9][0-9]*$/);

	await expect(
		page.getByRole("heading", {
			name: uiText("dashboard_home_security_title"),
		}),
	).toBeVisible();
	await expect(
		page.getByText(uiText("sentinel_score_gauge_label")),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: uiText("dashboard_home_recent_title") }),
	).toBeVisible();
	await expect(
		page.getByText(uiText("dashboard_home_recent_empty")),
	).toBeVisible();
	await expect(
		page.getByRole("heading", {
			name: uiText("dashboard_home_get_desktop_title"),
		}),
	).toBeVisible();
	await expect(
		page.getByRole("heading", {
			name: uiText("dashboard_home_devices_title"),
			exact: true,
		}),
	).toBeVisible();
	await expect(
		page.getByText(uiText("dashboard_home_device_current")),
	).toBeVisible();

	// Nobody has invited this account, so the invitations card renders nothing at
	// all rather than an empty state.
	await expect(page.getByText(uiText("dashboard_pending_title"))).toHaveCount(
		0,
	);
});

test("the sidebar and the guards both follow the plan, from Free up to Team", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);
	await openHome(page);

	// --- Free: no entitlements at all ---
	await expect(navLinks(page)).toHaveText([
		uiText("nav_item_dashboard"),
		uiText("nav_item_vaults"),
		uiText("nav_item_team"),
		uiText("nav_item_billing"),
		uiText("nav_item_settings"),
	]);

	const billingHeading = page.getByRole("heading", {
		name: uiText("billing_page_heading"),
	});
	// Both gated routes fail their entitlement check, and on cloud that redirects
	// to the page that can sell the entitlement.
	await gotoRoute(page, "/security", billingHeading);
	await expect(page).toHaveURL(/\/billing$/);
	await gotoRoute(page, "/admin", billingHeading);
	await expect(page).toHaveURL(/\/billing$/);
	// `/billing` itself is reachable: this account is the owner of its own team.
	await gotoRoute(page, "/billing", billingHeading);
	await expect(page).toHaveURL(/\/billing$/);

	// --- Personal: sentinel, but no team management ---
	activateCloudPlan(user.email, "personal");
	await openHome(page);
	await expect(navLinks(page)).toHaveText([
		uiText("nav_item_dashboard"),
		uiText("nav_item_sentinel"),
		uiText("nav_item_vaults"),
		uiText("nav_item_team"),
		uiText("nav_item_billing"),
		uiText("nav_item_settings"),
	]);
	await gotoRoute(
		page,
		"/security",
		page.getByText(uiText("sentinel_score_gauge_label")),
	);
	await expect(page).toHaveURL(/\/security$/);
	// Admin needs `team_management`, which Personal does not carry.
	await gotoRoute(page, "/admin", billingHeading);
	await expect(page).toHaveURL(/\/billing$/);

	// --- Team: the only plan the Admin entry is listed for ---
	activateCloudPlan(user.email, "team");
	await openHome(page);
	await expect(navLinks(page)).toHaveText([
		uiText("nav_item_dashboard"),
		uiText("nav_item_sentinel"),
		uiText("nav_item_vaults"),
		uiText("nav_item_team"),
		uiText("nav_item_admin"),
		uiText("nav_item_billing"),
		uiText("nav_item_settings"),
	]);
	await gotoRoute(
		page,
		"/admin",
		page.getByRole("tab", { name: uiText("admin_console_tab_people") }),
	);
	await expect(page).toHaveURL(/\/admin/);
});

test("a member of a Team-plan team loses both Billing and Admin", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	// The plan is left where the previous test put it, so the only thing that
	// changes here is the role.
	setTeamRole(user.email, "member");
	await signIn(page, user);
	await openHome(page);

	await expect(navLinks(page)).toHaveText([
		uiText("nav_item_dashboard"),
		uiText("nav_item_sentinel"),
		uiText("nav_item_vaults"),
		uiText("nav_item_team"),
		uiText("nav_item_settings"),
	]);

	// Both routes are role-gated rather than entitlement-gated, so they redirect
	// to the team page instead of to billing.
	const teamMembersTab = page.getByRole("tab", {
		name: uiText("team_page_tab_members"),
	});
	await gotoRoute(page, "/billing", teamMembersTab);
	await expect(page).toHaveURL(/\/team$/);
	await gotoRoute(page, "/admin", teamMembersTab);
	await expect(page).toHaveURL(/\/team$/);

	// A role change must not touch the entitlement-gated routes.
	await gotoRoute(
		page,
		"/security",
		page.getByText(uiText("sentinel_score_gauge_label")),
	);
	await expect(page).toHaveURL(/\/security$/);
});
