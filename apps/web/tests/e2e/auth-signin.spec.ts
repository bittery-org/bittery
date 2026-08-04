import type { Page } from "@playwright/test";
import {
	expect,
	generateTestUser,
	signIn,
	signOut,
	signUp,
	type TestUser,
	test,
	waitForAppReady,
} from "../fixtures/auth";
import { uiText } from "../fixtures/messages";

/**
 * Sign-in, quick unlock, sign-out and the states the login screen shows in
 * between.
 *
 * One signup for the whole file, on a throwaway context: PBKDF2 at 600k
 * iterations plus SRP and RSA key generation is far too expensive to repeat per
 * test, and nothing here needs a second account.
 */

/** Vite's first paint of an auth route on a cold dev server. */
const COLD_START_MS = 60000;

/** One SRP handshake, which re-derives the master key from the password. */
const SIGN_IN_MS = 120000;

/**
 * Any `toast.error`, whatever its wording.
 *
 * `@bittery/ui` renders every toast through `toast.custom`, so Sonner stamps
 * `data-type="default"` on all of them and the destructive icon tint is the
 * only thing in the DOM that distinguishes an error from a success. `.first()`
 * because one failure can raise more than one toast.
 */
function errorToast(page: Page) {
	return page
		.locator("[data-sonner-toast]")
		.filter({ has: page.locator(".text-destructive") })
		.first();
}

/** The part of a Secret Key the server keeps, so it can be shown as a hint. */
function secretKeyHint(secretKey: string): string {
	return secretKey.split("-").slice(0, 2).join("-");
}

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

test("a fresh device signs in with email, Secret Key and password, and is offered the Secret Key hint", async ({
	page,
}) => {
	test.setTimeout(SIGN_IN_MS + COLD_START_MS);

	await page.goto("/login");
	const form = page.getByTestId("signin-form");
	// A context that has never held this account gets the full three-field form.
	await expect(form.locator("#secretKey")).toBeVisible({
		timeout: COLD_START_MS,
	});

	const hint = secretKeyHint(user.secretKey);
	await expect(page.getByText(hint)).toHaveCount(0);

	await form.locator("#email").fill(user.email);
	await form.locator("#email").blur();
	// The hint is looked up from the typed address, so it can only appear once
	// the server has recognised the account.
	await expect(page.getByText(hint)).toBeVisible();

	await form.locator("#secretKey").fill(user.secretKey);
	await form.locator("#password").fill(user.password);
	await page.getByTestId("signin-submit-button").click();

	await page.waitForURL("**/home", { timeout: SIGN_IN_MS });
	await waitForAppReady(page);
});

test("quick unlock takes the master password alone", async ({ page }) => {
	test.setTimeout(SIGN_IN_MS * 2 + COLD_START_MS);

	// Quick unlock is offered exactly when the device still holds the Secret Key
	// and an unexpired session, which is what the sign-in just above leaves
	// behind - so signing in first is what makes this deterministic.
	await signIn(page, user);

	await page.goto("/login");
	const form = page.getByTestId("signin-form");
	const email = form.locator("#email");
	await expect(email).toBeDisabled({ timeout: COLD_START_MS });
	await expect(email).toHaveValue(user.email);
	await expect(form.locator("#secretKey")).toHaveCount(0);

	await form.locator("#password").fill(user.password);
	await page.getByTestId("signin-submit-button").click();

	await page.waitForURL("**/home", { timeout: SIGN_IN_MS });
	await waitForAppReady(page);
});

