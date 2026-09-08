import type {
	BrowserContext,
	Page,
	Request,
	Response,
	Route,
} from "@playwright/test";
import { nanoid } from "nanoid";
import {
	expect,
	generateTestUser,
	signIn,
	signUp,
	type TestUser,
	test,
} from "../fixtures/auth";
import { uiText } from "../fixtures/messages";
import { waitForPageReady } from "../fixtures/network-helpers";
import { createSyncTransportProxy } from "../fixtures/sync-transport-proxy";
import {
	createItem,
	createVault,
	itemRow,
	itemRowTitles,
	openItem,
	openItemMenu,
	openVault,
	VAULT_READY_TIMEOUT_MS,
} from "../fixtures/vault";

/**
 * Two independently signed-in Devices converge through Runtime-owned Sync. The
 * receiving page remains mounted and idle while the other Device writes.
 * Runtime's HTTP client identity, rather than retired per-tab Sync storage,
 * distinguishes their Sessions. No host query invalidation drives these lists.
 */

// Each test asserts over the list the previous ones wrote into, so a failure has
// to stop the run rather than resurface as a list mismatch further down.
test.describe.configure({ mode: "serial" });

/** Signup, two SRP sign-ins and the seed item. */
const SETUP_BUDGET_MS = 600000;

/** One sign-in's worth of headroom around a create and its propagation. */
const TEST_BUDGET_MS = 180000;

/** A bounded wait for another Device's change while the receiver stays idle. */
const SYNC_BUDGET_MS = 20000;

const suffix = nanoid(6);
const seedTitle = `Sync Seed ${suffix}`;
const fromWriterTitle = `Sync From A ${suffix}`;
const fromReaderTitle = `Sync From B ${suffix}`;
const deleteForeverTitle = `Sync Delete Forever ${suffix}`;

let user: TestUser;
let vaultId: string;
let seedItemId: string;
let writerContext: BrowserContext;
let readerContext: BrowserContext;
let readerTransport: Awaited<ReturnType<typeof createSyncTransportProxy>>;
let writer: Page;
let reader: Page;
let writerSync: ReturnType<typeof observeSyncTransport>;
let readerSync: ReturnType<typeof observeSyncTransport>;

/** Observe public transport identity and lifetime, never bearer headers or bodies. */
function observeSyncTransport(context: BrowserContext) {
	let clientId: string | null = null;
	let opened = 0;
	let bootstrapRequests = 0;
	const active = new Map<Request, number>();
	const onRequest = async (request: Request) => {
		const path = new URL(request.url()).pathname;
		if (!path.startsWith("/api/v1/sync/")) return;
		if (path === "/api/v1/sync/bootstrap") bootstrapRequests += 1;
		const identity = await request.headerValue("bittery-client-id");
		if (identity) clientId = identity;
	};
	const onResponse = (response: Response) => {
		if (
			new URL(response.url()).pathname !== "/api/v1/sync/events" ||
			response.status() !== 200
		)
			return;
		const request = response.request();
		active.set(request, ++opened);
	};
	const onRequestDone = (request: Request) => active.delete(request);
	context.on("requestfailed", onRequestDone);
	context.on("requestfinished", onRequestDone);
	context.on("request", onRequest);
	context.on("response", onResponse);
	return {
		snapshot: () => ({
			clientId,
			opened,
			bootstrapRequests,
			active: [...active.values()],
		}),
		dispose: () => {
			context.off("requestfailed", onRequestDone);
			context.off("requestfinished", onRequestDone);
			context.off("request", onRequest);
			context.off("response", onResponse);
		},
	};
}

async function waitForItemAuthority(page: Page, itemId: string) {
	await expect
		.poll(
			() =>
				page.evaluate(async (itemId) => {
					const modulePath = "/src/lib/crypto.ts";
					const { runtimeClient } = await import(/* @vite-ignore */ modulePath);
					const session = runtimeClient.session().getSnapshot();
					if (session.state !== "unlocked") return session.state;
					const snapshot = runtimeClient.items(session.accountId).getSnapshot();
					return snapshot.state === "ready"
						? snapshot.value.items.find(
								(item: { itemId: string }) => item.itemId === itemId,
							)?.status
						: snapshot.state;
				}, itemId),
			{ timeout: SYNC_BUDGET_MS },
		)
		.toBe("authoritative");
}

