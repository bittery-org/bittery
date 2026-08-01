/**
 * E2E Tests for moving a vault item to another vault in the web app.
 */

import type { Page } from "@playwright/test";
import {
	waitForVaultDetailReady,
	waitForVaultsPageReady,
} from "../fixtures/network-helpers";
import {
	BitteryPage,
	expect,
	generateTestUser,
	test,
} from "../fixtures/test-fixtures";

async function createVaultFromVaultsPage(page: Page, name: string) {
	await page.goto("/vaults");
	await waitForVaultsPageReady(page);
	await page.getByTestId("new-vault-button").click();
	await expect(page.getByTestId("create-vault-dialog")).toBeVisible();
	await page.getByPlaceholder("Enter vault name").fill(name);
	await page.getByTestId("create-vault-submit-button").click();
	await expect(page).toHaveURL(/.*\/vaults\/.+/);
}

async function createLoginItem(page: Page, title: string) {
	await page.getByTestId("new-item-button").click();
	await expect(page.getByTestId("create-item-sheet")).toBeVisible();
	await page.getByTestId("item-category-login").click();
	await page.getByLabel("Title *").fill(title);
	await page.getByLabel("Username").fill("e2e-user");
	await page.getByLabel("Password").fill("e2e-password");
	await page.getByTestId("item-form-submit-button").click();
	await expect(page.getByText(title).first()).toBeVisible();
}

/** dnd-kit's PointerSensor needs real pointer events and >8px of travel. */
async function dragItemOntoVault(
	page: Page,
	itemTitle: string,
	vaultName: string,
) {
	const source = page
		.getByRole("button", { name: `Select ${itemTitle}` })
		.first();
	const target = page
		.getByRole("link", { name: vaultName, exact: false })
		.first();

	const sourceBox = await source.boundingBox();
	const targetBox = await target.boundingBox();
	if (!sourceBox || !targetBox) {
		throw new Error("drag source or drop target is not rendered");
	}

	const from = {
		x: sourceBox.x + sourceBox.width / 2,
		y: sourceBox.y + sourceBox.height / 2,
	};
	const to = {
		x: targetBox.x + targetBox.width / 2,
		y: targetBox.y + targetBox.height / 2,
	};

	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	for (let step = 1; step <= 12; step++) {
		await page.mouse.move(
			from.x + ((to.x - from.x) * step) / 12,
			from.y + ((to.y - from.y) * step) / 12,
		);
	}
	await page.mouse.move(to.x, to.y);
	await page.mouse.up();
}

test.describe("Move item between vaults", () => {
	let secretKey: string;
	let testUser: ReturnType<typeof generateTestUser>;

	test.beforeAll(async ({ browser }) => {
		testUser = generateTestUser();
		const context = await browser.newContext();
		const page = await context.newPage();
		const bitteryPage = new BitteryPage(page);
		secretKey = await bitteryPage.completeSignup(testUser);
		await context.close();
	});

	test.beforeEach(async ({ page }) => {
		const bitteryPage = new BitteryPage(page);
		testUser.secretKey = secretKey;
		await bitteryPage.login(
			testUser.email,
			testUser.password,
			testUser.secretKey,
		);
	});

	test("moves an item to another vault by dragging it onto the sidebar", async ({
		page,
	}) => {
		const sourceVault = `Move Source ${Date.now()}`;
		const targetVault = `Move Target ${Date.now()}`;
		const itemName = `Movable Item ${Date.now()}`;

		await createVaultFromVaultsPage(page, targetVault);
		await createVaultFromVaultsPage(page, sourceVault);
		await waitForVaultDetailReady(page);

		const sourceVaultUrl = page.url();
		await createLoginItem(page, itemName);

		await dragItemOntoVault(page, itemName, targetVault);

		await expect(
			page.locator("[data-sonner-toast]").filter({ hasText: "Failed to move" }),
		).toHaveCount(0);

		await expect(page).not.toHaveURL(sourceVaultUrl);
		await expect(page.getByText(itemName).first()).toBeVisible();

		await page.goto(sourceVaultUrl);
		await waitForVaultDetailReady(page);
		await expect(page.getByText(itemName)).toHaveCount(0);
	});
});
