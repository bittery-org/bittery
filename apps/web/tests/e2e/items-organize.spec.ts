import type { Locator, Page } from "@playwright/test";
import { nanoid } from "nanoid";
import {
	expect,
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
	cssAttributeValue,
	itemRow,
	itemRowTitles,
	openItem,
	openItemMenu,
	openVault,
	toastWithText,
	VAULT_READY_TIMEOUT_MS,
	vaultNavLink,
} from "../fixtures/vault";

/**
 * Finding items again once a vault has more than one: search, the category
 * filter, sorting, tags, favorites, the trash round trip, and moving an item to
 * another vault through both affordances the product offers.
 *
 * One signup for the whole file, on a throwaway context. Every test signs that
 * account back in on a fresh context and seeds its own vault, so one test's
 * items can never satisfy another's assertion.
 */

/** One SRP handshake, a vault, up to three items, and their assertions. */
const TEST_BUDGET_MS = 180000;

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

/** The list's search box lives behind a popover trigger. */
async function openSearch(page: Page): Promise<Locator> {
	await page
		.getByRole("button", {
			name: uiText("vaults_detail_items_list_search_toggle"),
		})
		.click();
	const input = page.getByPlaceholder(
		uiText("vaults_detail_items_list_search_placeholder"),
	);
	await expect(input).toBeVisible();
	return input;
}

/** Pick a sort field and direction from the list's sort menu. */
async function sortBy(
	page: Page,
	fieldLabel: string,
	directionLabel: string,
): Promise<void> {
	const trigger = page.getByRole("button", {
		name: uiText("vaults_detail_items_list_sort_toggle"),
	});
	await trigger.click();
	await page.getByRole("menuitemradio", { name: fieldLabel }).click();
	await trigger.click();
	await page.getByRole("menuitemradio", { name: directionLabel }).click();
}

/** Create a login whose only interesting property is its title. */
function seedLogin(page: Page, title: string): Promise<string> {
	return createItem(page, "login", async (sheet) => {
		await sheet.locator("#title").fill(title);
		await sheet.locator("#username").fill(`user-${title}`);
	});
}

test("search narrows the list to matching items and says so when nothing matches", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);
	await createVault(page, `Search ${nanoid(6)}`);

	const suffix = nanoid(6);
	const alpha = `Alpha ${suffix}`;
	const beta = `Beta ${suffix}`;
	await seedLogin(page, alpha);
	await createItem(page, "secure-note", async (sheet) => {
		await sheet.locator("#title").fill(beta);
		await sheet.locator("#note").fill("nothing to see here");
	});
	await expect(page.getByTestId("item-row")).toHaveCount(2);

	const search = await openSearch(page);
	await search.fill("Alpha");
	await expect(itemRow(page, alpha)).toBeVisible();
	await expect(itemRow(page, beta)).toHaveCount(0);

	await search.fill("no-such-item");
	await expect(page.getByTestId("item-row")).toHaveCount(0);
	await expect(
		page.getByText(uiText("vaults_detail_items_list_empty_filtered_title")),
	).toBeVisible();

	await search.fill("");
	await expect(page.getByTestId("item-row")).toHaveCount(2);
});

test("the category filter shows one category at a time", async ({ page }) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);
	await createVault(page, `Categories ${nanoid(6)}`);

	const suffix = nanoid(6);
	const login = `Login ${suffix}`;
	const note = `Note ${suffix}`;
	await seedLogin(page, login);
	await createItem(page, "secure-note", async (sheet) => {
		await sheet.locator("#title").fill(note);
		await sheet.locator("#note").fill("filtered away");
	});

	const filter = page.getByRole("combobox");
	await expect(filter).toHaveText(
		uiText("vaults_detail_items_list_filter_category_all"),
	);

	await filter.click();
	await page
		.getByRole("option", {
			name: uiText("vaults_detail_items_list_filter_category_secure_notes"),
		})
		.click();
	await expect(itemRow(page, note)).toBeVisible();
	await expect(itemRow(page, login)).toHaveCount(0);

	await filter.click();
	await page
		.getByRole("option", {
			name: uiText("vaults_detail_items_list_filter_category_logins"),
		})
		.click();
	await expect(itemRow(page, login)).toBeVisible();
	await expect(itemRow(page, note)).toHaveCount(0);

	await filter.click();
	await page
		.getByRole("option", {
			name: uiText("vaults_detail_items_list_filter_category_all"),
		})
		.click();
	await expect(page.getByTestId("item-row")).toHaveCount(2);
});

