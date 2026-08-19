import { nanoid } from "nanoid";
import {
	expect,
	generateTestUser,
	signIn,
	signUp,
	type TestUser,
	test,
} from "../fixtures/auth";
import { activateTeamPlan } from "../fixtures/billing";
import { runE2eSql, sqlString } from "../fixtures/e2e-database";
import { uiText } from "../fixtures/messages";
import {
	createItem,
	createVault,
	gotoRoute,
	itemRowTitles,
} from "../fixtures/vault";

/**
 * Sentinel at `/security`: the score tier it grades a vault with, the three
 * issue sections it splits the findings into, and the entitlement that gates
 * the whole route.
 *
 * ONE signup for the whole file, in `beforeAll` on a throwaway context, which
 * also seeds the vault - creating items needs no entitlement, so the seeding can
 * happen while the account is still on Free and the guard test below is still
 * honest.
 *
 * Sentinel runs entirely on the client (`packages/core/src/hooks/use-password-security.ts`):
 * zxcvbn scores every login item's password, identical passwords are reused, and
 * anything older than `OLD_PASSWORD_THRESHOLD_DAYS` is aging. Only the last of
 * the three cannot be reached through the product - the UI has no way to make an
 * item a year old - so that one item's `updated_at` is written directly, the
 * same way `../fixtures/billing` writes the columns a Stripe webhook would.
 */

/** One SRP sign-in plus a full item fetch, decrypt and zxcvbn pass. */
const TEST_BUDGET_MS = 180000;

/** Comfortably past `OLD_PASSWORD_THRESHOLD_DAYS` (365). */
const AGING_ITEM_AGE_DAYS = 400;

/** zxcvbn scores this 0, which is below `WEAK_PASSWORD_THRESHOLD` (2). */
const WEAK_PASSWORD = "password";

/** Shared by two items on purpose; strong enough that only reuse flags them. */
const REUSED_PASSWORD = "Th3-Reused-Vault-Passphrase-9xQ";

/** Unique and strong, so only its age can flag it. */
const AGING_PASSWORD = "Ag1ng-Rotation-Passphrase-4kQz";

const suffix = nanoid(6);
const titles = {
	weak: `Sentinel Weak ${suffix}`,
	reusedFirst: `Sentinel Reused A ${suffix}`,
	reusedSecond: `Sentinel Reused B ${suffix}`,
	aging: `Sentinel Aging ${suffix}`,
};

let user: TestUser;

test.beforeAll(async ({ browser }) => {
	test.setTimeout(420000);
	const context = await browser.newContext();
	try {
		const page = await context.newPage();
		user = await signUp(page, generateTestUser());
		await createVault(page, `Sentinel vault ${suffix}`);

		const addLogin = (title: string, password: string) =>
			createItem(page, "login", async (sheet) => {
				await sheet.locator("#title").fill(title);
				await sheet.locator("#username").fill(`sentinel_${suffix}`);
				await sheet.locator("#password").fill(password);
			});

		await addLogin(titles.weak, WEAK_PASSWORD);
		await addLogin(titles.reusedFirst, REUSED_PASSWORD);
		await addLogin(titles.reusedSecond, REUSED_PASSWORD);
		const agingItemId = await addLogin(titles.aging, AGING_PASSWORD);

		// Sentinel counts what the client decrypted, so a seed that silently lost
		// an item would read as a wrong score rather than as a broken fixture.
		expect(await itemRowTitles(page)).toEqual(
			expect.arrayContaining(Object.values(titles)),
		);

		// psql's row count is the only signal that the id matched anything; without
		// it a mistyped id would silently leave the aging section empty.
		const result = runE2eSql(
			`UPDATE item SET updated_at = now() - interval '${AGING_ITEM_AGE_DAYS} days' WHERE id = '${sqlString(agingItemId)}'`,
		);
		if (result !== "UPDATE 1") {
			throw new Error(
				`Expected to backdate exactly one item, psql said: ${result}`,
			);
		}
	} finally {
		await context.close();
	}
});

