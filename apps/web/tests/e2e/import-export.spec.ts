import type { BrowserContext, Locator, Page } from "@playwright/test";
import { nanoid } from "nanoid";
import { expect, generateTestUser, signUp, test } from "../fixtures/auth";
import {
	buildOnePasswordArchive,
	createFixtureScratchDir,
	localFixture,
	readBttrxPayload,
	sharedFixture,
} from "../fixtures/import-files";
import { uiText } from "../fixtures/messages";
import {
	createItem,
	createVault,
	gotoRoute,
	itemRowTitles,
	toastWithText,
	VAULT_READY_TIMEOUT_MS,
} from "../fixtures/vault";

/**
 * Import and export at `/settings`: one real export file per provider driven
 * through the import dialog, the warnings and errors the preview raises, and a
 * `.bttrx` round trip that exports the account and imports the archive back.
 *
 * ONE signup for the whole file, and one browser context that every test shares.
 * Nothing here changes a credential, so no test needs a fresh context - and a
 * context per test would buy nothing but an SRP handshake each, on top of the
 * signup that already dominates the file.
 *
 * The tests are ordered, not independent: the round trip runs first, while the
 * account still holds only the two seeded items, so the archive it exports is
 * small and its contents are known. Every provider import after it adds vaults
 * and items that a later export would have to carry.
 *
 * Vault names are prefixed per test because several providers name a source
 * vault the same thing ("No Folder", "GitHub" items in three of them), and the
 * assertions address a vault by the name the sidebar renders.
 */

// Ordering already comes from `fullyParallel: false`; serial mode is here for
// the failure semantics, so one break skips the rest instead of cascading.
test.describe.configure({ mode: "serial" });

/** Signup, WASM key generation and the seed items. */
const SETUP_BUDGET_MS = 300000;

/** One import: parse, per-vault key generation, encryption and upload. */
const IMPORT_BUDGET_MS = 240000;

const suffix = nanoid(6);

const seed = {
	vaultName: `Export Source ${suffix}`,
	loginTitle: `Export Login ${suffix}`,
	noteTitle: `Export Note ${suffix}`,
};

let context: BrowserContext;
let page: Page;
let scratchDir: string;

test.beforeAll(async ({ browser }) => {
	test.setTimeout(SETUP_BUDGET_MS);
	scratchDir = createFixtureScratchDir();
	context = await browser.newContext();
	page = await context.newPage();
	await signUp(page, generateTestUser());

	await createVault(page, seed.vaultName);
	await createItem(page, "login", async (sheet) => {
		await sheet.locator("#title").fill(seed.loginTitle);
		await sheet.locator("#username").fill(`exporter_${suffix}`);
		await sheet.locator("#password").fill(`Export-Pass-${suffix}!`);
		await sheet.locator("#url").fill("https://export.example.com");
	});
	await createItem(page, "secure-note", async (sheet) => {
		await sheet.locator("#title").fill(seed.noteTitle);
		await sheet
			.locator("#note")
			.fill(`Seeded for the export round trip ${suffix}`);
	});

	// The export reads what the server holds, so a seed that silently lost an item
	// would surface as a short archive rather than as a broken fixture.
	expect((await itemRowTitles(page)).sort()).toEqual(
		[seed.loginTitle, seed.noteTitle].sort(),
	);
});

test.afterAll(async () => {
	await context?.close();
});

/** Open `/settings` and switch to the General tab, which owns both triggers. */
async function openSettingsGeneral(): Promise<void> {
	await gotoRoute(page, "/settings", page.getByTestId("settings-tab-account"));
	const general = page.getByTestId("settings-tab-general");
	await general.click();
	await expect(general).toHaveAttribute("data-state", "active");
}

/**
 * Open the import dialog from the General tab.
 *
 * The sidebar's onboarding card mounts a second copy of the same dialog and its
 * own "Start Import" button, so the trigger is addressed by the settings card's
 * own copy rather than by a loose button query.
 */
