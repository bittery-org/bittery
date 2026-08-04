/**
 * Network simulation helpers for E2E testing
 *
 * Provides utilities for simulating network conditions like:
 * - Network failures
 * - Slow connections
 * - Intermittent connectivity
 * - API error responses
 */

import type { Page, Request, Route } from "@playwright/test";

type RouteMatcher = string | RegExp;

const RPC_ROUTE_PATTERN = /\/rpc(?:\/|\?|$)/;

const API_ROUTE_PATTERNS: readonly RegExp[] = [RPC_ROUTE_PATTERN];

function isApiRequestUrl(url: string): boolean {
	return API_ROUTE_PATTERNS.some((pattern) => pattern.test(url));
}

function requestMatchesProcedure(
	request: Pick<Request, "url" | "postData">,
	procedureName: string,
): boolean {
	const url = request.url();
	if (!RPC_ROUTE_PATTERN.test(url)) {
		return false;
	}

	const postData = request.postData();
	return typeof postData === "string" && postData.includes(procedureName);
}

/**
 * Network condition presets
 */
export const NetworkConditions = {
	OFFLINE: {
		offline: true,
		latency: 0,
		downloadThroughput: 0,
		uploadThroughput: 0,
	},
	SLOW_3G: {
		offline: false,
		latency: 400,
		downloadThroughput: (500 * 1024) / 8,
		uploadThroughput: (500 * 1024) / 8,
	},
	FAST_3G: {
		offline: false,
		latency: 100,
		downloadThroughput: (1.6 * 1024 * 1024) / 8,
		uploadThroughput: (750 * 1024) / 8,
	},
	SLOW_WIFI: {
		offline: false,
		latency: 50,
		downloadThroughput: (2 * 1024 * 1024) / 8,
		uploadThroughput: (1 * 1024 * 1024) / 8,
	},
};

/**
 * API error responses for testing error handling
 */
export const ApiErrors = {
	INTERNAL_SERVER_ERROR: {
		status: 500,
		body: { error: "Internal Server Error" },
	},
	UNAUTHORIZED: { status: 401, body: { error: "Unauthorized" } },
	FORBIDDEN: { status: 403, body: { error: "Forbidden" } },
	NOT_FOUND: { status: 404, body: { error: "Not Found" } },
	RATE_LIMITED: { status: 429, body: { error: "Too Many Requests" } },
	BAD_REQUEST: { status: 400, body: { error: "Bad Request" } },
	SERVICE_UNAVAILABLE: { status: 503, body: { error: "Service Unavailable" } },
};

/**
 * Hold a route open for `delayMs`, then settle it.
 *
 * Teardown unroutes the page, and that settles whatever routes are still in
 * flight - including this one, still inside its sleep. The late `continue` or
 * `abort` then throws `Route is already handled!` from a handler no test is
 * awaiting, so it lands on whichever test happens to be running by then. There
 * is nothing left to do about a route someone else already settled.
 */
async function settleAfterDelay(
	delayMs: number,
	settle: () => Promise<void>,
): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, delayMs));
	try {
		await settle();
	} catch {}
}

/**
 * Network failure simulator class
 */
export class NetworkSimulator {
	private interceptedRoutes: Set<RouteMatcher> = new Set();

	constructor(private page: Page) {}

	private async routeApiRequests(
		handler: (route: Route) => Promise<void> | void,
	): Promise<void> {
		for (const pattern of API_ROUTE_PATTERNS) {
			this.interceptedRoutes.add(pattern);
			await this.page.route(pattern, handler);
		}
	}

	private async routeProcedureRequests(
		procedureName: string,
		handler: (route: Route) => Promise<void> | void,
	): Promise<void> {
		const routePattern = RPC_ROUTE_PATTERN;
		this.interceptedRoutes.add(routePattern);

		await this.page.route(routePattern, async (route) => {
			if (!requestMatchesProcedure(route.request(), procedureName)) {
				await route.continue();
				return;
			}

			await handler(route);
		});
	}

	/**
	 * Go offline - block all network requests
	 */
	async goOffline() {
		await this.page.context().setOffline(true);
	}

	/**
	 * Go online - restore network connectivity
	 */
	async goOnline() {
		await this.page.context().setOffline(false);
	}

	/**
	 * Simulate slow network by adding delay to all API requests
	 */
	async simulateSlowNetwork(delayMs = 2000) {
		await this.routeApiRequests(async (route) => {
			await settleAfterDelay(delayMs, () => route.continue());
		});
	}

	/**
	 * Simulate intermittent connectivity - randomly fail requests
	 */
	async simulateIntermittentConnectivity(failureRate = 0.3) {
		await this.routeApiRequests(async (route) => {
			if (Math.random() < failureRate) {
				await route.abort("connectionfailed");
			} else {
				await route.continue();
			}
		});
	}

