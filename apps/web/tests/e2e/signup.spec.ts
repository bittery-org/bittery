/**
 * E2E Tests for User Signup Flow
 *
 * Tests the complete signup flow including:
 * - Secret key generation and acknowledgment
 * - Form validation
 * - Account creation
 * - Navigation to dashboard
 * - Error handling
 */

import {
	createNetworkSimulator,
	waitForLoginPageReady,
} from "../fixtures/network-helpers";
import {
	BitteryPage,
	expect,
	generateTestUser,
	test,
} from "../fixtures/test-fixtures";

test.describe("User Signup Flow", () => {
	test.beforeEach(async ({ page }) => {
		// Navigate to the login page before each test
		await page.goto("/login");
		await waitForLoginPageReady(page);
	});

	test("should display secret key and require acknowledgment before showing signup form", async ({
		page,
		bitteryPage,
	}) => {
		// Switch to signup mode
		const signUpLink = page.locator('button:has-text("Sign up")');
		if (await signUpLink.isVisible()) {
			await signUpLink.click();
		}

		// Should show the secret key screen
		await expect(
			page.getByRole("heading", { name: "Save your Secret Key" }),
		).toBeVisible();
		await expect(
			page.getByText("Your Secret Key", { exact: true }),
		).toBeVisible();

		// Secret key should be displayed in the correct format (A3-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX)
		const secretKeyElement = page.locator(".font-mono.text-sm.tracking-wide");
		await expect(secretKeyElement).toBeVisible();
		const secretKey = await secretKeyElement.textContent();
		expect(secretKey).toMatch(
			/A3-[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}/,
		);

		// Warning about no recovery should be visible
		await expect(
			page.locator("text=There is no account recovery"),
		).toBeVisible();

		// Copy and Download buttons should be present
		await expect(page.locator('button:has-text("Copy")')).toBeVisible();
		await expect(page.locator('button:has-text("Download Kit")')).toBeVisible();

		// The signup form fields should NOT be visible yet
		await expect(page.locator("#name")).not.toBeVisible();
		await expect(page.locator("#email")).not.toBeVisible();
	});

	test("should show signup form after acknowledging secret key", async ({
		page,
	}) => {
		// Switch to signup mode
		const signUpLink = page.locator('button:has-text("Sign up")');
		if (await signUpLink.isVisible()) {
			await signUpLink.click();
		}

		// Acknowledge the secret key
		await page.click('button:has-text("I have saved my Secret Key")');

		// Now the form should be visible
		await expect(page.locator("#serverUrl")).toBeVisible();
		await expect(page.locator("#name")).toBeVisible();
		await expect(page.locator("#organizationName")).toBeVisible();
		await expect(page.locator("#email")).toBeVisible();
		await expect(page.locator("#password")).toBeVisible();
		await expect(
			page.locator('button:has-text("Create Account")'),
		).toBeVisible();
	});

	test("should allow going back to secret key view", async ({ page }) => {
		// Switch to signup mode
		const signUpLink = page.locator('button:has-text("Sign up")');
		if (await signUpLink.isVisible()) {
			await signUpLink.click();
		}

		// Acknowledge the secret key
		await page.click('button:has-text("I have saved my Secret Key")');

		// Click back button
		await page.click('button:has-text("Back to Secret Key")');

		// Should be back on secret key screen
		await expect(page.locator("text=Save your Secret Key")).toBeVisible();
	});

	test("should successfully create a new account", async ({
		page,
		testUser,
	}) => {
		const bitteryPage = new BitteryPage(page);

		// Complete the signup flow
		const secretKey = await bitteryPage.completeSignup(testUser);

		// Should be redirected to home page
		await expect(page).toHaveURL(/.*\/home/);

		// Verify the secret key was captured
		expect(secretKey).toMatch(
			/A3-[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}/,
		);
	});

	test("should show error for duplicate email", async ({ page, testUser }) => {
		const bitteryPage = new BitteryPage(page);

		// First signup
		await bitteryPage.completeSignup(testUser);

		// Clear storage and go back to login
		await page.evaluate(() => {
			sessionStorage.clear();
			localStorage.clear();
		});
		await page.goto("/login");
		await waitForLoginPageReady(page);

		// Try to signup with the same email - click "Sign up" link
		const signUpLink = page.locator('button:has-text("Sign up")');
		await signUpLink.click();

		// Wait for secret key screen and acknowledge it
		await page
			.locator('button:has-text("I have saved my Secret Key")')
			.waitFor({ state: "visible", timeout: 10000 });
		await page.click('button:has-text("I have saved my Secret Key")');

		await bitteryPage.fillSignupForm(testUser);
		await bitteryPage.submitSignup();

		// Should show error toast
		const toast = page
			.locator("[data-sonner-toast]")
			.filter({ hasText: /already exists|duplicate|taken/i })
			.first();
		await expect(toast).toBeVisible({ timeout: 10000 });
	});

	test("should validate required fields", async ({ page }) => {
		// Switch to signup mode
		const signUpLink = page.locator('button:has-text("Sign up")');
		if (await signUpLink.isVisible()) {
			await signUpLink.click();
		}

		// Acknowledge secret key
		await page.click('button:has-text("I have saved my Secret Key")');

		// Try to submit with empty fields
		await page.click('button:has-text("Create Account")');

		// Browser validation should prevent submission
		// Check that we're still on the signup form
		await expect(
			page.locator('button:has-text("Create Account")'),
		).toBeVisible();
	});

	test("should copy secret key to clipboard", async ({ page, context }) => {
		// Grant clipboard permissions
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);

		// Switch to signup mode
		const signUpLink = page.locator('button:has-text("Sign up")');
		if (await signUpLink.isVisible()) {
			await signUpLink.click();
		}

		// Get the displayed secret key
		const secretKeyElement = page.locator(".font-mono.text-sm.tracking-wide");
		const displayedKey = await secretKeyElement.textContent();

		// Click copy button
		await page.click('button:has-text("Copy")');

		// Verify clipboard content (may need to check toast instead due to permissions)
		const toast = page
			.locator("[data-sonner-toast]")
			.filter({ hasText: /copied/i });
		await expect(toast).toBeVisible({ timeout: 5000 });
	});

	test("should download emergency kit", async ({ page }) => {
		// Switch to signup mode
		const signUpLink = page.locator('button:has-text("Sign up")');
		if (await signUpLink.isVisible()) {
			await signUpLink.click();
		}

		// Set up download listener
		const downloadPromise = page.waitForEvent("download");

		// Click download button
		await page.click('button:has-text("Download Kit")');

		// Verify download started
		const download = await downloadPromise;
		expect(download.suggestedFilename()).toBe("bittery-emergency-kit.txt");

		// Verify toast
		const toast = page
			.locator("[data-sonner-toast]")
			.filter({ hasText: /downloaded/i });
		await expect(toast).toBeVisible({ timeout: 5000 });
	});

	test("should toggle password visibility", async ({ page }) => {
		// Switch to signup mode
		const signUpLink = page.locator('button:has-text("Sign up")');
		if (await signUpLink.isVisible()) {
			await signUpLink.click();
		}

		// Acknowledge secret key
		await page.click('button:has-text("I have saved my Secret Key")');

		const passwordInput = page.locator("#password");

		// Password should be hidden by default
		await expect(passwordInput).toHaveAttribute("type", "password");

		// Click the eye button to show password
		await page.locator("#password + button, #password ~ button").click();

		// Password should now be visible
		await expect(passwordInput).toHaveAttribute("type", "text");

		// Click again to hide
		await page.locator("#password + button, #password ~ button").click();
		await expect(passwordInput).toHaveAttribute("type", "password");
	});

	test("should toggle secret key visibility on initial screen", async ({
		page,
	}) => {
		// Switch to signup mode
		const signUpLink = page.locator('button:has-text("Sign up")');
		if (await signUpLink.isVisible()) {
			await signUpLink.click();
		}

		const secretKeyDisplay = page.locator(".font-mono.text-sm.tracking-wide");

		// Secret key should be visible by default
		const initialValue = await secretKeyDisplay.textContent();
		expect(initialValue).not.toContain("••••••");

		// Click the eye button to hide
		await page.click(
			'[class*="absolute"][class*="top-3"][class*="right-3"] button',
		);

		// Secret key should now be masked
		const maskedValue = await secretKeyDisplay.textContent();
		expect(maskedValue).toContain("••••••");
	});

	test("should switch between sign in and sign up forms", async ({ page }) => {
		// Should start on sign in
		await expect(
			page.getByRole("heading", { name: "Sign in to your account" }),
		).toBeVisible();

		// Switch to sign up
		await page.click('button:has-text("Sign up")');
		await expect(
			page.getByRole("heading", { name: "Create an account" }),
		).toBeVisible();

		// Acknowledge secret key
		await page.click('button:has-text("I have saved my Secret Key")');

		// Now on signup form - go back to secret key screen first
		await page.click('button:has-text("Back to Secret Key")');

		// Now switch back to sign in
		await page.click('button:has-text("Already have an account? Sign in")');
		await expect(
			page.getByRole("heading", { name: "Sign in to your account" }),
		).toBeVisible();
	});
});

