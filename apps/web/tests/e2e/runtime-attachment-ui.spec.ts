import { readFile } from "node:fs/promises";
import { nanoid } from "nanoid";
import { expect, generateTestUser, signUp, test } from "../fixtures/auth";
import { activateTeamPlan } from "../fixtures/billing";
import { uiText } from "../fixtures/messages";
import {
	createItem,
	createVault,
	openItem,
	VAULT_READY_TIMEOUT_MS,
} from "../fixtures/vault";

test("foreground Attachment upload, download, rename and delete use the live Runtime projection", async ({
	page,
}) => {
	test.setTimeout(240000);
	const user = await signUp(page, generateTestUser());
	activateTeamPlan(user.email);
	const title = `Attachment Item ${nanoid(6)}`;
	await createVault(page, `Attachment Vault ${nanoid(6)}`);
	await createItem(page, "login", async (sheet) => {
		await sheet.locator("#title").fill(title);
	});
	await openItem(page, title);
	const pane = page.getByTestId("item-detail-pane");
	const bytes = Buffer.from(
		"Runtime attachment plaintext — retained exactly\n",
	);
	const choosingFile = page.waitForEvent("filechooser");
	await pane
		.getByRole("button", {
			name: uiText("vaults_detail_items_attachments_action_attach_file"),
			exact: true,
		})
		.click();
	await (await choosingFile).setFiles({
		name: "original.txt",
		mimeType: "text/plain",
		buffer: bytes,
	});
	await pane
		.getByRole("button", {
			name: uiText("vaults_detail_items_attachments_action_upload"),
			exact: true,
		})
		.click();
	await expect(pane.getByText("original.txt", { exact: true })).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});
	const originalRow = pane
		.getByTestId("attachment-row")
		.filter({ has: page.getByText("original.txt", { exact: true }) });
	const attachmentId = await originalRow.getAttribute("data-attachment-id");
	if (!attachmentId)
		throw new Error("The uploaded Attachment row has no identity");
	const row = pane.locator(
		`[data-testid="attachment-row"][data-attachment-id="${attachmentId}"]`,
	);
	const downloading = page.waitForEvent("download");
	await row
		.getByRole("button", {
			name: uiText("vaults_detail_items_attachments_action_download"),
		})
		.click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe("original.txt");
	const path = await download.path();
	if (!path) throw new Error("Attachment download did not produce a file");
	expect(await readFile(path)).toEqual(bytes);
	await row
		.getByRole("button", {
			name: uiText("vaults_detail_items_attachments_action_rename_attachment"),
		})
		.click();
	await row.locator("input").fill("renamed.txt");
	await row.locator("input").press("Enter");
	await expect(pane.getByText("renamed.txt", { exact: true })).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});
	await page
		.getByRole("link", { name: uiText("nav_item_vaults"), exact: true })
		.click();
	await expect(pane).not.toHaveAttribute("data-item-id", /.+/);
	await openItem(page, title);
	await expect(pane.getByText("renamed.txt", { exact: true })).toBeVisible();
	await expect(pane.getByText("original.txt", { exact: true })).toHaveCount(0);

	await row
		.getByRole("button", {
			name: uiText("vaults_detail_items_attachments_action_delete_attachment"),
		})
		.click();
	await expect(row).toHaveCount(0);
	await expect(pane.getByText("renamed.txt", { exact: true })).toHaveCount(0);
	await page
		.getByRole("link", { name: uiText("nav_item_vaults"), exact: true })
		.click();
	await expect(pane).not.toHaveAttribute("data-item-id", /.+/);
	await openItem(page, title);
	await expect(row).toHaveCount(0);
	await expect(pane.getByText("renamed.txt", { exact: true })).toHaveCount(0);
});
