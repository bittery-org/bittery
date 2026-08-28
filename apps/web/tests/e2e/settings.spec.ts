import type { Page } from "@playwright/test";
import { nanoid } from "nanoid";
import {
	expect,
	generateTestUser,
	readSecretKey,
	signIn,
	signUp,
	type TestUser,
	test,
	waitForAppReady,
} from "../fixtures/auth";
import { uiText, uiTextIn } from "../fixtures/messages";
import {
	gotoRoute,
	toastWithText,
	VAULT_READY_TIMEOUT_MS,
} from "../fixtures/vault";

/**
 * `/settings` end to end: the profile it shows, the devices it manages, the
 * preferences it stores locally, and the four credential operations that each
 * end in a full sign-in - email, master password, Secret Key and deletion.
 *
 * ONE signup for the whole file, in `beforeAll` on a throwaway context. Every
 * test after it pays only for a sign-in, which is the cheaper half of the
 * crypto (one SRP handshake instead of a handshake plus RSA keygen).
 *
 * The order below is not cosmetic, and moving a test breaks the one after it:
 *
 *  - Each credential change rewrites `user`, so the tests that change email,
 *    password and Secret Key have to run in that order and every later test
 *    signs in with what the previous one left behind.
 *  - Changing the email, the password or the Secret Key all clear the account's
 *    Recovery Key server-side, so the "Recovery Key is configured" assertion has
 *    to come before any of them - after one of them the Security tab renders
 *    `SetupRecoveryKeyDialog` instead.
 *  - Regenerating the Secret Key signs every *other* session out, so the device
 *    test has to come before it.
 *  - Deleting the account destroys it, so it is last.
 *
 * Every test uses the `page` fixture, which is a fresh browser context: a
 * context that already holds this account renders the one-field quick-unlock
 * form, which has no Secret Key input at all.
 */

/** One SRP sign-in plus the page's own work. */
const TEST_BUDGET_MS = 180000;

/**
 * A sign-in, a client-side re-encryption of every vault key, and a second
 * sign-in with the new credential.
 */
const CREDENTIAL_CHANGE_BUDGET_MS = 300000;

const RUNTIME_STORAGE_PREFIX = "bittery:runtime:platform-storage:";
const TRANSITIONAL_CREDENTIAL_SUFFIXES = [
	"session_data",
	"jwt_token",
	"vault_keys",
	"encrypted_private_key",
	"secret_key",
	"pinned_kdf_params",
	"last_biometric_auth",
].map((name) => `_${name}`);

/** Rewritten in place by each credential test; later tests sign in with it. */
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

/** Open `/settings` and wait for the tab strip, which the header renders last. */
async function openSettings(page: Page): Promise<void> {
	const ready = page.getByTestId("settings-tab-account");
	const liveSettingsLink = page.locator('a[href="/settings"]').first();
	if (await liveSettingsLink.isVisible()) {
		// Runtime startup intentionally restores the Account locked. Preserve the
		// live unlock when the preceding Sign-in already rendered an app route.
		await liveSettingsLink.click();
		await expect(ready).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
		return;
	}
	await gotoRoute(page, "/settings", ready);
}

/** Switch to one settings tab and wait for it to become the active one. */
async function openSettingsTab(
	page: Page,
	tab: "account" | "security" | "devices" | "general",
): Promise<void> {
	const trigger = page.getByTestId(`settings-tab-${tab}`);
	await trigger.click();
	await expect(trigger).toHaveAttribute("data-state", "active");
}

/** The accountId every per-account storage key is built from. */
async function activeAccountId(page: Page): Promise<string> {
	const { accountId, runtimeAccountId, webAccountId } = await page.evaluate(
		() => ({
			accountId: localStorage.getItem("bittery_active_account"),
			runtimeAccountId: localStorage.getItem("bittery_runtime_account_id"),
			webAccountId: localStorage.getItem("bittery_web_account_id"),
		}),
	);
	if (!accountId) {
		throw new Error(
			"No active account on this device; the sign-in never finished.",
		);
	}
	if (!webAccountId || !runtimeAccountId || accountId === runtimeAccountId) {
		throw new Error(
			`The signed-in browser must name distinct transitional and Runtime Accounts: active=${accountId}, web=${webAccountId ?? "null"}, runtime=${runtimeAccountId ?? "null"}.`,
		);
	}
	return accountId;
}