test("sorting by title reorders the list, and the direction reverses it", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);
	await createVault(page, `Sorting ${nanoid(6)}`);

	const suffix = nanoid(6);
	const zulu = `Zulu ${suffix}`;
	const alpha = `Alpha ${suffix}`;
	const mike = `Mike ${suffix}`;
	// Creation order is deliberately not alphabetical: the default sort is most
	// recently updated first, so this is what "sorted by title" has to change.
	await seedLogin(page, zulu);
	await seedLogin(page, alpha);
	await seedLogin(page, mike);
	await expect.poll(() => itemRowTitles(page)).toEqual([mike, alpha, zulu]);

	await sortBy(
		page,
		uiText("vaults_detail_items_list_sort_field_title"),
		uiText("vaults_detail_items_list_sort_direction_asc"),
	);
	await expect.poll(() => itemRowTitles(page)).toEqual([alpha, mike, zulu]);

	await sortBy(
		page,
		uiText("vaults_detail_items_list_sort_field_title"),
		uiText("vaults_detail_items_list_sort_direction_desc"),
	);
	await expect.poll(() => itemRowTitles(page)).toEqual([zulu, mike, alpha]);
});

test("tagging an item adds a sidebar tag that lists only the tagged items", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);
	await createVault(page, `Tags ${nanoid(6)}`);

	const suffix = nanoid(6);
	const tagged = `Tagged ${suffix}`;
	const untagged = `Untagged ${suffix}`;
	const tagName = `tag-${suffix}`;
	await seedLogin(page, untagged);
	await seedLogin(page, tagged);

	const pane = page.getByTestId("item-detail-pane");
	await pane
		.getByRole("button", {
			name: uiText("vaults_detail_items_tag_input_button_default"),
		})
		.click();
	await page
		.getByPlaceholder(
			uiText("vaults_detail_items_tag_input_search_placeholder"),
		)
		.fill(tagName);
	await page
		.getByRole("option", {
			name: uiText("vaults_detail_items_tag_input_action_create", {
				tag: tagName,
			}),
		})
		.click();
	await expect(pane.getByText(tagName)).toBeVisible();

	const tagLink = page.locator(
		`[data-testid="tag-filter"][data-tag-name="${cssAttributeValue(tagName)}"]`,
	);
	await expect(tagLink).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	await tagLink.click();

	await page.waitForURL(`**/vaults/tag/${tagName}**`);
	await expect(itemRow(page, tagged)).toBeVisible();
	await expect(itemRow(page, untagged)).toHaveCount(0);
});

test("starring an item lists it under Favorites, and unstarring empties that list", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);
	await createVault(page, `Favorites ${nanoid(6)}`);

	const suffix = nanoid(6);
	const starred = `Starred ${suffix}`;
	const plain = `Plain ${suffix}`;
	await seedLogin(page, plain);
	await seedLogin(page, starred);

	await openItemMenu(page);
	await page.getByTestId("item-favorite-button").click();
	await expect(
		page.getByText(
			uiText("vaults_detail_items_list_section_favorites", { count: 1 }),
		),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });

	await page.goto("/vaults/favorites");
	await expect(itemRow(page, starred)).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});
	await expect(itemRow(page, plain)).toHaveCount(0);

	await openItem(page, starred);
	await openItemMenu(page);
	await page.getByTestId("item-favorite-button").click();
	await expect(itemRow(page, starred)).toHaveCount(0, {
		timeout: VAULT_READY_TIMEOUT_MS,
	});
});

