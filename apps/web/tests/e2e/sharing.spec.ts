import type { Browser, Locator, Page } from "@playwright/test";
import { nanoid } from "nanoid";
import {
	expect,
	generateTestLoginItem,
	generateTestUser,
	signIn,
	signUp,
	type TestUser,
	test,
} from "../fixtures/auth";
import { activateTeamPlan } from "../fixtures/billing";
import { mailOutboxNow, waitForCode } from "../fixtures/mail-outbox";
import { uiText } from "../fixtures/messages";
import {
	confirmAlertDialog,
	copyShareLink,
	createShareLink,
	expireShareLinksForItem,
	openShareDialog,
	openShareHistory,
	revokeButton,
} from "../fixtures/sharing";
import {
	createItem,
	createVault,
	gotoRoute,
	openItem,
	toastWithText,
	VAULT_READY_TIMEOUT_MS,
} from "../fixtures/vault";

/**
 * Share links end to end: the owner-side dialogs, and what the recipient gets
 * when they open the URL in a browser that has never seen this account.
 *
 * One signup for the whole file, on a throwaway context - PBKDF2 at 600k
 * iterations plus SRP and RSA key generation is far too expensive to repeat per
 * test. That account's team is then put on an active Team plan (see
 * `../fixtures/billing`), because `resolve_share_links_policy` allows a Free
 * plan zero active share links and every create would 403.
 *
 * No test here needs a second *account*: a share link is explicitly for someone
 * who has none, so every recipient is an anonymous browser context.
 */

/** One SRP handshake, a vault, an item, a share link and a recipient context. */
const TEST_BUDGET_MS = 180000;

/**
 * `apps/web/src/routes/share.$token.tsx` renders these strings inline instead
 * of through `packages/i18n/messages/en.json`, so `uiText()` cannot reach them
 * and the literal is the only selector available. See the i18n gap in the
 * step report.
 */
const RECIPIENT_COPY = {
	notFoundTitle: "Share Link Not Found",
	expiredTitle: "Link Expired",
	revokedTitle: "Link Revoked",
	exhaustedTitle: "Link Already Used",
	decryptionFailedTitle: "Decryption Failed",
	missingKey: "Missing decryption key. Please use the complete share link.",
	emailGateTitle: "Email Verification Required",
	sendCode: "Send Verification Code",
	verifyAndAccess: "Verify & Access",
	fieldWebsite: "Website",
	fieldUsername: "Username",
	fieldPassword: "Password",
};

// The dialog's copy button is the only way to clear its uncopied-link guard,
// and reading the clipboard back needs both halves of the permission.
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

let user: TestUser;

test.beforeAll(async ({ browser }) => {
	test.setTimeout(300000);
	const context = await browser.newContext();
	try {
		user = await signUp(await context.newPage(), generateTestUser());
	} finally {
		await context.close();
	}
	activateTeamPlan(user.email);
});

/**
 * One field of the revealed item. The recipient page binds no label to its
 * inputs and gives them no id, so the field's label text is what identifies the
 * row that holds it.
 */
function sharedField(page: Page, label: string): Locator {
	return page
		.locator("div.space-y-1")
		.filter({ has: page.getByText(label, { exact: true }) });
}

/**
 * A per-test recipient address. Lowercase on purpose: the share dialog
 * lowercases every address it accepts, so a mixed-case one would never match
 * the badge it renders.
 */
function recipientAddress(): string {
	return `share-recipient-${nanoid(8).toLowerCase()}@test.bittery.com`;
}

/** Sign in and put one fresh login item in a fresh vault, ready to share. */
async function signInWithItem(
	page: Page,
): Promise<{ itemId: string; item: ReturnType<typeof generateTestLoginItem> }> {
	await signIn(page, user);
	await createVault(page, `Sharing ${nanoid(6)}`);
	const item = generateTestLoginItem();
	const itemId = await createItem(page, "login", async (sheet) => {
		await sheet.locator("#title").fill(item.title);
		await sheet.locator("#username").fill(item.username);
		await sheet.locator("#password").fill(item.password);
		await sheet.locator("#url").fill(item.url);
	});
	return { itemId, item };
}

/**
 * Open a URL in a browser context that has never held this account.
 *
 * `ready` names the screen this recipient is expected to get, because
 * `/share/$token` renders a different one per link state and shares no wrapper
 * between them - and because a context this cold is the likeliest place for a
 * route chunk to stall (see `gotoRoute`).
 */