/** Retry the existing dialog until its Runtime-led teardown reports success. */
async function finishAccountDeletion(page: Page): Promise<void> {
	const deadline = Date.now() + VAULT_READY_TIMEOUT_MS;
	const retry = page.getByTestId("delete-account-confirm");
	const success = toastWithText(
		page,
		uiText("settings_delete_account_dialog_toast_deleted"),
	);
	// Do not read the still-enabled confirmation button from the render that
	// dispatched the first attempt as an immediate retry.
	await page.waitForTimeout(100);

	while (Date.now() < deadline) {
		if (await success.isVisible()) {
			return;
		}
		if ((await retry.isVisible()) && (await retry.isEnabled())) {
			await retry.click();
		}
		await page.waitForTimeout(100);
	}

	throw new Error(
		"Account deletion did not reach the Runtime's complete teardown outcome before the settings timeout.",
	);
}

/** The Secret Key hint the server keeps: the key's first two segments. */
function secretKeyHint(secretKey: string): string {
	return secretKey.split("-").slice(0, 2).join("-");
}

/** The toast Sonner marks with destructive text; `data-type` is always "default". */
function errorToast(page: Page) {
	return page
		.locator("[data-sonner-toast]")
		.filter({ has: page.locator(".text-destructive") })
		.first();
}

test("the account tab shows the identity signup created, and offers no way to rename it", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);
	await openSettings(page);

	const account = page.getByRole("tabpanel");
	await expect(account.getByText(user.name, { exact: true })).toBeVisible();
	await expect(account.getByText(user.email, { exact: true })).toBeVisible();
	await expect(
		account.getByText(secretKeyHint(user.secretKey), { exact: true }),
	).toBeVisible();

	// The Email card is the only one of the three that carries an action. The
	// Name card is display-only and the server exposes no rename at all - see the
	// gap reported for this step.
	await expect(
		account.getByRole("button", {
			name: uiText("settings_change_email_dialog_trigger"),
		}),
	).toBeVisible();
	const nameCard = account
		.locator("div.rounded-lg")
		.filter({ hasText: uiText("settings_field_name") })
		.first();
	await expect(nameCard.getByRole("button")).toHaveCount(0);
});

