import type { BrowserContext, Page } from "@playwright/test";
import { nanoid } from "nanoid";
import {
	expect,
	generateTestUser,
	signIn,
	signUp,
	type TestUser,
	test,
} from "../fixtures/auth";
import { waitForNetworkIdleExceptSSE } from "../fixtures/network-helpers";
import {
	createItem,
	createVault,
	itemRow,
	itemRowTitles,
	openVault,
} from "../fixtures/vault";

/**
 * Live sync between two devices of one account: a write in one browser context
 * reaches the other over the SSE stream, with no navigation, no refetch and no
 * refocus in between.
 *
 * ONE signup for the whole file. Both contexts are the *same* account - a second
 * signup would be a second user and would prove nothing - so each of them pays
 * one SRP sign-in, both in `beforeAll`, and every test reuses them. Item events
 * never invalidate a query key (`packages/sync/src/query-invalidation.ts`), so
 * there is nothing per test to reset: the receiving list is driven straight off
 * the vault repository's snapshot.
 *
 * The two contexts have separate localStorage, so `getOrCreateClientId` mints a
 * different `bittery_sync_client_id` in each - which is what makes them two
 * devices rather than one, and what the last test pins.
 */

/** Signup, two SRP sign-ins and the seed item. */
const SETUP_BUDGET_MS = 600000;

/** One sign-in's worth of headroom around a create and its propagation. */
const TEST_BUDGET_MS = 180000;

/**
 * A ping, `sync.getEventsSince`, `vault.getItem` and one WASM decrypt. Well past
 * the ~1s that costs, and well short of the 35s stale-connection reconnect - so
 * a failure here means the stream never delivered, not that it was slow.
 */
const SYNC_BUDGET_MS = 20000;

const suffix = nanoid(6);
const seedTitle = `Sync Seed ${suffix}`;
const fromWriterTitle = `Sync From A ${suffix}`;
const fromReaderTitle = `Sync From B ${suffix}`;

let user: TestUser;
let vaultId: string;
let writerContext: BrowserContext;
let readerContext: BrowserContext;
let writer: Page;
let reader: Page;

/** Put one context on the shared vault and wait for it to have hydrated. */
async function openSharedVault(page: Page, expectedTitle: string) {
	await openVault(page, vaultId);
	await waitForNetworkIdleExceptSSE(page);
	// Seeing an item that already existed proves this context finished its
	// bootstrap and holds the vault key, so anything it misses afterwards is the
	// stream's fault rather than a half-open session.
	await expect(itemRow(page, expectedTitle)).toBeVisible({ timeout: 60000 });
}

test.beforeAll(async ({ browser }) => {
	test.setTimeout(SETUP_BUDGET_MS);

	const setupContext = await browser.newContext();
	try {
		const setupPage = await setupContext.newPage();
		user = await signUp(setupPage, generateTestUser());
		vaultId = await createVault(setupPage, `Sync Vault ${suffix}`);
		await createItem(setupPage, "login", async (sheet) => {
			await sheet.locator("#title").fill(seedTitle);
			await sheet.locator("#username").fill(`sync_${suffix}`);
			await sheet.locator("#password").fill(`Sync-Pass-${suffix}!`);
		});
	} finally {
		await setupContext.close();
	}

	writerContext = await browser.newContext();
	readerContext = await browser.newContext();
	writer = await writerContext.newPage();
	reader = await readerContext.newPage();

	await signIn(writer, user);
	await signIn(reader, user);
	await openSharedVault(writer, seedTitle);
	await openSharedVault(reader, seedTitle);
});

test.afterAll(async () => {
	await writerContext?.close();
	await readerContext?.close();
});

test("an item created in one context reaches the other over SSE, with no navigation", async () => {
	test.setTimeout(TEST_BUDGET_MS);

	await createItem(writer, "login", async (sheet) => {
		await sheet.locator("#title").fill(fromWriterTitle);
		await sheet.locator("#username").fill(`writer_${suffix}`);
		await sheet.locator("#password").fill(`Writer-Pass-${suffix}!`);
	});

	// The receiving context is left exactly where it was: no reload, no click.
	await expect(itemRow(reader, fromWriterTitle)).toBeVisible({
		timeout: SYNC_BUDGET_MS,
	});
	// The delivered item decrypts, so the list renders its title rather than a
	// placeholder row.
	await expect(itemRow(reader, fromWriterTitle)).toHaveAttribute(
		"data-item-title",
		fromWriterTitle,
	);
});

test("the reverse direction works too, and the writing context does not duplicate its own item", async () => {
	test.setTimeout(TEST_BUDGET_MS);

	await createItem(reader, "login", async (sheet) => {
		await sheet.locator("#title").fill(fromReaderTitle);
		await sheet.locator("#username").fill(`reader_${suffix}`);
		await sheet.locator("#password").fill(`Reader-Pass-${suffix}!`);
	});

	await expect(itemRow(writer, fromReaderTitle)).toBeVisible({
		timeout: SYNC_BUDGET_MS,
	});

	// The server pings every open stream, the originator included, and an item
	// event carries no client id - so the writer re-fetches what it just wrote.
	// That upsert has to be idempotent, or the row appears twice.
	await expect(itemRow(reader, fromReaderTitle)).toHaveCount(1);
	await expect(itemRow(writer, fromReaderTitle)).toHaveCount(1);

	// Both contexts converge on the same three items.
	const expected = [seedTitle, fromWriterTitle, fromReaderTitle].sort();
	expect((await itemRowTitles(writer)).sort()).toEqual(expected);
	expect((await itemRowTitles(reader)).sort()).toEqual(expected);
});

test("the two contexts are two sync clients of one account", async () => {
	test.setTimeout(TEST_BUDGET_MS);

	const clientId = (page: Page) =>
		page.evaluate(() => localStorage.getItem("bittery_sync_client_id"));

	const writerClientId = await clientId(writer);
	const readerClientId = await clientId(reader);

	expect(writerClientId).toBeTruthy();
	expect(readerClientId).toBeTruthy();
	// A fresh context always mints its own client id, which is why it bootstraps
	// the whole vault instead of catching up from a cursor.
	expect(writerClientId).not.toBe(readerClientId);

	// One account, one vault: the sync above was two devices of one user, not two
	// users who happen to see the same names.
	expect(new URL(writer.url()).pathname).toBe(`/vaults/${vaultId}`);
	expect(new URL(reader.url()).pathname).toBe(`/vaults/${vaultId}`);
});
