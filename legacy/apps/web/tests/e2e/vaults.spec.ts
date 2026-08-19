import type { Page } from "@playwright/test";
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
import { uiText } from "../fixtures/messages";
import { inviteMember, signUpFromInvite } from "../fixtures/team";
import {
	createVault,
	openVault,
	toastWithText,
	VAULT_READY_TIMEOUT_MS,
	vaultMenuTrigger,
	vaultNavLink,
} from "../fixtures/vault";

/**
 * Vault lifecycle: create, edit, delete, and the personal <-> shared
 * conversion, including the case the UI has to refuse.
 *
 * One signup for the whole file, on a throwaway context. That account's team is
 * then put on an active Team plan (see `../fixtures/billing`), because a
 * shared vault is a paid entitlement the E2E stack cannot buy.
 */

/** One SRP handshake plus a vault and its assertions. */
const TEST_BUDGET_MS = 180000;

/**
 * Icon picker options, whose `aria-label` is hardcoded English in
 * `packages/ui/src/components/vault-avatar.tsx` rather than a message key, so
 * `uiText()` cannot reach them. Each maps to the lucide class its svg renders.
 */
const SHIELD_ICON = { label: "Shield", svgClass: "svg.lucide-shield-check" };
const KEY_ICON = { label: "Key", svgClass: "svg.lucide-key" };

let user: TestUser;

test.beforeAll(async ({ browser }) => {
	test.setTimeout(300000);
	const context = await browser.newContext();
	try {
		user = await signUp(await context.newPage(), generateTestUser());
	} finally {
		await context.close();
	}
	activateTeamPlan(user.email);
});

/** Convert the vault the page is showing into a shared one. */
async function makeShared(page: Page): Promise<void> {
	await page.getByTestId("vault-menu-button").click();
	await page.getByTestId("make-shared-button").click();
	await page.getByTestId("make-shared-confirm-button").click();
	await expect(
		toastWithText(
			page,
			uiText("vaults_detail_toast_convert_to_shared_success"),
		),
	).toBeVisible();
}

test("a new vault appears in the sidebar with the icon it was given", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);

	const name = `Created ${nanoid(6)}`;
	const vaultId = await createVault(page, name, {
		iconLabel: SHIELD_ICON.label,
	});

	const navLink = vaultNavLink(page, vaultId);
	await expect(navLink).toHaveAttribute("data-vault-name", name);
	await expect(navLink.locator(SHIELD_ICON.svgClass)).toBeVisible();
	await expect(page).toHaveURL(new RegExp(`/vaults/${vaultId}$`));
	// A brand-new vault holds nothing, and says so.
	await expect(
		page.getByText(uiText("vaults_detail_items_list_empty_default_title")),
	).toBeVisible();
});

test("editing a vault renames it and changes its icon everywhere", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);

	const name = `Before ${nanoid(6)}`;
	const renamed = `After ${nanoid(6)}`;
	const vaultId = await createVault(page, name, {
		iconLabel: SHIELD_ICON.label,
	});

	await vaultMenuTrigger(page, vaultId).click();
	await page
		.getByRole("menuitem", {
			name: uiText("vaults_page_card_action_edit_vault"),
		})
		.click();
	const dialog = page.getByTestId("edit-vault-dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog.locator("#name")).toHaveValue(name);
	await dialog.locator("#name").fill(renamed);
	await dialog.getByRole("button", { name: KEY_ICON.label }).click();
	await page.getByTestId("edit-vault-submit-button").click();

	await expect(dialog).toBeHidden();
	await expect(
		toastWithText(page, uiText("vaults_edit_dialog_toast_updated")),
	).toBeVisible();

	const navLink = vaultNavLink(page, vaultId);
	await expect(navLink).toHaveAttribute("data-vault-name", renamed, {
		timeout: VAULT_READY_TIMEOUT_MS,
	});
	await expect(navLink.locator(KEY_ICON.svgClass)).toBeVisible();
	await expect(navLink.locator(SHIELD_ICON.svgClass)).toHaveCount(0);
	// The vault header renders the same name and icon as the sidebar entry.
	await expect(page.getByText(renamed).first()).toBeVisible();
});

test("deleting a vault removes it from the sidebar and leaves its route", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);

	const name = `Doomed ${nanoid(6)}`;
	const vaultId = await createVault(page, name);
	await expect(vaultNavLink(page, vaultId)).toBeVisible();

	await vaultMenuTrigger(page, vaultId).click();
	await page
		.getByRole("menuitem", {
			name: uiText("vaults_page_card_action_delete_vault"),
		})
		.click();
	const dialog = page.getByTestId("delete-vault-dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(name);
	await page.getByTestId("delete-vault-confirm-button").click();

	await expect(dialog).toBeHidden();
	await expect(
		toastWithText(page, uiText("vaults_detail_toast_vault_deleted")),
	).toBeVisible();
	await expect(vaultNavLink(page, vaultId)).toHaveCount(0);
	// Deleting the vault you are looking at falls back to All Objects.
	await page.waitForURL("**/vaults");
});