test("the devices tab lists every session, renames this one and revokes another", async ({
	page,
	browser,
}) => {
	// Two SRP handshakes: this device, plus the session to revoke.
	test.setTimeout(CREDENTIAL_CHANGE_BUDGET_MS);
	await signIn(page, user);

	const second = await browser.newContext();
	try {
		await openSettings(page);
		await openSettingsTab(page, "devices");

		const rows = page.getByTestId("device-row");
		const current = page.locator(
			'[data-testid="device-row"][data-device-current="true"]',
		);
		const other = page.locator(
			'[data-testid="device-row"][data-device-current="false"]',
		);
		await expect(current).toHaveCount(1, {
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		// The list is the account's session history, and every earlier test in this
		// file left a session behind, so the count is only meaningful as a delta.
		const before = await rows.count();

		await signIn(await second.newPage(), user);
		await gotoRoute(
			page,
			"/settings",
			page.getByTestId("settings-tab-account"),
		);
		await openSettingsTab(page, "devices");
		await expect(rows).toHaveCount(before + 1, {
			timeout: VAULT_READY_TIMEOUT_MS,
		});

		await expect(current).toHaveCount(1);
		await expect(current).toContainText(
			uiText("settings_devices_badge_current"),
		);
		// Only a session that is not this one can be revoked.
		await expect(current.getByTestId("revoke-device-button")).toHaveCount(0);

		// The rename trigger is an unlabelled icon button; the revoke button next to
		// it is the only one in the row that carries a testid.
		const renamed = `E2E Renamed ${nanoid(6)}`;
		await current
			.locator('button:not([data-testid="revoke-device-button"])')
			.click();
		const renameDialog = page.getByRole("dialog", {
			name: uiText("settings_devices_rename_dialog_title"),
		});
		await expect(renameDialog).toBeVisible();
		await renameDialog.locator("#deviceName").fill(renamed);
		await renameDialog
			.getByRole("button", {
				name: uiText("settings_devices_rename_dialog_action_submit"),
			})
			.click();
		await expect(
			toastWithText(page, uiText("settings_devices_toast_rename_success")),
		).toBeVisible();
		await expect(current).toContainText(renamed, {
			timeout: VAULT_READY_TIMEOUT_MS,
		});

		// Revoking is a two-step confirmation: the testid marks the trigger.
		// The list sorts the current session first and the rest by activity, so the
		// first other row is the session the second context just opened.
		const revoked = other.first();
		const revokedId = await revoked.getAttribute("data-device-id");
		await revoked.getByTestId("revoke-device-button").click();
		const confirm = page.getByRole("alertdialog");
		await expect(confirm).toContainText(
			uiText("settings_devices_revoke_dialog_title"),
		);
		await confirm
			.getByRole("button", {
				name: uiText("settings_devices_revoke_dialog_action_submit"),
			})
			.click();
		await expect(
			toastWithText(page, uiText("settings_devices_toast_revoke_success")),
		).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });

		await expect(rows).toHaveCount(before, {
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await expect(
			page.locator(`[data-testid="device-row"][data-device-id="${revokedId}"]`),
		).toHaveCount(0);
	} finally {
		await second.close();
	}
});

test("the general tab switches theme and locale, and both survive a reload", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);
	await openSettings(page);
	await openSettingsTab(page, "general");

	const html = page.locator("html");
	await expect(html).toHaveAttribute("lang", "en");

	await page
		.getByRole("combobox", {
			name: uiText("settings_general_appearance_title"),
		})
		.click();
	await page
		.getByRole("option", { name: uiText("settings_theme_dark") })
		.click();
	await expect(html).toHaveClass(/\bdark\b/);
	expect(await page.evaluate(() => localStorage.getItem("theme"))).toBe("dark");

	// The catalogue decides what German reads like; a hardcoded string here would
	// pin the test to today's translation instead of to the key.
	await page
		.getByRole("combobox", { name: uiText("settings_general_language_title") })
		.click();
	await page.getByRole("option", { name: uiText("i18n_language_de") }).click();
	await expect(html).toHaveAttribute("lang", "de");
	await expect(
		page.getByRole("heading", {
			name: uiTextIn("de", "settings_page_hero_heading"),
		}),
	).toBeVisible();
	await expect(page.getByTestId("settings-tab-security")).toContainText(
		uiTextIn("de", "settings_tab_security"),
	);
	expect(
		await page.evaluate(() => localStorage.getItem("bittery.locale")),
	).toBe("de");

	// Both preferences are device-bound, so a reload must not fall back to English.
	await gotoRoute(page, "/settings", page.getByTestId("settings-tab-account"));
	await expect(html).toHaveAttribute("lang", "de");
	await expect(html).toHaveClass(/\bdark\b/);
	await expect(
		page.getByRole("heading", {
			name: uiTextIn("de", "settings_page_hero_heading"),
		}),
	).toBeVisible();
	// The sidebar is translated by the same catalogue, not only the settings page.
	await expect(
		page.getByRole("link", { name: uiTextIn("de", "nav_item_vaults") }),
	).toBeVisible();
});

