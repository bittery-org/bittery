/**
 * Auth fixtures for the web E2E suite: unique test data plus signup / sign-in /
 * sign-out helpers that drive the real DOM, so a spec never has to know the
 * shape of the auth forms.
 */
import {
	type Browser,
	test as base,
	expect,
	type Locator,
	type Page,
} from "@playwright/test";
import { nanoid } from "nanoid";
import { mailOutboxNow, waitForCode } from "./mail-outbox";
import { uiText } from "./messages";
import { gotoRoute } from "./vault";

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
 * Generate a unique test user for isolation.
 *
 * The email must stay per-run unique - do not replace it with a fixed fixture
 * address. Signup-code verification keeps a *lifetime* wrong-code counter keyed
 * on the email hash which requesting a fresh code deliberately does not reset
 * (`RATE_LIMIT_SIGNUP_VERIFY_MAX`, see apps/server/src/services/rate_limit.rs),
 * so a reused address accumulates failures across runs until it is locked out.
 *
 * The address is lowercased because signup lowercases it before storing it, and
 * anything the server hands back - `data-member-email`, an invitation row - is
 * then matched by exact-value CSS selectors that would miss the original case.
 */
export function generateTestUser(): TestUser {
	const uniqueId = nanoid(8);
	return {
		email: `e2e-test-${uniqueId.toLowerCase()}@test.bittery.com`,
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

/** Cloud plan tile a signup starts from. */
export type SignUpPlan = "free" | "personal" | "family" | "team";

export interface SignUpOptions {
	/**
	 * Passed as `?plan=`, which skips the plan-selection step entirely - except
	 * for `team`, which has to walk that step to name the team.
	 */
	plan?: SignUpPlan;
	/** Budget for the whole flow; WASM key generation and SRP dominate it. */
	timeoutMs?: number;
	/**
	 * Runs after legacy signup has installed its authenticated Account but before
	 * the fixture performs the first full Runtime sign-in. Acceptance fixtures use
	 * this only to create Server authority that the initial Runtime Bootstrap must
	 * discover; it does not replace or shorten either authentication ceremony.
	 */
	beforeRuntimeSignIn?: (page: Page) => Promise<void>;
}

/** The Team tile's name in `packages/shared/src/pricing.ts`. */
const TEAM_PLAN_NAME = "Team";

/**
 * Vite's first paint of an auth route is slow enough to trip the default
 * expect timeout on a cold dev server.
 */
const COLD_START_TIMEOUT_MS = 60000;

/** The authed layout only exists once the account is unlocked. */
function appShell(page: Page): Locator {
	return page.locator("#app-scroll-area");
}

export async function waitForAppReady(page: Page): Promise<void> {
	await expect(appShell(page)).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
}

/**
 * The Secret Key is generated in the browser and never rendered, so
 * localStorage is the only place a spec can read it back from.
 * Key scheme: `packages/storage/src/keys.ts`.
 */
export async function readSecretKey(page: Page): Promise<string> {
	const deadline = Date.now() + 15000;
	for (;;) {
		const secretKey = await page.evaluate(() => {
			const suffix = "_secret_key";
			const stored = Object.keys(localStorage)
				.filter((key) => key.startsWith("bittery_account_"))
				.filter((key) => key.endsWith(suffix))
				.map((key) => ({
					accountId: key.slice("bittery_account_".length, -suffix.length),
					value: localStorage.getItem(key),
				}))
				.filter((entry): entry is { accountId: string; value: string } =>
					Boolean(entry.value),
				);
			if (stored.length === 0) {
				return null;
			}
			// A full sign-in mints a fresh accountId and leaves the previous
			// account's Secret Key behind, so the active pointer decides; the
			// single-entry fallback only covers a pointer that has not caught up.
			const activeAccountId = localStorage.getItem("bittery_active_account");
			const active = stored.find(
				(entry) => entry.accountId === activeAccountId,
			);
			if (active) {
				return active.value;
			}
			return stored.length === 1 ? (stored[0]?.value ?? null) : null;
		});
		if (secretKey) {
			return secretKey;
		}
		if (Date.now() >= deadline) {
			const keys = await page.evaluate(() => Object.keys(localStorage));
			throw new Error(
				`No Secret Key in localStorage - signup did not finish, or several accounts are stored and none is the active one.\nlocalStorage keys: ${JSON.stringify(keys, null, 2)}`,
			);
		}
		await page.waitForTimeout(250);
	}
}

/**
 * Complete cloud signup and land on `/home`.
 *
 * Returns the same user object with `secretKey` filled in, so the caller can
 * sign back in later - after a sign out the local copy is gone for good.
 */
export async function signUp(
	page: Page,
	user: TestUser = generateTestUser(),
	options: SignUpOptions = {},
): Promise<TestUser> {
	const plan = options.plan ?? "free";
	const timeout = options.timeoutMs ?? COLD_START_TIMEOUT_MS;

	// `?plan=` skips the plan step, and the team-name field only exists *on* that
	// step - a Team signup that skips it silently gets the default team name.
	const choosesTeamName = plan === "team";
	await page.goto(choosesTeamName ? "/signup" : `/signup?plan=${plan}`);
	const appOrigin = new URL(page.url()).origin;

	if (choosesTeamName) {
		await expect(
			page.getByRole("heading", { name: "Choose your plan" }),
		).toBeVisible({ timeout });
		// The plan tiles are unlabelled buttons and their names are hardcoded
		// English in `packages/shared/src/pricing.ts`, not message keys, so the
		// only tile whose text mentions Team is the one to click.
		await page.locator("button").filter({ hasText: TEAM_PLAN_NAME }).click();
		await page.locator("#organizationName").fill(user.organizationName);
		await page.getByRole("button", { name: "Continue" }).click();
	}

	await expect(
		page.getByRole("heading", { name: "Create your account" }),
	).toBeVisible({ timeout });

	await page.locator("#name").fill(user.name);
	await page.locator("#email").fill(user.email);
	await page.locator("#password").fill(user.password);

	// The gate and the disabled submit both read "Download Emergency Kit"; only
	// the gate carries this description.
	const emergencyKitGate = page
		.locator("button")
		.filter({ hasText: "Required before creating your account" });
	await expect(emergencyKitGate).toBeEnabled({ timeout });
	const download = page.waitForEvent("download").catch(() => null);
	await emergencyKitGate.click();
	await download;
	await expect(
		page.getByText("Your Secret Key & Recovery Key have been saved"),
	).toBeVisible({ timeout });

	const since = mailOutboxNow();
	await page.getByRole("button", { name: "Continue to verification" }).click();

	await expect(
		page.getByRole("heading", { name: "Verify your email" }),
	).toBeVisible({ timeout });

	const code = await waitForCode({
		purpose: "signup",
		email: user.email,
		since,
	});

	// One real input backs the six decorative slots.
	await page.locator("#signup-verification-step-code").fill(code);
	await page.getByRole("button", { name: "Verify code" }).click();

	// A paid plan hands straight off to Stripe checkout. Depending on the test
	// Stripe configuration that may stay on local /billing or reach the hosted
	// checkout page. The account and Team exist either way; only the subscription
	// is missing until the database fixture activates it.
	await page.waitForURL(
		plan === "free"
			? "**/home"
			: (url) =>
					url.pathname === "/billing" || url.hostname === "checkout.stripe.com",
		{ timeout },
	);
	if (plan !== "free") {
		await page.goto(new URL("/home", appOrigin).href);
		await page.waitForURL("**/home", { timeout });
	}
	// Signup installs the legacy browser account before the process-owned Rust
	// Runtime has authenticated it. The Runtime route guard therefore sends the
	// first visit through the existing password Quick Unlock ceremony. Complete
	// that real ceremony so this helper's promise (a usable signed-in page) stays
	// true while the migration has two installation moments.
	const unlockButton = page.getByRole("button", {
		name: "Unlock Vault",
		exact: true,
	});
	const needsRuntimeUnlock = await Promise.race([
		unlockButton.waitFor({ state: "visible", timeout }).then(() => true),
		appShell(page)
			.waitFor({ state: "visible", timeout })
			.then(() => false),
	]);
	let secretKey: string | undefined;
	if (needsRuntimeUnlock) {
		await options.beforeRuntimeSignIn?.(page);
		// A just-created legacy account has no Rust installation to quick-unlock yet.
		// Keep the Secret Key before switching the form, then perform the full Rust
		// Sign-in that creates that installation.
		secretKey = await readSecretKey(page);
		await switchToFullSignIn(page, timeout);
		await page.locator("#email").fill(user.email);
		await page.locator("#secretKey").fill(secretKey);
		await page.locator("#password").fill(user.password);
		await page.getByRole("button", { name: "Sign In", exact: true }).click();
		await page.waitForURL("**/home", { timeout });
	}
	await waitForAppReady(page);

	return { ...user, secretKey: secretKey ?? (await readSecretKey(page)) };
}

/**
 * Retire the locked account and converge on the full sign-in form.
 *
 * A Runtime refusal deliberately keeps the page in place. The first refusal
 * leaves the ordinary retry available; the second also exposes the labelled
 * browser-only escape. The signup fixture must drive that public contract
 * instead of assuming every press reloads the document.
 */
async function switchToFullSignIn(page: Page, timeout: number): Promise<void> {
	const fullSignIn = page.locator("#secretKey");
	const retry = page.getByTestId("use-different-account");
	const browserOnlyEscape = page.getByTestId("use-different-account-escape");
	const deadline = Date.now() + timeout;
	let action = retry;

	for (;;) {
		await action.click();
		// Let React publish the running state before accepting the same enabled
		// button as the settled retry from this attempt.
		await page.waitForTimeout(100);

		while (Date.now() < deadline) {
			if (await fullSignIn.isVisible()) {
				return;
			}
			if (
				(await browserOnlyEscape.isVisible()) &&
				(await browserOnlyEscape.isEnabled())
			) {
				action = browserOnlyEscape;
				break;
			}
			if ((await retry.isVisible()) && (await retry.isEnabled())) {
				action = retry;
				break;
			}
			await page.waitForTimeout(100);
		}

		if (Date.now() >= deadline) {
			throw new Error(
				"The account retirement neither reached full sign-in nor exposed a retry/escape before the signup timeout.",
			);
		}
	}
}

export interface SelfHostedSignUpOptions {
	/**
	 * The `/invite/$token` link this signup accepts. Without it the form is the
	 * bootstrap one at `/signup`, which only a server with no users at all
	 * still serves.
	 */
	inviteUrl?: string;
	/** Budget for the whole flow; WASM key generation and SRP dominate it. */
	timeoutMs?: number;
}

/**
 * Complete a signup against a self-hosted server, where `SelfHostedSignUpForm`
 * is what `/signup` and `/invite/$token` both render.
 *
 * A different form from the one `signUp()` drives, and a shorter flow: the
 * server reports `requiresEmailVerification: false` in self-hosted mode, so
 * there is no code to wait for and the outbox never receives one.
 */
export async function signUpSelfHosted(
	page: Page,
	user: TestUser = generateTestUser(),
	options: SelfHostedSignUpOptions = {},
): Promise<TestUser> {
	const timeout = options.timeoutMs ?? COLD_START_TIMEOUT_MS;
	const inviteUrl = options.inviteUrl;

	// Which form renders is decided by `registrationStatus`, which is undefined
	// on first paint - so the cloud plan step flashes before the swap. Anchoring
	// on the self-hosted heading is what waits that swap out.
	await gotoRoute(
		page,
		inviteUrl ?? "/signup",
		page.getByRole("heading", {
			name: uiText(
				inviteUrl
					? "auth_self_hosted_title_accept_invitation"
					: "auth_self_hosted_title_create_admin",
			),
		}),
	);

	const form = page.getByTestId("signup-form");
	await form.locator("#name").fill(user.name);
	if (inviteUrl) {
		// The invitation fixes the address, and the input is disabled.
		await expect(form.locator("#email")).toHaveValue(user.email);
	} else {
		await form.locator("#email").fill(user.email);
	}
	await form.locator("#password").fill(user.password);

	// Disabled until the Secret Key and Recovery Key the kit carries exist.
	const emergencyKit = page.getByTestId("emergency-kit-download-button");
	await expect(emergencyKit).toBeEnabled({ timeout });
	const download = page.waitForEvent("download").catch(() => null);
	await emergencyKit.click();
	await download;
	await expect(emergencyKit).toContainText(
		uiText("auth_signup_emergency_kit_saved_title"),
	);

	// The submit button stays disabled until the kit has been taken.
	const submit = page.getByTestId("signup-submit-button");
	await expect(submit).toBeEnabled({ timeout });
	await submit.click();

	// An invitation is accepted server-side as part of the signup, which is what
	// lands the new account on the team rather than on its own home.
	await page.waitForURL(inviteUrl ? "**/team" : "**/home", { timeout });
	await waitForAppReady(page);

	return { ...user, secretKey: await readSecretKey(page) };
}

/**
 * Full sign-in with email, Secret Key and master password.
 *
 * A context that still holds quick-unlock material renders the one-field
 * "Welcome back" form instead, which has no Secret Key input - use a fresh
 * browser context, or `signOut()` first.
 */
export async function signIn(page: Page, user: TestUser): Promise<void> {
	if (!user.secretKey) {
		throw new Error(
			"signIn() needs a Secret Key; use the user object returned by signUp().",
		);
	}

	await page.goto("/login");
	const secretKeyInput = page.locator("#secretKey");
	await expect(secretKeyInput).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });

	await page.locator("#email").fill(user.email);
	await secretKeyInput.fill(user.secretKey);
	await page.locator("#password").fill(user.password);
	await page.getByRole("button", { name: "Sign In", exact: true }).click();

	await page.waitForURL("**/home", { timeout: COLD_START_TIMEOUT_MS });
	await waitForAppReady(page);
}

