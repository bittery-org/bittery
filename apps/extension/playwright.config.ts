import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
// Shared with apps/web so both harnesses start the API server with the same
// E2E-only rate-limit budgets. See that file for the rationale.
import { E2E_SERVER_RATE_LIMITS } from "../web/tests/e2e-server-env";

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
 * - Extension must be built: pnpm run build:release
 * - Database must be running: pnpm run db:start (from root)
 * - Server must be running or will be started automatically
 */

// This package is `"type": "module"`, so Playwright loads this config as ESM
// where `__dirname` does not exist.
const configDir = path.dirname(fileURLToPath(import.meta.url));

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
						`--disable-extensions-except=${path.resolve(configDir, "dist")}`,
						`--load-extension=${path.resolve(configDir, "dist")}`,
						"--no-sandbox",
					],
				},
			},
		},
	],
	webServer: [
		{
			// Start the API server. `dev` runs under cargo watch, which no CI
			// runner has and which buys nothing for a single non-interactive run,
			// so CI takes the plain `cargo run` path instead.
			command: process.env.CI
				? "cd ../server && pnpm run dev:once"
				: "cd ../server && pnpm run dev",
			url: "http://localhost:3000",
			reuseExistingServer: !process.env.CI,
			timeout: 120000,
			// E2E-only auth rate-limit budgets; a whole run comes from one IP.
			// See apps/web/tests/e2e-server-env.ts before changing/removing.
			env: E2E_SERVER_RATE_LIMITS,
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