test("a trashed item can be restored, and deleting it forever removes it for good", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);
	const vaultId = await createVault(page, `Trash ${nanoid(6)}`);

	const title = `Trashed ${nanoid(6)}`;
	const itemId = await seedLogin(page, title);

	await openItemMenu(page);
	await page.getByTestId("item-delete-button").click();
	await page.getByTestId("delete-item-confirm-button").click();
	await expect(itemRow(page, title)).toHaveCount(0);

	await page.goto("/vaults/trash");
	const restore = page.locator(
		`[data-testid="trash-restore-button"][data-item-id="${itemId}"]`,
	);
	await expect(restore).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	await restore.click();
	await expect(
		toastWithText(page, uiText("vaults_trash_toast_restore_success")),
	).toBeVisible();
	await expect(restore).toHaveCount(0);

	await openVault(page, vaultId);
	await expect(itemRow(page, title)).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});

	await openItem(page, title);
	await openItemMenu(page);
	await page.getByTestId("item-delete-button").click();
	await page.getByTestId("delete-item-confirm-button").click();
	// Wait for the trashing to land: navigating on the click alone races the
	// mutation, and Trash then renders its empty state.
	await expect(
		toastWithText(page, uiText("vaults_detail_toast_item_moved_to_trash")),
	).toBeVisible();

	await page.goto("/vaults/trash");
	const deleteForever = page.locator(
		`[data-testid="trash-delete-forever-button"][data-item-id="${itemId}"]`,
	);
	await expect(deleteForever).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	await deleteForever.click();
	// The testid marks the trigger; the destructive step is a second dialog.
	await page
		.getByRole("dialog")
		.getByRole("button", {
			name: uiText("vaults_trash_delete_dialog_action_confirm"),
		})
		.click();
	await expect(
		toastWithText(page, uiText("vaults_trash_toast_permanent_delete_success")),
	).toBeVisible();
	await expect(deleteForever).toHaveCount(0);

	await openVault(page, vaultId);
	await expect(itemRow(page, title)).toHaveCount(0);
});

test("an item moves to another vault through the detail menu", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);
	const targetName = `Move target ${nanoid(6)}`;
	const targetVaultId = await createVault(page, targetName);
	const sourceVaultId = await createVault(page, `Move source ${nanoid(6)}`);

	const title = `Moving ${nanoid(6)}`;
	await seedLogin(page, title);

	await openItemMenu(page);
	await page.getByTestId("item-move-button").click();
	const moveDialog = page.getByRole("dialog", {
		name: uiText("vaults_detail_items_move_dialog_title", { title }),
	});
	await expect(moveDialog).toBeVisible();
	await moveDialog.getByRole("option", { name: targetName }).click();
	await moveDialog
		.getByRole("button", {
			name: uiText("vaults_detail_items_move_dialog_action_move"),
			exact: true,
		})
		.click();

	await expect(
		toastWithText(
			page,
			uiText("vaults_detail_items_move_dialog_toast_success"),
		),
	).toBeVisible();
	await page.waitForURL(`**/vaults/${targetVaultId}**`);
	await expect(itemRow(page, title)).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});

	await openVault(page, sourceVaultId);
	await expect(itemRow(page, title)).toHaveCount(0);
});

test("an item moves to another vault when dragged onto it in the sidebar", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);
	const targetVaultId = await createVault(page, `Drop target ${nanoid(6)}`);
	const sourceVaultId = await createVault(page, `Drag source ${nanoid(6)}`);

	const title = `Dragged ${nanoid(6)}`;
	await seedLogin(page, title);

	// @dnd-kit listens for pointer events on the row's drag wrapper, which is the
	// parent of the row button, and its sensor only starts a drag after 8px of
	// movement - so Playwright's dragTo() (one move, on the wrong element) never
	// picks the item up.
	const dragHandle = itemRow(page, title).locator("xpath=..");
	const dropTarget = vaultNavLink(page, targetVaultId);
	await dropTarget.scrollIntoViewIfNeeded();
	const from = await dragHandle.boundingBox();
	const to = await dropTarget.boundingBox();
	if (!from || !to) {
		throw new Error("The drag source or the drop target is not on screen.");
	}

	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(
		from.x + from.width / 2,
		from.y + from.height / 2 + 20,
		{
			steps: 5,
		},
	);
	await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
		steps: 20,
	});
	await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2);
	await page.mouse.up();

	await expect(
		toastWithText(page, uiText("vaults_dnd_move_success")),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	await page.waitForURL(`**/vaults/${targetVaultId}**`);
	await expect(itemRow(page, title)).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});

	await openVault(page, sourceVaultId);
	await expect(itemRow(page, title)).toHaveCount(0);
});
