import { type CloudPlanId, planInfoMap } from "@bittery/shared/pricing";
import type { Page } from "@playwright/test";
import {
	expect,
	readSecretKey,
	type TestUser,
	test,
	waitForAppReady,
} from "../fixtures/auth";
import {
	type MailOutboxEntry,
	mailOutboxNow,
	waitForMail,
} from "../fixtures/mail-outbox";
import { uiText } from "../fixtures/messages";

/**
 * Cloud signup. Signing up is what is under test here, so this is the one spec
 * that pays for key generation more than once - hence the deliberately small
 * test count.
 *
 * Serial: the duplicate-email test reuses the address the first test registered
 * rather than burning a third signup on creating one.
 */
test.describe.configure({ mode: "serial" });

/** Vite's first paint of an auth route on a cold dev server. */
const COLD_START_MS = 60000;

/** PBKDF2 at 600k iterations, SRP registration and RSA key generation. */
const KEY_GENERATION_MS = 120000;

const ALL_PLANS: CloudPlanId[] = ["free", "personal", "family", "team"];

/**
 * Any `toast.error`, whatever its wording.
 *
 * `@bittery/ui` renders every toast through `toast.custom`, so Sonner stamps
 * `data-type="default"` on all of them and the destructive icon tint is the
 * only thing in the DOM that distinguishes an error from a success. `.first()`
 * because one failure can raise more than one toast - a rejected signup raises
 * both the mutation's own error and the one its caller re-reports.
 */
function errorToast(page: Page) {
	return page
		.locator("[data-sonner-toast]")
		.filter({ has: page.locator(".text-destructive") })
		.first();
}

/** A six-digit code that is definitely not the one that was emailed. */
function wrongCode(realCode: string): string {
	return realCode === "000000" ? "111111" : "000000";
}

/**
 * One real input backs the six decorative slots, and `input-otp` only honours
 * one deletion per change event: `fill("")` on a full field shortens the code
 * by a single digit instead of clearing it, and a plain refill then keeps the
 * digits it did not overwrite. Backspacing it empty first is what makes a
 * second attempt land.
 */
async function enterVerificationCode(page: Page, code: string): Promise<void> {
	const input = page.locator("#signup-verification-step-code");
	await input.click();
	for (let index = 0; index < 6; index += 1) {
		await input.press("Backspace");
	}
	await expect(input).toHaveValue("");
	await input.fill(code);
	await expect(input).toHaveValue(code);
}

/** Drives the account step up to the point where submit is allowed. */
async function fillAccountStep(page: Page, user: TestUser): Promise<void> {
	const form = page.getByTestId("signup-form");
	await expect(form).toBeVisible({ timeout: COLD_START_MS });
	await form.locator("#name").fill(user.name);
	await form.locator("#email").fill(user.email);
	await form.locator("#password").fill(user.password);
}

/**
 * Clicking the gate opens a real browser download; the wait has to be armed
 * first or the click never settles.
 */
async function downloadEmergencyKit(page: Page): Promise<void> {
	const gate = page.getByTestId("emergency-kit-download-button");
	await expect(gate).toBeEnabled({ timeout: COLD_START_MS });
	const [download] = await Promise.all([
		page.waitForEvent("download"),
		gate.click(),
	]);
	expect(download.suggestedFilename()).toMatch(
		/^bittery-emergency-kit\.(pdf|txt)$/,
	);
	await expect(gate).toContainText(
		uiText("auth_signup_emergency_kit_saved_description"),
	);
}

/** The address the first test registers, reused by the duplicate-email test. */
let registeredUser: TestUser;