test("the security tab reports the Recovery Key signup configured and stores an auto-lock choice", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await signIn(page, user);
	const accountId = await activeAccountId(page);
	await openSettings(page);
	await openSettingsTab(page, "security");

	const security = page.getByRole("tabpanel");
	// A normal signup writes a Recovery Key, so this is the regenerate dialog
	// rather than the setup one. Only the dialog's content carries a testid, so
	// the trigger's copy is what tells the two apart.
	await expect(
		security.getByText(uiText("settings_security_recovery_key_configured")),
	).toBeVisible();
	const regenerateRecoveryKey = security.getByRole("button", {
		name: uiText("settings_recovery_key_regenerate_trigger"),
	});
	await expect(regenerateRecoveryKey).toBeVisible();
	await regenerateRecoveryKey.click();
	await expect(
		page.getByTestId("regenerate-recovery-key-dialog"),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("regenerate-recovery-key-dialog")).toBeHidden();

	// Auto-lock is the tab's only Select; Radix unmounts the other tabs' content.
	const autoLock = security.getByRole("combobox");
	await expect(autoLock).toContainText(
		uiText("settings_auto_lock_option_minutes_plural", { count: 10 }),
	);
	await autoLock.click();
	await page
		.getByRole("option", {
			name: uiText("settings_auto_lock_option_minutes_plural", { count: 30 }),
		})
		.click();
	await expect(
		toastWithText(page, uiText("settings_auto_lock_toast_updated")),
	).toBeVisible();
	expect(
		await page.evaluate(
			(key) => localStorage.getItem(key),
			`bittery_account_${accountId}_auto_lock_timeout`,
		),
	).toBe("1800000");

	// Device-bound, so it has to survive a reload of the route.
	await gotoRoute(page, "/settings", page.getByTestId("settings-tab-account"));
	await openSettingsTab(page, "security");
	await expect(page.getByRole("tabpanel").getByRole("combobox")).toContainText(
		uiText("settings_auto_lock_option_minutes_plural", { count: 30 }),
		{ timeout: VAULT_READY_TIMEOUT_MS },
	);
});