	/**
	 * Simulate specific API endpoint failure
	 */
	async simulateApiFailure(
		endpointPattern: string,
		error: keyof typeof ApiErrors = "INTERNAL_SERVER_ERROR",
	) {
		this.interceptedRoutes.add(endpointPattern);

		await this.page.route(endpointPattern, async (route) => {
			const errorResponse = ApiErrors[error];
			await route.fulfill({
				status: errorResponse.status,
				contentType: "application/json",
				body: JSON.stringify(errorResponse.body),
			});
		});
	}

	/**
	 * Simulate RPC endpoint failure for a specific procedure.
	 */
	async simulateRpcFailure(
		procedureName: string,
		error: keyof typeof ApiErrors = "INTERNAL_SERVER_ERROR",
	) {
		await this.routeProcedureRequests(procedureName, async (route) => {
			const errorResponse = ApiErrors[error];
			await route.fulfill({
				status: errorResponse.status,
				contentType: "application/json",
				body: JSON.stringify({
					error: {
						message: errorResponse.body.error,
						code: error,
					},
				}),
			});
		});
	}

	/**
	 * Simulate network timeout
	 */
	async simulateTimeout(endpointPattern: string, timeoutMs = 30000) {
		this.interceptedRoutes.add(endpointPattern);

		await this.page.route(endpointPattern, async (route) => {
			await settleAfterDelay(timeoutMs, () => route.abort("timedout"));
		});
	}

	/**
	 * Simulate network timeout for a specific RPC procedure.
	 */
	async simulateProcedureTimeout(procedureName: string, timeoutMs = 30000) {
		await this.routeProcedureRequests(procedureName, async (route) => {
			await settleAfterDelay(timeoutMs, () => route.abort("timedout"));
		});
	}

	/**
	 * Intercept and modify API responses
	 */
	async interceptApiResponse(
		endpointPattern: string,
		modifier: (response: any) => any,
	) {
		this.interceptedRoutes.add(endpointPattern);

		await this.page.route(endpointPattern, async (route) => {
			const response = await route.fetch();
			const json = await response.json();
			const modifiedJson = modifier(json);
			await route.fulfill({
				response,
				body: JSON.stringify(modifiedJson),
			});
		});
	}

	/**
	 * Track all API requests for assertion
	 */
	async trackApiRequests(): Promise<
		{ method: string; url: string; body?: any }[]
	> {
		const requests: { method: string; url: string; body?: any }[] = [];

		this.page.on("request", (request) => {
			if (isApiRequestUrl(request.url())) {
				const postData = request.postData();
				let parsedBody: unknown;
				if (postData) {
					try {
						parsedBody = JSON.parse(postData);
					} catch {
						parsedBody = postData;
					}
				}
				requests.push({
					method: request.method(),
					url: request.url(),
					body: parsedBody,
				});
			}
		});

		return requests;
	}

	/**
	 * Wait for specific API call
	 */
	async waitForApiCall(procedureName: string, timeout = 10000): Promise<void> {
		await this.page.waitForResponse(
			(response) => requestMatchesProcedure(response.request(), procedureName),
			{ timeout },
		);
	}

	/**
	 * Clear all route interceptions
	 */
	async clearInterceptions() {
		for (const pattern of this.interceptedRoutes) {
			await this.page.unroute(pattern);
		}
		this.interceptedRoutes.clear();
		await this.goOnline();
	}

	/**
	 * Simulate DNS failure
	 */
	async simulateDnsFailure(hostPattern = "*") {
		this.interceptedRoutes.add(hostPattern);

		await this.page.route(hostPattern, async (route) => {
			await route.abort("namenotresolved");
		});
	}

	/**
	 * Simulate connection reset
	 */
	async simulateConnectionReset(endpointPattern: string) {
		this.interceptedRoutes.add(endpointPattern);

		await this.page.route(endpointPattern, async (route) => {
			await route.abort("connectionreset");
		});
	}

	/**
	 * Simulate connection reset for a specific RPC procedure.
	 */
	async simulateProcedureConnectionReset(procedureName: string) {
		await this.routeProcedureRequests(procedureName, async (route) => {
			await route.abort("connectionreset");
		});
	}
}

/**
 * Create a network simulator for the given page
 */
export function createNetworkSimulator(page: Page): NetworkSimulator {
	return new NetworkSimulator(page);
}

/**
 * Helper to wait for network idle state
 */
export async function waitForNetworkIdle(
	page: Page,
	timeout = 5000,
): Promise<void> {
	await page.waitForLoadState("networkidle", { timeout });
}

/**
 * @deprecated Use waitForPageReady() or specific DOM-based waits instead.
 * This function exists for backward compatibility but should be replaced
 * with more reliable DOM-based waiting strategies.
 */
export async function waitForNetworkIdleExceptSSE(
	page: Page,
	_timeout = 30000,
): Promise<void> {
	await page.waitForLoadState("load");
	// Wait for React hydration by checking for interactive elements
	await page.waitForFunction(
		() => {
			return (
				document.readyState === "complete" &&
				!document.querySelector('[data-loading="true"]')
			);
		},
		{ timeout: _timeout },
	);
}

/**
 * Wait for page to be ready by checking for common loading indicators.
 * This is a more reliable approach than fixed timeouts.
 */
