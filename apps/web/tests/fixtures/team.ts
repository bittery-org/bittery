/**
 * Team helpers: the `/team` page, the invite dialog and the one signup that
 * has to run *through* an invitation link.
 *
 * `signUpFromInvite()` lives here rather than in a spec because it is the only
 * way to put a second account on a team at all: `send_invitation`
 * (`apps/server/src/services/team.rs`) refuses any address whose user already
 * has a `team_id`, and every ordinary signup creates a team of one.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { readSecretKey, type TestUser, waitForAppReady } from "./auth";
import { mailOutboxNow, waitForCode } from "./mail-outbox";
import { uiText } from "./messages";
import { cssAttributeValue, gotoRoute, VAULT_READY_TIMEOUT_MS } from "./vault";

export type TeamRole = "member" | "admin";

/** Open `/team` and wait for the tabs, which only render once the team loads. */
export async function openTeamPage(page: Page): Promise<void> {
	await gotoRoute(
		page,
		"/team",
		page.getByRole("tab", { name: uiText("team_page_tab_members") }),
	);
}

/** Switch to one of the `/team` tabs and wait for it to become the active one. */
export async function openTeamTab(
	page: Page,
	messageKey:
		| "team_page_tab_members"
		| "team_page_tab_invitations"
		| "team_page_tab_settings",
): Promise<void> {
	const tab = page.getByRole("tab", { name: uiText(messageKey) });
	await tab.click();
	await expect(tab).toHaveAttribute("data-state", "active");
}

/**
 * Open an invite link, in a fresh context or a signed-in one.
 *
 * `ready` is what that visitor is expected to get - a signup form, an
 * accept/decline prompt, or a dead-link notice - because `/invite/$token`
 * renders a different screen for each and shares no wrapper between them.
 */
export async function openInviteLink(
	page: Page,
	inviteUrl: string,
	ready: Locator,
): Promise<void> {
	await gotoRoute(page, inviteUrl, ready);
}

/** One team- or vault-member card, addressed by the email it renders. */
export function memberRow(page: Page, email: string): Locator {
	return page.locator(
		`[data-testid="member-row"][data-member-email="${cssAttributeValue(email)}"]`,
	);
}

/**
 * Send an invitation from `/team` and return the invite URL.
 *
 * The link is shown once, inside the dialog: only the token's SHA-256 digest is
 * stored, so nothing can hand it back afterwards.
 */
export async function inviteMember(
	page: Page,
	email: string,
	role: TeamRole = "member",
): Promise<string> {
	await page
		.getByRole("button", { name: uiText("team_invite_dialog_trigger") })
		.click();
	const dialog = page.getByTestId("invite-dialog");
	await expect(dialog).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	await dialog.locator("#email").fill(email);
	if (role !== "member") {
		await dialog.getByRole("combobox").click();
		await page.getByRole("option", { name: uiText("team_role_admin") }).click();
	}
	await page.getByTestId("invite-submit-button").click();

	const inviteLink = page.getByTestId("invite-link-value");
	await expect(inviteLink).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	const inviteUrl = (await inviteLink.innerText()).trim();

	await dialog
		.getByRole("button", { name: uiText("team_common_action_cancel") })
		.click();
	await expect(dialog).toBeHidden();
	return inviteUrl;
}

/**
 * Sign a brand-new account up through an invitation link.
 *
 * An invitation signup renders `SelfHostedSignUpForm` even in cloud mode, so
 * this is a different form from the one `signUp()` drives: the email is fixed
 * by the invitation, and the code is confirmed in a dialog rather than a step.
 * The server accepts the invitation as part of the signup, which is what puts
 * the new account on the inviter's team.
 */
export async function signUpFromInvite(
	page: Page,
	inviteUrl: string,
	invitee: TestUser,
): Promise<TestUser> {
	const form = page.getByTestId("signup-form");
	await openInviteLink(page, inviteUrl, form);
	await expect(form.locator("#email")).toHaveValue(invitee.email);

	await form.locator("#name").fill(invitee.name);
	await form.locator("#password").fill(invitee.password);

	const download = page.waitForEvent("download").catch(() => null);
	await page.getByTestId("emergency-kit-download-button").click();
	await download;

	const since = mailOutboxNow();
	await page.getByTestId("signup-submit-button").click();
	const verification = page.getByTestId("signup-verification-dialog");
	await expect(verification).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });

	const code = await waitForCode({
		purpose: "signup",
		email: invitee.email,
		since,
	});
	await verification.locator("#signup-verification-code").fill(code);
	await page.getByTestId("signup-verification-submit").click();

	// The server accepts the invitation during signup, so the new member lands
	// on the team page rather than back on the invitation.
	await page.waitForURL("**/team", { timeout: VAULT_READY_TIMEOUT_MS });
	await waitForAppReady(page);
	return { ...invitee, secretKey: await readSecretKey(page) };
}
