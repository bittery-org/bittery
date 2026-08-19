import { nanoid } from "nanoid";
import {
	expect,
	generateTestCreditCard,
	generateTestLoginItem,
	generateTestSecureNote,
	generateTestUser,
	signIn,
	signUp,
	type TestUser,
	test,
} from "../fixtures/auth";
import { uiText } from "../fixtures/messages";
import {
	createItem,
	createVault,
	detailRow,
	itemRow,
	openItemMenu,
	revealValue,
	toastWithText,
	VAULT_READY_TIMEOUT_MS,
} from "../fixtures/vault";

/**
 * Item CRUD across all five categories, plus the per-item affordances that hang
 * off the detail pane: custom fields, password history, star, copy and reveal.
 *
 * One signup for the whole file, on a throwaway context - PBKDF2 at 600k
 * iterations plus SRP and RSA key generation is far too expensive to repeat per
 * test. Every test signs that one account back in on its own fresh context and
 * creates its own vault, so no test can see another's items.
 */

/** One SRP handshake plus a vault, an item or two, and their assertions. */
const TEST_BUDGET_MS = 180000;

/** A valid base32 TOTP secret; the form refuses anything else. */
const TOTP_SECRET = "JBSWY3DPEHPK3PXP";

// Reading back a copied value needs both halves of the clipboard permission in
// Chromium; `navigator.clipboard.readText()` rejects without them.
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

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

test("a login item is created with a custom field, edited, and moved to trash", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);
	await createVault(page, `Logins ${nanoid(6)}`);

	const item = generateTestLoginItem();
	const customFieldValue = `custom-${nanoid(6)}`;
	const itemId = await createItem(page, "login", async (sheet) => {
		await sheet.locator("#title").fill(item.title);
		await sheet.locator("#username").fill(item.username);
		await sheet.locator("#password").fill(item.password);
		await sheet.locator("#url").fill(item.url);
		await sheet.locator("#notes").fill(item.notes ?? "");
		await sheet
			.getByRole("button", {
				name: uiText("vaults_detail_items_form_login_action_add_custom_field"),
			})
			.click();
		await sheet
			.getByPlaceholder(
				uiText("vaults_detail_items_form_login_placeholder_custom_field_label"),
			)
			.fill("API Key");
		await sheet
			.getByPlaceholder(
				uiText("vaults_detail_items_form_login_placeholder_custom_field_value"),
			)
			.fill(customFieldValue);
	});

	const pane = page.getByTestId("item-detail-pane");
	await expect(pane).toHaveAttribute("data-item-id", itemId);
	await expect(pane.getByRole("heading", { name: item.title })).toBeVisible();
	await expect(
		detailRow(pane, uiText("vaults_detail_items_detail_login_field_username")),
	).toContainText(item.username);
	await expect(
		detailRow(pane, uiText("vaults_detail_items_detail_login_field_website")),
	).toContainText(item.url);
	await expect(pane.getByText(item.notes ?? "")).toBeVisible();
	// A custom field is rendered as a row labelled with the name the user typed.
	await expect(detailRow(pane, "API Key")).toContainText(customFieldValue);

	const editedTitle = `${item.title} edited`;
	const editedUsername = `${item.username}-edited`;
	await page.getByTestId("item-edit-button").click();
	const editSheet = page.getByTestId("edit-item-dialog");
	await expect(editSheet).toBeVisible();
	await editSheet.locator("#title").fill(editedTitle);
	await editSheet.locator("#username").fill(editedUsername);
	await editSheet.getByTestId("item-form-submit-button").click();
	await expect(editSheet).toBeHidden();

	await expect(itemRow(page, editedTitle)).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});
	await expect(itemRow(page, item.title)).toHaveCount(0);
	await expect(
		detailRow(pane, uiText("vaults_detail_items_detail_login_field_username")),
	).toContainText(editedUsername);

	await openItemMenu(page);
	await page.getByTestId("item-delete-button").click();
	await expect(page.getByTestId("delete-item-dialog")).toBeVisible();
	await page.getByTestId("delete-item-confirm-button").click();

	await expect(
		toastWithText(page, uiText("vaults_detail_toast_item_moved_to_trash")),
	).toBeVisible();
	await expect(itemRow(page, editedTitle)).toHaveCount(0);
	await expect(pane).not.toHaveAttribute("data-item-id", itemId);
});