export async function waitForPageReady(
	page: Page,
	options: {
		timeout?: number;
		/** Selector that indicates loading is complete (e.g., main content) */
		readySelector?: string;
		/** Selectors that indicate loading is in progress */
		loadingSelectors?: string[];
	} = {},
): Promise<void> {
	const {
		timeout = 30000,
		readySelector,
		loadingSelectors = [
			'[data-loading="true"]',
			'[class*="skeleton"]',
			'[class*="animate-pulse"]',
			'[aria-busy="true"]',
		],
	} = options;

	await page.waitForLoadState("domcontentloaded");

	// Wait for any loading indicators to disappear
	for (const selector of loadingSelectors) {
		const element = page.locator(selector).first();
		if (await element.isVisible({ timeout: 100 }).catch(() => false)) {
			await element.waitFor({ state: "hidden", timeout }).catch(() => {
				// Loading indicator might have already disappeared
			});
		}
	}

	// If a ready selector is provided, wait for it
	if (readySelector) {
		await page.locator(readySelector).waitFor({ state: "visible", timeout });
	}
}

/**
 * Wait for login page to be ready
 */
export async function waitForLoginPageReady(
	page: Page,
	timeout = 10000,
): Promise<void> {
	await page.waitForLoadState("domcontentloaded");
	// Wait for the email input to be visible (always present on login page)
	await page.locator("#email").waitFor({
		state: "visible",
		timeout,
	});
}

/**
 * Wait for signup form to be ready (after acknowledging secret key)
 */
export async function waitForSignupFormReady(
	page: Page,
	timeout = 10000,
): Promise<void> {
	await page.locator("#name").waitFor({ state: "visible", timeout });
}

/**
 * Wait for secret key screen to be ready
 */
export async function waitForSecretKeyScreenReady(
	page: Page,
	timeout = 10000,
): Promise<void> {
	// Use the heading which is unique on the page
	await page.getByRole("heading", { name: "Save your Secret Key" }).waitFor({
		state: "visible",
		timeout,
	});
}

/**
 * Wait for vaults page to be ready
 */
export async function waitForVaultsPageReady(
	page: Page,
	timeout = 15000,
): Promise<void> {
	await page.waitForLoadState("domcontentloaded");
	// Wait for either the vaults header or a vault link to appear
	await page
		.locator(
			'h1:has-text("Vaults"), h2:has-text("Vaults"), a[href*="/vaults/"]',
		)
		.first()
		.waitFor({
			state: "visible",
			timeout,
		});
}

/**
 * Wait for vault detail page to be ready
 */
export async function waitForVaultDetailReady(
	page: Page,
	timeout = 15000,
): Promise<void> {
	await page.waitForLoadState("domcontentloaded");
	// Wait for the Items tab to appear (always present on vault detail)
	await page.getByRole("tab", { name: "Items" }).waitFor({
		state: "visible",
		timeout,
	});
}

/**
 * Wait for home page to be ready after login/signup
 */
export async function waitForHomePageReady(
	page: Page,
	timeout = 15000,
): Promise<void> {
	await page.waitForURL("**/home", { timeout });
	await page.waitForLoadState("domcontentloaded");
}

/**
 * Wait for a toast notification to appear
 */
export async function waitForToast(
	page: Page,
	textPattern: RegExp | string,
	timeout = 10000,
): Promise<void> {
	const toast = page.locator("[data-sonner-toast]").filter({
		hasText: typeof textPattern === "string" ? textPattern : textPattern,
	});
	await toast.waitFor({ state: "visible", timeout });
}

/**
 * Wait for a dialog/modal to be visible
 */
export async function waitForDialog(
	page: Page,
	timeout = 10000,
): Promise<void> {
	await page.locator('[role="dialog"]').waitFor({ state: "visible", timeout });
}

/**
 * Wait for a dialog/modal to close
 */
export async function waitForDialogClosed(
	page: Page,
	timeout = 10000,
): Promise<void> {
	await page.locator('[role="dialog"]').waitFor({ state: "hidden", timeout });
}

/**
 * Wait for share page to load (either shows content or error)
 */
export async function waitForSharePageReady(
	page: Page,
	timeout = 15000,
): Promise<void> {
	await page.waitForLoadState("domcontentloaded");
	// Wait for either the share content, loading, or error state
	await page
		.locator("text=Share Link Not Found")
		.or(page.locator("text=Link Not Available"))
		.or(page.locator("text=Loading shared item"))
		.or(page.locator('[class*="animate-spin"]'))
		.or(page.locator('button:has-text("Go Home")'))
		.first()
		.waitFor({ state: "visible", timeout })
		.catch(() => {
			// If none of the expected elements appear, that's fine - page may have loaded successfully
		});
}

/**
 * Helper to check if page has pending network requests
 */
export async function hasPendingRequests(page: Page): Promise<boolean> {
	// This is a workaround since Playwright doesn't expose pending request count directly
	const navigationPromise = page.waitForLoadState("networkidle", {
		timeout: 100,
	});
	try {
		await navigationPromise;
		return false;
	} catch {
		return true;
	}
}