async function openImportDialog(): Promise<Locator> {
	await openSettingsGeneral();
	await page
		.getByRole("button", {
			name: uiText("settings_general_import_open"),
			exact: true,
		})
		.click();
	const dialog = page.getByTestId("import-dialog");
	await expect(dialog).toBeVisible();
	return dialog;
}

/** Pick a provider on step 1 and advance to the upload step. */
async function chooseProvider(
	dialog: Locator,
	providerId: string,
): Promise<void> {
	const tile = dialog.getByTestId(`import-provider-${providerId}`);
	await tile.click();
	await expect(tile).toHaveAttribute("aria-pressed", "true");
	await dialog
		.getByRole("button", { name: uiText("vaults_import_action_continue") })
		.click();
	// The file input is disabled until a provider is chosen, so it being enabled
	// is what says the upload step is ready for this provider's export.
	await expect(page.getByTestId("import-file-input")).toBeEnabled();
	await expect(
		dialog.getByText(uiText("vaults_import_upload_selected_provider_label")),
	).toBeVisible();
}

/** Hand the export file to the hidden file input and wait for the preview. */
async function uploadExport(dialog: Locator, filePath: string): Promise<void> {
	await page.getByTestId("import-file-input").setInputFiles(filePath);
	await expect(
		dialog.getByText(uiText("vaults_import_preview_ready_title")),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
}

/**
 * Hand the export file over expecting it to be rejected: the message appears in
 * the dialog's own error box, no preview is built, and there is nothing to
 * confirm.
 */
async function uploadRejectedExport(
	dialog: Locator,
	filePath: string,
	expectedMessage: string,
): Promise<void> {
	await page.getByTestId("import-file-input").setInputFiles(filePath);
	await expect(dialog.getByText(expectedMessage)).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});
	await expect(
		dialog.getByText(uiText("vaults_import_preview_ready_title")),
	).toBeHidden();
	await expect(dialog.getByTestId("import-confirm-button")).toBeHidden();
}

/** The amber block the preview lists its warnings in; it carries no testid. */
function warningsBlock(dialog: Locator): Locator {
	return dialog.locator('[class*="border-amber-500/30"]');
}

/**
 * The value of one stat card, found from its label: the cards carry no testid
 * and the label is the only text that identifies them.
 */
function statValue(dialog: Locator, labelKey: string): Locator {
	return dialog
		.getByText(uiText(labelKey), { exact: true })
		.locator("xpath=following-sibling::div[1]");
}

async function expectPreviewStats(
	dialog: Locator,
	expected: {
		vaults: number;
		items: number;
		skipped: number;
		warnings: number;
	},
): Promise<void> {
	await expect(
		statValue(dialog, "vaults_import_preview_stat_vaults"),
	).toHaveText(String(expected.vaults));
	await expect(
		statValue(dialog, "vaults_import_preview_stat_items"),
	).toHaveText(String(expected.items));
	await expect(
		statValue(dialog, "vaults_import_preview_stat_skipped"),
	).toHaveText(String(expected.skipped));
	await expect(
		statValue(dialog, "vaults_import_preview_stat_warnings"),
	).toHaveText(String(expected.warnings));
}

/**
 * Prefix every target vault name so the vaults this import creates can be told
 * apart from the ones the previous tests created. Returns the names in the order
 * the mapping rows render them.
 */
async function prefixTargetVaultNames(
	dialog: Locator,
	prefix: string,
	expectedCount: number,
): Promise<string[]> {
	const nameInputs = dialog.getByPlaceholder(
		uiText("vaults_import_mapping_placeholder_new_vault_name"),
	);
	await expect(nameInputs).toHaveCount(expectedCount);

	const names: string[] = [];
	for (let index = 0; index < expectedCount; index += 1) {
		const input = nameInputs.nth(index);
		const prefixed = `${prefix} ${await input.inputValue()}`;
		await input.fill(prefixed);
		names.push(prefixed);
	}
	return names;
}

