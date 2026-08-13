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
	createItem,
	createVault,
	gotoRoute,
	itemRow,
	openItem,
	openVault,
	toastWithText,
	VAULT_READY_TIMEOUT_MS,
} from "../fixtures/vault";

/**
 * Teams end to end: the team a signup creates, its invitations, Vault-only
 * member removal, and the two ways a member stops being one - removed by an
 * owner, or leaving - all driving key rotation on the real client.
 *
 * The owner signs up once for the whole file, on a throwaway context, and its
 * team is put on an active Team plan (see `../fixtures/billing`) because
 * `assert_team_management_entitlement` refuses every invitation on Free.
 *
 * Four tests below pay for a *second* signup each, and there is no way around
 * it: `send_invitation` refuses any address whose user already has a `team_id`
 * and every signup creates a team, so a second team member can only ever be
 * minted by signing up through the invitation link. Removing a member and
 * leaving a team each consume that member permanently (both hand them a fresh
 * personal team), and the pending-invitation surface needs an account that
 * signed up *outside* the invitation - so the four cannot share one account.
 */

// Every test accumulates members, vaults and invitations on the one owner team,
// so a failure has to stop the ones that assert over that accumulated state.
test.describe.configure({ mode: "serial" });

/** One SRP handshake plus a vault, an invitation and its assertions. */
const TEST_BUDGET_MS = 240000;

/** A second full signup, plus a client-side key rotation over a shared vault. */
const SECOND_ACCOUNT_BUDGET_MS = 480000;

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

/** Add a login and optionally an Attachment, exercising both rotation manifests. */
async function populateSharedVault(
	page: Page,
	vaultLabel: string,
	attachmentName?: string,
): Promise<{ itemTitle: string; attachmentContents?: string }> {
	const itemTitle = `${vaultLabel} login ${nanoid(6)}`;
	await createItem(page, "login", async (sheet) => {
		await sheet.locator("#title").fill(itemTitle);
		await sheet.locator("#username").fill(`${vaultLabel.toLowerCase()}-user`);
		await sheet.locator("#password").fill(`secret-${nanoid(10)}`);
	});

	if (attachmentName) {
		const attachmentContents = `rotation attachment ${nanoid(12)}`;
		const pane = page.getByTestId("item-detail-pane");
		await pane.locator('input[type="file"]').setInputFiles({
			name: attachmentName,
			mimeType: "text/plain",
			buffer: Buffer.from(attachmentContents),
		});
		await pane
			.getByRole("button", {
				name: uiText("vaults_detail_items_attachments_action_upload"),
			})
			.click();
		await expect(
			toastWithText(
				page,
				uiText("vaults_detail_items_attachments_toast_uploaded"),
			),
		).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
		await expect(pane.getByText(attachmentName, { exact: true })).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		return { itemTitle, attachmentContents };
	}

	return { itemTitle };
}

/** Download and compare plaintext bytes, proving the rotated envelope still opens. */
async function expectAttachmentDownload(
	page: Page,
	attachmentName: string,
	expectedContents: string,
): Promise<void> {
	const downloaded = page.evaluate(() => {
		return new Promise<{ bytes: number[]; fileName: string }>((resolve) => {
			const original = URL.createObjectURL;
			URL.createObjectURL = (source) => {
				if (!(source instanceof Blob)) return original(source);
				const blob = source;
				const bytes = blob.arrayBuffer();
				const listener = (event: MouseEvent) => {
					const anchor = (event.target as Element | null)?.closest(
						"a[download]",
					);
					if (!anchor) return;
					document.removeEventListener("click", listener, true);
					URL.createObjectURL = original;
					void bytes.then((buffer) => {
						resolve({
							bytes: Array.from(new Uint8Array(buffer)),
							fileName: (anchor as HTMLAnchorElement).download,
						});
					});
				};
				document.addEventListener("click", listener, true);
				return original(blob);
			};
		});
	});
	const downloadButton = page
		.getByTestId("item-detail-pane")
		.getByRole("button", {
			name: uiText("vaults_detail_items_attachments_action_download"),
		});
	await expect(downloadButton).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	await downloadButton.click();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let result: Awaited<typeof downloaded>;
	try {
		result = await Promise.race([
			downloaded,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error("Attachment download did not start")),
					20000,
				);
			}),
		]);
	} finally {
		clearTimeout(timeout);
	}
	expect(result.fileName).toBe(attachmentName);
	expect(Buffer.from(result.bytes).toString("utf8")).toBe(expectedContents);
}

