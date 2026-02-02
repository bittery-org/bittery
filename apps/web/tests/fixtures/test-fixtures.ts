/**
 * Playwright E2E Test Fixtures
 *
 * This file contains custom fixtures for E2E testing of the Bittery password manager.
 * It provides utilities for authentication, database cleanup, and test isolation.
 */

import { test as base, type Page } from "@playwright/test";
import { nanoid } from "nanoid";
import {
	waitForHomePageReady,
	waitForLoginPageReady,
	waitForVaultsPageReady,
} from "./network-helpers";

/**
 * Test user credentials interface
 */
export interface TestUser {
	email: string;
	password: string;
	secretKey: string;
	name: string;
	organizationName: string;
}

/**
 * Generate a unique test user for isolation
 */
export function generateTestUser(): TestUser {
	const uniqueId = nanoid(8);
	return {
		email: `e2e-test-${uniqueId}@test.bittery.com`,
		password: "TestPassword123!@#",
		secretKey: "", // Will be captured during signup
		name: `E2E Test User ${uniqueId}`,
		organizationName: `Test Org ${uniqueId}`,
	};
}

/**
 * Test item data for vault operations
 */
export interface TestLoginItem {
	title: string;
	url: string;
	username: string;
	password: string;
	notes?: string;
}

export interface TestSecureNote {
	title: string;
	note: string;
}

export interface TestCreditCard {
	title: string;
	cardholderName: string;
	cardNumber: string;
	expiryDate: string;
	cvv: string;
}

/**
 * Generate test item data
 */
export function generateTestLoginItem(): TestLoginItem {
	const uniqueId = nanoid(6);
	return {
		title: `Test Login ${uniqueId}`,
		url: `https://test-${uniqueId}.example.com`,
		username: `testuser_${uniqueId}`,
		password: `TestPass_${uniqueId}!@#`,
		notes: `Test notes for login item ${uniqueId}`,
	};
}

export function generateTestSecureNote(): TestSecureNote {
	const uniqueId = nanoid(6);
	return {
		title: `Test Secure Note ${uniqueId}`,
		note: `This is a secure note content for testing. ID: ${uniqueId}\n\nMulti-line content is supported.`,
	};
}

export function generateTestCreditCard(): TestCreditCard {
	const uniqueId = nanoid(6);
	return {
		title: `Test Credit Card ${uniqueId}`,
		cardholderName: "Test Cardholder",
		cardNumber: "4111111111111111", // Test Visa number
		expiryDate: "12/28",
		cvv: "123",
	};
}

/**
 * Custom test context with authenticated user
 */
export interface AuthenticatedFixtures {
	authenticatedPage: Page;
	testUser: TestUser;
}

/**
 * Page object for common operations
 */
export class BitteryPage {
	constructor(readonly page: Page) {}

	/**
	 * Navigate to the login page
	 */
	async goToLogin() {
		await this.page.goto("/login");
		await waitForLoginPageReady(this.page);
	}

	/**
	 * Navigate to the home page (requires authentication)
	 */
	async goToHome() {
		await this.page.goto("/home");
		await waitForHomePageReady(this.page);
	}

	/**
	 * Navigate to vaults page
	 */
	async goToVaults() {
		await this.page.goto("/vaults");
		await waitForVaultsPageReady(this.page);
	}

	/**
	 * Wait for toast message
	 */
	async waitForToast(text: string, timeout = 10000) {
		const toast = this.page
			.locator("[data-sonner-toast]")
			.filter({ hasText: text });
		await toast.waitFor({ state: "visible", timeout });
		return toast;
	}

	/**
	 * Dismiss all toasts
	 */
	async dismissToasts() {
		const toasts = this.page.locator("[data-sonner-toast]");
		const count = await toasts.count();
		for (let i = 0; i < count; i++) {
			const closeButton = toasts
				.nth(i)
				.locator('button[aria-label="Close toast"]');
			if (await closeButton.isVisible()) {
				await closeButton.click();
			}
		}
	}