async function waitForStream(monitor: ReturnType<typeof observeSyncTransport>) {
	await expect
		.poll(() => monitor.snapshot().active.length, { timeout: SYNC_BUDGET_MS })
		.toBe(1);
}

/** Put one context on the shared vault and wait for it to have hydrated. */
async function openSharedVault(page: Page, expectedTitle: string) {
	await openVault(page, vaultId);
	await waitForPageReady(page);
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
		seedItemId = await createItem(setupPage, "login", async (sheet) => {
			await sheet.locator("#title").fill(seedTitle);
			await sheet.locator("#username").fill(`sync_${suffix}`);
			await sheet.locator("#password").fill(`Sync-Pass-${suffix}!`);
		});
		await waitForItemAuthority(setupPage, seedItemId);
	} finally {
		await setupContext.close();
	}

	writerContext = await browser.newContext();
	readerTransport = await createSyncTransportProxy();
	readerContext = await browser.newContext({
		proxy: { server: readerTransport.url },
	});
	writerSync = observeSyncTransport(writerContext);
	readerSync = observeSyncTransport(readerContext);
	writer = await writerContext.newPage();
	reader = await readerContext.newPage();

	await signIn(writer, user);
	await waitForStream(writerSync);
	// Signing in the second Device must finish while the first stream stays open.
	const writerStream = writerSync.snapshot().active;
	await signIn(reader, user);
	expect(writerSync.snapshot().active).toEqual(writerStream);
	await waitForStream(readerSync);
	await openSharedVault(writer, seedTitle);
	await openSharedVault(reader, seedTitle);
	await Promise.all([
		waitForItemAuthority(writer, seedItemId),
		waitForItemAuthority(reader, seedItemId),
	]);
});

test.afterAll(async () => {
	writerSync?.dispose();
	readerSync?.dispose();
	await writerContext?.close();
	await readerContext?.close();
	await readerTransport?.close();
});

test("an item created in one context reaches the other over SSE, with no navigation", async () => {
	test.setTimeout(TEST_BUDGET_MS);

	const heldWriterStream = writerSync.snapshot().active;
	const heldReaderStream = readerSync.snapshot().active;
	const writerBootstraps = writerSync.snapshot().bootstrapRequests;
	const readerBootstraps = readerSync.snapshot().bootstrapRequests;
	expect(heldWriterStream).toHaveLength(1);
	expect(heldReaderStream).toHaveLength(1);
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
	expect(writerSync.snapshot().active).toEqual(heldWriterStream);
	expect(readerSync.snapshot().active).toEqual(heldReaderStream);
	// An ordinary Item event reads that Item, without replacing the whole Replica.
	expect(writerSync.snapshot().bootstrapRequests).toBe(writerBootstraps);
	expect(readerSync.snapshot().bootstrapRequests).toBe(readerBootstraps);
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
	await expect
		.poll(async () => (await itemRowTitles(writer)).sort())
		.toEqual(expected);
	await expect
		.poll(async () => (await itemRowTitles(reader)).sort())
		.toEqual(expected);
});

test("starring and unstarring converge in both directions without navigation", async () => {
	test.setTimeout(TEST_BUDGET_MS);

	await openItem(writer, fromWriterTitle);
	await openItemMenu(writer);
	await writer.getByTestId("item-favorite-button").click();

	const favoritesHeading = (page: Page) =>
		page.getByText(
			uiText("vaults_detail_items_list_section_favorites", { count: 1 }),
		);
	await expect(favoritesHeading(reader)).toBeVisible({
		timeout: SYNC_BUDGET_MS,
	});

	await openItem(reader, fromWriterTitle);
	await openItemMenu(reader);
	await reader.getByTestId("item-favorite-button").click();

	await expect(favoritesHeading(writer)).toHaveCount(0, {
		timeout: SYNC_BUDGET_MS,
	});
});

test("the two contexts are two sync clients of one account", async () => {
	test.setTimeout(TEST_BUDGET_MS);

	await expect.poll(() => writerSync.snapshot().clientId).toBeTruthy();
	await expect.poll(() => readerSync.snapshot().clientId).toBeTruthy();
	expect(writerSync.snapshot().clientId).not.toBe(
		readerSync.snapshot().clientId,
	);

	// One account, one vault: the sync above was two devices of one user, not two
	// users who happen to see the same names.
	expect(new URL(writer.url()).pathname).toBe(`/vaults/${vaultId}`);
	expect(new URL(reader.url()).pathname).toBe(`/vaults/${vaultId}`);
});