test("a secure note is created, edited, and moved to trash", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);
	await createVault(page, `Notes ${nanoid(6)}`);

	const note = generateTestSecureNote();
	await createItem(page, "secure-note", async (sheet) => {
		await sheet.locator("#title").fill(note.title);
		await sheet.locator("#note").fill(note.note);
	});

	const pane = page.getByTestId("item-detail-pane");
	await expect(pane.getByRole("heading", { name: note.title })).toBeVisible();
	// The note body is rendered verbatim in a <pre>, newlines included.
	await expect(pane.locator("pre")).toHaveText(note.note);

	const editedNote = `${note.note}\nAppended by the edit.`;
	await page.getByTestId("item-edit-button").click();
	const editSheet = page.getByTestId("edit-item-dialog");
	await expect(editSheet).toBeVisible();
	await editSheet.locator("#note").fill(editedNote);
	await editSheet.getByTestId("item-form-submit-button").click();
	await expect(editSheet).toBeHidden();
	await expect(pane.locator("pre")).toHaveText(editedNote, {
		timeout: VAULT_READY_TIMEOUT_MS,
	});

	await openItemMenu(page);
	await page.getByTestId("item-delete-button").click();
	await page.getByTestId("delete-item-confirm-button").click();
	await expect(itemRow(page, note.title)).toHaveCount(0);
});

test("a credit card is created, its number revealed, edited, and moved to trash", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);
	await createVault(page, `Cards ${nanoid(6)}`);

	const card = generateTestCreditCard();
	await createItem(page, "credit-card", async (sheet) => {
		await sheet.locator("#title").fill(card.title);
		await sheet.locator("#cardholderName").fill(card.cardholderName);
		await sheet.locator("#cardNumber").fill(card.cardNumber);
		await sheet.locator("#expiryDate").fill(card.expiryDate);
		await sheet.locator("#cvv").fill(card.cvv);
	});

	const pane = page.getByTestId("item-detail-pane");
	await expect(pane.getByRole("heading", { name: card.title })).toBeVisible();
	await expect(
		detailRow(
			pane,
			uiText("vaults_detail_items_detail_credit_card_field_cardholder_name"),
		),
	).toContainText(card.cardholderName);
	await expect(
		detailRow(
			pane,
			uiText("vaults_detail_items_detail_credit_card_field_expiry_date"),
		),
	).toContainText(card.expiryDate);

	const numberRow = detailRow(
		pane,
		uiText("vaults_detail_items_detail_credit_card_field_card_number"),
	);
	await expect(numberRow).not.toContainText(card.cardNumber);
	await revealValue(numberRow);
	await expect(numberRow).toContainText(card.cardNumber);

	const editedCardholder = `${card.cardholderName} II`;
	await page.getByTestId("item-edit-button").click();
	const editSheet = page.getByTestId("edit-item-dialog");
	await expect(editSheet).toBeVisible();
	await editSheet.locator("#cardholderName").fill(editedCardholder);
	await editSheet.getByTestId("item-form-submit-button").click();
	await expect(editSheet).toBeHidden();
	await expect(
		detailRow(
			pane,
			uiText("vaults_detail_items_detail_credit_card_field_cardholder_name"),
		),
	).toContainText(editedCardholder, { timeout: VAULT_READY_TIMEOUT_MS });

	await openItemMenu(page);
	await page.getByTestId("item-delete-button").click();
	await page.getByTestId("delete-item-confirm-button").click();
	await expect(itemRow(page, card.title)).toHaveCount(0);
});