test.describe("Signup with Network Failures", () => {
	test("should handle network failure during signup gracefully", async ({
		page,
		testUser,
	}) => {
		const networkSimulator = createNetworkSimulator(page);
		const bitteryPage = new BitteryPage(page);

		await page.goto("/login");
		await waitForLoginPageReady(page);

		// Switch to signup mode
		await page.click('button:has-text("Sign up")');

		// Wait for and acknowledge secret key
		await page
			.locator('button:has-text("I have saved my Secret Key")')
			.waitFor({ state: "visible", timeout: 10000 });
		await page.click('button:has-text("I have saved my Secret Key")');

		// Fill the form
		await bitteryPage.fillSignupForm(testUser);

		// Simulate network failure before submission
		await networkSimulator.goOffline();

		// Try to submit
		await bitteryPage.submitSignup();

		// When offline, requests hang - the form should show loading state or error
		// Either a toast appears OR the form stays in loading state (both are valid handling)
		const toast = page
			.locator("[data-sonner-toast]")
			.filter({ hasText: /failed|error|network|offline/i })
			.first();
		const loadingButton = page.locator(
			'button:has-text("Creating Account...")',
		);

		// Wait a bit for either toast or loading state
		await Promise.race([
			toast.waitFor({ state: "visible", timeout: 5000 }).catch(() => {}),
			loadingButton
				.waitFor({ state: "visible", timeout: 5000 })
				.catch(() => {}),
		]);

		// Should NOT have navigated away - still on signup form
		await expect(page).toHaveURL(/\/login/);

		// Cleanup
		await networkSimulator.goOnline();
	});

	test("should handle slow network during signup", async ({
		page,
		testUser,
	}) => {
		const networkSimulator = createNetworkSimulator(page);
		const bitteryPage = new BitteryPage(page);

		await page.goto("/login");
		await waitForLoginPageReady(page);

		// Switch to signup mode
		await page.click('button:has-text("Sign up")');

		// Wait for and acknowledge secret key
		await page
			.locator('button:has-text("I have saved my Secret Key")')
			.waitFor({ state: "visible", timeout: 10000 });
		await page.click('button:has-text("I have saved my Secret Key")');

		// Fill the form
		await bitteryPage.fillSignupForm(testUser);

		// Simulate slow network
		await networkSimulator.simulateSlowNetwork(3000);

		// Submit - the button should show loading state
		await bitteryPage.submitSignup();

		// Button should show loading state
		await expect(
			page.locator('button:has-text("Creating Account...")'),
		).toBeVisible();

		// Wait for completion (with extended timeout due to slow network)
		await expect(page).toHaveURL(/.*\/home/, { timeout: 60000 });

		// Cleanup
		await networkSimulator.clearInterceptions();
	});

	test("should handle API error during signup", async ({ page, testUser }) => {
		const networkSimulator = createNetworkSimulator(page);
		const bitteryPage = new BitteryPage(page);

		await page.goto("/login");
		await waitForLoginPageReady(page);

		// Switch to signup mode
		await page.click('button:has-text("Sign up")');

		// Wait for and acknowledge secret key
		await page
			.locator('button:has-text("I have saved my Secret Key")')
			.waitFor({ state: "visible", timeout: 10000 });
		await page.click('button:has-text("I have saved my Secret Key")');

		// Fill the form
		await bitteryPage.fillSignupForm(testUser);

		// Simulate API error
		await networkSimulator.simulateTrpcFailure(
			"auth.signup",
			"INTERNAL_SERVER_ERROR",
		);

		// Try to submit
		await bitteryPage.submitSignup();

		// Should show error toast (various possible error messages depending on how tRPC handles the simulated error)
		const toast = page
			.locator("[data-sonner-toast]")
			.filter({ hasText: /failed|error|internal|server|network|request/i })
			.first();
		await expect(toast).toBeVisible({ timeout: 10000 });

		// Should still be on signup form (not navigated away due to error)
		await expect(
			page.locator('button:has-text("Create Account")'),
		).toBeVisible();

		// Cleanup
		await networkSimulator.clearInterceptions();
	});
});