/**
 * Sign out from the sidebar user menu. On web this also removes the account
 * from the device, so the next sign-in is a full one.
 */
export async function signOut(page: Page): Promise<void> {
	await page.getByTestId("user-menu").click();
	await page.getByTestId("sign-out-button").click();
	await expect(page.getByTestId("log-out-dialog")).toBeVisible();
	await page.getByTestId("log-out-confirm").click();
	await page.waitForURL("**/login", { timeout: COLD_START_TIMEOUT_MS });
}

/**
 * One browser profile's transitional and Runtime platform documents, split by
 * the Web Storage area that owns each value.
 */
export interface AuthSnapshot {
	local: Record<string, string>;
	session: Record<string, string>;
}

/**
 * Sync state is deliberately not part of a snapshot: two contexts sharing a
 * `bittery_sync_client_id` would be one device, and self-echo suppression would
 * stop being exercised. `sync.spec.ts` pins that the two ids differ.
 */
const SYNC_KEY_PREFIX = "bittery_sync_";

const RUNTIME_STORAGE_PREFIX = "bittery:runtime:platform-storage:";
const RUNTIME_ACTIVE_ACCOUNT_KEY = "bittery_runtime_account_id";

/**
 * Load-bearing as a pair with `bittery_device_key`: `session_data` carries the
 * master unlock key wrapped under it, so replaying one without the other logs
 * the page in and then fails every decrypt.
 */
