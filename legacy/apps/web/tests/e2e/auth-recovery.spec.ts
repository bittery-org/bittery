import {
	expect,
	generateTestUser,
	readSecretKey,
	signIn,
	signOut,
	signUp,
	type TestUser,
	test,
	waitForAppReady,
} from "../fixtures/auth";
import { mailOutboxNow, waitForCode } from "../fixtures/mail-outbox";
import { uiText } from "../fixtures/messages";

/**
 * Account recovery end to end: regenerate the Recovery Key in Settings, sign
 * out, reset the master password through `/recover` with the emailed code, and
 * sign in on a clean device with the credentials that came out of it.
 *
 * Serial, because each test consumes what the previous one produced - and one
 * signup for the file, since key generation is far too expensive to repeat.
 */
test.describe.configure({ mode: "serial" });

/** Vite's first paint of a route on a cold dev server. */
const COLD_START_MS = 60000;

/** One SRP handshake or one master-key re-derivation. */
const KEY_WORK_MS = 120000;

let user: TestUser;
/** The Recovery Key Settings hands out, which `/recover` then has to accept. */
let recoveryKey: string;
/** Email plus the password and Secret Key that recovery replaced them with. */
let recoveredUser: TestUser;

test.beforeAll(async ({ browser }) => {
	test.setTimeout(300000);
	const context = await browser.newContext();
	try {
		user = await signUp(await context.newPage(), generateTestUser());
	} finally {
		await context.close();
	}
});

test("Settings regenerates the Recovery Key and shows it once", async ({
	page,
}) => {
	test.setTimeout(KEY_WORK_MS * 2);

	await signIn(page, user);
	await page.goto("/settings");

	const securityTab = page.getByTestId("settings-tab-security");
	await expect(securityTab).toBeVisible({ timeout: COLD_START_MS });
	await securityTab.click();

	await page
		.getByRole("button", {
			name: uiText("settings_recovery_key_regenerate_trigger"),
		})
		.click();

	const dialog = page.getByTestId("regenerate-recovery-key-dialog");
	await expect(dialog).toBeVisible();
	// Regeneration re-derives the master key, so it has to prove the password.
	await dialog.locator("#regenRecoveryPassword").fill(user.password);
	await dialog.locator('button[type="submit"]').click();

	const keyValue = page.getByTestId("recovery-key-value");
	await expect(keyValue).toBeVisible({ timeout: KEY_WORK_MS });
	recoveryKey = (await keyValue.innerText()).trim();
	expect(recoveryKey).toMatch(/^R1-/);

	// The new key is only stored once the user confirms they wrote it down.
	const confirm = dialog.locator('[data-slot="dialog-footer"] button').last();
	await expect(confirm).toBeDisabled();
	await dialog.locator('input[type="checkbox"]').check();
	await expect(confirm).toBeEnabled();
	await confirm.click();
	await expect(dialog).toBeHidden({ timeout: KEY_WORK_MS });

	await signOut(page);
});

test("the 5-step /recover flow resets the password and issues a new Secret Key", async ({
	page,
}) => {
	test.setTimeout(420000);

	const newPassword = `${user.password}-Recovered1!`;
	const since = mailOutboxNow();

	await page.goto("/recover");

	// Step 1 - email. Every step renders exactly one form with one submit.
	const submit = page.locator('form button[type="submit"]');
	await expect(page.locator("#email")).toBeVisible({ timeout: COLD_START_MS });
	await page.locator("#email").fill(user.email);
	await submit.click();

	// Step 2 - the emailed recovery code.
	const codeInput = page.locator("#code");
	await expect(codeInput).toBeVisible({ timeout: COLD_START_MS });
	const code = await waitForCode({
		purpose: "recovery",
		email: user.email,
		since,
	});
	await codeInput.fill(code);
	await submit.click();

	// Step 3 - the Recovery Key Settings handed out in the previous test.
	const recoveryKeyInput = page.locator("#recoveryKey");
	await expect(recoveryKeyInput).toBeVisible({ timeout: COLD_START_MS });
	await recoveryKeyInput.fill(recoveryKey);
	await submit.click();

	// Step 4 - the new master password.
	await expect(page.locator("#newPassword")).toBeVisible();
	await page.locator("#newPassword").fill(newPassword);
	await page.locator("#confirmPassword").fill(newPassword);
	await submit.click();

	// Step 5 - the new Secret Key. Resetting the password mints a fresh one, so
	// the Emergency Kit from signup is now stale.
	await expect(page.locator("#newPassword")).toHaveCount(0, {
		timeout: 240000,
	});
	const newSecretKey = await readSecretKey(page);
	expect(newSecretKey).toMatch(/^A3-/);
	expect(newSecretKey).not.toBe(user.secretKey);
	await expect(page.getByText(newSecretKey)).toBeVisible();

	// The kit gate again: no way past this screen without saving the new key.
	const continueToVault = page.getByRole("button", {
		name: uiText("auth_recover_button_continue_to_vault"),
	});
	await expect(continueToVault).toBeDisabled();
	const [download] = await Promise.all([
		page.waitForEvent("download"),
		page
			.getByRole("button", { name: uiText("auth_recover_button_download_kit") })
			.click(),
	]);
	expect(download.suggestedFilename()).toMatch(
		/^bittery-emergency-kit\.(pdf|txt)$/,
	);
	await expect(continueToVault).toBeEnabled();

	await continueToVault.click();
	await page.waitForURL("**/home", { timeout: COLD_START_MS });
	await waitForAppReady(page);

	recoveredUser = { ...user, password: newPassword, secretKey: newSecretKey };
});

test("the recovered credentials sign in on a clean device and the vault is still readable", async ({
	page,
}) => {
	test.setTimeout(KEY_WORK_MS + COLD_START_MS);

	await signIn(page, recoveredUser);

	// Recovery re-wrapped the vault keys under the new master unlock key; if it
	// had not, the personal vault would be unreadable here.
	await page.goto("/vaults");
	await expect(page.getByTestId("vault-nav-link").first()).toBeVisible({
		timeout: COLD_START_MS,
	});
});
