import type { Locator, Page } from "@playwright/test";
import { nanoid } from "nanoid";
import {
	expect,
	generateTestLoginItem,
	generateTestUser,
	signIn,
	signUp,
	type TestUser,
	test,
} from "../fixtures/auth";
import { activateTeamPlan } from "../fixtures/billing";
import { runE2eSql, sqlString } from "../fixtures/e2e-database";
import { uiText } from "../fixtures/messages";
import { inviteMember, openTeamPage, signUpFromInvite } from "../fixtures/team";
import {
	createItem,
	createVault,
	gotoRoute,
	VAULT_READY_TIMEOUT_MS,
} from "../fixtures/vault";

/**
 * The admin console at `/admin`: who is on the team, what they did, and the two
 * guards that keep everyone else out.
 *
 * ONE signup for the whole file, in `beforeAll` on a throwaway context, plus
 * exactly ONE second signup - paid for in the last test. There is no cheaper way
 * to get a non-owner: `send_invitation` refuses any address whose user already
 * has a `team_id` and every ordinary signup creates a team of one, so the only
 * account that can hold the `member` role is one that signed up *through* an
 * invitation link.
 *
 * The console is gated three ways (`beforeLoad` in `src/routes/_app/admin/index.tsx`):
 * the `team_management` entitlement, the `team` plan, and an owner-or-admin
 * role. A cloud E2E signup lands on Free with no Stripe, so the first test
 * exercises the unentitled side for real; everything after it runs on the same
 * plan columns a Stripe webhook would have written (see `../fixtures/billing`).
 *
 * The admin page carries no `data-testid` at all, so every selector here is
 * copy-based through `uiText` - a wording change moves the selector instead of
 * breaking it.
 */

/** One SRP sign-in plus the console's own queries. */
const TEST_BUDGET_MS = 180000;

/** A sign-in, an invitation, and a second full signup behind it. */
const SECOND_ACCOUNT_BUDGET_MS = 480000;

let owner: TestUser;

test.beforeAll(async ({ browser }) => {
	test.setTimeout(300000);
	const context = await browser.newContext();
	try {
		owner = await signUp(await context.newPage(), generateTestUser());
	} finally {
		await context.close();
	}
});

/** Open `/admin` and wait for the tab strip the console renders once loaded. */
async function openAdmin(page: Page): Promise<void> {
	await gotoRoute(
		page,
		"/admin",
		page.getByRole("tab", { name: uiText("admin_console_tab_people") }),
	);
}

/** Switch to one `/admin` tab and wait for it to become the active one. */
async function openAdminTab(
	page: Page,
	messageKey: "admin_console_tab_people" | "admin_console_tab_activity",
): Promise<void> {
	const tab = page.getByRole("tab", { name: uiText(messageKey) });
	await tab.click();
	await expect(tab).toHaveAttribute("data-state", "active");
}

/**
 * One of the filter bar's three unlabelled Selects, found by the option it is
 * currently showing - which is the only thing that distinguishes them.
 */
function filterSelect(page: Page, currentLabel: string): Locator {
	return page.getByRole("combobox").filter({ hasText: currentLabel });
}

/**
 * An event row in the activity table, addressed by the action it renders.
 *
 * Scoped to the open tab panel: the People tab renders the same events, so an
 * unscoped match would count them twice.
 */
function eventRow(page: Page, actionLabel: string): Locator {
	return page
		.getByRole("tabpanel")
		.getByRole("button")
		.filter({ hasText: actionLabel });
}

test("an unentitled account is redirected off /admin to /billing", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, owner);

	// Free carries no `team_management`, so the guard bounces to the page that
	// can fix that - which is the cloud redirect target for every entitlement.
	await gotoRoute(
		page,
		"/admin",
		page.getByRole("heading", { name: uiText("billing_page_heading") }),
	);
	await expect(page).toHaveURL(/\/billing$/);
});

