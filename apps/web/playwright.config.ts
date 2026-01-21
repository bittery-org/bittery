import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E Test Configuration for Bittery Web App
 *
 * Test Suites:
 * - signup.spec.ts: User registration flow
 * - vault-items.spec.ts: Vault item viewing and management
 * - sharing.spec.ts: Password sharing functionality
 * - network-failures.spec.ts: Network resilience testing
 *
 * Run tests:
 *   pnpm run test:e2e           - Run all E2E tests
 *   pnpm run test:e2e:ui        - Run with Playwright UI
 *   pnpm run test:e2e:headed    - Run in headed mode (see browser)
 *
 * Prerequisites:
 * - Database must be running: pnpm run db:start
 * - Server must be running or will be started automatically
 */

export default defineConfig({
	testDir: "./tests/e2e",
	fullyParallel: false, // Run tests serially to avoid conflicts with shared test users
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0, // Retry once locally for flaky tests
	workers: process.env.CI ? 1 : 4, // Use 2 workers locally for faster runs
	reporter: [
		["list"],
		["html", { outputFolder: "playwright-report", open: "never" }],
	],
	timeout: 60000, // 60 second timeout for tests (SRP auth is slow)
	expect: {
		timeout: 10000, // 10 second timeout for expect assertions
	},
	use: {
		baseURL: "http://localhost:3001",
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
		actionTimeout: 15000, // 15 seconds for actions
		navigationTimeout: 30000, // 30 seconds for navigation
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
		// Uncomment to test on Firefox
		// {
		// 	name: "firefox",
		// 	use: { ...devices["Desktop Firefox"] },
		// },
		// Uncomment to test on Safari
		// {
		// 	name: "webkit",
		// 	use: { ...devices["Desktop Safari"] },
		// },
	],
	webServer: [
		{
			// Start the API server
			command: "cd ../server && pnpm run dev",
			url: "http://localhost:3000",
			reuseExistingServer: !process.env.CI,
			timeout: 120000, // 2 minutes to start server
		},
		{
			// Start the web app
			command: "pnpm run dev",
			url: "http://localhost:3001",
			reuseExistingServer: !process.env.CI,
			timeout: 120000, // 2 minutes to start web app
		},
	],
});
