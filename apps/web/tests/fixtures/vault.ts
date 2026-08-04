/**
 * Vault and item helpers for the vault E2E specs: they drive the real sidebar,
 * the create-item sheet and the detail pane, so a spec spells out only what it
 * actually asserts.
 */
import {
	expect,
	type Locator,
	type Page,
	type TestInfo,
	test,
} from "@playwright/test";

/** The categories the create-item sheet offers, spelled as their testid suffix. */
export type ItemCategory =
	| "login"
	| "totp"
	| "secure-note"
	| "credit-card"
	| "identity";

/**
 * Bootstrapping a vault after a sign-in means fetching and decrypting every
 * item, which is well past the default expect timeout on a cold dev server.
 *
 * Sized for the worst case rather than the typical one: a browser context that
 * has never talked to this Vite dev server refetches the whole module graph,
 * and the dev server itself gets slower the longer a suite run goes on. A tight
 * budget here does not fail an assertion, it reports a route that never
 * rendered - which reads exactly like a product bug.
 */
export const VAULT_READY_TIMEOUT_MS = 60000;

/** The toast carrying this copy; `.first()` because one action can raise several. */
export function toastWithText(page: Page, text: string): Locator {
	return page.locator("[data-sonner-toast]").filter({ hasText: text }).first();
}

/** The sidebar entry for one vault - the link itself, not its wrapper. */
export function vaultNavLink(page: Page, vaultId: string): Locator {
	return page.locator(
		`[data-testid="vault-nav-link"][data-vault-id="${vaultId}"]`,
	);
}

/**
 * The `...` menu on a sidebar vault entry, which carries no testid: it lives in
 * the entry wrapper that has the vault's link as its direct child.
 */
export function vaultMenuTrigger(page: Page, vaultId: string): Locator {
	return page
		.locator(
			`div:has(> [data-testid="vault-nav-link"][data-vault-id="${vaultId}"])`,
		)
		.getByRole("button");
}

/** One item row, addressed by the title the list renders. */
export function itemRow(page: Page, title: string): Locator {
	return page.locator(
		`[data-testid="item-row"][data-item-title="${cssAttributeValue(title)}"]`,
	);
}

/** The titles the item list currently shows, top to bottom. */
export function itemRowTitles(page: Page): Promise<(string | null)[]> {
	return page
		.getByTestId("item-row")
		.evaluateAll((rows) =>
			rows.map((row) => row.getAttribute("data-item-title")),
		);
}

/**
 * One row of the item detail pane, found from its field label: the rows carry
 * no testid, and the label is the only text that identifies them.
 */
export function detailRow(pane: Locator, label: string): Locator {
	return pane
		.getByText(label, { exact: true })
		.locator('xpath=ancestor::div[contains(@class,"group/frow")][1]');
}

/**
 * Reveal a concealed value, proving the row was hidden first and shown after.
 *
 * The eye button carries no accessible name, so the icon it renders is what
 * distinguishes it - and what states which way the toggle currently points.
 */
export async function revealValue(row: Locator): Promise<void> {
	await expect(row.locator("button:has(svg.lucide-eye)")).toHaveCount(1);
	await row.locator("button:has(svg.lucide-eye)").click();
	await expect(row.locator("button:has(svg.lucide-eye-off)")).toHaveCount(1);
}

/** Create a vault from the sidebar and return its id, taken from the URL. */
export async function createVault(
	page: Page,
	name: string,
	options: { iconLabel?: string } = {},
): Promise<string> {
	// The sidebar that owns this button only exists under /vaults.
	await gotoRoute(page, "/vaults", page.getByTestId("new-vault-button"));
	await page.getByTestId("new-vault-button").click();
	const dialog = page.getByTestId("create-vault-dialog");
	await expect(dialog).toBeVisible();
	await dialog.locator("#name").fill(name);
	if (options.iconLabel) {
		await dialog.getByRole("button", { name: options.iconLabel }).click();
	}
	await page.getByTestId("create-vault-submit-button").click();
	await expect(dialog).toBeHidden();

	// Creating navigates to the new vault, whose detail header is the only place
	// the new-item button exists.
	await expect(page.getByTestId("new-item-button")).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});
	return vaultIdFromUrl(page);
}

/**
 * How long one navigation attempt gets before it is retried. The last attempt
 * gets `VAULT_READY_TIMEOUT_MS` instead, so a route that is merely slow is
 * never reloaded out from under itself.
 */
const ROUTE_ATTEMPT_TIMEOUT_MS = 20000;

/** Navigations before `gotoRoute` gives up and asserts. */
const ROUTE_ATTEMPTS = 3;

/**
 * The budget one navigation gets under `E2E_STRICT_ROUTES=1`, where the retry
 * loop is off entirely - short enough that a stalled chunk fails rather than
 * being waited out.
 */
const STRICT_ROUTE_TIMEOUT_MS = 15000;

/**
 * Record that a route had to be re-issued, so the count of `route-retry`
 * annotations in the JSON report measures how much the dev server is
 * struggling. Without it a passing run cannot be told apart from one that
 * passed only because this helper absorbed a 20-second stall.
 */