const DEVICE_KEY = "bittery_device_key";

const ACTIVE_ACCOUNT_KEY = "bittery_active_account";

const ACCOUNTS_LIST_KEY = "bittery_accounts_list";

/**
 * Copy every transitional and Runtime value the profile holds, out of both stores.
 *
 * Throws unless the exact signed-in pointers and Runtime documents are present
 * in the expected store, so an ownership move fails here by name.
 */
export async function captureAuthSnapshot(page: Page): Promise<AuthSnapshot> {
	const snapshot = await page.evaluate(
		({ runtimePrefix, syncPrefix }) => {
			const copy = (store: Storage): Record<string, string> => {
				const entries: Record<string, string> = {};
				for (let index = 0; index < store.length; index += 1) {
					const key = store.key(index);
					if (
						(!key?.startsWith("bittery_") && !key?.startsWith(runtimePrefix)) ||
						key.startsWith(syncPrefix)
					) {
						continue;
					}
					const value = store.getItem(key);
					if (value !== null) {
						entries[key] = value;
					}
				}
				return entries;
			};
			return { local: copy(localStorage), session: copy(sessionStorage) };
		},
		{ runtimePrefix: RUNTIME_STORAGE_PREFIX, syncPrefix: SYNC_KEY_PREFIX },
	);
	assertSnapshotComplete(snapshot);
	return snapshot;
}