async function openAsRecipient(
	browser: Browser,
	url: string,
	ready: (page: Page) => Locator,
): Promise<{ page: Page; close: () => Promise<void> }> {
	const context = await browser.newContext();
	const page = await context.newPage();
	await gotoRoute(page, url, ready(page));
	return { page, close: () => context.close() };
}

test("a share link only decrypts with its fragment key, and reveals the item", async ({
	page,
	browser,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	const { item } = await signInWithItem(page);

	// Created without copying, so the dialog's uncopied-link guard has to fire.
	const shareUrl = await createShareLink(page, { copyBeforeClose: false });
	await page
		.getByRole("button", { name: uiText("sharing_item_dialog_action_done") })
		.click();
	const guard = page.getByRole("alertdialog");
	await expect(guard).toContainText(
		uiText("sharing_item_dialog_close_without_copy_description"),
	);
	await guard
		.getByRole("button", { name: uiText("sharing_item_dialog_action_cancel") })
		.click();
	await expect(guard).toBeHidden();

	await copyShareLink(page);
	await expect(
		toastWithText(page, uiText("sharing_common_link_label")),
	).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		shareUrl,
	);
	await page
		.getByRole("button", { name: uiText("sharing_item_dialog_action_done") })
		.click();
	await expect(page.getByTestId("share-item-dialog")).toBeHidden();

	// Same token, fragment dropped: the page must refuse before offering any
	// action, because an access that could never decrypt would still be spent.
	const withoutKey = shareUrl.slice(0, shareUrl.indexOf("#"));
	const stripped = await openAsRecipient(browser, withoutKey, (view) =>
		view.getByText(RECIPIENT_COPY.decryptionFailedTitle),
	);
	try {
		await expect(
			stripped.page.getByText(RECIPIENT_COPY.missingKey),
		).toBeVisible();
		await expect(stripped.page.getByTestId("share-reveal-button")).toHaveCount(
			0,
		);
	} finally {
		await stripped.close();
	}

	const recipient = await openAsRecipient(browser, shareUrl, (view) =>
		view.getByText(uiText("share_access_gate_title"), { exact: true }),
	);
	try {
		const view = recipient.page;
		await expect(
			view.getByText(uiText("share_access_gate_access_anyone")),
		).toBeVisible();
		await expect(
			view.getByText(uiText("share_access_gate_usage_multi")),
		).toBeVisible();
		await view.getByTestId("share-reveal-button").click();

		await expect(view.getByText(item.title, { exact: true })).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await expect(
			sharedField(view, RECIPIENT_COPY.fieldUsername).locator("input"),
		).toHaveValue(item.username);
		await expect(
			sharedField(view, RECIPIENT_COPY.fieldWebsite).locator("input"),
		).toHaveValue(item.url);

		// The password arrives concealed; only the eye toggle un-conceals it.
		const password = sharedField(view, RECIPIENT_COPY.fieldPassword);
		await expect(password.locator("input")).toHaveAttribute("type", "password");
		await expect(password.locator("input")).toHaveValue(item.password);
		await password.locator("button:has(svg.lucide-eye)").click();
		await expect(password.locator("input")).toHaveAttribute("type", "text");
		await expect(
			password.locator("button:has(svg.lucide-eye-off)"),
		).toHaveCount(1);
	} finally {
		await recipient.close();
	}
});

test("a one-time link is spent by the first reveal", async ({
	page,
	browser,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	const { item } = await signInWithItem(page);
	const shareUrl = await createShareLink(page, { oneTimeUse: true });

	const recipient = await openAsRecipient(browser, shareUrl, (view) =>
		view.getByText(uiText("share_access_gate_title_one_time"), { exact: true }),
	);
	try {
		const view = recipient.page;
		await expect(
			view.getByText(uiText("share_access_gate_usage_one_time")),
		).toBeVisible();
		await expect(
			view.getByText(uiText("share_access_gate_one_time_warning")),
		).toBeVisible();

		await view
			.getByRole("button", {
				name: uiText("share_access_gate_action_reveal_one_time"),
			})
			.click();
		await expect(view.getByText(item.title, { exact: true })).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});

		// A reload is the cheapest proof the link is spent: the decrypted item
		// lives in component state only, so the page has to ask the server again.
		await view.reload();
		await expect(view.getByText(RECIPIENT_COPY.exhaustedTitle)).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await expect(view.getByTestId("share-reveal-button")).toHaveCount(0);
	} finally {
		await recipient.close();
	}

	const history = await openShareHistory(page);
	await expect(
		history.getByText(uiText("sharing_links_list_status_exhausted")),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	await expect(
		history.getByText(uiText("sharing_links_list_badge_one_time")),
	).toBeVisible();
	await expect(
		history.getByText(
			uiText("sharing_links_list_access_count_with_limit_single", {
				count: 1,
				max: 1,
			}),
		),
	).toBeVisible();
	// A spent link is no longer revocable, so its revoke action is gone.
	await expect(revokeButton(page)).toHaveCount(0);
});