test("changing the email re-keys the account and the new address is what signs in", async ({
	page,
	browser,
}) => {
	test.setTimeout(CREDENTIAL_CHANGE_BUDGET_MS);
	await signIn(page, user);
	await openSettings(page);

	const newEmail = `e2e-test-${nanoid(8).toLowerCase()}@test.bittery.com`;
	await page
		.getByRole("button", {
			name: uiText("settings_change_email_dialog_trigger"),
		})
		.click();
	const dialog = page.getByRole("dialog", {
		name: uiText("settings_change_email_dialog_title"),
	});
	await expect(dialog).toBeVisible();
	await expect(dialog.locator("#currentEmail")).toHaveValue(user.email);
	await dialog.locator("#newEmail").fill(newEmail);
	await dialog.locator("#confirmEmail").fill(newEmail);
	await dialog.locator("#emailChangePassword").fill(user.password);
	await dialog
		.getByRole("button", {
			name: uiText("settings_change_email_dialog_action_submit"),
		})
		.click();

	await expect(
		toastWithText(page, uiText("settings_change_email_dialog_toast_updated")),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	await page.waitForURL("**/login", { timeout: VAULT_READY_TIMEOUT_MS });

	user = { ...user, email: newEmail };

	// A fresh context: this one still holds the account, so /login would offer the
	// one-field quick-unlock form instead of the full sign-in.
	const next = await browser.newContext();
	try {
		const signedIn = await next.newPage();
		await signIn(signedIn, user);
		await openSettings(signedIn);
		await expect(
			signedIn.getByRole("tabpanel").getByText(newEmail, { exact: true }),
		).toBeVisible();
		// Re-deriving the keys under the new address invalidated the Recovery Key.
		await openSettingsTab(signedIn, "security");
		await expect(
			signedIn.getByRole("button", {
				name: uiText("settings_recovery_key_setup_trigger"),
			}),
		).toBeVisible();
	} finally {
		await next.close();
	}
});

test("changing the master password forces a full sign-in with the new one", async ({
	page,
	browser,
}) => {
	test.setTimeout(CREDENTIAL_CHANGE_BUDGET_MS);
	await signIn(page, user);
	await openSettings(page);
	await openSettingsTab(page, "security");

	const newPassword = `NewTestPassword-${nanoid(6)}!`;
	await page
		.getByRole("button", {
			name: uiText("settings_change_password_dialog_trigger"),
		})
		.click();
	const dialog = page.getByTestId("change-password-dialog");
	await expect(dialog).toBeVisible();
	await dialog.locator("#currentPassword").fill(user.password);
	await dialog.locator("#newPassword").fill(newPassword);
	await dialog.locator("#confirmPassword").fill(newPassword);
	await dialog
		.getByRole("button", {
			name: uiText("settings_change_password_dialog_action_submit"),
		})
		.click();

	await expect(
		toastWithText(
			page,
			uiText("settings_change_password_dialog_toast_changed"),
		),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	await page.waitForURL("**/login", { timeout: VAULT_READY_TIMEOUT_MS });

	const previousPassword = user.password;
	user = { ...user, password: newPassword };

	const next = await browser.newContext();
	try {
		const signedIn = await next.newPage();

		// The old password must no longer derive the auth key the server holds.
		await signedIn.goto("/login");
		await expect(signedIn.locator("#secretKey")).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await signedIn.locator("#email").fill(user.email);
		await signedIn.locator("#secretKey").fill(user.secretKey);
		await signedIn.locator("#password").fill(previousPassword);
		await signedIn
			.getByRole("button", { name: "Sign In", exact: true })
			.click();
		await expect(errorToast(signedIn)).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await expect(signedIn).toHaveURL(/\/login/);

		await signIn(signedIn, user);
		await waitForAppReady(signedIn);
	} finally {
		await next.close();
	}
});

test("regenerating the Secret Key replaces the one a full sign-in needs", async ({
	page,
	browser,
}) => {
	test.setTimeout(CREDENTIAL_CHANGE_BUDGET_MS);
	await signIn(page, user);
	await openSettings(page);
	await openSettingsTab(page, "security");

	await page
		.getByRole("button", {
			name: uiText("settings_secret_key_regenerate_trigger"),
		})
		.click();
	const dialog = page.getByTestId("regenerate-secret-key-dialog");
	await expect(dialog).toBeVisible();
	await dialog.locator("#currentPassword").fill(user.password);
	await dialog
		.getByRole("button", {
			name: uiText("settings_secret_key_regenerate_action_generate"),
		})
		.click();

	await expect(
		dialog.getByText(uiText("settings_secret_key_regenerate_display_title")),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	await dialog.locator('input[type="checkbox"]').check();
	await dialog
		.getByRole("button", {
			name: uiText("settings_secret_key_regenerate_action_confirm"),
		})
		.click();
	await expect(
		toastWithText(
			page,
			uiText("settings_secret_key_regenerate_toast_regenerated"),
		),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });

	// The regeneration rewrote the stored key in place, so the spec's copy is
	// stale from here on.
	const previousSecretKey = user.secretKey;
	const nextSecretKey = await readSecretKey(page);
	expect(nextSecretKey).toMatch(/^A3-/);
	expect(nextSecretKey).not.toBe(previousSecretKey);
	user = { ...user, secretKey: nextSecretKey };

	await gotoRoute(page, "/settings", page.getByTestId("settings-tab-account"));
	await expect(
		page
			.getByRole("tabpanel")
			.getByText(secretKeyHint(nextSecretKey), { exact: true }),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });

	const next = await browser.newContext();
	try {
		const signedIn = await next.newPage();

		// The replaced key derives a different auth key, so the server rejects it.
		await signedIn.goto("/login");
		await expect(signedIn.locator("#secretKey")).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await signedIn.locator("#email").fill(user.email);
		await signedIn.locator("#secretKey").fill(previousSecretKey);
		await signedIn.locator("#password").fill(user.password);
		await signedIn
			.getByRole("button", { name: "Sign In", exact: true })
			.click();
		await expect(errorToast(signedIn)).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await expect(signedIn).toHaveURL(/\/login/);

		await signIn(signedIn, user);
		await waitForAppReady(signedIn);
	} finally {
		await next.close();
	}
});

test("a lost successful deletion response replays the exact marker after reload", async ({
	page,
}) => {
	test.setTimeout(CREDENTIAL_CHANGE_BUDGET_MS);
	const disposable = await signUp(page, generateTestUser());
	await openSettings(page);
	await openSettingsTab(page, "general");
	let lost = false;
	await page.route("**/api/v1/users/me", async (route) => {
		if (route.request().method() !== "DELETE" || lost) {
			await route.continue();
			return;
		}
		await route.fetch();
		lost = true;
		await route.abort("connectionreset");
	});

	await page
		.getByRole("button", {
			name: uiText("settings_delete_account_dialog_trigger"),
		})
		.click();
	const dialog = page.getByTestId("delete-account-dialog");
	await dialog.locator("#confirmEmail").fill(disposable.email);
	await dialog
		.locator("#confirmText")
		.fill(uiText("settings_delete_account_dialog_confirm_phrase"));
	await dialog.getByTestId("delete-account-confirm").click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					JSON.parse(localStorage.getItem("bittery_account_deletion") ?? "null")
						?.phase,
			),
		)
		.toBe("dispatchedUnknown");

	await page.reload();
	await page.waitForURL("**/login", { timeout: VAULT_READY_TIMEOUT_MS });
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("bittery_account_deletion")),
		)
		.toBeNull();
});