test("an identity is created, edited, and moved to trash", async ({ page }) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);
	await createVault(page, `Identities ${nanoid(6)}`);

	const suffix = nanoid(6);
	const title = `Test Identity ${suffix}`;
	const email = `identity-${suffix}@test.bittery.com`;
	await createItem(page, "identity", async (sheet) => {
		await sheet.locator("#title").fill(title);
		await sheet.locator("#firstName").fill("Ada");
		await sheet.locator("#lastName").fill("Lovelace");
		await sheet.locator("#email").fill(email);
	});

	const pane = page.getByTestId("item-detail-pane");
	await expect(pane.getByRole("heading", { name: title })).toBeVisible();
	await expect(
		detailRow(
			pane,
			uiText("vaults_detail_items_form_identity_field_first_name"),
		),
	).toContainText("Ada");
	await expect(
		detailRow(pane, uiText("vaults_detail_items_form_identity_field_email")),
	).toContainText(email);

	await page.getByTestId("item-edit-button").click();
	const editSheet = page.getByTestId("edit-item-dialog");
	await expect(editSheet).toBeVisible();
	await editSheet.locator("#lastName").fill("Byron");
	await editSheet.getByTestId("item-form-submit-button").click();
	await expect(editSheet).toBeHidden();
	await expect(
		detailRow(
			pane,
			uiText("vaults_detail_items_form_identity_field_last_name"),
		),
	).toContainText("Byron", { timeout: VAULT_READY_TIMEOUT_MS });

	await openItemMenu(page);
	await page.getByTestId("item-delete-button").click();
	await page.getByTestId("delete-item-confirm-button").click();
	await expect(itemRow(page, title)).toHaveCount(0);
});

test("an authenticator is created from a setup key, edited, and moved to trash", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);
	await createVault(page, `Authenticators ${nanoid(6)}`);

	const title = `Test Authenticator ${nanoid(6)}`;
	await createItem(page, "totp", async (sheet) => {
		// The category opens on an import screen; typing a key is behind this.
		await sheet
			.getByRole("button", {
				name: uiText(
					"vaults_detail_items_form_totp_action_enter_setup_key_manually",
				),
			})
			.click();
		await sheet.locator("#title").fill(title);
		await sheet.locator("#totpSecret").fill(TOTP_SECRET);
		await sheet.locator("#totpIssuer").fill("Test Issuer");
	});

	const pane = page.getByTestId("item-detail-pane");
	await expect(pane.getByRole("heading", { name: title })).toBeVisible();
	await expect(pane.getByText("Test Issuer")).toBeVisible();
	// The stored secret is concealed until revealed, exactly like a password.
	const secretRow = detailRow(
		pane,
		uiText("vaults_detail_items_copy_label_secret_key"),
	);
	await expect(secretRow).not.toContainText(TOTP_SECRET);
	await revealValue(secretRow);
	await expect(secretRow).toContainText(TOTP_SECRET);

	await page.getByTestId("item-edit-button").click();
	const editSheet = page.getByTestId("edit-item-dialog");
	await expect(editSheet).toBeVisible();
	await editSheet.locator("#totpIssuer").fill("Edited Issuer");
	await editSheet.getByTestId("item-form-submit-button").click();
	await expect(editSheet).toBeHidden();
	await expect(pane.getByText("Edited Issuer")).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});

	await openItemMenu(page);
	await page.getByTestId("item-delete-button").click();
	await page.getByTestId("delete-item-confirm-button").click();
	await expect(itemRow(page, title)).toHaveCount(0);
});