test("an unentitled account is redirected off /security to /billing", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);

	// Free carries no `sentinel` entitlement, and the cloud redirect target for a
	// failed entitlement is the page that can sell it.
	await gotoRoute(
		page,
		"/security",
		page.getByRole("heading", { name: uiText("billing_page_heading") }),
	);
	await expect(page).toHaveURL(/\/billing$/);
});

test.describe("with an active Team plan", () => {
	test.beforeAll(() => {
		activateTeamPlan(user.email);
	});

	test("Sentinel grades the seeded vault critical and splits its issues three ways", async ({
		page,
	}) => {
		test.setTimeout(TEST_BUDGET_MS);
		await signIn(page, user);

		// The monitored count is the ready signal rather than the score ring: the
		// ring renders as soon as zxcvbn has run over whatever the client holds,
		// and a bootstrap that came back a password short would then be asserted
		// against. `gotoRoute` reloads, which re-runs the bootstrap - see the
		// intermittent short bootstrap reported for this step.
		const monitored = page.getByText(
			uiText("sentinel_overview_health_mix_monitored", { count: 4 }),
		);
		await gotoRoute(page, "/security", monitored);

		// Four monitored passwords, every one of them flagged: one weak, two
		// sharing a password, one a year old. The score formula cannot climb out
		// of the critical band from there, whatever zxcvbn makes of the two strong
		// passwords - the weak one alone caps the average strength at 3/4.
		await expect(monitored).toBeVisible();
		await expect(
			page.getByText(uiText("sentinel_score_tier_critical_label"), {
				exact: true,
			}),
		).toBeVisible();
		await expect(
			page.getByText(
				uiText("sentinel_overview_score_coverage", { percent: 0 }),
			),
		).toBeVisible();

		// One link per flagged item, so the counts are the sections themselves
		// rather than a badge that could drift from them.
		const weak = page.locator("#sentinel-section-weak");
		await expect(weak.getByRole("link")).toHaveCount(1);
		await expect(weak).toContainText(titles.weak);

		const reused = page.locator("#sentinel-section-reused");
		await expect(reused.getByRole("link")).toHaveCount(2);
		await expect(reused).toContainText(titles.reusedFirst);
		await expect(reused).toContainText(titles.reusedSecond);
		await expect(reused).toContainText(
			uiText("sentinel_issue_detail_used_in_items", { count: 2 }),
		);

		const aging = page.locator("#sentinel-section-old");
		await expect(aging.getByRole("link")).toHaveCount(1);
		await expect(aging).toContainText(titles.aging);
		// The rendered day count is whatever has elapsed since the row was
		// backdated, so only the shape of the age detail is assertable - Postgres
		// resolves `interval '400 days'` against the server's own calendar.
		await expect(aging).toContainText(
			uiText("sentinel_issue_detail_days_old", { days: "" }).trim(),
		);

		// Each item is flagged for exactly one reason: a strong unique password is
		// not weak, and an aging one is not reused.
		await expect(weak).not.toContainText(titles.aging);
		await expect(reused).not.toContainText(titles.weak);
		await expect(aging).not.toContainText(titles.reusedFirst);

		// The briefing counts the same three findings, at the priorities the
		// recommendation generator assigns them.
		const briefing = page.locator("#sentinel-section-briefing");
		await expect(briefing).toContainText(
			uiText("sentinel_recommendations_item_weak_title_single", { count: 1 }),
		);
		await expect(briefing).toContainText(
			uiText("sentinel_recommendations_item_reused_title_plural", { count: 2 }),
		);
		await expect(briefing).toContainText(
			uiText("sentinel_recommendations_item_old_title_single", { count: 1 }),
		);
		await expect(briefing).toContainText(
			uiText("sentinel_recommendations_priority_high"),
		);
		await expect(briefing).toContainText(
			uiText("sentinel_recommendations_priority_medium"),
		);
		await expect(briefing).not.toContainText(
			uiText("sentinel_recommendations_item_good_title"),
		);
	});
});
