import type { Browser, Page } from "@playwright/test";
import { nanoid } from "nanoid";
import {
	expect,
	generateTestUser,
	signIn,
	signUp,
	type TestUser,
	test,
	waitForAppReady,
} from "../fixtures/auth";
import { activateTeamPlan } from "../fixtures/billing";
import { uiText } from "../fixtures/messages";
import {
	inviteMember,
	memberRow,
	openInviteLink,
	openTeamPage,
	openTeamTab,
	signUpFromInvite,
} from "../fixtures/team";
import {
	createVault,
	gotoRoute,
	openVault,
	toastWithText,
	VAULT_READY_TIMEOUT_MS,
} from "../fixtures/vault";

/**
 * Teams end to end: the team a signup creates, its invitations, and the two
 * ways a member stops being one - removed by an owner, or leaving - both of
 * which rotate every shared vault key on the client.
 *
 * The owner signs up once for the whole file, on a throwaway context, and its
 * team is put on an active Team plan (see `../fixtures/billing`) because
 * `assert_team_management_entitlement` refuses every invitation on Free.
 *
 * Three tests below pay for a *second* signup each, and there is no way around
 * it: `send_invitation` refuses any address whose user already has a `team_id`
 * and every signup creates a team, so a second team member can only ever be
 * minted by signing up through the invitation link. Removing a member and
 * leaving a team each consume that member permanently (both hand them a fresh
 * personal team), and the pending-invitation surface needs an account that
 * signed up *outside* the invitation - so the three cannot share one account.
 */

// Every test accumulates members, vaults and invitations on the one owner team,
// so a failure has to stop the ones that assert over that accumulated state.
test.describe.configure({ mode: "serial" });

/** One SRP handshake plus a vault, an invitation and its assertions. */
const TEST_BUDGET_MS = 240000;

/** A second full signup, plus a client-side key rotation over a shared vault. */
const SECOND_ACCOUNT_BUDGET_MS = 480000;

/**
 * The fixed head of a parameterised message. The removal toast counts the
 * vaults it rotated, and that count depends on how many shared vaults this
 * file's owner has accumulated by then, so only the head is assertable.
 */
function messagePrefix(key: string): string {
	const [head] = uiText(key).split("{");
	return (head ?? "").trim();
}

/**
 * A per-test invitee address, lowercase on purpose: signup lowercases the
 * address it stores while `send_invitation` stores the one it was given as-is,
 * and `get_pending_invitations` matches the two with `=`.
 */
function inviteeAddress(): string {
	return `e2e-invitee-${nanoid(8).toLowerCase()}@test.bittery.com`;
}

let owner: TestUser;

test.beforeAll(async ({ browser }) => {
	test.setTimeout(300000);
	const context = await browser.newContext();
	try {
		// The Team plan's signup step is the product's only "create a team" form:
		// it is what names the team the new account owns.
		owner = await signUp(await context.newPage(), generateTestUser(), {
			plan: "team",
		});
	} finally {
		await context.close();
	}
	activateTeamPlan(owner.email);
});

/**
 * A shared vault for a team member to be added to.
 *
 * Deliberately empty: `re_encrypt_item` decrypts with no AAD while items are
 * encrypted with one, so a rotation over a vault that holds anything fails.
 * See the product bug reported for this step.
 */
async function createSharedVault(page: Page): Promise<string> {
	const vaultId = await createVault(page, `Team vault ${nanoid(6)}`);

	await page.getByTestId("vault-menu-button").click();
	await page.getByTestId("make-shared-button").click();
	await page.getByTestId("make-shared-confirm-button").click();
	await expect(
		toastWithText(
			page,
			uiText("vaults_detail_toast_convert_to_shared_success"),
		),
	).toBeVisible();
	return vaultId;
}

/** Open the members dialog of the vault the page is showing. */
async function openVaultMembers(page: Page) {
	await page.getByTestId("vault-menu-button").click();
	await page
		.getByRole("menuitem", { name: uiText("vaults_detail_tab_members") })
		.click();
	const dialog = page.getByRole("dialog", {
		name: uiText("vaults_nav_members_dialog_title"),
	});
	await expect(dialog).toBeVisible();
	return dialog;
}