/** Open the members dialog of the vault the page is showing. */
async function openVaultMembers(page: Page) {
	await page.getByTestId("vault-menu-button").click();
	await page
		.getByRole("menuitem", {
			name: uiText("vaults_detail_tab_members"),
			exact: true,
		})
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
		.getByText(email, { exact: true })
		.locator("xpath=../..")
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
	let invitee = generateTestUser();
	await openTeamPage(page);
	const inviteUrl = await inviteMember(page, invitee.email);

	const context = await browser.newContext();
	const memberPage = await context.newPage();
	invitee = await signUpFromInvite(memberPage, inviteUrl, invitee);
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

test("removing a Vault member rotates its Item and Attachment keys", async ({
	page,
	browser,
}) => {
	test.setTimeout(SECOND_ACCOUNT_BUDGET_MS);
	await signIn(page, owner);
	const vaultId = await createSharedVault(page);
	const attachmentName = `vault-removal-${nanoid(6)}.txt`;
	const { itemTitle, attachmentContents } = await populateSharedVault(
		page,
		"Vault removal",
		attachmentName,
	);
	if (!attachmentContents) {
		throw new Error("Attachment fixture did not return its plaintext");
	}

	const joined = await joinTeamThroughInvite(page, browser);
	try {
		await openVault(page, vaultId);
		await addVaultMember(page, joined.invitee.email);
		await page.keyboard.press("Escape");

		// Establish that the member can decrypt the Vault's Item before the owner
		// removes only this Vault grant. The owner's successful upload above and
		// exact download below cover the Attachment ciphertext on both sides of the
		// rotation.
		await joined.memberPage.reload();
		await waitForAppReady(joined.memberPage);
		await openVault(joined.memberPage, vaultId);
		await openItem(joined.memberPage, itemTitle);
		await expect(
			joined.memberPage.getByRole("heading", { name: itemTitle }),
		).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
		await expectAttachmentDownload(
			joined.memberPage,
			attachmentName,
			attachmentContents,
		);

		await openVault(page, vaultId);
		const membersDialog = await openVaultMembers(page);
		await memberRow(page, joined.invitee.email)
			.getByRole("button", {
				name: uiText("vaults_member_list_remove_dialog_title"),
			})
			.click();
		const confirm = page.getByRole("alertdialog");
		await expect(confirm).toContainText(
			uiText("vaults_member_list_remove_dialog_description", {
				name: joined.invitee.name,
			}),
		);
		await expect(confirm).toContainText(
			uiText("vaults_member_list_remove_dialog_rotation_notice"),
		);
		await confirm
			.getByRole("button", {
				name: uiText("vaults_member_list_remove_dialog_action_confirm"),
			})
			.click();
		await expect(
			toastWithText(page, uiText("vaults_member_list_toast_member_removed")),
		).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
		await expect(membersDialog.getByTestId("member-row")).toHaveCount(1, {
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await page.keyboard.press("Escape");

		// Reloading discards every in-memory query result, so these assertions prove
		// the server-committed key and Attachment envelope survive a fresh client.
		await page.reload();
		await waitForAppReady(page);
		await openVault(page, vaultId);
		await openItem(page, itemTitle);
		await expectAttachmentDownload(page, attachmentName, attachmentContents);

		// Vault-only removal keeps team membership but evicts the inaccessible
		// Vault from the removed member's authoritative client state.
		await joined.memberPage.reload();
		await waitForAppReady(joined.memberPage);
		await gotoRoute(
			joined.memberPage,
			"/vaults",
			joined.memberPage.getByTestId("new-vault-button"),
		);
		await expect(
			joined.memberPage.locator(`a[href="/vaults/${vaultId}"]`),
		).toHaveCount(0);
		await openTeamPage(joined.memberPage);
		await expect(memberRow(joined.memberPage, owner.email)).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
	} finally {
		await joined.close();
	}
});

test("member departure rotates multiple shared vaults and an attachment", async ({
	page,
	browser,
}) => {
	// Pays for one second signup: the only way onto someone else's team.
	test.setTimeout(SECOND_ACCOUNT_BUDGET_MS);
	await signIn(page, owner);
	const firstVaultId = await createSharedVault(page);
	const attachmentName = `departure-${nanoid(6)}.txt`;
	const {
		itemTitle: firstItemTitle,
		attachmentContents: firstAttachmentContents,
	} = await populateSharedVault(page, "First", attachmentName);
	if (!firstAttachmentContents) {
		throw new Error("Attachment fixture did not return its plaintext");
	}
	const secondVaultId = await createSharedVault(page);
	const { itemTitle: secondItemTitle } = await populateSharedVault(
		page,
		"Second",
	);

	const joined = await joinTeamThroughInvite(page, browser);
	try {
		// The invitation is accepted during signup, so the member lands on /team.
		await expect(joined.memberPage).toHaveURL(/\/team$/);
		await expect(memberRow(joined.memberPage, owner.email)).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});

		await openTeamPage(page);
		await expect(memberRow(page, owner.email)).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		const row = memberRow(page, joined.invitee.email);
		await expect(row).toContainText(joined.invitee.name);
		await expect(row).toContainText(uiText("team_role_member"));

		await openVault(page, firstVaultId);
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
		await openVault(page, secondVaultId);
		await addVaultMember(page, joined.invitee.email);
		await page.keyboard.press("Escape");

		// Both Vault grants are visible to the member before departure, including
		// the Vault whose rotation manifest contains an Attachment key envelope.
		await joined.memberPage.reload();
		await waitForAppReady(joined.memberPage);
		await gotoRoute(
			joined.memberPage,
			"/vaults",
			joined.memberPage.locator(`a[href="/vaults/${firstVaultId}"]`),
		);
		await expect(
			joined.memberPage.locator(`a[href="/vaults/${secondVaultId}"]`),
		).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });

		// Let finalization commit, then lose only its response. Replaying the exact
		// request proves recovery returns the stored result instead of rotating a
		// second time or treating the already-removed member as a new operation.
		let finishLostFinalize: (request: {
			url: string;
			headers: Record<string, string>;
			body: string | null;
		}) => void = () => {};
		const lostFinalize = new Promise<{
			url: string;
			headers: Record<string, string>;
			body: string | null;
		}>((resolve) => {
			finishLostFinalize = resolve;
		});
		await page.route(
			/\/teams\/[^/]+\/members\/[^/]+\/removal-rotation-plans\/finalize$/,
			async (route) => {
				const request = route.request();
				const response = await route.fetch();
				expect(response.ok()).toBe(true);
				finishLostFinalize({
					url: request.url(),
					headers: request.headers(),
					body: request.postData(),
				});
				await route.fulfill({ response });
			},
			{ times: 1 },
		);

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

		const finalizeRequest = await lostFinalize;
		const replay = await page.request.fetch(finalizeRequest.url, {
			method: "POST",
			headers: finalizeRequest.headers,
			data: finalizeRequest.body ?? undefined,
		});
		expect(replay.ok()).toBe(true);
		expect(replay.headers()["idempotency-replayed"]).toBe("true");
		await expect(
			toastWithText(page, uiText("team_members_toast_remove_success")),
		).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });

		await openVault(page, firstVaultId);
		await expect(itemRow(page, firstItemTitle)).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});

		// Reloaded because the team queries are never invalidated - see the
		// product bug reported for this step.
		await openTeamPage(page);
		await expect(memberRow(page, joined.invitee.email)).toHaveCount(0, {
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await expect(memberRow(page, owner.email)).toBeVisible();

		// The rotation has to leave the owner's own copy of the vault key usable,
		// and the vault has to be theirs alone again.
		await openVault(page, firstVaultId);
		await openItem(page, firstItemTitle);
		await expect(page.getByText(attachmentName, { exact: true })).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await expectAttachmentDownload(
			page,
			attachmentName,
			firstAttachmentContents,
		);
		const remaining = await openVaultMembers(page);
		await expect(remaining.getByTestId("member-row")).toHaveCount(1, {
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await page.keyboard.press("Escape");
		await page.goto("about:blank");
		await openVault(page, secondVaultId);
		await expect(itemRow(page, secondItemTitle)).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});

		// Finalization revokes the departed member's sessions. A stale tab cannot
		// reopen either Vault after it asks the server for authoritative state.
		await joined.memberPage.goto(`/vaults/${firstVaultId}`);
		await expect(joined.memberPage.getByTestId("new-item-button")).toHaveCount(
			0,
			{
				timeout: VAULT_READY_TIMEOUT_MS,
			},
		);
		await expect(joined.memberPage).not.toHaveURL(
			new RegExp(`/vaults/${firstVaultId}$`),
			{ timeout: VAULT_READY_TIMEOUT_MS },
		);
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
	const attachmentName = `team-leave-${nanoid(6)}.txt`;
	const { itemTitle, attachmentContents } = await populateSharedVault(
		page,
		"Team leave",
		attachmentName,
	);
	if (!attachmentContents) {
		throw new Error("Attachment fixture did not return its plaintext");
	}

	const joined = await joinTeamThroughInvite(page, browser);
	try {
		await openVault(page, vaultId);
		await addVaultMember(page, joined.invitee.email);
		await page.keyboard.press("Escape");

		const member = joined.memberPage;
		await member.reload();
		await waitForAppReady(member);
		await openVault(member, vaultId);
		await openItem(member, itemTitle);
		await expect(member.getByRole("heading", { name: itemTitle })).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
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
		await expect(memberRow(page, owner.email)).toBeVisible();

		// The leaver rotated the vault key; the owner must still hold a usable copy
		// of the Item and Attachment key, and be the only member left.
		await openVault(page, vaultId);
		await openItem(page, itemTitle);
		await expect(page.getByText(attachmentName, { exact: true })).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await expectAttachmentDownload(page, attachmentName, attachmentContents);
		const membersDialog = await openVaultMembers(page);
		await expect(membersDialog.getByTestId("member-row")).toHaveCount(1, {
			timeout: VAULT_READY_TIMEOUT_MS,
		});

		// Finalization revokes the leaver's old session. After authenticating again,
		// their fresh personal Team must not retain the former Team's Vault.
		await member.reload();
		await signIn(member, joined.invitee);
		await gotoRoute(member, "/vaults", member.getByTestId("new-vault-button"));
		await expect(member.locator(`a[href="/vaults/${vaultId}"]`)).toHaveCount(0);
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