	/**
	 * Fill and submit the signup form (step 1: acknowledge secret key)
	 */
	async acknowledgeSecretKey(): Promise<string> {
		// Wait for the secret key to be generated and displayed
		await this.page.waitForSelector("text=Your Secret Key", { timeout: 10000 });

		// Get the secret key
		const secretKeyElement = this.page.locator(
			".font-mono.text-sm.tracking-wide",
		);
		await secretKeyElement.waitFor({ state: "visible" });
		const secretKey = (await secretKeyElement.textContent()) || "";

		// Click the acknowledge button
		await this.page.click('button:has-text("I have saved my Secret Key")');

		return secretKey.trim();
	}

	/**
	 * Fill signup form fields (step 2: after acknowledging secret key)
	 */
	async fillSignupForm(
		user: Omit<TestUser, "secretKey">,
		accountType: "personal" | "organization" = "organization",
	) {
		// Fill server URL if it's empty or default
		const serverUrlInput = this.page.locator("#serverUrl");
		const currentValue = await serverUrlInput.inputValue();
		if (!currentValue || currentValue === "https://your-server.com") {
			await serverUrlInput.fill("http://localhost:3000");
		}

		// Fill the form fields
		await this.page.fill("#name", user.name);

		// Select account type
		if (accountType === "organization") {
			await this.page.click('button:has-text("Organization")');
			// Wait for organization name field to appear
			await this.page.waitForSelector("#organizationName", {
				state: "visible",
			});
			await this.page.fill("#organizationName", user.organizationName);
		} else {
			await this.page.click('button:has-text("Personal")');
		}

		await this.page.fill("#email", user.email);
		await this.page.fill("#password", user.password);
	}

	/**
	 * Submit signup form
	 */
	async submitSignup() {
		await this.page.click('button:has-text("Create Account")');
	}

	/**
	 * Complete full signup flow
	 */
	async completeSignup(user: Omit<TestUser, "secretKey">): Promise<string> {
		await this.goToLogin();

		// Switch to signup form if on sign in
		const signUpLink = this.page.locator('button:has-text("Sign up")');
		if (await signUpLink.isVisible()) {
			await signUpLink.click();
		}

		// Step 1: Acknowledge secret key
		const secretKey = await this.acknowledgeSecretKey();

		// Step 2: Fill and submit form
		await this.fillSignupForm(user);
		await this.submitSignup();

		// Wait for navigation to home
		await this.page.waitForURL("**/home", { timeout: 30000 });

		return secretKey;
	}

	/**
	 * Fill and submit the login form
	 */
	async login(email: string, password: string, secretKey: string) {
		await this.goToLogin();

		// Fill server URL
		const serverUrlInput = this.page.locator("#serverUrl");
		await serverUrlInput.fill("http://localhost:3000");

		// Fill login credentials
		await this.page.fill("#email", email);

		// Wait for secret key input to be ready (it may be dynamically shown)
		const secretKeyInput = this.page.locator("#secretKey");
		await secretKeyInput.waitFor({ state: "visible", timeout: 10000 });

		await secretKeyInput.fill(secretKey);
		await this.page.fill("#password", password);

		// Submit
		await this.page.click('button:has-text("Sign In")');

		// Wait for navigation
		await this.page.waitForURL("**/home", { timeout: 30000 });
	}

	/**
	 * Check if user is authenticated
	 */
	async isAuthenticated(): Promise<boolean> {
		try {
			await this.page.waitForURL("**/home", { timeout: 5000 });
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Logout current user
	 */
	async logout() {
		// Navigate to settings or find logout button
		const userMenu = this.page.locator('[data-testid="user-menu"]');
		if (await userMenu.isVisible()) {
			await userMenu.click();
			await this.page.click('button:has-text("Logout")');
		}
		await this.page.waitForURL("**/login", { timeout: 10000 });
	}
}

/**
 * Extended test with Bittery-specific fixtures
 */
export const test = base.extend<{
	bitteryPage: BitteryPage;
	testUser: TestUser;
}>({
	bitteryPage: async ({ page }, use) => {
		const bitteryPage = new BitteryPage(page);
		await use(bitteryPage);
	},
	testUser: async (_fixtures, use) => {
		const user = generateTestUser();
		await use(user);
	},
});

export { expect } from "@playwright/test";