test.describe("with an active Team plan", () => {
	test.beforeAll(() => {
		activateTeamPlan(owner.email);
	});

	test("the Activity tab lists audit events, filters them, and opens one in detail", async ({
		page,
	}) => {
		test.setTimeout(TEST_BUDGET_MS);
		await signIn(page, owner);

		// Two audit events with known entity ids: `vault_created` carries the vault
		// id, `item_created` the item id (`apps/server/src/services/vault.rs`).
		const vaultName = `Admin vault ${nanoid(6)}`;
		const vaultId = await createVault(page, vaultName);
		const login = generateTestLoginItem();
		const itemId = await createItem(page, "login", async (sheet) => {
			await sheet.locator("#title").fill(login.title);
			await sheet.locator("#username").fill(login.username);
			await sheet.locator("#password").fill(login.password);
		});

		// PRODUCT BUG, worked around here: `defaultFilters()` truncates its `to`
		// bound to the start of the current minute (`toLocalDateTimeValue` slices
		// an ISO string to `YYYY-MM-DDTHH:mm`) and the filter bar renders no date
		// input at all, so the console silently hides everything that happened
		// since that minute began - which is exactly the two events just created.
		// Backdating them is the only way to assert the console's own behaviour
		// rather than the clock's.
		const backdated = runE2eSql(
			`UPDATE audit_log SET created_at = created_at - interval '5 minutes' WHERE entity_id IN ('${sqlString(vaultId)}', '${sqlString(itemId)}')`,
		);
		if (backdated !== "UPDATE 2") {
			throw new Error(
				`Expected two audit rows for the new vault and item, psql said: ${backdated}`,
			);
		}

		await openAdmin(page);
		await openAdminTab(page, "admin_console_tab_activity");

		const vaultCreated = uiText("admin_page_event_action_vault_created");
		const itemCreated = uiText("admin_page_event_action_item_created");
		await expect(eventRow(page, itemCreated)).toHaveCount(1, {
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await expect(eventRow(page, vaultCreated)).toHaveCount(1);
		// The actor column is the signed-in owner, resolved from the team roster.
		await expect(eventRow(page, itemCreated)).toContainText(owner.email);
		await expect(eventRow(page, itemCreated)).toContainText(
			uiText("admin_page_event_result_success"),
		);

		// Action group: `vault_%` only, so the item event has to disappear.
		await filterSelect(
			page,
			uiText("admin_page_filter_action_group_option_all"),
		).click();
		await page
			.getByRole("option", {
				name: uiText("admin_page_event_action_group_vault"),
			})
			.click();
		await expect(eventRow(page, itemCreated)).toHaveCount(0, {
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await expect(eventRow(page, vaultCreated)).toHaveCount(1);

		// The Failures view asks for failed events only, which excludes the audit
		// log entirely - it records successes - and this team has no share access
		// log at all, so the console has nothing left to show.
		await page
			.getByRole("button", { name: uiText("admin_console_view_failures") })
			.click();
		await expect(page.getByText(uiText("admin_page_empty_title"))).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await expect(eventRow(page, vaultCreated)).toHaveCount(0);

		await page
			.getByRole("button", { name: uiText("admin_page_filter_reset") })
			.click();
		await expect(eventRow(page, itemCreated)).toHaveCount(1, {
			timeout: VAULT_READY_TIMEOUT_MS,
		});

		// Free-text search runs over action, entity id and metadata, so the item's
		// own id matches exactly one event - and the vault's does not.
		await page
			.getByPlaceholder(uiText("admin_page_filter_search_placeholder"))
			.fill(itemId);
		await expect(eventRow(page, vaultCreated)).toHaveCount(0, {
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await expect(eventRow(page, itemCreated)).toHaveCount(1);

		// The evidence rail shows the masked network details; the dialog behind it
		// shows the unmasked ones plus the raw metadata.
		await eventRow(page, itemCreated).click();
		await page
			.getByRole("button", { name: uiText("admin_page_table_action_view") })
			.click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText(uiText("admin_page_dialog_description"));
		await expect(dialog).toContainText(itemCreated);
		await expect(dialog).toContainText(
			uiText("admin_page_event_entity_type_item"),
		);
		await expect(dialog).toContainText(itemId);
		await expect(dialog).toContainText(
			uiText("admin_page_event_source_audit_log"),
		);
		await expect(dialog).toContainText(
			uiText("admin_page_section_network_details"),
		);
		// The metadata block is the created item's own payload reference.
		await expect(dialog.locator("pre")).toContainText(vaultId);
	});

	test("the People tab profiles a member, and that member is redirected off /admin", async ({
		page,
		browser,
	}) => {
		// Pays for this file's one second signup: the invitation flow is the only
		// way to mint an account whose team role is not `owner`.
		test.setTimeout(SECOND_ACCOUNT_BUDGET_MS);
		await signIn(page, owner);
		await openTeamPage(page);

		const invitee = generateTestUser();
		const inviteUrl = await inviteMember(page, invitee.email);

		const memberContext = await browser.newContext();
		try {
			const memberPage = await memberContext.newPage();
			await signUpFromInvite(memberPage, inviteUrl, invitee);

			await openAdmin(page);
			const people = page.getByRole("tabpanel");
			// The console renders no testids; the member search input is the only
			// input on this tab, which is what anchors its section.
			const roster = people.locator("section:has(input)");
			await expect(roster.getByRole("button")).toHaveCount(2, {
				timeout: VAULT_READY_TIMEOUT_MS,
			});
			await expect(roster).toContainText(owner.email);
			await expect(roster).toContainText(invitee.email);

			await roster
				.getByPlaceholder(uiText("admin_console_search_members"))
				.fill(invitee.email);
			await expect(roster.getByRole("button")).toHaveCount(1);

			// Filtering leaves exactly one member, so the profile beside it is theirs.
			await expect(
				people.getByRole("heading", { name: invitee.name }),
			).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
			await expect(people).toContainText(uiText("admin_console_joined"));
			await expect(people).toContainText(uiText("admin_console_stat_vaults"));
			await expect(people).toContainText(uiText("admin_console_stat_sessions"));
			await expect(people).toContainText(uiText("admin_console_stat_shares"));
			// A brand-new member holds no shared vault and has created no link, and
			// personal vaults are deliberately never listed here.
			await expect(
				people.getByText(uiText("admin_console_vault_access_empty")),
			).toBeVisible();
			await expect(
				people.getByText(uiText("admin_console_share_links_empty")),
			).toBeVisible();

			// The role guard is the last of the three, so it redirects to /team
			// rather than to /billing: this account's team is on the Team plan and
			// carries the entitlement, it simply is not an owner or an admin.
			await gotoRoute(
				memberPage,
				"/admin",
				memberPage.getByRole("tab", { name: uiText("team_page_tab_members") }),
			);
			await expect(memberPage).toHaveURL(/\/team$/);
		} finally {
			await memberContext.close();
		}
	});
});
