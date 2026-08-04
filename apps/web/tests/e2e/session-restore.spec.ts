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
});

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

	for (const name of ["jwt_token", "vault_keys", "encrypted_private_key"]) {
		expect(snapshot.session).toHaveProperty(accountKey(name));
		expect(snapshot.local).not.toHaveProperty(accountKey(name));
	}

	for (const name of [
		"session_data",
		"secret_key",
		"pinned_kdf_params",
		"server_url",
	]) {
		expect(snapshot.local).toHaveProperty(accountKey(name));
		expect(snapshot.session).not.toHaveProperty(accountKey(name));
	}

	for (const key of [
		"bittery_device_key",
		"bittery_accounts_list",
		"bittery_active_account",
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

	const [first, second] = await Promise.all([
		restoredPage(browser),
		restoredPage(browser),
	]);

	const clientId = (page: Page) =>
		page.evaluate(() => localStorage.getItem("bittery_sync_client_id"));
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
