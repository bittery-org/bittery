import { defineConfig, devices } from "@playwright/test";

/** Uses the separately leased API and Vite service; never starts or resets a Server. */
export default defineConfig({
	testDir: "./tests/e2e",
	testMatch: "native-legacy-readonly.spec.ts",
	workers: 1,
	retries: 0,
	reporter: [["list"]],
	timeout: 900_000,
	expect: { timeout: 30_000 },
	projects: [
		{
			name: "cloud",
			use: {
				...devices["Desktop Chrome"],
				baseURL: "http://localhost:3173",
				actionTimeout: 30_000,
				navigationTimeout: 60_000,
				video: "off",
			},
		},
	],
});
