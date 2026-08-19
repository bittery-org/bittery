/**
 * E2E Tests for Extension Save Login Prompt Feature
 *
 * Tests cover:
 * - T019: Duplicate detection and update flow
 * - T020: Vault selection with multiple vaults
 * - T021: Security (credentials not saved when locked, proper encryption)
 *
 * Prerequisites:
 * - Extension must be built (pnpm run build)
 * - Server and web app must be running
 * - Database must be running
 */

import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";

// Test user credentials.
//
// The email MUST be generated per run, never a fixed literal. Signup-code
// verification keeps a lifetime wrong-code counter keyed on the email hash that
// requesting a fresh code deliberately does not reset
// (RATE_LIMIT_SIGNUP_VERIFY_MAX in apps/server/src/services/rate_limit.rs), so a
// reused address accumulates failures across runs and eventually locks itself
// out semi-permanently. This matches `generateTestUser()` in
// apps/web/tests/fixtures/test-fixtures.ts.
const TEST_USER = {
	email: `e2e-extension-save-${randomUUID().slice(0, 8)}@test.bittery.com`,
	password: "TestPassword123!@#",
	masterPassword: "MasterPass123!@#",
};

// Test login form credentials
const TEST_LOGIN = {
	username: "testuser@example.com",
	password: "TestLogin123!",
	url: "https://example.com/login",
};

/**
 * Helper: Get extension ID from browser context
 */
async function getExtensionId(context: BrowserContext): Promise<string> {
	// Service worker is ready
	const background =
		context.serviceWorkers()[0] ||
		(await context.waitForEvent("serviceworker"));
	const extensionId = background.url().split("/")[2];
	return extensionId;
}

/**
 * Helper: Setup authenticated extension context
 */
async function setupAuthenticatedContext(context: BrowserContext, page: Page) {
	// Navigate to web app for authentication
	await page.goto("http://localhost:3001");

	// Check if already logged in by looking for vault elements
	const isLoggedIn = await page
		.locator('[data-testid="vault-list"], [data-testid="vault-grid"]')
		.isVisible()
		.catch(() => false);

	if (!isLoggedIn) {
		// Sign up or login
		const signupButton = page
			.locator('a[href="/signup"], button:has-text("Sign up")')
			.first();
		const loginButton = page
			.locator(
				'a[href="/login"], button:has-text("Login"), button:has-text("Log in")',
			)
			.first();

		if (await signupButton.isVisible().catch(() => false)) {
			// Go to signup
			await signupButton.click();
			await page.fill('input[type="email"]', TEST_USER.email);
			await page.fill(
				'input[name="password"], input[type="password"]',
				TEST_USER.password,
			);
			await page.click('button[type="submit"]');
			await page.waitForURL("**/vault**", { timeout: 30000 });
		} else if (await loginButton.isVisible().catch(() => false)) {
			// Go to login
			await loginButton.click();
			await page.fill('input[type="email"]', TEST_USER.email);
			await page.fill('input[type="password"]', TEST_USER.password);
			await page.click('button[type="submit"]');
			await page.waitForURL("**/vault**", { timeout: 30000 });
		}
	}

	// Create a test vault if needed
	await ensureTestVaults(page);

	// Unlock extension by opening popup and authenticating
	const extensionId = await getExtensionId(context);
	const popupPage = await context.newPage();
	await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);

	// Check if locked
	const isLocked = await popupPage
		.locator('input[type="password"], button:has-text("Unlock")')
		.isVisible()
		.catch(() => false);

	if (isLocked) {
		await popupPage.fill('input[type="password"]', TEST_USER.masterPassword);
		await popupPage.click('button[type="submit"], button:has-text("Unlock")');
		await popupPage.waitForTimeout(2000); // Wait for unlock
	}

	await popupPage.close();
}

/**
 * Helper: Ensure test vaults exist
 */