test("a retained wrong-email refusal clears its marker and preserves local Account data", async ({
	page,
}) => {
	test.setTimeout(CREDENTIAL_CHANGE_BUDGET_MS);
	const disposable = await signUp(page, generateTestUser());
	const before = await page.evaluate(() => ({
		runtime: localStorage.getItem("bittery_runtime_account_id"),
		transitional: localStorage.getItem("bittery_active_account"),
	}));
	const requestIds: string[] = [];
	let refuse = true;
	await page.route("**/api/v1/users/me", async (route) => {
		if (route.request().method() !== "DELETE") {
			await route.continue();
			return;
		}
		requestIds.push(route.request().headers()["idempotency-key"] ?? "");
		if (refuse) {
			refuse = false;
			await route.continue({
				postData: JSON.stringify({ confirmEmail: "wrong@example.test" }),
			});
			return;
		}
		await route.continue();
	});

	await openSettings(page);
	await openSettingsTab(page, "general");
	await page
		.getByRole("button", {
			name: uiText("settings_delete_account_dialog_trigger"),
		})
		.click();
	const dialog = page.getByTestId("delete-account-dialog");
	await dialog.locator("#confirmEmail").fill(disposable.email);
	await dialog
		.locator("#confirmText")
		.fill(uiText("settings_delete_account_dialog_confirm_phrase"));
	await dialog.getByTestId("delete-account-confirm").click();
	await expect(errorToast(page)).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("bittery_account_deletion")),
		)
		.toBeNull();
	expect(
		await page.evaluate(() => ({
			runtime: localStorage.getItem("bittery_runtime_account_id"),
			transitional: localStorage.getItem("bittery_active_account"),
		})),
	).toEqual(before);

	await dialog.getByTestId("delete-account-confirm").click();
	await finishAccountDeletion(page);
	expect(requestIds).toHaveLength(2);
	expect(requestIds[0]).not.toBe(requestIds[1]);
});

test("a reload during the serverDeleted local tail resumes without a second Server delete", async ({
	page,
}) => {
	test.setTimeout(CREDENTIAL_CHANGE_BUDGET_MS);
	const disposable = await signUp(page, generateTestUser());
	let deletes = 0;
	await page.route("**/api/v1/users/me", async (route) => {
		if (route.request().method() === "DELETE") deletes += 1;
		await route.continue();
	});
	await page.evaluate((prefix) => {
		const original = Storage.prototype.removeItem;
		let refused = false;
		Storage.prototype.removeItem = function (key: string) {
			if (!refused && key.startsWith(prefix)) {
				refused = true;
				throw new Error("forced Runtime platform tail failure");
			}
			return original.call(this, key);
		};
	}, RUNTIME_STORAGE_PREFIX);
	await openSettings(page);
	await openSettingsTab(page, "general");
	await page
		.getByRole("button", {
			name: uiText("settings_delete_account_dialog_trigger"),
		})
		.click();
	const dialog = page.getByTestId("delete-account-dialog");
	await dialog.locator("#confirmEmail").fill(disposable.email);
	await dialog
		.locator("#confirmText")
		.fill(uiText("settings_delete_account_dialog_confirm_phrase"));
	await dialog.getByTestId("delete-account-confirm").click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					JSON.parse(localStorage.getItem("bittery_account_deletion") ?? "null")
						?.phase,
			),
		)
		.toBe("serverDeleted");
	await page.reload();
	await page.waitForURL("**/login", { timeout: VAULT_READY_TIMEOUT_MS });
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("bittery_account_deletion")),
		)
		.toBeNull();
	expect(deletes).toBe(1);
});