/**
 * The transitional Account whose metadata this snapshot names.
 * Runtime authentication has its own Account id and credential documents.
 */
function snapshotAccountId(snapshot: AuthSnapshot): string | null {
	return snapshot.local[ACTIVE_ACCOUNT_KEY] ?? null;
}

function assertSnapshotComplete(snapshot: AuthSnapshot): void {
	const transitionalAccountId = snapshotAccountId(snapshot);
	const runtimeAccountId = snapshot.local[RUNTIME_ACTIVE_ACCOUNT_KEY];
	const missing: string[] = [];

	if (!transitionalAccountId)
		missing.push(`localStorage: ${ACTIVE_ACCOUNT_KEY}`);
	if (!runtimeAccountId)
		missing.push(`localStorage: ${RUNTIME_ACTIVE_ACCOUNT_KEY}`);
	if (
		transitionalAccountId &&
		runtimeAccountId &&
		transitionalAccountId === runtimeAccountId
	) {
		missing.push("distinct transitional and Runtime Account ids");
	}

	if (!(DEVICE_KEY in snapshot.local)) {
		missing.push(`localStorage: ${DEVICE_KEY}`);
	}
	if (!(ACCOUNTS_LIST_KEY in snapshot.local)) {
		missing.push(`localStorage: ${ACCOUNTS_LIST_KEY}`);
	}
	for (const [storeName, entries, suffix] of [
		["localStorage", snapshot.local, "device-catalog"],
		["localStorage", snapshot.local, "device-key"],
		["localStorage", snapshot.local, "metadata"],
		["localStorage", snapshot.local, "quick-unlock"],
		["sessionStorage", snapshot.session, "current-session"],
	] as const) {
		const keys = Object.keys(entries).filter(
			(key) =>
				key.startsWith(RUNTIME_STORAGE_PREFIX) && key.endsWith(`:${suffix}`),
		);
		if (keys.length !== 1) {
			missing.push(`${storeName}: exactly one Runtime ${suffix} document`);
		}
	}

	if (missing.length > 0) {
		throw new Error(
			`captureAuthSnapshot: the page is not fully signed in, or a value moved between storage tiers.\nMissing:\n  ${missing.join("\n  ")}\nIf a value was moved on purpose, packages/storage/src/tiers.ts is the table to reconcile this list with.\nsessionStorage: ${JSON.stringify(Object.keys(snapshot.session))}\nlocalStorage: ${JSON.stringify(Object.keys(snapshot.local))}`,
		);
	}
}