test("Trash acknowledgement advances Delete Forever's If-Match and converges both clients", async () => {
	test.setTimeout(TEST_BUDGET_MS);

	await createItem(writer, "login", async (sheet) => {
		await sheet.locator("#title").fill(deleteForeverTitle);
		await sheet.locator("#username").fill(`delete_${suffix}`);
		await sheet.locator("#password").fill(`Delete-Pass-${suffix}!`);
	});
	await expect(itemRow(reader, deleteForeverTitle)).toBeVisible({
		timeout: SYNC_BUDGET_MS,
	});
	await openItem(writer, deleteForeverTitle);
	const itemId = await writer
		.getByTestId("item-detail-pane")
		.getAttribute("data-item-id");
	if (!itemId) {
		throw new Error("The synced Item has no id.");
	}

	type ObservedWrite = {
		operation: "trash" | "delete_forever";
		status: number;
		ifMatch: string | undefined;
		// The retained Operation outcome carries the version the effect reached, where the
		// response ETag used to. There is one representation of that fact, not two.
		kind: string | undefined;
		version: number | undefined;
	};
	const writes: ObservedWrite[] = [];
	const itemPath = `/api/v1/items/${itemId}`;
	const matchesItemWrite = (url: URL) =>
		url.pathname === itemPath || url.pathname === `${itemPath}/permanent`;
	const observeWrite = async (route: Route) => {
		const request = route.request();
		if (request.method() !== "DELETE") {
			await route.continue();
			return;
		}
		const requestHeaders = await request.allHeaders();
		// Read the real response before forwarding it: a late CDP body read can lose the
		// Worker's response while the optimistic UI navigates. No response bytes are changed.
		const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
		try {
			const outcome = (await response.json()) as {
				kind?: string;
				result?: { version?: number };
			};
			writes.push({
				operation: new URL(request.url()).pathname.endsWith("/permanent")
					? "delete_forever"
					: "trash",
				status: response.status(),
				ifMatch: requestHeaders["if-match"],
				kind: outcome.kind,
				version: outcome.result?.version,
			});
		} finally {
			await route.fulfill({ response });
		}
	};
	await writer.context().route(matchesItemWrite, observeWrite);

	try {
		await openItemMenu(writer);
		await writer.getByTestId("item-delete-button").click();
		await writer.getByTestId("delete-item-confirm-button").click();
		await expect(itemRow(writer, deleteForeverTitle)).toHaveCount(0);

		// Followed in-app rather than with `goto`: the row disappears optimistically,
		// so a reload here tears the page down while the trash write is still being
		// acknowledged, and the queue restored from storage resends a command the
		// server has already applied. Its idempotency key makes that replay a no-op -
		// at-least-once delivery working as intended - but it is not what this test is
		// about, and CI is slow enough to lose that race every time.
		await writer
			.getByRole("link", { name: uiText("vaults_sidebar_link_trash") })
			.first()
			.click();
		await writer.waitForURL("**/vaults/trash");
		const deleteForever = writer.locator(
			`[data-testid="trash-delete-forever-button"][data-item-id="${itemId}"]`,
		);
		await expect(deleteForever).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await reader
			.getByRole("link", {
				name: uiText("vaults_sidebar_link_trash"),
				exact: true,
			})
			.click();
		await expect(reader).toHaveURL(/\/vaults\/trash$/);
		await expect(
			reader.locator(
				`[data-testid="trash-delete-forever-button"][data-item-id="${itemId}"]`,
			),
		).toBeVisible({ timeout: SYNC_BUDGET_MS });

		await deleteForever.click();
		await writer
			.getByRole("dialog")
			.getByRole("button", {
				name: uiText("vaults_trash_delete_dialog_action_confirm"),
			})
			.click();

		await expect.poll(() => writes.length, { timeout: SYNC_BUDGET_MS }).toBe(2);
		expect(writes).toEqual([
			{
				operation: "trash",
				status: 200,
				ifMatch: '"1"',
				kind: "trash_item",
				version: 2,
			},
			{
				operation: "delete_forever",
				status: 200,
				ifMatch: '"2"',
				kind: "permanently_delete_item",
				version: 3,
			},
		]);

		await expect(
			reader.locator(
				`[data-testid="trash-delete-forever-button"][data-item-id="${itemId}"]`,
			),
		).toHaveCount(0, { timeout: SYNC_BUDGET_MS });
	} finally {
		await writer.context().unroute(matchesItemWrite, observeWrite);
	}
});