/** Grant a team member access to the vault the members dialog belongs to. */
async function addVaultMember(page: Page, email: string): Promise<void> {
	const membersDialog = await openVaultMembers(page);
	await membersDialog
		.getByRole("button", { name: uiText("vaults_add_member_dialog_trigger") })
		.click();
	const addDialog = page.getByRole("dialog", {
		name: uiText("vaults_add_member_dialog_title"),
	});
	await expect(addDialog.getByText(email)).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});
	await addDialog
		.getByRole("button", {
			name: uiText("vaults_add_member_dialog_action_add"),
			exact: true,
		})
		.click();
	await expect(
		toastWithText(page, uiText("vaults_add_member_dialog_toast_member_added")),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(addDialog).toBeHidden();
	await expect(membersDialog.getByTestId("member-row")).toHaveCount(2, {
		timeout: VAULT_READY_TIMEOUT_MS,
	});
}

/** Sign a second account up through an invitation and hand back its page. */
async function joinTeamThroughInvite(
	page: Page,
	browser: Browser,
): Promise<{
	invitee: TestUser;
	memberPage: Page;
	close: () => Promise<void>;
}> {
	const invitee = generateTestUser();
	await openTeamPage(page);
	const inviteUrl = await inviteMember(page, invitee.email);

	const context = await browser.newContext();
	const memberPage = await context.newPage();
	await signUpFromInvite(memberPage, inviteUrl, invitee);
	return { invitee, memberPage, close: () => context.close() };
}

test("the Team plan signup names the team the new account owns", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, owner);
	await openTeamPage(page);

	await expect(
		page.getByRole("heading", { name: owner.organizationName }),
	).toBeVisible();
	await expect(
		page.getByText(
			uiText("team_page_hero_member_count_created_by_single", {
				count: 1,
				ownerName: owner.name,
			}),
		),
	).toBeVisible();
	// A solo team is still a team: one member, and that member is the owner.
	await expect(page.getByTestId("member-row")).toHaveCount(1);
	const row = memberRow(page, owner.email);
	await expect(row).toContainText(owner.name);
	await expect(row).toContainText(uiText("team_members_badge_you"));
	await expect(row).toContainText(uiText("team_role_owner"));
	await expect(
		page.getByRole("button", { name: uiText("team_invite_dialog_trigger") }),
	).toBeVisible();

	await openTeamTab(page, "team_page_tab_invitations");
	await expect(
		page.getByText(uiText("team_invitations_empty_title")),
	).toBeVisible();
});

test("an invitation can be resent for a fresh link and then cancelled", async ({
	page,
	browser,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, owner);
	await openTeamPage(page);

	const inviteeEmail = inviteeAddress();
	const firstLink = await inviteMember(page, inviteeEmail, "admin");

	// Reloaded because the invitation list was already fetched when the page
	// loaded and `invalidateTeam` never matches it - see the product bug
	// reported for this step.
	await openTeamPage(page);
	await openTeamTab(page, "team_page_tab_invitations");
	// Scoped to the open tab panel: the sidebar has its own "Admin" link, and the
	// tab heading reads "Pending Invitations".
	const invitations = page.getByRole("tabpanel");
	await expect(invitations.getByText(inviteeEmail)).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});
	await expect(
		invitations.getByText(uiText("team_invitations_status_pending"), {
			exact: true,
		}),
	).toBeVisible();
	await expect(
		invitations.getByText(uiText("team_role_admin"), { exact: true }),
	).toBeVisible();

	// A signed-in visitor gets the accept/decline screen, not a signup form.
	await openInviteLink(
		page,
		firstLink,
		page.getByRole("heading", { name: uiText("auth_invite_header_title") }),
	);
	await expect(page.getByText(owner.organizationName).first()).toBeVisible();
	await expect(
		page.getByRole("button", { name: uiText("auth_invite_action_accept") }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: uiText("auth_invite_action_decline") }),
	).toBeVisible();

	await openTeamPage(page);
	await openTeamTab(page, "team_page_tab_invitations");
	await page
		.getByRole("button", { name: uiText("team_invitations_action_resend") })
		.click();
	await expect(
		toastWithText(page, uiText("team_invitations_toast_resent")),
	).toBeVisible();
	await expect(
		page.getByText(uiText("team_invitations_resend_link_title")),
	).toBeVisible();

	// Resending rotates the token, so the new link is a different URL and the
	// old one no longer resolves to anything.
	// The new link sits in the paragraph right after the hint; neither carries a
	// testid, and the hint is the only text that anchors the block.
	const secondLink = (
		await page
			.locator("p")
			.filter({ hasText: uiText("team_invitations_resend_link_hint") })
			.locator("xpath=following-sibling::p[1]")
			.innerText()
	).trim();
	expect(secondLink).not.toBe(firstLink);

	const stale = await browser.newContext();
	try {
		const view = await stale.newPage();
		await openInviteLink(
			view,
			firstLink,
			view.getByRole("heading", {
				name: uiText("auth_invite_not_found_title"),
			}),
		);
		// The replacement link is live and offers a signed-out visitor a signup.
		await openInviteLink(view, secondLink, view.getByTestId("signup-form"));
		await expect(view.getByTestId("signup-form").locator("#email")).toHaveValue(
			inviteeEmail,
		);
	} finally {
		await stale.close();
	}

	await page
		.getByRole("button", { name: uiText("team_invitations_action_cancel") })
		.click();
	await expect(
		toastWithText(page, uiText("team_invitations_toast_cancelled")),
	).toBeVisible();

	// Reloading also verifies that cancellation survived beyond the query cache.
	await openTeamPage(page);
	await openTeamTab(page, "team_page_tab_invitations");
	await expect(
		page.getByText(uiText("team_invitations_empty_title")),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });

	const cancelled = await browser.newContext();
	try {
		const view = await cancelled.newPage();
		await openInviteLink(
			view,
			secondLink,
			view.getByRole("heading", {
				name: uiText("auth_invite_not_found_title"),
			}),
		);
	} finally {
		await cancelled.close();
	}
});

