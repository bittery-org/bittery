import { nanoid } from "nanoid";
import { expect, generateTestUser, signUp, test } from "../fixtures/auth";
import { activateTeamPlan } from "../fixtures/billing";
import { uiText } from "../fixtures/messages";
import { inviteMember, openTeamPage } from "../fixtures/team";
import { toastWithText, VAULT_READY_TIMEOUT_MS } from "../fixtures/vault";

test("current User sees and declines a pending Team invitation through Runtime", async ({
	page,
	browser,
}) => {
	test.setTimeout(480000);
	const owner = await signUp(page, generateTestUser(), { plan: "team" });
	activateTeamPlan(owner.email);
	await openTeamPage(page);

	// An ordinary signup creates a personal Team, so accepting this invitation is
	// refused by the Server; declining is the available authenticated gesture.
	const invitee = {
		...generateTestUser(),
		email: `runtime-invitee-${nanoid(8).toLowerCase()}@test.bittery.com`,
	};
	await inviteMember(page, invitee.email);
	const context = await browser.newContext();
	try {
		const invitedPage = await context.newPage();
		await signUp(invitedPage, invitee);
		const pendingTitle = invitedPage.getByText(
			uiText("dashboard_pending_title"),
		);
		// signUp already landed on the live, unlocked home document. Reloading it
		// would retire that Runtime before it can publish the pending invitation.
		await expect(invitedPage).toHaveURL(/\/home(?:[?#]|$)/);
		await expect(pendingTitle).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
		await expect(
			invitedPage.getByText(
				uiText("dashboard_pending_description_single", { count: 1 }),
			),
		).toBeVisible();
		await expect(
			invitedPage.getByText(owner.organizationName).first(),
		).toBeVisible();

		await invitedPage
			.getByRole("button", { name: uiText("dashboard_pending_action_accept") })
			.click();
		await expect(
			invitedPage
				.locator("[data-sonner-toast]")
				.filter({ has: invitedPage.locator(".text-destructive") })
				.first(),
		).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
		await expect(pendingTitle).toBeVisible();

		await invitedPage.getByTestId("invitation-decline-button").click();
		await expect(
			toastWithText(invitedPage, uiText("dashboard_pending_toast_declined")),
		).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
		await expect(pendingTitle).toHaveCount(0, {
			timeout: VAULT_READY_TIMEOUT_MS,
		});
	} finally {
		await context.close();
	}
});