function recordRouteRetry(url: string): void {
	let info: TestInfo;
	try {
		info = test.info();
	} catch {
		// The only way `test.info()` throws is with no test to attach the
		// annotation to; the retry it would have recorded still happens.
		return;
	}
	info.annotations.push({ type: "route-retry", description: url });
}

/**
 * Navigate to a route and wait for the element that proves it rendered,
 * reloading in between if it does not.
 *
 * The router code-splits every route, so a navigation fetches that route's
 * chunk from the Vite dev server - and late in a long serial run that dev
 * server occasionally never answers. The document still loads, so nothing
 * throws: the router simply sits on an empty outlet until the test times out,
 * which reads exactly like a product bug. Reloading re-issues those requests.
 *
 * The retries are bounded and the last attempt asserts unconditionally, so a
 * route that genuinely never renders still fails - and says where the page
 * ended up, which is what tells a stalled chunk apart from an unexpected
 * redirect.
 *
 * `E2E_STRICT_ROUTES=1` drops the retries and asserts on the first attempt,
 * which is how the papering-over gets switched off to see the raw truth.
 */
export async function gotoRoute(
	page: Page,
	url: string,
	ready: Locator,
): Promise<void> {
	await page.goto(url);

	if (process.env.E2E_STRICT_ROUTES === "1") {
		await expect(
			ready,
			`${url} never rendered; the page ended up at ${page.url()}`,
		).toBeVisible({ timeout: STRICT_ROUTE_TIMEOUT_MS });
		return;
	}

	for (let attempt = 1; attempt < ROUTE_ATTEMPTS; attempt += 1) {
		const rendered = await ready
			.waitFor({ state: "visible", timeout: ROUTE_ATTEMPT_TIMEOUT_MS })
			.then(
				() => true,
				() => false,
			);
		if (rendered) {
			return;
		}
		recordRouteRetry(url);
		await page.reload();
	}

	await expect(
		ready,
		`${url} never rendered; the page ended up at ${page.url()}`,
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
}

/** Open a vault's detail route and wait for its header to render. */
export async function openVault(page: Page, vaultId: string): Promise<void> {
	await gotoRoute(
		page,
		`/vaults/${vaultId}`,
		page.getByTestId("new-item-button"),
	);
}

/**
 * Create one item in the vault the page is showing and return its id.
 *
 * `fill` receives the open sheet, already switched to the chosen category's
 * form.
 */
export async function createItem(
	page: Page,
	category: ItemCategory,
	fill: (sheet: Locator) => Promise<void>,
): Promise<string> {
	const pane = page.getByTestId("item-detail-pane");
	// The pane is always mounted and keeps showing whichever item was selected
	// before, so "the id is non-empty" is already true on a second create and
	// would hand back the *previous* item. The id it held going in is what the
	// new one has to differ from.
	const previousItemId =
		(await pane.count()) > 0 ? await pane.getAttribute("data-item-id") : null;

	await page.getByTestId("new-item-button").click();
	const sheet = page.getByTestId("create-item-sheet");
	await expect(sheet).toBeVisible();
	await sheet.getByTestId(`item-category-${category}`).click();
	await fill(sheet);
	await sheet.getByTestId("item-form-submit-button").click();
	await expect(sheet).toBeHidden();

	// Creating selects the new item, so the detail pane naming it is the proof
	// that the item exists and decrypts.
	if (previousItemId) {
		await expect(pane).not.toHaveAttribute("data-item-id", previousItemId, {
			timeout: VAULT_READY_TIMEOUT_MS,
		});
	}
	await expect(pane).toHaveAttribute("data-item-id", /.+/, {
		timeout: VAULT_READY_TIMEOUT_MS,
	});
	const itemId = await pane.getAttribute("data-item-id");
	if (!itemId) {
		throw new Error("The detail pane lost its item id between two reads.");
	}
	return itemId;
}

/** Select an item in the list and wait for the detail pane to catch up. */
export async function openItem(page: Page, title: string): Promise<void> {
	await itemRow(page, title).click();
	await expect(page.getByTestId("item-detail-pane")).toHaveAttribute(
		"data-item-id",
		/.+/,
		{ timeout: VAULT_READY_TIMEOUT_MS },
	);
}

/**
 * Open the detail pane's `...` menu, which holds star / move / delete. The
 * trigger has no testid and is the pane's only ellipsis button.
 */
export async function openItemMenu(page: Page): Promise<void> {
	await page
		.getByTestId("item-detail-pane")
		.locator("button:has(svg.lucide-ellipsis)")
		.click();
}

function vaultIdFromUrl(page: Page): string {
	const vaultId = new URL(page.url()).pathname.split("/").pop();
	if (!vaultId) {
		throw new Error(`No vault id in ${page.url()}`);
	}
	return vaultId;
}

/** Test titles are generated, but an unescaped quote would still break the selector. */
function cssAttributeValue(value: string): string {
	return value.replace(/["\\]/g, "\\$&");
}
