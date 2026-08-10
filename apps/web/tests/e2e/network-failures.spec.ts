import type { BrowserContext, Locator, Page } from "@playwright/test";
import { nanoid } from "nanoid";
import {
	expect,
	generateTestUser,
	signIn,
	signUp,
	type TestUser,
	test,
} from "../fixtures/auth";
import {
	ApiErrors,
	createNetworkSimulator,
	type NetworkSimulator,
} from "../fixtures/network-helpers";
import {
	createItem,
	createVault,
	gotoRoute,
	itemRow,
	VAULT_READY_TIMEOUT_MS,
} from "../fixtures/vault";

/**
 * What the app does when the API misbehaves: unreachable, slow, failing once,
 * answering 500 / 503 / 429, and never answering at all.
 *
 * ONE signup for the whole file, on a throwaway context, and one context every
 * test then shares. Nothing here changes a credential, and the route
 * interceptions are per-page, so `clearInterceptions()` between tests puts the
 * page back to a working baseline for the price of one navigation.
 *
 * Every failure here is injected at the transport, never with `setOffline()`.
 * The web app is served by the Vite dev server on another port and code-splits
 * every route, so cutting the whole context off the network stops the route
 * chunk from ever loading: the app renders nothing and there is no offline
 * behaviour left to observe. Blocking the API origin is the condition being
 * tested - the server is gone, the client is not.
 */

/** The API the cloud project boots on; see `playwright.config.ts`. */
const API_ORIGIN = "http://localhost:3010";

/** Every request the app makes to the API. */
const API_URL_PATTERN = `${API_ORIGIN}/**`;

function isApiDataRequest(url: string): boolean {
	return new URL(url).pathname.startsWith("/api/v1/");
}

/** Signup, WASM key generation, the seed item and one SRP sign-in. */
const SETUP_BUDGET_MS = 420000;

/**
 * TanStack Query retries a failed query three times with a 1s/2s/4s backoff
 * before the cache's `onError` toasts, so every error surface here is ~7s of
 * retrying away even when the transport fails instantly.
 */
const ERROR_SURFACE_TIMEOUT_MS = 60000;

const suffix = nanoid(6);
const seedTitle = `Network Seed ${suffix}`;

let context: BrowserContext;
let page: Page;
let simulator: NetworkSimulator;
let vaultId: string;

/**
 * The toast Sonner marks with destructive text. `data-type` is always "default",
 * so the destructive child is the only thing that tells an error toast apart,
 * and `.first()` because one failed render can raise several.
 */
function errorToast(target: Page): Locator {
	return target
		.locator("[data-sonner-toast]")
		.filter({ has: target.locator(".text-destructive") })
		.first();
}

/**
 * Wait for the error toast and hover it.
 *
 * Sonner drops a toast four seconds after it appears and pauses that timer while
 * the pointer is over it, so hovering is what keeps a whole block of assertions
 * about one toast from racing its own dismissal.
 */
async function pinnedErrorToast(): Promise<Locator> {
	const toast = errorToast(page);
	await expect(toast).toBeVisible({ timeout: ERROR_SURFACE_TIMEOUT_MS });
	await toast.hover();
	return toast;
}

/**
 * The label the query cache hangs on every error toast (`apps/web/src/router.tsx`);
 * it is hardcoded there rather than translated.
 */
const RETRY_ACTION_LABEL = "retry";

/**
 * What the user is actually shown when the transport fails, whatever the cause.
 *
 * The API facade normalizes transport failures into the same UI error surface.
 */
const TRANSPORT_ERROR_MESSAGE = "malformed response from the API";

test.beforeAll(async ({ browser }) => {
	test.setTimeout(SETUP_BUDGET_MS);

	const setupContext = await browser.newContext();
	let user: TestUser;
	try {
		const setupPage = await setupContext.newPage();
		user = await signUp(setupPage, generateTestUser());
		vaultId = await createVault(setupPage, `Network Vault ${suffix}`);
		await createItem(setupPage, "login", async (sheet) => {
			await sheet.locator("#title").fill(seedTitle);
			await sheet.locator("#username").fill(`network_${suffix}`);
			await sheet.locator("#password").fill(`Network-Pass-${suffix}!`);
		});
	} finally {
		await setupContext.close();
	}

	context = await browser.newContext();
	page = await context.newPage();
	simulator = createNetworkSimulator(page);
	await signIn(page, user);
});

test.afterEach(async () => {
	await simulator.clearInterceptions();
	await page.unrouteAll({ behavior: "ignoreErrors" });
});

test.afterAll(async () => {
	await context?.close();
});

/** Prove the vault route works right now, which also clears any stale toast. */
async function expectVaultRouteHealthy(): Promise<void> {
	await gotoRoute(page, `/vaults/${vaultId}`, itemRow(page, seedTitle));
	await expect(itemRow(page, seedTitle)).toBeVisible();
	await expect(errorToast(page)).toHaveCount(0);
}