test("an expired link tells the recipient it expired", async ({
	page,
	browser,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	const { itemId } = await signInWithItem(page);
	const shareUrl = await createShareLink(page, { expiresIn: "1hour" });

	// The shortest expiry the dialog offers is an hour and the server stamps
	// `expires_at` from its own clock, so backdating the row is the only way to
	// reach this state without sleeping - see `expireShareLinksForItem`.
	expireShareLinksForItem(itemId);

	const recipient = await openAsRecipient(browser, shareUrl, (view) =>
		view.getByText(RECIPIENT_COPY.expiredTitle),
	);
	try {
		await expect(recipient.page.getByTestId("share-reveal-button")).toHaveCount(
			0,
		);
	} finally {
		await recipient.close();
	}

	const history = await openShareHistory(page);
	await expect(
		history.getByText(uiText("sharing_links_list_status_expired")),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	await expect(revokeButton(page)).toHaveCount(0);
});

test("revoking a link disables it for the recipient", async ({
	page,
	browser,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	const { item } = await signInWithItem(page);
	const shareUrl = await createShareLink(page);

	const history = await openShareHistory(page);
	await expect(
		history.getByText(uiText("sharing_links_list_status_active")),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	await expect(revokeButton(page)).toHaveCount(1);
	await expect(revokeButton(page)).toHaveAttribute("data-share-link-id", /.+/);

	// Revoking is a two-step action: the button only opens the confirmation.
	await revokeButton(page).click();
	await confirmAlertDialog(
		page,
		uiText("sharing_links_list_action_revoke_link"),
	);
	await expect(
		toastWithText(page, uiText("sharing_links_list_toast_revoke_success")),
	).toBeVisible();

	// A fresh load also verifies that revocation survived beyond the query cache.
	await page.reload();
	await openItem(page, item.title);
	const refreshed = await openShareHistory(page);
	await expect(
		refreshed.getByText(uiText("sharing_links_list_status_revoked")),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	await expect(revokeButton(page)).toHaveCount(0);

	const recipient = await openAsRecipient(browser, shareUrl, (view) =>
		view.getByText(RECIPIENT_COPY.revokedTitle),
	);
	try {
		await expect(recipient.page.getByTestId("share-reveal-button")).toHaveCount(
			0,
		);
	} finally {
		await recipient.close();
	}
});

test("share history counts the access and the access log records it", async ({
	page,
	browser,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	const { item } = await signInWithItem(page);
	const shareUrl = await createShareLink(page);

	const history = await openShareHistory(page);
	await expect(
		history.getByText(
			uiText("sharing_links_list_access_count_plural", { count: 0 }),
		),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	await history
		.getByTitle(uiText("sharing_links_list_action_view_access_logs"))
		.click();
	const logs = page.getByRole("dialog", {
		name: uiText("sharing_links_list_logs_title"),
	});
	await expect(
		logs.getByText(uiText("sharing_links_list_empty_logs")),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	await page.keyboard.press("Escape");
	await expect(logs).toBeHidden();
	await page.keyboard.press("Escape");
	await expect(history).toBeHidden();

	const recipient = await openAsRecipient(browser, shareUrl, (view) =>
		view.getByTestId("share-reveal-button"),
	);
	try {
		await recipient.page.getByTestId("share-reveal-button").click();
		await expect(
			recipient.page.getByText(item.title, { exact: true }),
		).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	} finally {
		await recipient.close();
	}

	// Reloaded rather than reopened: the share queries are never invalidated, so
	// a second open of the dialog would replay the counts read above. Reported
	// as a product bug for this step.
	await page.reload();
	await openItem(page, item.title);
	const reopened = await openShareHistory(page);
	await expect(
		reopened.getByText(
			uiText("sharing_links_list_access_count_single", { count: 1 }),
		),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	await reopened
		.getByTitle(uiText("sharing_links_list_action_view_access_logs"))
		.click();
	await expect(
		logs.getByText(uiText("sharing_links_list_logs_status_success")),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	await expect(
		logs.getByText(uiText("sharing_links_list_empty_logs")),
	).toHaveCount(0);
});

test("an email-restricted link needs the code from the recipient's mailbox", async ({
	page,
	browser,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	const { item } = await signInWithItem(page);
	const recipientEmail = recipientAddress();
	const shareUrl = await createShareLink(page, {
		accessMode: "email-restricted",
		allowedEmails: [recipientEmail],
	});

	const recipient = await openAsRecipient(browser, shareUrl, (view) =>
		view.getByText(RECIPIENT_COPY.emailGateTitle),
	);
	try {
		const view = recipient.page;
		// An email-restricted link never offers the anyone-mode reveal action.
		await expect(view.getByTestId("share-reveal-button")).toHaveCount(0);

		await view.locator("#email").fill(recipientEmail);
		// Watermark before the request, or the code lands "before" the wait.
		const since = mailOutboxNow();
		await view.getByRole("button", { name: RECIPIENT_COPY.sendCode }).click();
		await expect(view.locator("#code")).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});

		const code = await waitForCode({
			purpose: "share_email",
			email: recipientEmail,
			since,
		});
		await view.locator("#code").fill(code);
		await view
			.getByRole("button", { name: RECIPIENT_COPY.verifyAndAccess })
			.click();

		await expect(view.getByText(item.title, { exact: true })).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await expect(
			sharedField(view, RECIPIENT_COPY.fieldUsername).locator("input"),
		).toHaveValue(item.username);
	} finally {
		await recipient.close();
	}

	// The owner's history marks exactly the address that verified.
	const history = await openShareHistory(page);
	await expect(
		history.getByText(
			uiText("sharing_links_list_access_mode_email_restricted"),
		),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	await expect(
		history.getByText(
			`${recipientEmail}${uiText("sharing_links_list_allowed_email_verified_suffix")}`,
		),
	).toBeVisible();
});

test("an unusable share token shows the not-found page", async ({
	browser,
}) => {
	test.setTimeout(TEST_BUDGET_MS);

	// A well-formed token that was never issued, and a malformed one the server
	// rejects on length alone - both are dead ends for the recipient.
	for (const token of ["a".repeat(32), "not-a-token"]) {
		const recipient = await openAsRecipient(
			browser,
			`/share/${token}#${nanoid(16)}`,
			(view) => view.getByText(RECIPIENT_COPY.notFoundTitle, { exact: true }),
		);
		try {
			await expect(
				recipient.page.getByTestId("share-reveal-button"),
			).toHaveCount(0);
		} finally {
			await recipient.close();
		}
	}
});

test("an email-restricted link cannot be created without an address", async ({
	page,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	const { item } = await signInWithItem(page);

	const dialog = await openShareDialog(page);
	await expect(dialog).toContainText(
		uiText("sharing_item_dialog_description", { itemTitle: item.title }),
	);
	await expect(page.getByTestId("share-create-button")).toBeEnabled();

	const accessMode = dialog
		.getByRole("combobox")
		.filter({ hasText: uiText("sharing_item_dialog_access_mode_anyone") });
	await accessMode.click();
	await page
		.getByRole("option")
		.filter({
			hasText: uiText("sharing_item_dialog_access_mode_email_restricted"),
		})
		.click();

	await expect(page.getByTestId("share-create-button")).toBeDisabled();
	const allowed = recipientAddress();
	await dialog
		.getByPlaceholder(uiText("sharing_item_dialog_placeholder_email"))
		.fill(allowed);
	await dialog
		.getByRole("button", {
			name: uiText("sharing_item_dialog_action_add_email"),
			exact: true,
		})
		.click();
	await expect(dialog.getByText(allowed, { exact: true })).toBeVisible();
	await expect(page.getByTestId("share-create-button")).toBeEnabled();
});