test("a wrong master password is refused and keeps the user on /login", async ({
	page,
}) => {
	test.setTimeout(SIGN_IN_MS + COLD_START_MS);

	await page.goto("/login");
	const form = page.getByTestId("signin-form");
	await expect(form.locator("#secretKey")).toBeVisible({
		timeout: COLD_START_MS,
	});

	await form.locator("#email").fill(user.email);
	await form.locator("#secretKey").fill(user.secretKey);
	await form.locator("#password").fill(`${user.password}-wrong`);
	await page.getByTestId("signin-submit-button").click();

	await expect(errorToast(page)).toBeVisible({ timeout: SIGN_IN_MS });
	await expect(page).toHaveURL(/\/login/);
	await expect(form.locator("#secretKey")).toBeVisible();
	// Nothing was unlocked: no account material reached this device.
	expect(
		await page.evaluate(() =>
			Object.keys(localStorage).filter((key) => key.endsWith("_secret_key")),
		),
	).toEqual([]);
});

test("signing out removes the account from the device and forces a full sign-in", async ({
	page,
}) => {
	test.setTimeout(SIGN_IN_MS + COLD_START_MS);

	await signIn(page, user);
	expect(
		await page.evaluate(() =>
			Object.keys(localStorage).filter((key) => key.endsWith("_secret_key")),
		),
	).toHaveLength(1);

	await signOut(page);

	const form = page.getByTestId("signin-form");
	await expect(form.locator("#secretKey")).toBeVisible({
		timeout: COLD_START_MS,
	});
	await expect(form.locator("#email")).toBeEnabled();
	await expect(form.locator("#email")).toHaveValue("");
	// Sign-out on web removes the account outright, so no Secret Key is left for
	// the next person at this browser profile.
	expect(
		await page.evaluate(() =>
			Object.keys(localStorage).filter((key) => key.endsWith("_secret_key")),
		),
	).toEqual([]);
});

test("an expired session shows the session-expired banner and asks for the Secret Key again", async ({
	page,
}) => {
	test.setTimeout(SIGN_IN_MS + COLD_START_MS);

	await signIn(page, user);

	// `session_data` is the device-bound half of the quick-unlock pair and lives
	// in localStorage as plain JSON; backdating both expiries is the only way to
	// reach this state without waiting out the real 14-day window.
	const expiredCount = await page.evaluate(() => {
		const suffix = "_session_data";
		const past = Date.now() - 24 * 60 * 60 * 1000;
		let count = 0;
		for (const key of Object.keys(localStorage)) {
			if (!key.startsWith("bittery_account_") || !key.endsWith(suffix)) {
				continue;
			}
			const raw = localStorage.getItem(key);
			if (!raw) continue;
			const session = JSON.parse(raw);
			session.expiresAt = past;
			session.serverExpiresAt = past;
			localStorage.setItem(key, JSON.stringify(session));
			count += 1;
		}
		return count;
	});
	expect(expiredCount).toBe(1);

	await page.goto("/login");
	await expect(
		page.getByText(uiText("auth_signin_session_expired_title")),
	).toBeVisible({ timeout: COLD_START_MS });
	await expect(
		page.getByText(uiText("auth_signin_session_expired_description")),
	).toBeVisible();
	// Quick unlock is gone with the session, so the full form is back.
	await expect(
		page.getByTestId("signin-form").locator("#secretKey"),
	).toBeVisible();
});

test("an unauthenticated deep link bounces to /login, and ?redirect= lands there after sign-in", async ({
	page,
}) => {
	test.setTimeout(SIGN_IN_MS + COLD_START_MS);

	await page.goto("/vaults");
	await page.waitForURL(/\/login/, { timeout: COLD_START_MS });
	await expect(page.getByTestId("signin-form")).toBeVisible();
	expect(new URL(page.url()).pathname).toBe("/login");

	// The guard does not carry the requested route over, so drive the parameter
	// the login route does honour.
	await page.goto("/login?redirect=%2Fvaults");
	const form = page.getByTestId("signin-form");
	await expect(form.locator("#secretKey")).toBeVisible({
		timeout: COLD_START_MS,
	});
	await form.locator("#email").fill(user.email);
	await form.locator("#secretKey").fill(user.secretKey);
	await form.locator("#password").fill(user.password);
	await page.getByTestId("signin-submit-button").click();

	await page.waitForURL(/\/vaults/, { timeout: SIGN_IN_MS });
	await waitForAppReady(page);
});
