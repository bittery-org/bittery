import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E Test Configuration for Bittery Extension
 *
 * Test Suites:
 * - save-login-prompt.spec.ts: Save login prompt feature
 *
 * Run tests:
 *   pnpm run test:e2e           - Run all E2E tests
 *   pnpm run test:e2e:ui        - Run with Playwright UI
 *   pnpm run test:e2e:headed    - Run in headed mode (see browser)
 *
 * Prerequisites:
 * - Extension must be built: pnpm run build
 * - Database must be running: pnpm run db:start (from root)
 * - Server must be running or will be started automatically
 */

export default defineConfig({
	testDir: "./tests/e2e",
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: 1, // Extensions need sequential testing
	reporter: [
		["list"],
		["html", { outputFolder: "playwright-report", open: "never" }],
	],
	timeout: 90000, // 90 second timeout for extension tests
	expect: {
		timeout: 15000, // 15 second timeout for expect assertions
	},
	use: {
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
		actionTimeout: 15000,
		navigationTimeout: 30000,
		// Extension will be loaded in test setup
	},
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				// Chrome/Chromium args for extension testing
				launchOptions: {
					args: [
						`--disable-extensions-except=${path.resolve(__dirname, "dist")}`,
						`--load-extension=${path.resolve(__dirname, "dist")}`,
						"--no-sandbox",
					],
				},
			},
		},
	],
	webServer: [
		{
			// Start the API server
			command: "cd ../server && pnpm run dev",
			url: "http://localhost:3000",
			reuseExistingServer: !process.env.CI,
			timeout: 120000,
		},
		{
			// Start the web app (for authentication/setup)
			command: "cd ../web && pnpm run dev",
			url: "http://localhost:3001",
			reuseExistingServer: !process.env.CI,
			timeout: 120000,
		},
	],
});