/** Confirm the import and wait for the summary step. */
async function confirmImport(
	dialog: Locator,
	expected: { imported: number; skipped: number; newVaults: number },
): Promise<void> {
	const confirm = dialog.getByTestId("import-confirm-button");
	await expect(confirm).toBeEnabled();
	await confirm.click();

	await expect(
		dialog.getByRole("heading", {
			name: uiText("vaults_import_summary_title"),
		}),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	// Asserted before the stats because Sonner drops a toast after four seconds.
	await expect(
		toastWithText(page, uiText("vaults_import_toast_completed_successfully")),
	).toBeVisible();
	await expect(
		statValue(dialog, "vaults_import_summary_stat_imported"),
	).toHaveText(String(expected.imported));
	await expect(
		statValue(dialog, "vaults_import_summary_stat_skipped"),
	).toHaveText(String(expected.skipped));
	await expect(
		statValue(dialog, "vaults_import_summary_stat_new_vaults"),
	).toHaveText(String(expected.newVaults));
	// A vault the import could not write is reported here rather than thrown, so
	// its absence is what says every mapped vault actually took its items.
	await expect(
		dialog.getByText(uiText("vaults_import_summary_failed_vaults_title")),
	).toBeHidden();

	// Radix gives every dialog its own screen-reader "Close" button, so the
	// summary's own dismissal is taken through the action that names a route.
	await dialog
		.getByRole("button", {
			name: uiText("vaults_import_summary_action_open_vaults"),
		})
		.click();
	await expect(dialog).toBeHidden();
	await page.waitForURL("**/vaults");
}

/**
 * Open a vault the import created and return the item titles it holds.
 *
 * The ready locator names the row count the import reported, so `gotoRoute`
 * reloads - and re-runs the bootstrap - when a hydrate came back short instead
 * of asserting against a half-decrypted list.
 */
async function importedVaultItemTitles(
	vaultName: string,
	expectedItemCount: number,
): Promise<string[]> {
	const navLink = page.locator(
		`[data-testid="vault-nav-link"][data-vault-name="${vaultName}"]`,
	);
	await gotoRoute(page, "/vaults", navLink);
	const vaultId = await navLink.getAttribute("data-vault-id");
	if (!vaultId) {
		throw new Error(
			`The sidebar entry for "${vaultName}" carries no vault id.`,
		);
	}

	await gotoRoute(
		page,
		`/vaults/${vaultId}`,
		page.getByTestId("item-row").nth(expectedItemCount - 1),
	);
	const titles = await itemRowTitles(page);
	return titles.map((title) => title ?? "").sort();
}

test("a .bttrx export round-trips: the archive carries the account, and importing it brings the items back", async () => {
	test.setTimeout(IMPORT_BUDGET_MS);
	const prefix = `bttrx-${suffix}`;

	await openSettingsGeneral();
	await page
		.getByRole("button", {
			name: uiText("settings_general_export_open"),
			exact: true,
		})
		.click();
	const exportDialog = page.getByTestId("export-dialog");
	await expect(exportDialog).toBeVisible();

	await exportDialog.getByTestId("export-confirm-button").click();
	await expect(
		exportDialog.getByText(uiText("vault_export_dialog_stage_completed")),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });

	// Building the archive and handing it to the browser are two separate
	// buttons: `export-confirm-button` only fills the in-memory blob.
	const downloadPromise = page.waitForEvent("download");
	await exportDialog
		.getByRole("button", { name: uiText("vault_export_dialog_download") })
		.click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe("bittery-export.bttrx");

	// The provider matches on the file extension, and `download.path()` is an
	// extensionless temp file, so the archive has to be saved under its own name.
	const archivePath = `${scratchDir}/round-trip.bttrx`;
	await download.saveAs(archivePath);

	const payload = await readBttrxPayload(archivePath);
	expect(payload.version).toBe("1");
	expect(payload.vaults.map((vault) => vault.name)).toEqual([seed.vaultName]);
	expect(payload.metadata).toEqual({ totalItems: 2, totalVaults: 1 });
	expect(payload.items.map((item) => item.data.title).sort()).toEqual(
		[seed.loginTitle, seed.noteTitle].sort(),
	);

	await exportDialog
		.getByRole("button", { name: uiText("vault_export_dialog_cancel") })
		.click();
	await expect(exportDialog).toBeHidden();

	const dialog = await openImportDialog();
	await chooseProvider(dialog, "bittery-bttrx");
	await uploadExport(dialog, archivePath);
	await expectPreviewStats(dialog, {
		vaults: 1,
		items: 2,
		skipped: 0,
		warnings: 0,
	});
	// Nothing was lossy, so the amber warnings block is not rendered at all.
	await expect(warningsBlock(dialog)).toHaveCount(0);

	const [targetVaultName] = await prefixTargetVaultNames(dialog, prefix, 1);
	expect(targetVaultName).toBe(`${prefix} ${seed.vaultName}`);
	await confirmImport(dialog, { imported: 2, skipped: 0, newVaults: 1 });

	expect(
		await importedVaultItemTitles(`${prefix} ${seed.vaultName}`, 2),
	).toEqual([seed.loginTitle, seed.noteTitle].sort());
});

