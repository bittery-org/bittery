import type { Browser, Page } from "@playwright/test";
import { nanoid } from "nanoid";
import {
	type AuthSnapshot,
	expect,
	RESTORE_BUDGET_MS,
	restoreSession,
	signUpForSpec,
	type TestUser,
	test,
} from "../fixtures/auth";
import { uiText } from "../fixtures/messages";
import {
	createItem,
	createVault,
	detailRow,
	itemRow,
	openItem,
	openVault,
} from "../fixtures/vault";

/**
 * The contract behind `restoreSession`: replaying one signed-in profile's
 * storage into a fresh browser context is worth the same as an SRP sign-in,
 * without the 600k-iteration PBKDF2 that dominates one.
 *
 * This file is what the rest of the suite leans on, so it pins the parts that
 * could rot silently: which store each value lives in, that a restored context
 * really talked to the server and really unwrapped the master unlock key, that
 * two restored contexts stay two sync devices, and that a restore stays cheap.
 *
 * The snapshot is taken straight after signup, *before* the vault exists - which
 * is how the migrated specs will use it, and which proves a snapshot does not
 * have to be refreshed every time the account gains data.
 */

/** One signup, one restore, and the seed vault plus item. */
const SETUP_BUDGET_MS = 300000;

/** A restore and a vault bootstrap, with a cold Vite route in between. */
const TEST_BUDGET_MS = 180000;

const suffix = nanoid(6);
const vaultName = `Restore Vault ${suffix}`;
const itemTitle = `Restore Item ${suffix}`;
const itemUsername = `restore_user_${suffix}`;

let user: TestUser;
let snapshot: AuthSnapshot;
let vaultId: string;
let seedPromise: Promise<void> | undefined;
const openedContexts: { close: () => Promise<void> }[] = [];

/** A fresh context restored from the snapshot, torn down after the file. */
async function restoredPage(browser: Browser): Promise<Page> {
	const context = await browser.newContext();
	openedContexts.push(context);
	const page = await context.newPage();
	await restoreSession(page, snapshot);
	return page;
}

test.beforeAll(async ({ browser }) => {
	test.setTimeout(SETUP_BUDGET_MS);

	({ user, snapshot } = await signUpForSpec(browser));
});

/** Create the ciphertext fixture only for scenarios that actually read it. */
async function ensureSeedData(browser: Browser): Promise<void> {
	if (seedPromise) return seedPromise;
	seedPromise = (async () => {
		// The seed data is written from a *restored* context, so the file also proves
		// a replayed session can create, not only read.
		const setupContext = await browser.newContext();
		try {
			const setupPage = await setupContext.newPage();
			await restoreSession(setupPage, snapshot);
			vaultId = await createVault(setupPage, vaultName);
			await createItem(setupPage, "login", async (sheet) => {
				await sheet.locator("#title").fill(itemTitle);
				await sheet.locator("#username").fill(itemUsername);
				await sheet.locator("#password").fill(`Restore-Pass-${suffix}!`);
			});
		} finally {
			await setupContext.close();
		}
	})();
	return seedPromise;
}

test.afterAll(async () => {
	await Promise.all(openedContexts.map((context) => context.close()));
});

