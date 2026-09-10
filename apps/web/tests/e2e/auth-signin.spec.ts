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

/** The exact transitional and Runtime names one signed-in browser stores. */
async function accountStorageShape(page: Page) {
	return page.evaluate(() => {
		const rawAccounts = localStorage.getItem("bittery_accounts_list");
		const accountsDocument = rawAccounts
			? (JSON.parse(rawAccounts) as {
					version?: number;
					accounts?: Array<{ accountId: string }>;
				})
			: null;
		return {
			activeAccountId: localStorage.getItem("bittery_active_account"),
			accounts: accountsDocument,
			webAccountId: localStorage.getItem("bittery_web_account_id"),
			runtimeAccountId: localStorage.getItem("bittery_runtime_account_id"),
			accountDeletionMarker: localStorage.getItem("bittery_account_deletion"),
			secretKeyNames: Object.keys(localStorage)
				.filter((key) => key.endsWith("_secret_key"))
				.sort(),
		};
	});
}

/** Account teardown evidence without rejecting legitimate Device-wide Runtime documents. */
async function removedAccountStorageShape(
	page: Page,
	runtimeAccountId: string,
) {
	return page.evaluate(
		({ forbiddenSuffixes, runtimeAccountId, runtimePrefix }) => {
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
			runtimeAccountId,
			runtimePrefix: RUNTIME_STORAGE_PREFIX,
		},
	);
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

	// Quick unlock is offered exactly when the device still holds the Secret Key and
	// pinned KDF profile, which is what the sign-in just above leaves behind.
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
	// Nothing was unlocked: no named Account material reached this device.
	const failedShape = await accountStorageShape(page);
	expect(failedShape.secretKeyNames).toEqual([]);
	expect(failedShape.accounts).toBeNull();
	expect(failedShape.activeAccountId).toBe(failedShape.webAccountId);
	expect(failedShape.runtimeAccountId).toBeNull();
	expect(failedShape.accountDeletionMarker).toBeNull();
});

test("signing out removes the account from the device and forces a full sign-in", async ({
	page,
}) => {
	test.setTimeout(SIGN_IN_MS + COLD_START_MS);

	await signIn(page, user);
	const signedInShape = await accountStorageShape(page);
	expect(signedInShape.activeAccountId).not.toBeNull();
	expect(signedInShape.webAccountId).not.toBeNull();
	// A fresh browser may keep using its pre-login transitional id. Runtime
	// Sign-in owns a different Account and mirrors no credentials into that store.
	expect(signedInShape.activeAccountId).toBe(signedInShape.webAccountId);
	expect(signedInShape.accounts).toBeNull();
	expect(signedInShape.secretKeyNames).toEqual([]);
	expect(signedInShape.runtimeAccountId).not.toBeNull();
	expect(signedInShape.runtimeAccountId).not.toBe(
		signedInShape.activeAccountId,
	);
	expect(signedInShape.runtimeAccountId).not.toBe(signedInShape.webAccountId);
	expect(signedInShape.accountDeletionMarker).toBeNull();
	const removedRuntimeAccountId = signedInShape.runtimeAccountId;
	if (!removedRuntimeAccountId) {
		throw new Error("Sign-in did not persist the Runtime Account id.");
	}

	await signOut(page);

	const form = page.getByTestId("signin-form");
	await expect(form.locator("#secretKey")).toBeVisible({
		timeout: COLD_START_MS,
	});
	await expect(form.locator("#email")).toBeEnabled();
	await expect(form.locator("#email")).toHaveValue("");
	// Sign-out on web removes the account outright, so no Secret Key is left for
	// the next person at this browser profile.
	const signedOutShape = await accountStorageShape(page);
	expect(signedOutShape).toEqual({
		activeAccountId: null,
		accounts: { version: 2, accounts: [] },
		webAccountId: null,
		runtimeAccountId: null,
		accountDeletionMarker: null,
		secretKeyNames: [],
	});
	expect(
		await removedAccountStorageShape(page, removedRuntimeAccountId),
	).toEqual({
		localRuntimeAccountKeys: [],
		sessionRuntimeAccountKeys: [],
		localTransitionalCredentialKeys: [],
		sessionTransitionalCredentialKeys: [],
	});
});

test("an expired session keeps password-only Quick Unlock available", async ({
	page,
}) => {
	test.setTimeout(SIGN_IN_MS + COLD_START_MS);

	await signIn(page, user);
	const accountId = (await accountStorageShape(page)).activeAccountId;
	expect(accountId).not.toBeNull();

	// Backdate both legacy Session expiry fields without deleting the Device-bound
	// Secret Key or pinned KDF profile used by the fresh online SRP ceremony.
	const expired = await page.evaluate((activeAccountId) => {
		const past = Date.now() - 24 * 60 * 60 * 1000;
		const key = `bittery_account_${activeAccountId}_session_data`;
		const raw = localStorage.getItem(key);
		if (!raw) return false;
		const session = JSON.parse(raw);
		session.expiresAt = past;
		session.serverExpiresAt = past;
		localStorage.setItem(key, JSON.stringify(session));
		return true;
	}, accountId);
	expect(expired).toBe(true);

	await page.goto("/login");
	const form = page.getByTestId("signin-form");
	await expect(form.locator("#email")).toBeDisabled({ timeout: COLD_START_MS });
	await expect(form.locator("#email")).toHaveValue(user.email);
	await expect(form.locator("#secretKey")).toHaveCount(0);
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