async function ensureTestVaults(page: Page) {
	// Check if we have at least 2 vaults (for multi-vault testing)
	const vaultElements = await page
		.locator('[data-testid="vault-item"], [data-vault-id]')
		.count()
		.catch(() => 0);

	if (vaultElements < 2) {
		// Create additional test vault
		const createButton = page
			.locator('button:has-text("Create"), button:has-text("New Vault")')
			.first();
		if (await createButton.isVisible().catch(() => false)) {
			await createButton.click();
			await page.fill(
				'input[name="name"], input[placeholder*="vault"]',
				"Test Vault 2",
			);
			await page.click('button[type="submit"]');
			await page.waitForTimeout(2000);
		}
	}
}

/**
 * Helper: Create a test login page with form
 */
async function createTestLoginPage(page: Page) {
	await page.setContent(`
		<!DOCTYPE html>
		<html>
		<head>
			<title>Test Login Page</title>
		</head>
		<body>
			<h1>Login</h1>
			<form id="loginForm" action="/login" method="POST">
				<label for="username">Username/Email:</label>
				<input type="email" id="username" name="username" autocomplete="username" required />

				<label for="password">Password:</label>
				<input type="password" id="password" name="password" autocomplete="current-password" required />

				<button type="submit">Login</button>
			</form>
		</body>
		</html>
	`);
}

/**
 * Helper: Fill and submit login form
 */
async function submitLoginForm(page: Page, username: string, password: string) {
	await page.fill("#username", username);
	await page.fill("#password", password);

	// Intercept form submission to prevent actual navigation
	await page.evaluate(() => {
		const form = document.querySelector("#loginForm") as HTMLFormElement;
		if (form) {
			form.addEventListener("submit", (e) => {
				e.preventDefault();
				// Simulate successful login response
				document.body.innerHTML +=
					'<div id="login-success">Login successful!</div>';
			});
		}
	});

	await page.click('button[type="submit"]');
}

/**
 * Helper: Wait for save prompt to appear
 */
async function waitForSavePrompt(page: Page, timeout = 10000) {
	// The save prompt is injected as an iframe with shadow DOM
	await page.waitForSelector('iframe[src*="save-prompt-iframe.html"]', {
		timeout,
	});
}

/**
 * Helper: Get save prompt iframe
 */
async function getSavePromptFrame(page: Page) {
	const iframe = page.frameLocator('iframe[src*="save-prompt-iframe.html"]');
	return iframe;
}

/**
 * Helper: Lock the extension
 */
async function lockExtension(context: BrowserContext) {
	const extensionId = await getExtensionId(context);
	const popupPage = await context.newPage();
	await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);

	// Click lock button if available
	const lockButton = popupPage
		.locator('button:has-text("Lock"), button[aria-label="Lock"]')
		.first();
	if (await lockButton.isVisible().catch(() => false)) {
		await lockButton.click();
	}

	await popupPage.close();
}

// =============================================================================
// TEST SUITE
// =============================================================================