/** Throwaway context, one signup, capture, close - the block copied into 14 specs. */
export async function signUpForSpec(
	browser: Browser,
	user: TestUser = generateTestUser(),
	options: SignUpOptions = {},
): Promise<{ user: TestUser; snapshot: AuthSnapshot }> {
	const context = await browser.newContext();
	try {
		const page = await context.newPage();
		const signedUp = await signUp(page, user, options);
		return { user: signedUp, snapshot: await captureAuthSnapshot(page) };
	} finally {
		await context.close();
	}
}

/**
 * Not `bittery_`-prefixed, so a snapshot captured from a restored context never
 * carries it back out.
 */
const RESTORE_SENTINEL_KEY = "__e2e_session_restored";

/**
 * What a restore is allowed to cost. Measured at ~5.5s against ~7s for the
 * sign-in it replaces on an idle cloud stack - nearly all of both is the app's
 * own boot rather than the KDF a restore skips. The headroom is for restores
 * that run concurrently; what this budget catches is a restore that has quietly
 * grown a whole second page load or a blocking derivation before first paint.
 */
export const RESTORE_BUDGET_MS = 20000;

/**
 * Signed-in and unlocked without re-running the KDF. Lands on /home (or
 * `options.route`).
 *
 * A restore is only ever a shortcut *past* the sign-in, never a replacement for
 * a test of it. See `apps/web/tests/CONTEXT.md`.
 */
