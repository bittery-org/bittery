/**
 * Share-link helpers: the owner-side dialogs in
 * `packages/ui/src/components/sharing/*` and the recipient-side page
 * `apps/web/src/routes/share.$token.tsx`.
 *
 * The share key rides in the URL fragment and exists only in the creating
 * dialog's memory, so every helper here hands the *whole* URL around - a link
 * split into parts and reassembled without its `#` fragment is permanently
 * undecryptable.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { DEFAULT_E2E_DATABASE, runE2eSql, sqlString } from "./e2e-database";
import { uiText } from "./messages";
import { VAULT_READY_TIMEOUT_MS } from "./vault";

export type ShareAccessMode = "anyone" | "email-restricted";
export type ShareExpiration = "1hour" | "1day" | "7days" | "14days" | "30days";

export interface CreateShareLinkOptions {
	accessMode?: ShareAccessMode;
	expiresIn?: ShareExpiration;
	oneTimeUse?: boolean;
	/** Required by the form when `accessMode` is `email-restricted`. */
	allowedEmails?: string[];
	/**
	 * Press the copy button before closing. Leaving it false makes the dialog
	 * raise its "close without copying" guard, which the caller then has to
	 * answer.
	 */
	copyBeforeClose?: boolean;
}

const EXPIRATION_LABELS: Record<ShareExpiration, string> = {
	"1hour": uiText("sharing_item_dialog_expiration_1hour"),
	"1day": uiText("sharing_item_dialog_expiration_1day"),
	"7days": uiText("sharing_item_dialog_expiration_7days"),
	"14days": uiText("sharing_item_dialog_expiration_14days"),
	"30days": uiText("sharing_item_dialog_expiration_30days"),
};

const ACCESS_MODE_LABELS: Record<ShareAccessMode, string> = {
	anyone: uiText("sharing_item_dialog_access_mode_anyone"),
	"email-restricted": uiText(
		"sharing_item_dialog_access_mode_email_restricted",
	),
};

/**
 * The share dialog's two selects, in DOM order. Neither trigger has a testid
 * and neither label is bound to one, so position is what tells them apart; the
 * allowed-emails block that appears between them carries no combobox.
 */
const SELECT_INDEX = { accessMode: 0, expiresIn: 1 } as const;

/** Pick a value in one of those two selects and prove the trigger took it. */
async function chooseSelectValue(
	dialog: Locator,
	index: number,
	nextLabel: string,
): Promise<void> {
	const trigger = dialog.getByRole("combobox").nth(index);
	await trigger.click();
	await dialog
		.page()
		.getByRole("option")
		.filter({ hasText: nextLabel })
		.click();
	await expect(trigger).toContainText(nextLabel);
}

/** Open the share dialog from the item detail pane. */
export async function openShareDialog(page: Page): Promise<Locator> {
	await page.getByTestId("item-share-button").click();
	const dialog = page.getByTestId("share-item-dialog");
	await expect(dialog).toBeVisible();
	return dialog;
}

/**
 * Create one share link for the item the detail pane is showing and return the
 * complete URL, fragment included.
 *
 * `share-create-button` only opens a security-warning AlertDialog; the link is
 * created by that dialog's confirm action.
 */
export async function createShareLink(
	page: Page,
	options: CreateShareLinkOptions = {},
): Promise<string> {
	const dialog = await openShareDialog(page);

	const accessMode = options.accessMode ?? "anyone";
	if (accessMode !== "anyone") {
		await chooseSelectValue(
			dialog,
			SELECT_INDEX.accessMode,
			ACCESS_MODE_LABELS[accessMode],
		);
	}
	for (const email of options.allowedEmails ?? []) {
		await dialog
			.getByPlaceholder(uiText("sharing_item_dialog_placeholder_email"))
			.fill(email);
		await dialog
			.getByRole("button", {
				name: uiText("sharing_item_dialog_action_add_email"),
				exact: true,
			})
			.click();
		await expect(dialog.getByText(email, { exact: true })).toBeVisible();
	}

	const expiresIn = options.expiresIn ?? "7days";
	if (expiresIn !== "7days") {
		await chooseSelectValue(
			dialog,
			SELECT_INDEX.expiresIn,
			EXPIRATION_LABELS[expiresIn],
		);
	}

	if (options.oneTimeUse) {
		await dialog.locator("#one-time").click();
		await expect(dialog.locator("#one-time")).toBeChecked();
	}

	await page.getByTestId("share-create-button").click();
	await confirmAlertDialog(
		page,
		uiText("sharing_item_dialog_confirm_action_confirm"),
	);

	const linkValue = page.getByTestId("share-link-value");
	await expect(linkValue).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	const shareUrl = await linkValue.inputValue();
	if (!shareUrl.includes("#")) {
		throw new Error(`Share link has no fragment key: ${shareUrl}`);
	}

	if (options.copyBeforeClose !== false) {
		await copyShareLink(page);
		await page
			.getByRole("button", { name: uiText("sharing_item_dialog_action_done") })
			.click();
		await expect(dialog).toBeHidden();
	}

	return shareUrl;
}

/** Press the dialog's copy button, which also clears the uncopied-link guard. */
export async function copyShareLink(page: Page): Promise<void> {
	await page
		.getByTestId("share-item-dialog")
		.getByRole("button", {
			name: uiText("sharing_item_dialog_action_copy_link"),
		})
		.click();
}

/** Answer an AlertDialog by the label of its action button. */
export async function confirmAlertDialog(
	page: Page,
	actionLabel: string,
): Promise<void> {
	const alert = page.getByRole("alertdialog");
	await expect(alert).toBeVisible();
	await alert.getByRole("button", { name: actionLabel }).click();
	await expect(alert).toBeHidden();
}

/**
 * Open the share history for the item the detail pane is showing. Its trigger
 * lives in the pane's unlabelled ellipsis menu.
 */
export async function openShareHistory(page: Page): Promise<Locator> {
	await page
		.getByTestId("item-detail-pane")
		.locator("button:has(svg.lucide-ellipsis)")
		.click();
	await page
		.getByRole("menuitem", { name: uiText("sharing_history_dialog_title") })
		.click();
	const dialog = page.getByTestId("share-history-dialog");
	await expect(dialog).toBeVisible();
	return dialog;
}

/** The one row of the history list that is still revocable, i.e. still active. */
export function revokeButton(page: Page): Locator {
	return page.getByTestId("share-revoke-button");
}

/**
 * Backdate every share link on one item so the recipient page has to show its
 * expired state.
 *
 * The dialog's shortest expiry is one hour and the server derives `expires_at`
 * from its own clock, so there is nothing to fast-forward from the client -
 * waiting it out, or faking the browser's clock, would prove nothing about the
 * server's own check. Writing the column is the same fixture pattern
 * `./billing` uses for the Stripe webhook's plan columns.
 */
export function expireShareLinksForItem(
	itemId: string,
	database = DEFAULT_E2E_DATABASE,
): void {
	const result = runE2eSql(
		`UPDATE share_link SET expires_at = now() - interval '1 hour' WHERE item_id = '${sqlString(itemId)}' AND status = 'active'`,
		database,
	);
	if (result !== "UPDATE 1") {
		throw new Error(
			`Expected exactly one active share link on ${itemId}, psql said: ${result}`,
		);
	}
}