test("a deletion marker gates RemoveAccount and SignOut by its dispatch phase", async ({
	page,
}) => {
	test.setTimeout(CREDENTIAL_CHANGE_BUDGET_MS);
	const disposable = await signUp(page, generateTestUser());
	const names = await page.evaluate(() => ({
		runtimeAccountId: localStorage.getItem("bittery_runtime_account_id"),
		transitionalAccountId: localStorage.getItem("bittery_active_account"),
	}));
	if (!names.runtimeAccountId || !names.transitionalAccountId)
		throw new Error("missing Account names");
	await page.evaluate(
		({ runtimeAccountId, transitionalAccountId, email }) => {
			localStorage.setItem(
				"bittery_account_deletion",
				JSON.stringify({
					version: 1,
					runtimeAccountId,
					transitionalAccountId,
					confirmEmail: email,
					requestId: "018f47a2-6f40-47da-8d53-a55e557dc723",
					phase: "dispatchedUnknown",
				}),
			);
		},
		{ ...names, email: disposable.email },
	);
	await page.getByTestId("user-menu").click();
	await page.getByTestId("sign-out-button").click();
	await page.getByTestId("log-out-confirm").click();
	await expect(page.getByTestId("log-out-dialog")).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("bittery_runtime_account_id")),
		)
		.toBe(names.runtimeAccountId);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					JSON.parse(localStorage.getItem("bittery_account_deletion") ?? "null")
						?.phase,
			),
		)
		.toBe("dispatchedUnknown");

	// The locked-screen path invokes Runtime SignOut rather than RemoveAccount. The same
	// post-dispatch marker must preserve the retry Session there as well.
	await page.goto("/login");
	await expect(page.getByTestId("use-different-account")).toBeVisible();
	await page.getByTestId("use-different-account").click();
	await expect(page.getByTestId("use-different-account")).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("bittery_runtime_account_id")),
		)
		.toBe(names.runtimeAccountId);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					JSON.parse(localStorage.getItem("bittery_account_deletion") ?? "null")
						?.phase,
			),
		)
		.toBe("dispatchedUnknown");

	// A pre-dispatch marker owns no Server ambiguity. SignOut may cancel it and proceed.
	await page.evaluate(() => {
		const marker = JSON.parse(
			localStorage.getItem("bittery_account_deletion") ?? "null",
		);
		localStorage.setItem(
			"bittery_account_deletion",
			JSON.stringify({ ...marker, phase: "prepared" }),
		);
	});
	await page.getByTestId("use-different-account").click();
	await expect(page.getByTestId("signin-form").locator("#email")).toBeEnabled();
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("bittery_account_deletion")),
		)
		.toBeNull();
});