export async function restoreSession(
	page: Page,
	snapshot: AuthSnapshot,
	options: { route?: string } = {},
): Promise<void> {
	await page.context().addInitScript(
		({ local, session, sentinel }) => {
			// about:blank has an opaque origin, where touching either store throws.
			if (!location.protocol.startsWith("http")) {
				return;
			}
			// Only the first document of a context gets seeded: a later navigation
			// would otherwise stamp the captured vault_keys / session_data back over
			// whatever this context has since become.
			if (sessionStorage.getItem(sentinel)) {
				return;
			}
			sessionStorage.setItem(sentinel, "1");
			for (const [key, value] of Object.entries(session)) {
				sessionStorage.setItem(key, value);
			}
			for (const [key, value] of Object.entries(local)) {
				if (localStorage.getItem(key) === null) {
					localStorage.setItem(key, value);
				}
			}
		},
		{ ...snapshot, sentinel: RESTORE_SENTINEL_KEY },
	);

	await gotoRoute(page, options.route ?? "/home", appShell(page));
	await assertServerAuthenticated(page, snapshot);
}

/**
 * Seeded storage alone would make a page *look* signed in. The two ways a
 * restore can be hollow are a token the server rejects - which bounces to
 * /login - and a master unlock key that never unwrapped, which leaves every
 * decrypt empty. The sidebar footer's email comes from `auth.me`, so it renders
 * only after a round trip the server accepted, and matching it against the
 * account the snapshot names proves it is the right session.
 */
async function assertServerAuthenticated(
	page: Page,
	snapshot: AuthSnapshot,
): Promise<void> {
	const { pathname } = new URL(page.url());
	if (pathname.startsWith("/login")) {
		throw new Error(
			`restoreSession: the app redirected to ${pathname} - the replayed session was rejected.`,
		);
	}

	const email = snapshotEmail(snapshot);
	await expect(
		page.locator('[data-sidebar="footer"] [data-testid="user-menu"]'),
		"the restored session never rendered an account email, so no authenticated round trip completed",
	).toContainText(email ?? "@", { timeout: COLD_START_TIMEOUT_MS });
}

/** The address the accounts list holds for the snapshot's active account. */
function snapshotEmail(snapshot: AuthSnapshot): string | null {
	const accountId = snapshotAccountId(snapshot);
	const raw = snapshot.local[ACCOUNTS_LIST_KEY];
	if (!accountId || !raw) {
		return null;
	}
	const parsed: unknown = JSON.parse(raw);
	const accounts = (parsed as { accounts?: unknown }).accounts;
	if (!Array.isArray(accounts)) {
		return null;
	}
	const account = accounts.find(
		(entry: unknown) =>
			(entry as { accountId?: unknown }).accountId === accountId,
	) as { email?: unknown } | undefined;
	return typeof account?.email === "string" ? account.email : null;
}

/**
 * Extended test with Bittery-specific fixtures
 */
export const test = base.extend<{ testUser: TestUser }>({
	// Playwright reads the first parameter's destructuring pattern to work out a
	// fixture's dependencies, so it must literally be a destructuring pattern.
	// A named parameter (`_fixtures`) makes Playwright reject the whole file at
	// load time ("First argument must use the object destructuring pattern"),
	// which collects zero tests from every spec that imports this module.
	// biome-ignore lint/correctness/noEmptyPattern: required by Playwright for a fixture with no dependencies
	testUser: async ({}, use) => {
		await use(generateTestUser());
	},
});

export { expect } from "@playwright/test";