test("a 1Password .1pux import maps two vaults, skips the archived item and warns about it", async () => {
	test.setTimeout(IMPORT_BUDGET_MS);
	const prefix = `1pux-${suffix}`;
	const archivePath = await buildOnePasswordArchive(scratchDir);

	const dialog = await openImportDialog();
	await chooseProvider(dialog, "1password-1pux");
	await uploadExport(dialog, archivePath);

	await expectPreviewStats(dialog, {
		vaults: 2,
		items: 3,
		skipped: 1,
		warnings: 1,
	});
	await expect(
		dialog.getByText(
			uiText("vaults_import_preview_warnings_title", { count: 1 }),
		),
	).toBeVisible();
	await expect(
		dialog.getByText(
			uiText("vaults_import_warning_archived_skipped", {
				title: "1PUX Retired Login",
			}),
		),
	).toBeVisible();

	const names = await prefixTargetVaultNames(dialog, prefix, 2);
	expect(names).toEqual([`${prefix} 1P Private`, `${prefix} 1P Shared`]);
	await confirmImport(dialog, { imported: 3, skipped: 1, newVaults: 2 });

	expect(await importedVaultItemTitles(`${prefix} 1P Private`, 2)).toEqual(
		["1PUX GitHub", "1PUX Recovery Codes"].sort(),
	);
	expect(await importedVaultItemTitles(`${prefix} 1P Shared`, 1)).toEqual([
		"1PUX Visa",
	]);
});

test("a Bitwarden .json import drops the empty folder, warns twice and imports every supported category", async () => {
	test.setTimeout(IMPORT_BUDGET_MS);
	const prefix = `bwjson-${suffix}`;

	const dialog = await openImportDialog();
	await chooseProvider(dialog, "bitwarden");
	await uploadExport(dialog, sharedFixture.bitwardenJson);

	// The export carries four folders; the empty one is excluded before mapping,
	// which the stats and the mapping notice both have to agree on.
	await expectPreviewStats(dialog, {
		vaults: 3,
		items: 6,
		skipped: 1,
		warnings: 2,
	});
	await expect(
		dialog.getByText(
			uiText("vaults_import_mapping_skipped_empty_vaults_single", { count: 1 }),
		),
	).toBeVisible();
	await expect(
		dialog.getByText(
			uiText("vaults_import_preview_warnings_title", { count: 2 }),
		),
	).toBeVisible();
	await expect(
		dialog.getByText(
			uiText("vaults_import_warning_linked_field_skipped", {
				title: "Figma",
				fieldName: "link",
			}),
		),
	).toBeVisible();
	await expect(
		dialog.getByText(
			uiText("vaults_import_warning_unsupported_item_type", {
				title: "Test SSH",
				sourceCategory: "ssh-key",
			}),
		),
	).toBeVisible();

	const names = await prefixTargetVaultNames(dialog, prefix, 3);
	expect(names).toEqual([
		`${prefix} Test`,
		`${prefix} Test 2`,
		`${prefix} No Folder`,
	]);
	await confirmImport(dialog, { imported: 6, skipped: 1, newVaults: 3 });

	expect(await importedVaultItemTitles(`${prefix} Test`, 1)).toEqual([
		"Kreditkarte",
	]);
	expect(await importedVaultItemTitles(`${prefix} Test 2`, 2)).toEqual(
		["Figma", "GitHub"].sort(),
	);
	expect(await importedVaultItemTitles(`${prefix} No Folder`, 3)).toEqual(
		["Ada", "Google", "Test Notiz"].sort(),
	);
});