test("the snapshot splits across the two stores exactly as tiers.ts declares", () => {
	// `captureAuthSnapshot` copies each store verbatim apart from the deliberate
	// `bittery_sync_` exclusion, so which bucket a key lands in here is which
	// store the app actually put it in.
	const accountId = snapshot.local.bittery_active_account ?? "";
	expect(accountId).not.toBe("");
	const accountKey = (name: string) => `bittery_account_${accountId}_${name}`;
	const accountsDocument = JSON.parse(
		snapshot.local.bittery_accounts_list ?? "",
	) as {
		version: number;
		accounts: Array<{ accountId: string }>;
	};
	const webAccountId = snapshot.local.bittery_web_account_id ?? null;
	const runtimeAccountId = snapshot.local.bittery_runtime_account_id ?? "";

	// Signup may reuse the pre-login id as its transitional Account. Runtime
	// authentication owns a distinct Account id and does not mirror its Session.
	expect(webAccountId === null || webAccountId === accountId).toBe(true);
	expect(accountsDocument.version).toBe(2);
	expect(accountsDocument.accounts.map((account) => account.accountId)).toEqual(
		[accountId],
	);
	// Runtime scope has its own pointer; deletion recovery state is absent in an
	// ordinary signed-in snapshot.
	expect(runtimeAccountId).not.toBe("");
	expect(runtimeAccountId).not.toBe(accountId);
	if (webAccountId !== null) expect(runtimeAccountId).not.toBe(webAccountId);
	expect(snapshot.local).not.toHaveProperty("bittery_account_deletion");

	const forbiddenCredentialSuffixes = [
		"jwt_token",
		"vault_keys",
		"encrypted_private_key",
		"session_data",
		"secret_key",
		"pinned_kdf_params",
		"last_biometric_auth",
	].map((name) => `_${name}`);
	for (const entries of [snapshot.local, snapshot.session]) {
		expect(
			Object.keys(entries)
				.filter((key) => key.startsWith("bittery_account_"))
				.filter((key) =>
					forbiddenCredentialSuffixes.some((suffix) => key.endsWith(suffix)),
				)
				.sort(),
		).toEqual([]);
	}
	for (const name of ["biometric_enabled", "server_url", "travel_mode_cache"]) {
		expect(snapshot.local).toHaveProperty(accountKey(name));
	}

	const runtimePrefix = "bittery:runtime:platform-storage:";
	const runtimeAccountPrefix = `${runtimePrefix}account:${new TextEncoder().encode(runtimeAccountId).byteLength}:${runtimeAccountId}:incarnation:`;
	const runtimeLocalKeys = Object.keys(snapshot.local).filter((key) =>
		key.startsWith(runtimePrefix),
	);
	const runtimeAccountLocalKeys = runtimeLocalKeys.filter((key) =>
		key.startsWith(runtimeAccountPrefix),
	);
	expect(runtimeLocalKeys).toContain(`${runtimePrefix}device-catalog`);
	expect(runtimeLocalKeys).toContain(`${runtimePrefix}device-key`);
	expect(runtimeLocalKeys).toHaveLength(4);
	expect(
		runtimeAccountLocalKeys.map((key) => key.split(":").at(-1)).sort(),
	).toEqual(["metadata", "quick-unlock"]);
	const runtimeSessionKeys = Object.keys(snapshot.session).filter((key) =>
		key.startsWith(runtimePrefix),
	);
	expect(runtimeSessionKeys).toHaveLength(1);
	expect(runtimeSessionKeys[0]?.startsWith(runtimeAccountPrefix)).toBe(true);
	expect(runtimeSessionKeys[0]?.endsWith(":current-session")).toBe(true);

	for (const key of [
		"bittery_device_key",
		"bittery_accounts_list",
		"bittery_active_account",
		"bittery_runtime_account_id",
	]) {
		expect(snapshot.local).toHaveProperty(key);
	}

	// A shared client id would make two restored contexts one sync device.
	const syncKeys = [
		...Object.keys(snapshot.local),
		...Object.keys(snapshot.session),
	].filter((key) => key.startsWith("bittery_sync_"));
	expect(syncKeys).toEqual([]);
});

test("a restored context is signed in, unlocked, and decrypts an item written elsewhere", async ({
	browser,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await ensureSeedData(browser);

	const page = await restoredPage(browser);
	expect(new URL(page.url()).pathname).toBe("/home");
	await expect(
		page.locator('[data-sidebar="footer"] [data-testid="user-menu"]'),
	).toContainText(user.email);

	await openVault(page, vaultId);
	// The title and the username are ciphertext on the server: rendering them is
	// the master unlock key coming back out of `session_data`, not a page that
	// merely looks logged in.
	await expect(itemRow(page, itemTitle)).toBeVisible();
	await openItem(page, itemTitle);
	await expect(
		detailRow(
			page.getByTestId("item-detail-pane"),
			uiText("vaults_detail_items_detail_login_field_username"),
		),
	).toContainText(itemUsername);
});

test("two concurrently restored contexts are two sync clients of one account", async ({
	browser,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	await ensureSeedData(browser);

	const [first, second] = await Promise.all([
		restoredPage(browser),
		restoredPage(browser),
	]);

	const clientId = (page: Page) =>
		page.evaluate(() => sessionStorage.getItem("bittery_sync_client_id"));
	await expect.poll(() => clientId(first)).toBeTruthy();
	await expect.poll(() => clientId(second)).toBeTruthy();
	// Restoring must not clone the sync identity; `sync.spec.ts` depends on a
	// fresh context minting its own.
	expect(await clientId(first)).not.toBe(await clientId(second));

	for (const page of [first, second]) {
		await openVault(page, vaultId);
		await expect(itemRow(page, itemTitle)).toBeVisible();
	}
});

test("a restore stays inside its budget", async ({ browser }) => {
	test.setTimeout(TEST_BUDGET_MS);

	const context = await browser.newContext();
	openedContexts.push(context);
	const page = await context.newPage();

	const startedAt = Date.now();
	await restoreSession(page, snapshot);
	const elapsedMs = Date.now() - startedAt;

	test
		.info()
		.annotations.push({ type: "restore-ms", description: String(elapsedMs) });
	expect(
		elapsedMs,
		`a restore should cost seconds, not a sign-in; took ${elapsedMs}ms`,
	).toBeLessThan(RESTORE_BUDGET_MS);
});