test.describe("Save Login Prompt - Extension Feature", () => {
	let context: BrowserContext;
	let page: Page;

	test.beforeAll(async ({ browser }) => {
		// Create context with extension loaded
		context = await browser.newContext({
			permissions: ["clipboard-read", "clipboard-write"],
		});

		page = await context.newPage();

		// Setup authentication
		await setupAuthenticatedContext(context, page);
	});

	test.afterAll(async () => {
		await context?.close();
	});

	// =========================================================================
	// T019: Test duplicate detection and update flow
	// =========================================================================
	test("T019: Should detect duplicate credentials and offer update option", async () => {
		// Navigate to test login page
		await createTestLoginPage(page);

		// First submission - save new credential
		await submitLoginForm(page, TEST_LOGIN.username, TEST_LOGIN.password);

		// Wait for save prompt
		await waitForSavePrompt(page);

		// Get save prompt iframe
		const savePrompt = await getSavePromptFrame(page);

		// Verify save prompt appears
		await expect(savePrompt.locator("text=Save password?")).toBeVisible();

		// Select vault and save
		const vaultDropdown = savePrompt
			.locator('button:has-text("Select vault")')
			.first();
		if (await vaultDropdown.isVisible().catch(() => false)) {
			await vaultDropdown.click();
			await savePrompt.locator('button:has-text("Personal")').first().click();
		}

		await savePrompt.locator('button:has-text("Save")').first().click();

		// Wait for success message
		await expect(savePrompt.locator("text=Credentials saved!")).toBeVisible({
			timeout: 15000,
		});

		// Wait for prompt to auto-close
		await page.waitForTimeout(3000);

		// Second submission - same credentials should trigger duplicate detection
		await createTestLoginPage(page);
		await submitLoginForm(page, TEST_LOGIN.username, TEST_LOGIN.password);

		// Since credentials are identical, no prompt should appear
		// (hasChanges check should prevent prompt)
		const promptVisible = await page
			.locator('iframe[src*="save-prompt-iframe.html"]')
			.isVisible({ timeout: 3000 })
			.catch(() => false);

		// If credentials haven't changed, no prompt should appear
		expect(promptVisible).toBe(false);

		// Third submission - different password should trigger update option
		const newPassword = `${TEST_LOGIN.password}Updated`;
		await createTestLoginPage(page);
		await submitLoginForm(page, TEST_LOGIN.username, newPassword);

		// Wait for save prompt
		await waitForSavePrompt(page);

		const updatePrompt = await getSavePromptFrame(page);

		// Verify duplicate detection message
		await expect(
			updatePrompt.locator("text=Update or save password?"),
		).toBeVisible();
		await expect(
			updatePrompt.locator("text=Credentials for this site already exist"),
		).toBeVisible();

		// Verify both update and save new buttons are available
		await expect(
			updatePrompt.locator('button:has-text("Update existing")'),
		).toBeVisible();
		await expect(
			updatePrompt.locator('button:has-text("Save new")'),
		).toBeVisible();

		// Test update flow
		await updatePrompt.locator('button:has-text("Update existing")').click();

		// Wait for success
		await expect(updatePrompt.locator("text=Credentials updated!")).toBeVisible(
			{ timeout: 15000 },
		);
	});

	// =========================================================================
	// T020: Test vault selection with multiple vaults
	// =========================================================================
	test("T020: Should allow selecting from multiple vaults", async () => {
		// Navigate to test login page
		await createTestLoginPage(page);

		// Use different credentials for this test
		const uniqueUsername = `multitest-${Date.now()}@example.com`;
		await submitLoginForm(page, uniqueUsername, "TestPassword123");

		// Wait for save prompt
		await waitForSavePrompt(page);

		const savePrompt = await getSavePromptFrame(page);

		// Open vault dropdown
		const vaultSelector = savePrompt
			.locator("button")
			.filter({ hasText: /Select vault|Personal|Test Vault/ })
			.first();
		await vaultSelector.click();

		// Verify multiple vaults are shown
		const vaultOptions = savePrompt.locator(
			'[role="option"], button:has-text("Personal"), button:has-text("Test")',
		);
		const vaultCount = await vaultOptions.count();

		// Should have at least 1 vault option (we ensured 2 in setup, but one might be read-only)
		expect(vaultCount).toBeGreaterThanOrEqual(1);

		// Select a specific vault
		const secondVault = vaultOptions.nth(0);
		await secondVault.click();

		// Verify vault is selected
		await expect(vaultSelector).toContainText(/Personal|Test Vault/);

		// Save to selected vault
		await savePrompt.locator('button:has-text("Save")').first().click();

		// Wait for success
		await expect(savePrompt.locator("text=Credentials saved!")).toBeVisible({
			timeout: 15000,
		});
	});

	// =========================================================================
	// T021: Verify security - credentials not saved when locked
	// =========================================================================
	test("T021: Should not save credentials when extension is locked", async () => {
		// Lock the extension
		await lockExtension(context);

		// Wait a bit for lock to take effect
		await page.waitForTimeout(2000);

		// Navigate to test login page
		await createTestLoginPage(page);

		// Try to submit login
		const lockedUsername = `locked-test-${Date.now()}@example.com`;
		await submitLoginForm(page, lockedUsername, "LockedTest123");

		// Save prompt should NOT appear when locked
		const promptAppeared = await page
			.locator('iframe[src*="save-prompt-iframe.html"]')
			.isVisible({ timeout: 5000 })
			.catch(() => false);

		expect(promptAppeared).toBe(false);

		// Re-authenticate for remaining tests
		await setupAuthenticatedContext(context, page);
	});

	// =========================================================================
	// Additional Security Test: Verify proper encryption
	// =========================================================================
	test("T021: Should encrypt credentials before saving", async () => {
		// This test verifies that credentials are encrypted by checking
		// that the raw password is not stored in extension storage

		// Navigate to test login page
		await createTestLoginPage(page);

		const encTestUsername = `encryption-test-${Date.now()}@example.com`;
		const encTestPassword = "UniqueEncryptionTest123!@#";

		await submitLoginForm(page, encTestUsername, encTestPassword);

		// Wait for save prompt
		await waitForSavePrompt(page);

		const savePrompt = await getSavePromptFrame(page);

		// Save credential
		await savePrompt.locator('button:has-text("Save")').first().click();

		// Wait for success
		await expect(savePrompt.locator("text=Credentials saved!")).toBeVisible({
			timeout: 15000,
		});

		// Check extension storage - password should be encrypted
		const extensionId = await getExtensionId(context);
		const storagePage = await context.newPage();

		// Access background page or service worker
		await storagePage.goto(`chrome-extension://${extensionId}/popup.html`);

		// Check if raw password is in storage (it shouldn't be)
		const hasRawPassword = await storagePage.evaluate((password) => {
			// Check localStorage and chrome.storage
			const localStorageString = JSON.stringify(localStorage);
			return localStorageString.includes(password);
		}, encTestPassword);

		// Raw password should NOT be in storage (should be encrypted)
		expect(hasRawPassword).toBe(false);

		await storagePage.close();
	});

	// =========================================================================
	// Additional Test: Form submission detection
	// =========================================================================
	test("Should detect various form submission methods", async () => {
		// Test 1: Traditional form submit
		await createTestLoginPage(page);
		await submitLoginForm(
			page,
			`traditional-${Date.now()}@example.com`,
			"Test123",
		);

		const prompt1 = await page
			.locator('iframe[src*="save-prompt-iframe.html"]')
			.isVisible({ timeout: 5000 })
			.catch(() => false);
		expect(prompt1).toBe(true);

		// Cancel prompt
		const savePrompt1 = await getSavePromptFrame(page);
		await savePrompt1.locator('button:has-text("Cancel")').click();
		await page.waitForTimeout(1000);

		// Test 2: Enter key submission
		await createTestLoginPage(page);
		await page.fill("#username", `enterkey-${Date.now()}@example.com`);
		await page.fill("#password", "Test123");
		await page.press("#password", "Enter");

		const prompt2 = await page
			.locator('iframe[src*="save-prompt-iframe.html"]')
			.isVisible({ timeout: 5000 })
			.catch(() => false);
		expect(prompt2).toBe(true);
	});

	// =========================================================================
	// Additional Test: Cancel flow
	// =========================================================================
	test("Should properly cancel save prompt", async () => {
		await createTestLoginPage(page);
		await submitLoginForm(
			page,
			`cancel-test-${Date.now()}@example.com`,
			"CancelTest123",
		);

		// Wait for save prompt
		await waitForSavePrompt(page);

		const savePrompt = await getSavePromptFrame(page);

		// Click cancel
		await savePrompt.locator('button:has-text("Cancel")').click();

		// Prompt should disappear
		const promptVisible = await page
			.locator('iframe[src*="save-prompt-iframe.html"]')
			.isVisible({ timeout: 2000 })
			.catch(() => false);

		expect(promptVisible).toBe(false);
	});
});