test("the same Bitwarden vault as .csv imports cleanly, with no warnings and no skipped rows", async () => {
	test.setTimeout(IMPORT_BUDGET_MS);
	const prefix = `bwcsv-${suffix}`;

	const dialog = await openImportDialog();
	await chooseProvider(dialog, "bitwarden");
	await uploadExport(dialog, sharedFixture.bitwardenCsv);

	// The CSV form of the same vault carries neither the SSH key nor the linked
	// field, so it is the provider's lossless path.
	await expectPreviewStats(dialog, {
		vaults: 2,
		items: 4,
		skipped: 0,
		warnings: 0,
	});

	const names = await prefixTargetVaultNames(dialog, prefix, 2);
	expect(names).toEqual([`${prefix} Test 2`, `${prefix} No Folder`]);
	await confirmImport(dialog, { imported: 4, skipped: 0, newVaults: 2 });

	expect(await importedVaultItemTitles(`${prefix} Test 2`, 2)).toEqual(
		["Figma", "GitHub"].sort(),
	);
	expect(await importedVaultItemTitles(`${prefix} No Folder`, 2)).toEqual(
		["Google", "Test Notiz"].sort(),
	);
});

test("a Chrome .csv import puts every row, duplicates included, into one vault", async () => {
	test.setTimeout(IMPORT_BUDGET_MS);
	const prefix = `chrome-${suffix}`;

	const dialog = await openImportDialog();
	await chooseProvider(dialog, "chrome");
	await uploadExport(dialog, sharedFixture.chromeCsv);

	await expectPreviewStats(dialog, {
		vaults: 1,
		items: 4,
		skipped: 0,
		warnings: 0,
	});
	await expect(
		dialog.getByText(
			uiText("vaults_import_mapping_source_item_count_plural", { count: 4 }),
		),
	).toBeVisible();

	const [targetVaultName] = await prefixTargetVaultNames(dialog, prefix, 1);
	expect(targetVaultName).toBe(
		`${prefix} ${uiText("vaults_import_source_vault_chrome_passwords")}`,
	);
	await confirmImport(dialog, { imported: 4, skipped: 0, newVaults: 1 });

	// Chrome writes one row per affiliated domain, so "example.com" arrives twice
	// and both rows have to survive as separate items.
	expect(await importedVaultItemTitles(targetVaultName, 4)).toEqual([
		"example.com",
		"example.com",
		"example.org",
		"other.org",
	]);
});

test("a Firefox .csv import skips the Sync account entry and says so", async () => {
	test.setTimeout(IMPORT_BUDGET_MS);
	const prefix = `firefox-${suffix}`;

	const dialog = await openImportDialog();
	await chooseProvider(dialog, "firefox");
	await uploadExport(dialog, sharedFixture.firefoxCsv);

	await expectPreviewStats(dialog, {
		vaults: 1,
		items: 9,
		skipped: 1,
		warnings: 1,
	});
	await expect(
		dialog.getByText(uiText("vaults_import_warning_sync_account_skipped")),
	).toBeVisible();

	const [targetVaultName] = await prefixTargetVaultNames(dialog, prefix, 1);
	expect(targetVaultName).toBe(`${prefix} Firefox`);
	await confirmImport(dialog, { imported: 9, skipped: 1, newVaults: 1 });

	expect(await importedVaultItemTitles(targetVaultName, 9)).toEqual(
		[
			"github.com",
			"konto.example.de",
			"example.org",
			"quote.example.com",
			"intranet.example.com",
			"www7.example.com:8080",
			"portal.example.com",
			"legacy.example.net",
			"file://",
		].sort(),
	);
});

