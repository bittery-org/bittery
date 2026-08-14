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

const API_SERVER_URL = "http://localhost:3000";
const WEB_APP_URL = "http://localhost:3001";

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
			env: {
				// E2E-only auth rate-limit budgets; a whole run comes from one IP.
				// See apps/web/tests/e2e-server-env.ts before changing/removing.
				...E2E_SERVER_RATE_LIMITS,
				// The spec signs a fresh user up through the UI. Without this the
				// server hard-errors on verification email delivery
				// (services/auth_email.rs), so the signup can never complete.
				BITTERY_ENABLE_DEV_AUTH_STUBS: "true",
				BITTERY_MODE: process.env.BITTERY_MODE ?? "self-hosted",
				CORS_ORIGIN: WEB_APP_URL,
				JWT_SECRET:
					process.env.JWT_SECRET ?? "e2e-jwt-secret-not-used-outside-tests",
			},
		},
		{
			// Start the web app (for authentication/setup)
			command: "cd ../web && pnpm run dev",
			url: WEB_APP_URL,
			reuseExistingServer: !process.env.CI,
			timeout: 120000,
			// apps/web has only a .env.example, so with nothing set here
			// VITE_SERVER_URL is undefined and both auth-server.ts and
			// api-client-factory.ts fall back to window.location.origin - the Vite
			// port, not the API. Every auth call would 404.
			env: {
				VITE_SERVER_URL: API_SERVER_URL,
				VITE_WEBAPP_URL: WEB_APP_URL,
				VITE_DISABLE_DEVTOOLS: "true",
			},
		},
	],
});