test("a personal vault becomes shared and can be made private again", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);

	const vaultId = await createVault(page, `Convertible ${nanoid(6)}`);

	await page.getByTestId("vault-menu-button").click();
	await expect(page.getByTestId("make-private-button")).toHaveCount(0);
	await page.getByTestId("make-shared-button").click();
	const sharedDialog = page.getByTestId("make-shared-dialog");
	await expect(sharedDialog).toBeVisible();
	await page.getByTestId("make-shared-confirm-button").click();

	await expect(
		toastWithText(
			page,
			uiText("vaults_detail_toast_convert_to_shared_success"),
		),
	).toBeVisible();
	await expect(sharedDialog).toBeHidden();

	// A shared vault offers the reverse conversion and no longer offers its own.
	await page.getByTestId("vault-menu-button").click();
	await expect(page.getByTestId("make-shared-button")).toHaveCount(0);
	await expect(page.getByTestId("make-private-button")).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});
	await page.getByTestId("make-private-button").click();
	const privateDialog = page.getByTestId("make-private-dialog");
	await expect(privateDialog).toBeVisible();
	await page.getByTestId("make-private-confirm-button").click();

	await expect(
		toastWithText(
			page,
			uiText("vaults_detail_toast_convert_to_private_success"),
		),
	).toBeVisible();
	await expect(privateDialog).toBeHidden();

	// The round trip is complete only if the vault is offerable as shared again,
	// and the items list still belongs to the same vault.
	await openVault(page, vaultId);
	await page.getByTestId("vault-menu-button").click();
	await expect(page.getByTestId("make-shared-button")).toBeVisible();
	await expect(page.getByTestId("make-private-button")).toHaveCount(0);
});

test("a shared vault with a second member cannot be made private", async ({
	page,
	browser,
}) => {
	// A second account is the only way to give a vault two members, and it costs
	// a second full signup - the one place in these three specs that pays for it.
	test.setTimeout(420000);
	await signIn(page, user);

	const vaultId = await createVault(page, `Two members ${nanoid(6)}`);
	await makeShared(page);

	const invitee = generateTestUser();
	await page.goto("/team");
	const inviteUrl = await inviteMember(page, invitee.email);

	const inviteeContext = await browser.newContext();
	try {
		await signUpFromInvite(await inviteeContext.newPage(), inviteUrl, invitee);
	} finally {
		await inviteeContext.close();
	}

	await openVault(page, vaultId);
	await page.getByTestId("vault-menu-button").click();
	await page
		.getByRole("menuitem", { name: uiText("vaults_detail_tab_members") })
		.click();
	const membersDialog = page.getByRole("dialog", {
		name: uiText("vaults_nav_members_dialog_title"),
	});
	await expect(membersDialog).toBeVisible();
	await expect(membersDialog.getByTestId("member-row")).toHaveCount(1);

	await membersDialog
		.getByRole("button", { name: uiText("vaults_add_member_dialog_trigger") })
		.click();
	const addMemberDialog = page.getByRole("dialog", {
		name: uiText("vaults_add_member_dialog_title"),
	});
	await expect(addMemberDialog.getByText(invitee.email)).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});
	await addMemberDialog
		.getByRole("button", {
			name: uiText("vaults_add_member_dialog_action_add"),
			exact: true,
		})
		.click();
	await expect(
		toastWithText(page, uiText("vaults_add_member_dialog_toast_member_added")),
	).toBeVisible();

	await page.keyboard.press("Escape");
	await expect(addMemberDialog).toBeHidden();
	await expect(membersDialog.getByTestId("member-row")).toHaveCount(2, {
		timeout: VAULT_READY_TIMEOUT_MS,
	});
	await page.keyboard.press("Escape");
	await expect(membersDialog).toBeHidden();

	await page.getByTestId("vault-menu-button").click();
	await expect(page.getByTestId("make-private-button-disabled")).toBeVisible();
	await expect(page.getByTestId("make-private-button")).toHaveCount(0);
	await expect(
		page.getByText(
			uiText("vaults_detail_convert_make_private_disabled_reason", {
				count: 2,
			}),
		),
	).toBeVisible();
	await expect(page.getByTestId("make-private-button-disabled")).toBeDisabled();
});