test("free plan: comparison dialog, Emergency Kit gate, wrong code, resend, correct code", async ({
	page,
	testUser,
}) => {
	test.setTimeout(300000);

	// No `?plan=`, so cloud billing puts the plan step first.
	await page.goto("/signup");

	const comparePlans = page.getByRole("button", {
		name: uiText("auth_signup_compare_all_plans"),
	});
	await expect(comparePlans).toBeVisible({ timeout: COLD_START_MS });
	await comparePlans.click();

	const comparison = page.getByRole("dialog");
	await expect(comparison).toBeVisible();
	// Descriptions are unique per plan and only the header card carries one, so
	// they pick out one card each without going through UI copy.
	const planCard = (plan: CloudPlanId) =>
		comparison
			.locator("button")
			.filter({ hasText: planInfoMap[plan].description });
	for (const plan of ALL_PLANS) {
		await expect(planCard(plan)).toHaveCount(1);
		await expect(planCard(plan)).toContainText(planInfoMap[plan].priceLabel);
	}

	// The dialog writes back to the same form field the tiles do.
	const selectedMarker = (plan: CloudPlanId) =>
		planCard(plan)
			.locator("div")
			.filter({ hasText: /^Selected$/ });
	await expect(selectedMarker("free")).toHaveCount(1);
	await planCard("team").click();
	await expect(selectedMarker("team")).toHaveCount(1);
	await expect(selectedMarker("free")).toHaveCount(0);
	await planCard("free").click();
	await expect(selectedMarker("free")).toHaveCount(1);

	await page.keyboard.press("Escape");
	await expect(comparison).toBeHidden();

	await page
		.getByRole("button", {
			name: uiText("auth_signup_button_continue"),
			exact: true,
		})
		.click();

	const form = page.getByTestId("signup-form");
	await fillAccountStep(page, testUser);
	// The account step carries the chosen plan forward.
	await expect(form).toContainText(planInfoMap.free.name);
	await expect(form).toContainText(planInfoMap.free.priceLabel);
	// Free plan, so no team name is asked for.
	await expect(form.locator("#organizationName")).toHaveCount(0);

	const submit = page.getByTestId("signup-submit-button");
	await expect(submit).toBeDisabled();
	await expect(submit).toContainText(
		uiText("auth_signup_button_download_kit_to_continue"),
	);

	await downloadEmergencyKit(page);
	await expect(submit).toBeEnabled();
	await expect(submit).toContainText(
		uiText("auth_signup_button_continue_to_verification"),
	);

	const since = mailOutboxNow();
	await submit.click();

	const verification = page.getByTestId("signup-verification-dialog");
	await expect(verification).toBeVisible({ timeout: COLD_START_MS });
	const firstMail = await waitForMail({
		purpose: "signup",
		email: testUser.email,
		since,
	});

	const verify = page.getByTestId("signup-verification-submit");

	await enterVerificationCode(page, wrongCode(firstMail.code));
	await verify.click();
	await expect(errorToast(page)).toBeVisible();
	await expect(verification).toBeVisible();
	await expect(page).toHaveURL(/\/signup/);

	const sinceResend = mailOutboxNow();
	await page
		.getByRole("button", { name: uiText("auth_signup_button_resend_code") })
		.click();
	// `issuedAt` has nanosecond precision, so "not the one we already saw" is an
	// exact test - the resent code cannot be mistaken for the code it replaces.
	const resentMail: MailOutboxEntry = await waitForMail({
		purpose: "signup",
		email: testUser.email,
		since: sinceResend,
		match: (entry) => entry.issuedAt !== firstMail.issuedAt,
	});

	await enterVerificationCode(page, resentMail.code);
	await verify.click();

	await page.waitForURL("**/home", { timeout: KEY_GENERATION_MS });
	await waitForAppReady(page);

	const secretKey = await readSecretKey(page);
	expect(secretKey).toMatch(/^A3-/);
	registeredUser = { ...testUser, secretKey };

	// The account the server created is the one the browser holds keys for: its
	// Secret Key hint is the first two segments of the key that never left here.
	await page.goto("/settings");
	const accountTab = page.getByTestId("settings-tab-account");
	await expect(accountTab).toBeVisible({ timeout: COLD_START_MS });
	await accountTab.click();
	await expect(page.getByText(testUser.email).first()).toBeVisible();
	await expect(
		page.getByText(secretKey.split("-").slice(0, 2).join("-")),
	).toBeVisible();
});

test("the account step refuses a missing name and a malformed email", async ({
	page,
	testUser,
}) => {
	test.setTimeout(120000);

	await page.goto("/signup?plan=free");
	const form = page.getByTestId("signup-form");
	await expect(form).toBeVisible({ timeout: COLD_START_MS });

	// The kit gate is the only thing blocking submit at this point, so clearing
	// it first proves the next two failures come from the fields themselves.
	await downloadEmergencyKit(page);
	const submit = page.getByTestId("signup-submit-button");
	await expect(submit).toBeEnabled();

	await submit.click();
	expect(
		await form
			.locator("#name")
			.evaluate((input: HTMLInputElement) => input.validity.valueMissing),
	).toBe(true);
	await expect(page.getByTestId("signup-verification-dialog")).toHaveCount(0);

	await form.locator("#name").fill(testUser.name);
	await form.locator("#email").fill("not-an-email");
	await form.locator("#password").fill(testUser.password);
	await submit.click();
	expect(
		await form
			.locator("#email")
			.evaluate((input: HTMLInputElement) => input.validity.typeMismatch),
	).toBe(true);
	await expect(page.getByTestId("signup-verification-dialog")).toHaveCount(0);
	await expect(page).toHaveURL(/\/signup/);
});

test("a second signup with an already registered email is rejected", async ({
	page,
}) => {
	test.setTimeout(300000);

	await page.goto("/signup?plan=free");
	// Only the address is reused; everything else is a genuinely new signup.
	await fillAccountStep(page, { ...registeredUser, name: "Duplicate Signup" });
	await downloadEmergencyKit(page);

	const since = mailOutboxNow();
	await page.getByTestId("signup-submit-button").click();

	const verification = page.getByTestId("signup-verification-dialog");
	await expect(verification).toBeVisible({ timeout: COLD_START_MS });
	// The server only refuses a duplicate at account creation - requesting and
	// verifying a code for a registered address both succeed.
	const mail = await waitForMail({
		purpose: "signup",
		email: registeredUser.email,
		since,
	});
	await enterVerificationCode(page, mail.code);
	await page.getByTestId("signup-verification-submit").click();

	await expect(errorToast(page)).toBeVisible({ timeout: KEY_GENERATION_MS });
	await expect(page).toHaveURL(/\/signup/);
	await expect(verification).toBeVisible();
});