test("deleting the account destroys it on the server and removes it from the device", async ({
	page,
	browser,
}) => {
	test.setTimeout(CREDENTIAL_CHANGE_BUDGET_MS);
	await signIn(page, user);
	const accountId = await activeAccountId(page);
	const removedRuntimeAccountId = await page.evaluate(() =>
		localStorage.getItem("bittery_runtime_account_id"),
	);
	if (!removedRuntimeAccountId) {
		throw new Error("Sign-in did not persist the Runtime Account id.");
	}
	await openSettings(page);
	await openSettingsTab(page, "general");

	await page
		.getByRole("button", {
			name: uiText("settings_delete_account_dialog_trigger"),
		})
		.click();
	const dialog = page.getByTestId("delete-account-dialog");
	await expect(dialog).toBeVisible();

	const submit = dialog.getByRole("button", {
		name: uiText("settings_delete_account_dialog_action_submit"),
	});
	// Both confirmations are required: the address and the exact phrase.
	await expect(submit).toBeDisabled();
	await dialog.locator("#confirmEmail").fill(user.email);
	await expect(submit).toBeDisabled();
	await dialog
		.locator("#confirmText")
		.fill(uiText("settings_delete_account_dialog_confirm_phrase"));
	await expect(submit).toBeEnabled();
	await submit.click();
	await finishAccountDeletion(page);

	await expect(
		toastWithText(page, uiText("settings_delete_account_dialog_toast_deleted")),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	// `/` bounces an unauthenticated visitor to `/login`.
	await page.waitForURL("**/login", { timeout: VAULT_READY_TIMEOUT_MS });
	const removedShape = await page.evaluate(
		({
			forbiddenSuffixes,
			removedAccountId,
			runtimeAccountId,
			runtimePrefix,
		}) => {
			const rawAccounts = localStorage.getItem("bittery_accounts_list");
			const accounts = rawAccounts
				? (JSON.parse(rawAccounts) as {
						version?: number;
						accounts?: Array<{ accountId: string }>;
					})
				: null;
			const accountPrefix = `bittery_account_${removedAccountId}_`;
			const runtimeAccountPrefix = `${runtimePrefix}account:${new TextEncoder().encode(runtimeAccountId).byteLength}:${runtimeAccountId}:`;
			const matchingKeys = (store: Storage, prefix: string) =>
				Object.keys(store)
					.filter((key) => key.startsWith(prefix))
					.sort();
			const transitionalCredentialKeys = (store: Storage) =>
				Object.keys(store)
					.filter((key) => key.startsWith("bittery_account_"))
					.filter((key) =>
						forbiddenSuffixes.some((suffix) => key.endsWith(suffix)),
					)
					.sort();
			return {
				activeAccountId: localStorage.getItem("bittery_active_account"),
				accounts,
				webAccountId: localStorage.getItem("bittery_web_account_id"),
				runtimeAccountId: localStorage.getItem("bittery_runtime_account_id"),
				accountDeletionMarker: localStorage.getItem("bittery_account_deletion"),
				localAccountKeys: matchingKeys(localStorage, accountPrefix),
				sessionAccountKeys: matchingKeys(sessionStorage, accountPrefix),
				localRuntimeAccountKeys: matchingKeys(
					localStorage,
					runtimeAccountPrefix,
				),
				sessionRuntimeAccountKeys: matchingKeys(
					sessionStorage,
					runtimeAccountPrefix,
				),
				localTransitionalCredentialKeys:
					transitionalCredentialKeys(localStorage),
				sessionTransitionalCredentialKeys:
					transitionalCredentialKeys(sessionStorage),
			};
		},
		{
			forbiddenSuffixes: TRANSITIONAL_CREDENTIAL_SUFFIXES,
			removedAccountId: accountId,
			runtimeAccountId: removedRuntimeAccountId,
			runtimePrefix: RUNTIME_STORAGE_PREFIX,
		},
	);
	expect(removedShape).toEqual({
		activeAccountId: null,
		accounts: { version: 2, accounts: [] },
		webAccountId: null,
		runtimeAccountId: null,
		accountDeletionMarker: null,
		localAccountKeys: [],
		sessionAccountKeys: [],
		localRuntimeAccountKeys: [],
		sessionRuntimeAccountKeys: [],
		localTransitionalCredentialKeys: [],
		sessionTransitionalCredentialKeys: [],
	});

	// The account is gone on the server too, so even a device that never held it
	// cannot sign in.
	const next = await browser.newContext();
	try {
		const signedIn = await next.newPage();
		await signedIn.goto("/login");
		await expect(signedIn.locator("#secretKey")).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await signedIn.locator("#email").fill(user.email);
		await signedIn.locator("#secretKey").fill(user.secretKey);
		await signedIn.locator("#password").fill(user.password);
		await signedIn
			.getByRole("button", { name: "Sign In", exact: true })
			.click();
		await expect(errorToast(signedIn)).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await expect(signedIn).toHaveURL(/\/login/);
	} finally {
		await next.close();
	}
});
