import {
	expect,
	generateTestLoginItem,
	signIn,
	signOut,
	signUp,
	test,
} from "../fixtures/auth";
import { itemRow } from "../fixtures/vault";

/**
 * Proves the harness end to end: a fresh database, the dev mail outbox, real
 * WASM key generation, SRP sign-in and item decryption after a full sign-out.
 * If this fails, no other spec is trustworthy.
 */
test("signup, vault, item, sign out, full sign-in", async ({
	page,
	testUser,
}) => {
	// Two SRP handshakes plus WASM key generation live inside one test here.
	test.setTimeout(240000);

	const user = await signUp(page, testUser);
	expect(user.secretKey).toMatch(/^A3-/);

	await page.goto("/vaults");

	const newVaultButton = page.getByTestId("new-vault-button");
	await expect(newVaultButton).toBeVisible({ timeout: 30000 });
	await newVaultButton.click();

	const createVaultDialog = page.getByTestId("create-vault-dialog");
	await expect(createVaultDialog).toBeVisible();
	const vaultName = `Smoke Vault ${Date.now()}`;
	await createVaultDialog.locator("#name").fill(vaultName);
	await page.getByTestId("create-vault-submit-button").click();
	await expect(createVaultDialog).toBeHidden();
	await page.waitForURL(/\/vaults\/[^/?]+/);

	const item = generateTestLoginItem();
	await page.getByTestId("new-item-button").click();
	const createItemSheet = page.getByTestId("create-item-sheet");
	await expect(createItemSheet).toBeVisible();
	await page.getByTestId("item-category-login").click();
	await createItemSheet.locator("#title").fill(item.title);
	await createItemSheet.locator("#username").fill(item.username);
	await createItemSheet.locator("#password").fill(item.password);
	await createItemSheet.locator("#url").fill(item.url);
	await page.getByTestId("item-form-submit-button").click();
	await expect(createItemSheet).toBeHidden();

	const row = itemRow(page, item.title);
	await expect(row).toBeVisible({ timeout: 30000 });

	await signOut(page);
	await signIn(page, user);

	await page.goto("/vaults");
	await expect(row).toBeVisible({ timeout: 30000 });
});