test("a KeePassXC .csv import turns every group path into its own vault", async () => {
	test.setTimeout(IMPORT_BUDGET_MS);
	const prefix = `kpxc-${suffix}`;

	const dialog = await openImportDialog();
	await chooseProvider(dialog, "keepassxc");
	await uploadExport(dialog, sharedFixture.keepassxcCsv);

	await expectPreviewStats(dialog, {
		vaults: 6,
		items: 9,
		skipped: 1,
		warnings: 2,
	});
	await expect(
		dialog.getByText(
			uiText("vaults_import_warning_invalid_item", {
				itemNumber: 4,
				vaultName: "Work",
			}),
		),
	).toBeVisible();
	await expect(
		dialog.getByText(
			uiText("vaults_import_warning_totp_settings_unsupported", {
				title: "Steam",
			}),
		),
	).toBeVisible();

	const names = await prefixTargetVaultNames(dialog, prefix, 6);
	expect(names).toEqual([
		`${prefix} ${uiText("vaults_import_source_vault_no_group")}`,
		`${prefix} Work`,
		`${prefix} Work/Servers`,
		`${prefix} Persönliche Konten`,
		`${prefix} Finance`,
		`${prefix} Recycle Bin`,
	]);
	await confirmImport(dialog, { imported: 9, skipped: 1, newVaults: 6 });

	// The group path is kept verbatim as a vault name, and the recycle bin is an
	// ordinary group rather than something the import drops.
	expect(await importedVaultItemTitles(`${prefix} Work/Servers`, 1)).toEqual([
		"db-primary",
	]);
	expect(await importedVaultItemTitles(`${prefix} Recycle Bin`, 1)).toEqual([
		"Old Forum",
	]);
	expect(
		await importedVaultItemTitles(`${prefix} Persönliche Konten`, 2),
	).toEqual(["Kontoauszug", "WLAN Codes"].sort());
});

test("an export the provider cannot read is rejected before any preview, inline and as a toast", async () => {
	test.setTimeout(IMPORT_BUDGET_MS);
	const dialog = await openImportDialog();

	// A file the provider rejects on its extension alone, checked before a byte
	// of it is read.
	await chooseProvider(dialog, "1password-1pux");
	const incompatible = uiText("vaults_import_error_file_incompatible", {
		providerTitle: "1Password",
	});
	// The same message is raised twice on purpose: inline for the step the user
	// is on, and as a toast. The toast is asserted first because Sonner drops it
	// after four seconds while the inline box stays.
	await page
		.getByTestId("import-file-input")
		.setInputFiles(sharedFixture.firefoxCsv);
	await expect(toastWithText(page, incompatible)).toBeVisible();
	await expect(dialog.getByText(incompatible)).toBeVisible();
	await expect(
		dialog.getByText(uiText("vaults_import_preview_ready_title")),
	).toBeHidden();
	await expect(dialog.getByTestId("import-confirm-button")).toBeHidden();

	// The right extension for the wrong provider: a Chrome export has none of the
	// columns Firefox requires, and the message names every missing one.
	await dialog
		.getByRole("button", {
			name: uiText("vaults_import_upload_change_provider"),
		})
		.click();
	await chooseProvider(dialog, "firefox");
	await uploadRejectedExport(
		dialog,
		sharedFixture.chromeCsv,
		uiText("vaults_import_error_csv_missing_header", {
			headers:
				"httpRealm, formActionOrigin, guid, timeCreated, timeLastUsed, timePasswordChanged",
		}),
	);

	// An encrypted Bitwarden export parses as JSON but cannot be read, and the
	// provider says which export to take instead.
	await dialog
		.getByRole("button", {
			name: uiText("vaults_import_upload_change_provider"),
		})
		.click();
	await chooseProvider(dialog, "bitwarden");
	await uploadRejectedExport(
		dialog,
		localFixture.bitwardenEncryptedJson,
		uiText("vaults_import_error_bitwarden_encrypted_export_unsupported"),
	);

	await dialog
		.getByRole("button", { name: uiText("vaults_import_action_cancel") })
		.click();
	await expect(dialog).toBeHidden();
});