test("a dropped stream reconnects and catches an event committed while the receiver is offline", async () => {
	test.setTimeout(TEST_BUDGET_MS);
	await openSharedVault(writer, seedTitle);
	await openSharedVault(reader, seedTitle);
	await waitForStream(readerSync);
	const before = readerSync.snapshot();
	const readerUrl = reader.url();
	const title = `Sync offline ${suffix}`;
	try {
		readerTransport.setOffline(true);
		await expect
			.poll(() => readerSync.snapshot().active.length, {
				timeout: SYNC_BUDGET_MS,
			})
			.toBe(0);
		const itemId = await createItem(writer, "login", async (sheet) => {
			await sheet.locator("#title").fill(title);
			await sheet.locator("#username").fill(`offline_${suffix}`);
		});
		await waitForItemAuthority(writer, itemId);
		await expect(itemRow(reader, title)).toHaveCount(0);
		readerTransport.setOffline(false);
		await expect
			.poll(() => readerSync.snapshot().opened, { timeout: SYNC_BUDGET_MS })
			.toBeGreaterThan(before.opened);
		await waitForStream(readerSync);
		await expect(itemRow(reader, title)).toBeVisible({
			timeout: SYNC_BUDGET_MS,
		});
		await expect(itemRow(reader, title)).toHaveCount(1);
		expect(reader.url()).toBe(readerUrl);
		expect(readerSync.snapshot().clientId).toBe(before.clientId);
	} finally {
		readerTransport.setOffline(false);
	}
});

test("Lock releases the held stream and real Quick Unlock resumes live reception", async () => {
	test.setTimeout(TEST_BUDGET_MS);
	await openSharedVault(writer, seedTitle);
	await openSharedVault(reader, seedTitle);
	await waitForStream(readerSync);
	await reader.evaluate(async () => {
		const modulePath = "/src/lib/crypto.ts";
		const { runtimeClient } = await import(/* @vite-ignore */ modulePath);
		const session = runtimeClient.session().getSnapshot();
		if (session.state !== "unlocked")
			throw new Error("Reader Account is not unlocked");
		await runtimeClient.lock(session.accountId);
	});
	await expect
		.poll(() => readerSync.snapshot().active.length, {
			timeout: SYNC_BUDGET_MS,
		})
		.toBe(0);
	const afterLock = readerSync.snapshot();
	const lockedTitle = `Sync while locked ${suffix}`;
	const itemId = await createItem(writer, "login", async (sheet) => {
		await sheet.locator("#title").fill(lockedTitle);
		await sheet.locator("#username").fill(`locked_${suffix}`);
	});
	await waitForItemAuthority(writer, itemId);
	expect(readerSync.snapshot().active).toEqual([]);
	expect(readerSync.snapshot().opened).toBe(afterLock.opened);
	await reader.getByTestId("vault-unlock-button").click();
	await reader.waitForURL("**/login", { timeout: VAULT_READY_TIMEOUT_MS });
	await expect(
		reader.getByRole("button", { name: "Unlock Vault", exact: true }),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	await reader.locator("#password").fill(user.password);
	await reader
		.getByRole("button", { name: "Unlock Vault", exact: true })
		.click();
	await reader.waitForURL("**/home", { timeout: VAULT_READY_TIMEOUT_MS });
	await openSharedVault(reader, lockedTitle);
	await waitForStream(readerSync);
	expect(readerSync.snapshot().opened).toBeGreaterThan(afterLock.opened);
	expect(readerSync.snapshot().clientId).toBe(afterLock.clientId);
	const title = `Sync after unlock ${suffix}`;
	const readerUrl = reader.url();
	await createItem(writer, "login", async (sheet) => {
		await sheet.locator("#title").fill(title);
		await sheet.locator("#username").fill(`unlocked_${suffix}`);
	});
	await expect(itemRow(reader, title)).toBeVisible({ timeout: SYNC_BUDGET_MS });
	expect(reader.url()).toBe(readerUrl);
});