test("an unreachable API surfaces as an error toast with a retry action, and retrying recovers", async () => {
	test.setTimeout(SETUP_BUDGET_MS);
	await simulator.simulateDnsFailure(API_URL_PATTERN);

	// The error toast is the ready state here: with the API gone the vault route
	// has nothing to render, so waiting for its header would time out on what is
	// the expected outcome.
	await gotoRoute(page, `/vaults/${vaultId}`, errorToast(page));
	const toast = await pinnedErrorToast();
	await expect(toast).toContainText(TRANSPORT_ERROR_MESSAGE);

	const retry = toast.getByRole("button", { name: RETRY_ACTION_LABEL });
	await expect(retry).toBeVisible();

	// The retry action invalidates every query, so the same page recovers without
	// a reload once the API answers again.
	await simulator.clearInterceptions();
	await retry.click();
	await expect(itemRow(page, seedTitle)).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});
});

test("a slow API delays the route but never fails it", async () => {
	test.setTimeout(SETUP_BUDGET_MS);
	await simulator.simulateSlowNetwork(2000);

	const started = Date.now();
	await gotoRoute(page, `/vaults/${vaultId}`, itemRow(page, seedTitle));
	await expect(itemRow(page, seedTitle)).toBeVisible();

	// The delay was really applied: the route could not have rendered before its
	// first API round trip came back.
	expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
	// Latency is not an error, so nothing is reported as one.
	await expect(errorToast(page)).toHaveCount(0);
});

/** More than TanStack Query's three retries, so the burst always outlives them. */
const DROPPED_REQUEST_BURST = 4;

test("an intermittent drop is reported but does not cost the route its data, and the next navigation recovers", async () => {
	test.setTimeout(SETUP_BUDGET_MS);

	// `simulateIntermittentConnectivity` picks its victims with `Math.random`, so
	// the drops are placed by hand instead: the first few API calls of this
	// navigation fail, every later one is let through.
	let abortedRequests = 0;
	await page.route(API_URL_PATTERN, async (route) => {
		if (
			isApiDataRequest(route.request().url()) &&
			abortedRequests < DROPPED_REQUEST_BURST
		) {
			abortedRequests += 1;
			await route.abort("connectionfailed");
			return;
		}
		await route.continue();
	});

	await gotoRoute(page, `/vaults/${vaultId}`, itemRow(page, seedTitle));
	// Items are read from the encrypted local cache, so the route keeps its
	// contents even though the requests behind it were dropped.
	await expect(itemRow(page, seedTitle)).toBeVisible();
	// Without this the test would pass just as well with no failure injected.
	// Polled, not read once: the cached items render long before the 1s/2s/4s
	// retry backoff has spent the burst, so the count is still climbing here.
	await expect
		.poll(() => abortedRequests, { timeout: ERROR_SURFACE_TIMEOUT_MS })
		.toBe(DROPPED_REQUEST_BURST);

	// The drop is not swallowed either: the query cache reports it.
	const toast = await pinnedErrorToast();
	await expect(toast).toContainText(TRANSPORT_ERROR_MESSAGE);

	await simulator.clearInterceptions();
	await page.unrouteAll({ behavior: "ignoreErrors" });
	await expectVaultRouteHealthy();
});

for (const failure of [
	{ name: "500", error: "INTERNAL_SERVER_ERROR" },
	{ name: "503", error: "SERVICE_UNAVAILABLE" },
	{ name: "429", error: "RATE_LIMITED" },
] as const) {
	const expectedStatus = ApiErrors[failure.error].status;

	test(`an API answering ${failure.name} reaches the client and surfaces as an error toast`, async () => {
		test.setTimeout(SETUP_BUDGET_MS);
		await simulator.simulateApiFailure(API_URL_PATTERN, failure.error);

		const response = page.waitForResponse(
			(candidate) =>
				candidate.url().startsWith(API_ORIGIN) &&
				candidate.status() === expectedStatus,
			{ timeout: ERROR_SURFACE_TIMEOUT_MS },
		);
		await gotoRoute(page, `/vaults/${vaultId}`, errorToast(page));
		const toast = await pinnedErrorToast();
		expect((await response).status()).toBe(expectedStatus);

		// The status never reaches the copy: the client cannot tell a 500 from a
		// 429, so both read as the same transport failure.
		await expect(toast).toContainText(TRANSPORT_ERROR_MESSAGE);
		await expect(
			toast.getByRole("button", { name: RETRY_ACTION_LABEL }),
		).toBeVisible();
		// A server error is not an expired session: only a code the client reads as
		// UNAUTHORIZED clears the query cache and bounces to /login, and none of
		// these three do. Staying put is what keeps a 503 from signing a user out.
		await expect(page).toHaveURL(new RegExp(`/vaults/${vaultId}`));
	});
}

test("a request that never answers is not left hanging: it times out into the same error surface", async () => {
	test.setTimeout(SETUP_BUDGET_MS);
	const stallMs = 2000;
	await simulator.simulateEndpointTimeout("/api/v1/vaults", stallMs);

	const started = Date.now();
	await gotoRoute(page, `/vaults/${vaultId}`, errorToast(page));
	const toast = await pinnedErrorToast();
	await expect(toast).toContainText(TRANSPORT_ERROR_MESSAGE);

	// The request really hung rather than failing fast, so the surface below is
	// the timeout path and not an immediate rejection.
	expect(Date.now() - started).toBeGreaterThanOrEqual(stallMs);

	await simulator.clearInterceptions();
	await expectVaultRouteHealthy();
});
