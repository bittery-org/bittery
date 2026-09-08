import type { Browser } from "@playwright/test";

/**
 * Real Firefox signup spent 60 seconds in RSA generation alone and completed in 117 seconds.
 * Allow that existing cryptographic setup without changing any recovery assertion's deadline.
 */
export function recoverySetupBudget(browser: Browser, testTimeoutMs: number) {
	const firefox = browser.browserType().name() === "firefox";
	return {
		testTimeoutMs: testTimeoutMs + (firefox ? 120_000 : 0),
		signupOptions: firefox ? { timeoutMs: 180_000 } : {},
	};
}