test("an invited member joins, takes a vault role, and is removed with key rotation", async ({
	page,
	browser,
}) => {
	// Pays for one second signup: the only way onto someone else's team.
	test.setTimeout(SECOND_ACCOUNT_BUDGET_MS);
	await signIn(page, owner);
	const vaultId = await createSharedVault(page);

	const joined = await joinTeamThroughInvite(page, browser);
	try {
		// The invitation is accepted during signup, so the member lands on /team.
		await expect(joined.memberPage).toHaveURL(/\/team$/);
		await expect(memberRow(joined.memberPage, owner.email)).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});

		await openTeamPage(page);
		await expect(page.getByTestId("member-row")).toHaveCount(2, {
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		const row = memberRow(page, joined.invitee.email);
		await expect(row).toContainText(joined.invitee.name);
		await expect(row).toContainText(uiText("team_role_member"));

		await openVault(page, vaultId);
		await addVaultMember(page, joined.invitee.email);

		// Vault roles are the only roles the product lets an owner change.
		const vaultRow = memberRow(page, joined.invitee.email);
		const roleSelect = vaultRow.getByTestId("member-role-select");
		await expect(roleSelect).toContainText(uiText("vaults_common_role_member"));
		await roleSelect.click();
		await page
			.getByRole("option", { name: uiText("vaults_common_role_read_only") })
			.click();
		await expect(
			toastWithText(page, uiText("vaults_member_list_toast_role_updated")),
		).toBeVisible();
		await expect(roleSelect).toContainText(
			uiText("vaults_common_role_read_only"),
			{ timeout: VAULT_READY_TIMEOUT_MS },
		);
		await page.keyboard.press("Escape");

		await openTeamPage(page);
		await memberRow(page, joined.invitee.email)
			.getByRole("button", { name: uiText("team_members_action_remove") })
			.click();
		const confirm = page.getByRole("alertdialog");
		await expect(confirm).toContainText(
			uiText("team_members_remove_dialog_description", {
				name: joined.invitee.name,
			}),
		);
		await confirm
			.getByRole("button", {
				name: uiText("team_members_remove_dialog_action_confirm"),
			})
			.click();

		// The summary proves the rotation ran; the vault is empty, so nothing had
		// to be re-encrypted.
		const removalToast = toastWithText(
			page,
			messagePrefix("team_members_toast_removed_summary"),
		);
		await expect(removalToast).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await expect(removalToast).toContainText(
			uiText("team_members_toast_reencrypted_items_plural", { count: 0 }),
		);

		// Reloaded because the team queries are never invalidated - see the
		// product bug reported for this step.
		await openTeamPage(page);
		await expect(memberRow(page, joined.invitee.email)).toHaveCount(0, {
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await expect(page.getByTestId("member-row")).toHaveCount(1);

		// The rotation has to leave the owner's own copy of the vault key usable,
		// and the vault has to be theirs alone again.
		await openVault(page, vaultId);
		const remaining = await openVaultMembers(page);
		await expect(remaining.getByTestId("member-row")).toHaveCount(1, {
			timeout: VAULT_READY_TIMEOUT_MS,
		});
	} finally {
		await joined.close();
	}
});

test("a member can leave the team, rotating the keys they held", async ({
	page,
	browser,
}) => {
	// Pays for one second signup; the removed member of the previous test cannot
	// be reused, because leaving and being removed both end a membership.
	test.setTimeout(SECOND_ACCOUNT_BUDGET_MS);
	await signIn(page, owner);
	const vaultId = await createSharedVault(page);

	const joined = await joinTeamThroughInvite(page, browser);
	try {
		await openVault(page, vaultId);
		await addVaultMember(page, joined.invitee.email);
		await page.keyboard.press("Escape");

		const member = joined.memberPage;
		await openTeamPage(member);
		await openTeamTab(member, "team_page_tab_settings");
		// The section heading and its trigger button carry the same copy.
		await expect(
			member.getByText(uiText("team_settings_danger_leave_title")).first(),
		).toBeVisible();
		await expect(
			member.getByText(uiText("team_settings_danger_leave_description")),
		).toBeVisible();
		// Only a non-owner is offered the exit; the owner gets deletion instead.
		await expect(
			member.getByRole("button", {
				name: uiText("team_delete_dialog_trigger"),
			}),
		).toHaveCount(0);

		await member
			.getByRole("button", { name: uiText("team_leave_dialog_trigger") })
			.click();
		const confirm = member.getByRole("alertdialog");
		await expect(confirm).toContainText(owner.organizationName);
		await confirm
			.getByRole("button", {
				name: uiText("team_leave_dialog_action_confirm"),
			})
			.click();
		await expect(
			toastWithText(member, uiText("team_leave_dialog_toast_left")),
		).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });

		await openTeamPage(page);
		await expect(memberRow(page, joined.invitee.email)).toHaveCount(0, {
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await expect(page.getByTestId("member-row")).toHaveCount(1);

		// The leaver rotated the vault key; the owner must still hold a usable copy
		// and be the only member left.
		await openVault(page, vaultId);
		const membersDialog = await openVaultMembers(page);
		await expect(membersDialog.getByTestId("member-row")).toHaveCount(1, {
			timeout: VAULT_READY_TIMEOUT_MS,
		});
	} finally {
		await joined.close();
	}
});

test("a pending invitation reaches an account that signed up on its own", async ({
	page,
	browser,
}) => {
	// Pays for one second signup. It cannot be an invitation signup: this is the
	// only way an account can exist *and* still have an invitation outstanding.
	test.setTimeout(SECOND_ACCOUNT_BUDGET_MS);
	await signIn(page, owner);
	await openTeamPage(page);

	const invitee = { ...generateTestUser(), email: inviteeAddress() };
	await inviteMember(page, invitee.email);

	const context = await browser.newContext();
	try {
		const invitedPage = await context.newPage();
		await signUp(invitedPage, invitee);

		await gotoRoute(
			invitedPage,
			"/home",
			invitedPage.getByText(uiText("dashboard_pending_title")),
		);
		await expect(
			invitedPage.getByText(
				uiText("dashboard_pending_description_single", { count: 1 }),
			),
		).toBeVisible();
		await expect(
			invitedPage.getByText(owner.organizationName).first(),
		).toBeVisible();
		await expect(
			invitedPage.getByText(
				uiText("dashboard_pending_invited_by", { invitedBy: owner.name }),
			),
		).toBeVisible();

		// Accepting is refused: `accept_invitation_by_id` requires a null
		// `team_id`, and an ordinary signup has already created a team of one.
		// See the product gap called out in the step report.
		const accept = invitedPage.getByRole("button", {
			name: uiText("dashboard_pending_action_accept"),
		});
		await accept.click();
		await expect(
			invitedPage
				.locator("[data-sonner-toast]")
				.filter({ has: invitedPage.locator(".text-destructive") })
				.first(),
		).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });

		// Declining is the only action that resolves the invitation.
		await invitedPage.getByTestId("invitation-decline-button").click();
		await expect(
			toastWithText(invitedPage, uiText("dashboard_pending_toast_declined")),
		).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });

		// Reloaded because `invalidateTeamInvitations` misses the same way - see
		// the product bug reported for this step.
		await invitedPage.reload();
		await waitForAppReady(invitedPage);
		await expect(
			invitedPage.getByText(uiText("dashboard_pending_title")),
		).toHaveCount(0, { timeout: VAULT_READY_TIMEOUT_MS });
	} finally {
		await context.close();
	}

	// The owner's list no longer shows the invitation either.
	await openTeamPage(page);
	await openTeamTab(page, "team_page_tab_invitations");
	await expect(
		page.getByText(uiText("team_invitations_empty_title")),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
});