test("changing a login's password records the old one in history, and restoring it puts it back", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);
	await createVault(page, `History ${nanoid(6)}`);

	const item = generateTestLoginItem();
	const secondPassword = `${item.password}-second`;
	await createItem(page, "login", async (sheet) => {
		await sheet.locator("#title").fill(item.title);
		await sheet.locator("#password").fill(item.password);
	});

	const pane = page.getByTestId("item-detail-pane");
	const passwordRow = detailRow(
		pane,
		uiText("vaults_detail_items_detail_login_field_password"),
	);

	await openItemMenu(page);
	await page
		.getByRole("menuitem", {
			name: uiText("vaults_detail_items_password_history_dialog_title"),
		})
		.click();
	const historyDialog = page.getByRole("dialog", {
		name: uiText("vaults_detail_items_password_history_dialog_title"),
	});
	await expect(historyDialog).toBeVisible();
	await expect(
		historyDialog.getByText(
			uiText("vaults_detail_items_password_history_dialog_empty"),
		),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(historyDialog).toBeHidden();

	await page.getByTestId("item-edit-button").click();
	const editSheet = page.getByTestId("edit-item-dialog");
	await expect(editSheet).toBeVisible();
	await editSheet.locator("#password").fill(secondPassword);
	await editSheet.getByTestId("item-form-submit-button").click();
	await expect(editSheet).toBeHidden();
	await revealValue(passwordRow);
	await expect(passwordRow).toContainText(secondPassword, {
		timeout: VAULT_READY_TIMEOUT_MS,
	});

	await openItemMenu(page);
	await page
		.getByRole("menuitem", {
			name: uiText("vaults_detail_items_password_history_dialog_title"),
		})
		.click();
	await expect(historyDialog).toBeVisible();
	const restore = historyDialog.getByRole("button", {
		name: uiText("vaults_detail_items_password_history_dialog_action_restore"),
	});
	await expect(restore).toHaveCount(1);
	await restore.click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", {
			name: uiText(
				"vaults_detail_items_password_history_dialog_restore_dialog_action_restore",
			),
		})
		.click();

	await expect(
		toastWithText(
			page,
			uiText(
				"vaults_detail_items_password_history_dialog_toast_restore_success",
			),
		),
	).toBeVisible();

	// Reload so the password field starts concealed again: the restore left the
	// detail pane's reveal toggle flipped on.
	await page.reload();
	await expect(pane).toHaveAttribute("data-item-id", /.+/, {
		timeout: VAULT_READY_TIMEOUT_MS,
	});
	await revealValue(passwordRow);
	await expect(passwordRow).toContainText(item.password);
});

test("a login can be starred, its password revealed, and its password copied to the clipboard", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);
	await createVault(page, `Actions ${nanoid(6)}`);

	const item = generateTestLoginItem();
	await createItem(page, "login", async (sheet) => {
		await sheet.locator("#title").fill(item.title);
		await sheet.locator("#username").fill(item.username);
		await sheet.locator("#password").fill(item.password);
	});

	const pane = page.getByTestId("item-detail-pane");
	const passwordRow = detailRow(
		pane,
		uiText("vaults_detail_items_detail_login_field_password"),
	);

	await expect(
		page.getByText(
			uiText("vaults_detail_items_list_section_favorites", { count: 1 }),
		),
	).toHaveCount(0);
	await openItemMenu(page);
	const star = page.getByTestId("item-favorite-button");
	await expect(star).toHaveText(
		uiText("vaults_detail_items_list_item_action_add_favorite"),
	);
	await star.click();
	// Starring raises no toast on web, so the list's Favorites section is the
	// only feedback there is.
	await expect(
		page.getByText(
			uiText("vaults_detail_items_list_section_favorites", { count: 1 }),
		),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	await openItemMenu(page);
	await expect(star).toHaveText(
		uiText("vaults_detail_items_list_item_action_remove_favorite"),
	);
	await page.keyboard.press("Escape");

	await expect(passwordRow).not.toContainText(item.password);
	await revealValue(passwordRow);
	await expect(passwordRow).toContainText(item.password);

	await passwordRow.locator("button:has(svg.lucide-copy)").click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(item.password);
});
