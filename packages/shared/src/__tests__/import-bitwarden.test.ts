import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bitwardenImportProvider } from "../import/providers/bitwarden";
import type { ImportPreview, ImportSourceItem } from "../import/types";
import { ImportProviderError } from "../import/types";
import { generateTotpAt } from "../totp";

const CSV_HEADER =
	"folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp";

const TOTP_SECRET = "JBSWY3DPEHPK3PXP";
const FIXED_CLOCK = 1234567890;

/**
 * Synthetic stand-in for a sanitized real export. It intentionally exercises
 * quoted commas and newlines, non-ASCII text, empty username/password, multiple
 * URLs, folders, favorites, custom fields, a secure note, a raw TOTP seed, an
 * `otpauth://` URI and an unparseable TOTP value.
 */
const CSV_RECORDS = [
	CSV_HEADER,
	'Work,1,login,GitHub,"Zeile eins\nZeile zwei","API Key: abc123\nEnv: prod",0,https://github.com,octocat,hunter2,JBSWY3DPEHPK3PXP',
	`,0,login,"Comma, Inc.",,,1,"https://a.example.com,https://b.example.com",user@example.com,"pa,ss",otpauth://totp/Example:alice@example.com?secret=${TOTP_SECRET}&issuer=Example&algorithm=SHA256&digits=8&period=60`,
	'Personal,,note,"Recovery codes","one\ntwo",,,,,,',
	"Work,,login,,,,,,,,not-base32!!",
	"Personal,,card,Amex,,,,,,,",
];

const CSV_EXPORT = CSV_RECORDS.join("\n");
/** Same content with CRLF record separators; newlines inside quotes stay LF. */
const CSV_EXPORT_CRLF = CSV_RECORDS.join("\r\n");

function csvFile(content: string, name = "bitwarden_export.csv"): File {
	return new File([content], name, { type: "text/csv" });
}

function jsonFile(value: unknown, name = "bitwarden_export.json"): File {
	return new File([JSON.stringify(value)], name, { type: "application/json" });
}

function itemByTitle(preview: ImportPreview, title: string): ImportSourceItem {
	const item = preview.sourceItems.find(
		(candidate) => candidate.title === title,
	);
	if (!item) {
		throw new Error(`No imported item titled "${title}"`);
	}
	return item;
}

function warningCodes(preview: ImportPreview): string[] {
	return preview.warnings.map((warning) => warning.code);
}

async function expectParseError(file: File, code: string): Promise<void> {
	let thrown: unknown;
	try {
		await bitwardenImportProvider.parse(file);
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(ImportProviderError);
	expect((thrown as ImportProviderError).code).toBe(
		code as ImportProviderError["code"],
	);
}

describe("Bitwarden import provider", () => {
	describe("canParse", () => {
		test("accepts .csv and .json", () => {
			expect(bitwardenImportProvider.canParse(csvFile(CSV_EXPORT))).toBe(true);
			expect(
				bitwardenImportProvider.canParse(jsonFile({}, "export.json")),
			).toBe(true);
		});

		test("accepts .zip so the attachment export gets a specific error", () => {
			expect(
				bitwardenImportProvider.canParse(new File([""], "export.zip")),
			).toBe(true);
		});

		test("rejects unrelated extensions", () => {
			expect(
				bitwardenImportProvider.canParse(new File([""], "export.1pux")),
			).toBe(false);
		});
	});

	describe("CSV export", () => {
		test("maps folders onto source vaults", async () => {
			const preview = await bitwardenImportProvider.parse(csvFile(CSV_EXPORT));

			expect(preview.providerId).toBe("bitwarden");
			expect(
				preview.sourceVaults.map((vault) => [vault.name, vault.itemCount]),
			).toEqual([
				["Work", 2],
				["No Folder", 1],
				["Personal", 2],
			]);
			expect(preview.summary.itemCount).toBe(5);
			expect(preview.summary.vaultCount).toBe(3);
		});

		test("marks the unfoldered bucket with a localizable name code", async () => {
			const preview = await bitwardenImportProvider.parse(csvFile(CSV_EXPORT));
			const unfoldered = preview.sourceVaults.find(
				(vault) => vault.nameCode === "no-folder",
			);

			expect(unfoldered).toBeDefined();
			expect(unfoldered?.id).toBe("bitwarden-no-folder");
			expect(
				preview.sourceItems.filter(
					(item) => item.sourceVaultId === unfoldered?.id,
				),
			).toHaveLength(1);
		});

		test("produces deterministic item ids", async () => {
			const first = await bitwardenImportProvider.parse(csvFile(CSV_EXPORT));
			const second = await bitwardenImportProvider.parse(csvFile(CSV_EXPORT));

			expect(first.sourceItems.map((item) => item.id)).toEqual(
				second.sourceItems.map((item) => item.id),
			);
			expect(itemByTitle(first, "GitHub").id).toBe("bitwarden-folder-1-row-2");
		});

		test("maps a login row with notes, favorite and custom fields", async () => {
			const preview = await bitwardenImportProvider.parse(csvFile(CSV_EXPORT));
			const github = itemByTitle(preview, "GitHub");

			expect(github.category).toBe("login");
			expect(github.favorite).toBe(true);
			expect(github.data.username).toBe("octocat");
			expect(github.data.password).toBe("hunter2");
			expect(github.data.url).toBe("https://github.com");
			expect(github.data.notes).toBe("Zeile eins\nZeile zwei");
			expect(github.data.customFields).toEqual([
				{
					id: "bitwarden-folder-1-row-2-custom-1",
					label: "API Key",
					value: "abc123",
					type: "text",
				},
				{
					id: "bitwarden-folder-1-row-2-custom-2",
					label: "Env",
					value: "prod",
					type: "text",
				},
			]);
		});

		test("splits multiple URIs and preserves quoted commas", async () => {
			const preview = await bitwardenImportProvider.parse(csvFile(CSV_EXPORT));
			const item = itemByTitle(preview, "Comma, Inc.");

			expect(item.data.urls).toEqual([
				"https://a.example.com",
				"https://b.example.com",
			]);
			expect(item.data.url).toBe("https://a.example.com");
			expect(item.data.password).toBe("pa,ss");
			expect(item.favorite).toBe(false);
		});

		test("imports a note row as a secure note with a populated note body", async () => {
			const preview = await bitwardenImportProvider.parse(csvFile(CSV_EXPORT));
			const note = itemByTitle(preview, "Recovery codes");

			expect(note.category).toBe("secure-note");
			expect(note.data.note).toBe("one\ntwo");
			expect(note.data.notes).toBe("one\ntwo");
		});

		test("warns about reprompt, missing titles, unknown types and bad TOTP", async () => {
			const preview = await bitwardenImportProvider.parse(csvFile(CSV_EXPORT));

			expect(warningCodes(preview)).toEqual(
				expect.arrayContaining([
					"reprompt-not-supported",
					"missing-title",
					"category-fallback",
					"totp-secret-missing",
				]),
			);
			expect(itemByTitle(preview, "Amex").category).toBe("login");
			expect(
				itemByTitle(preview, "Imported item 4").data.totpSecret,
			).toBeUndefined();
		});

		test("generates the right code from a raw base32 seed at a fixed clock", async () => {
			const preview = await bitwardenImportProvider.parse(csvFile(CSV_EXPORT));
			const { data } = itemByTitle(preview, "GitHub");

			expect(data.totpSecret).toBe(TOTP_SECRET);
			const code = await generateTotpAt(
				{
					secret: data.totpSecret ?? "",
					...(data.totpAlgorithm ? { algorithm: data.totpAlgorithm } : {}),
					...(data.totpDigits ? { digits: data.totpDigits } : {}),
					...(data.totpPeriod ? { period: data.totpPeriod } : {}),
				},
				FIXED_CLOCK,
			);

			expect(code).toBe("742275");
		});

		test("carries otpauth parameters through to code generation", async () => {
			const preview = await bitwardenImportProvider.parse(csvFile(CSV_EXPORT));
			const { data } = itemByTitle(preview, "Comma, Inc.");

			expect(data.totpSecret).toBe(TOTP_SECRET);
			expect(data.totpIssuer).toBe("Example");
			expect(data.totpAccountName).toBe("alice@example.com");
			expect(data.totpAlgorithm).toBe("SHA256");
			expect(data.totpDigits).toBe(8);
			expect(data.totpPeriod).toBe(60);

			const code = await generateTotpAt(
				{
					secret: data.totpSecret ?? "",
					...(data.totpAlgorithm ? { algorithm: data.totpAlgorithm } : {}),
					...(data.totpDigits ? { digits: data.totpDigits } : {}),
					...(data.totpPeriod ? { period: data.totpPeriod } : {}),
				},
				FIXED_CLOCK,
			);

			expect(code).toBe("45806924");
		});

		test("survives a BOM and CRLF line endings", async () => {
			const withBom = `﻿${CSV_EXPORT_CRLF}`;
			expect(withBom).toContain("\r\n");

			const preview = await bitwardenImportProvider.parse(csvFile(withBom));

			expect(preview.summary.itemCount).toBe(5);
			expect(itemByTitle(preview, "GitHub").data.notes).toBe(
				"Zeile eins\nZeile zwei",
			);
		});
	});

	describe("CSV structural failures return nothing", () => {
		test("rejects a file truncated mid-quote", async () => {
			await expectParseError(
				csvFile(`${CSV_HEADER}\nWork,0,login,"unterminated,,,0,,,,`),
				"csv-malformed-quoting",
			);
		});

		test("rejects a duplicated column", async () => {
			await expectParseError(
				csvFile(`${CSV_HEADER},notes\nWork,0,login,A,,,0,,,,,x`),
				"csv-duplicate-header",
			);
		});

		test("rejects a missing column", async () => {
			await expectParseError(
				csvFile("folder,favorite,type,name\nWork,0,login,A"),
				"csv-missing-header",
			);
		});

		test("rejects a row with the wrong column count", async () => {
			await expectParseError(
				csvFile(`${CSV_HEADER}\nWork,0,login,A,,,0,,,`),
				"csv-row-column-mismatch",
			);
		});

		test("rejects an empty file", async () => {
			await expectParseError(csvFile(""), "csv-empty-file");
		});

		test("rejects a header-only export", async () => {
			await expectParseError(csvFile(CSV_HEADER), "no-items-found");
		});

		test("rejects an organization export before complaining about columns", async () => {
			await expectParseError(
				csvFile(
					"collections,type,name,notes,fields,login_uri,login_username,login_password,login_totp\nEngineering,login,A,,,,,,",
				),
				"bitwarden-organization-export-unsupported",
			);
		});

		test("rejects an attachment ZIP", async () => {
			await expectParseError(
				new File(["PKbinary"], "bitwarden_export.zip"),
				"bitwarden-attachment-export-unsupported",
			);
		});

		test("rejects a ZIP disguised as .json", async () => {
			await expectParseError(
				new File(["PKbinary"], "bitwarden_export.json"),
				"bitwarden-attachment-export-unsupported",
			);
		});
	});

	describe("JSON export", () => {
		const jsonExport = {
			encrypted: false,
			folders: [
				{ id: "f-work", name: "Work" },
				{ id: "f-empty", name: "Empty folder" },
			],
			items: [
				{
					id: "item-login",
					folderId: "f-work",
					type: 1,
					reprompt: 1,
					name: "GitHub",
					notes: "note body",
					favorite: true,
					fields: [
						{ name: "API Key", value: "abc123", type: 0 },
						{ name: "Recovery", value: "s3cret", type: 1 },
						{ name: "MFA enabled", value: "true", type: 2 },
						{ name: "Linked username", value: null, type: 3, linkedId: 100 },
					],
					login: {
						uris: [
							{ uri: "https://github.com", match: null },
							{ uri: "github.io", match: null },
						],
						username: "octocat",
						password: "hunter2",
						totp: TOTP_SECRET,
						fido2Credentials: [{ credentialId: "abc" }],
					},
					passwordHistory: [
						{ lastUsedDate: "2026-01-02T03:04:05.000Z", password: "old-one" },
					],
				},
				{
					id: "item-note",
					folderId: null,
					type: 2,
					name: "Recovery codes",
					notes: "one\ntwo",
					favorite: false,
					secureNote: { type: 0 },
				},
				{
					id: "item-card",
					folderId: null,
					type: 3,
					name: "Amex",
					favorite: false,
					card: {
						cardholderName: "Ada Lovelace",
						brand: "Amex",
						number: "371449635398431",
						expMonth: "4",
						expYear: "2031",
						code: "1234",
					},
				},
				{
					id: "item-identity",
					folderId: null,
					type: 4,
					name: "Ada",
					favorite: false,
					identity: {
						title: "Mrs",
						firstName: "Ada",
						middleName: "King",
						lastName: "Lovelace",
						address1: "12 Baker Street",
						address2: "Flat 3",
						address3: null,
						city: "London",
						state: "Greater London",
						postalCode: "NW1",
						country: "GB",
						company: "Analytical Engines",
						email: "ada@example.com",
						phone: "+44 20 7946 0000",
						ssn: "123-45-6789",
						username: "ada",
						passportNumber: "P1234567",
						licenseNumber: "LIC-9",
					},
				},
				{
					id: "item-ssh",
					folderId: null,
					type: 5,
					name: "Deploy key",
					favorite: false,
					sshKey: { privateKey: "x", publicKey: "y", keyFingerprint: "z" },
				},
				{
					id: "item-deleted",
					folderId: null,
					type: 1,
					name: "Trashed login",
					favorite: false,
					deletedDate: "2026-02-01T00:00:00.000Z",
					login: { username: "gone", password: "gone" },
				},
			],
		};

		test("maps folders and the unfoldered bucket onto source vaults", async () => {
			const preview = await bitwardenImportProvider.parse(jsonFile(jsonExport));

			expect(
				preview.sourceVaults.map((vault) => [
					vault.name,
					vault.itemCount,
					vault.skippedCount,
				]),
			).toEqual([
				["Work", 1, 0],
				["Empty folder", 0, 0],
				["No Folder", 3, 2],
			]);
			expect(
				preview.sourceVaults.find((vault) => vault.nameCode === "no-folder")
					?.id,
			).toBe("bitwarden-no-folder");
		});

		test("uses the export uuid as the item id", async () => {
			const preview = await bitwardenImportProvider.parse(jsonFile(jsonExport));

			expect(itemByTitle(preview, "GitHub").id).toBe("item-login");
		});

		test("maps a login with URIs, history and custom field types", async () => {
			const preview = await bitwardenImportProvider.parse(jsonFile(jsonExport));
			const { data, category, favorite } = itemByTitle(preview, "GitHub");

			expect(category).toBe("login");
			expect(favorite).toBe(true);
			expect(data.urls).toEqual(["https://github.com", "https://github.io"]);
			expect(data.username).toBe("octocat");
			expect(data.password).toBe("hunter2");
			expect(data.passwordHistory).toEqual([
				{ password: "old-one", changedAt: "2026-01-02T03:04:05.000Z" },
			]);
			expect(data.customFields).toEqual([
				{
					id: "item-login-custom-1",
					label: "API Key",
					value: "abc123",
					type: "text",
				},
				{
					id: "item-login-custom-2",
					label: "Recovery",
					value: "s3cret",
					type: "password",
				},
				{
					id: "item-login-custom-3",
					label: "MFA enabled",
					value: "true",
					type: "text",
				},
			]);
		});

		test("maps a secure note", async () => {
			const preview = await bitwardenImportProvider.parse(jsonFile(jsonExport));
			const note = itemByTitle(preview, "Recovery codes");

			expect(note.category).toBe("secure-note");
			expect(note.data.note).toBe("one\ntwo");
		});

		test("maps a card including a combined expiry date", async () => {
			const preview = await bitwardenImportProvider.parse(jsonFile(jsonExport));
			const card = itemByTitle(preview, "Amex");

			expect(card.category).toBe("credit-card");
			expect(card.data.cardholderName).toBe("Ada Lovelace");
			expect(card.data.cardNumber).toBe("371449635398431");
			expect(card.data.cvv).toBe("1234");
			expect(card.data.expiryDate).toBe("04/2031");
		});

		test("maps an identity into address, phone and custom fields", async () => {
			const preview = await bitwardenImportProvider.parse(jsonFile(jsonExport));
			const identity = itemByTitle(preview, "Ada");

			expect(identity.category).toBe("identity");
			expect(identity.data.firstName).toBe("Ada");
			expect(identity.data.middleName).toBe("King");
			expect(identity.data.lastName).toBe("Lovelace");
			expect(identity.data.email).toBe("ada@example.com");
			expect(identity.data.ssn).toBe("123-45-6789");
			expect(identity.data.passportNumber).toBe("P1234567");
			expect(identity.data.driversLicense).toBe("LIC-9");
			expect(identity.data.addresses).toEqual([
				{
					id: "item-identity-address-1",
					street: "12 Baker Street\nFlat 3",
					city: "London",
					state: "Greater London",
					zip: "NW1",
					country: "GB",
				},
			]);
			expect(identity.data.phoneNumbers).toEqual([
				{
					id: "item-identity-phone-1",
					label: "Phone",
					number: "+44 20 7946 0000",
				},
			]);
			expect(
				identity.data.customFields?.map((field) => [field.label, field.value]),
			).toEqual([
				["Title", "Mrs"],
				["Company", "Analytical Engines"],
				["Username", "ada"],
			]);
		});

		test("skips SSH keys and deleted items, counting both", async () => {
			const preview = await bitwardenImportProvider.parse(jsonFile(jsonExport));

			expect(
				preview.sourceItems.some((item) => item.title === "Deploy key"),
			).toBe(false);
			expect(
				preview.sourceItems.some((item) => item.title === "Trashed login"),
			).toBe(false);
			expect(preview.summary.skippedCount).toBe(2);
			expect(warningCodes(preview)).toEqual(
				expect.arrayContaining(["unsupported-item-type", "archived-skipped"]),
			);
		});

		test("reports passkey, reprompt and linked-field loss", async () => {
			const preview = await bitwardenImportProvider.parse(jsonFile(jsonExport));

			expect(warningCodes(preview)).toEqual(
				expect.arrayContaining([
					"passkeys-skipped",
					"reprompt-not-supported",
					"linked-field-skipped",
				]),
			);
		});

		test("generates the right TOTP code at a fixed clock", async () => {
			const preview = await bitwardenImportProvider.parse(jsonFile(jsonExport));
			const { data } = itemByTitle(preview, "GitHub");

			expect(
				await generateTotpAt({ secret: data.totpSecret ?? "" }, FIXED_CLOCK),
			).toBe("742275");
		});
	});

	describe("JSON structural failures return nothing", () => {
		test("rejects an encrypted export", async () => {
			await expectParseError(
				jsonFile({ encrypted: true, items: [] }),
				"bitwarden-encrypted-export-unsupported",
			);
		});

		test("rejects a password-protected export", async () => {
			await expectParseError(
				jsonFile({
					encrypted: true,
					passwordProtected: true,
					encKeyValidation_DO_NOT_EDIT: "x",
					data: "cipher",
				}),
				"bitwarden-encrypted-export-unsupported",
			);
		});

		test("rejects an organization export", async () => {
			await expectParseError(
				jsonFile({
					encrypted: false,
					collections: [{ id: "c1", name: "Engineering" }],
					items: [],
				}),
				"bitwarden-organization-export-unsupported",
			);
		});

		test("rejects malformed JSON", async () => {
			await expectParseError(
				new File(["{not json"], "bitwarden_export.json"),
				"invalid-export-data-json",
			);
		});

		test("rejects an export with no items", async () => {
			await expectParseError(
				jsonFile({ encrypted: false, folders: [], items: [] }),
				"no-items-found",
			);
		});
	});

	describe("toDecryptedItemData", () => {
		test("passes category, data and favorite through", async () => {
			const preview = await bitwardenImportProvider.parse(csvFile(CSV_EXPORT));
			const github = itemByTitle(preview, "GitHub");

			expect(bitwardenImportProvider.toDecryptedItemData(github)).toEqual({
				category: "login",
				data: github.data,
				favorite: true,
			});
		});

		test("rejects items from another provider", () => {
			expect(() =>
				bitwardenImportProvider.toDecryptedItemData({
					providerId: "1password-1pux",
					id: "x",
					sourceVaultId: "v",
					title: "t",
					category: "login",
					favorite: false,
					data: { title: "t" },
				}),
			).toThrow(ImportProviderError);
		});
	});

	/**
	 * Parses the committed sanitized export from a real Bitwarden web vault
	 * byte-for-byte. The synthetic fixtures above stay because this vault cannot
	 * cover everything (see `fixtures/bitwarden/README.md`); this suite exists to
	 * catch what only a real export shows — notably that `folderId` is *absent*
	 * on unfoldered items rather than null, that `expMonth`/`expYear` arrive as
	 * strings, and that a login can omit `username`/`password` entirely.
	 */
	describe("real sanitized export (fixtures/bitwarden)", () => {
		const realExportJson = readFileSync(
			new URL("./fixtures/bitwarden/individual-export.json", import.meta.url),
			"utf8",
		);
		const realExportCsv = readFileSync(
			new URL("./fixtures/bitwarden/individual-export.csv", import.meta.url),
			"utf8",
		);

		function realCsvFile(): File {
			return new File([realExportCsv], "bitwarden_export_20260729120827.csv", {
				type: "text/csv",
			});
		}

		function realExportFile(): File {
			return new File(
				[realExportJson],
				"bitwarden_export_20260729120709.json",
				{
					type: "application/json",
				},
			);
		}

		test("lists every folder, including the empty one, plus an unfoldered bucket", async () => {
			const preview = await bitwardenImportProvider.parse(realExportFile());

			expect(
				preview.sourceVaults.map((vault) => [
					vault.name,
					vault.itemCount,
					vault.skippedCount,
				]),
			).toEqual([
				["Empty", 0, 0],
				["Test", 1, 1],
				["Test 2", 2, 0],
				["No Folder", 3, 0],
			]);
			expect(
				preview.sourceVaults.find((vault) => vault.nameCode === "no-folder")
					?.id,
			).toBe("bitwarden-no-folder");
			expect(preview.summary.itemCount).toBe(6);
			expect(preview.summary.skippedCount).toBe(1);
		});

		test("treats an absent folderId the same as a null one", async () => {
			const preview = await bitwardenImportProvider.parse(realExportFile());

			// Bitwarden omits the key entirely for unfoldered items rather than
			// writing `"folderId": null`, which is what the published samples show.
			expect(realExportJson).not.toContain('"folderId": null');
			expect(itemByTitle(preview, "Google").sourceVaultId).toBe(
				"bitwarden-no-folder",
			);
		});

		test("maps a favorite login with text, boolean and linked custom fields", async () => {
			const preview = await bitwardenImportProvider.parse(realExportFile());
			const figma = itemByTitle(preview, "Figma");

			expect(figma.favorite).toBe(true);
			expect(figma.data.password).toBe("Xk7pQ2mNvR4tLw2231");
			// The linked (type 3) field is dropped, so numbering closes the gap.
			expect(figma.data.customFields).toEqual([
				{
					id: "f4a80c25-3d97-4b16-8e40-72c9b5031ea8-custom-1",
					label: "Test",
					value: "t123",
					type: "text",
				},
				{
					id: "f4a80c25-3d97-4b16-8e40-72c9b5031ea8-custom-2",
					label: "Bool",
					value: "true",
					type: "text",
				},
			]);
			expect(
				preview.warnings.find(
					(warning) => warning.code === "linked-field-skipped",
				)?.params,
			).toMatchObject({ title: "Figma", fieldName: "link" });
		});

		test("carries password history across", async () => {
			const preview = await bitwardenImportProvider.parse(realExportFile());

			expect(itemByTitle(preview, "Figma").data.passwordHistory).toEqual([
				{
					password: "Xk7pQ2mNvR4tLw",
					changedAt: "2026-07-29T10:02:57.849Z",
				},
			]);
			expect(itemByTitle(preview, "Google").data.passwordHistory).toEqual([
				{
					password: "Qm3vT8xLnW2pRk",
					changedAt: "2026-07-29T10:06:05.179Z",
				},
			]);
		});

		test("imports a login that has no username, password or TOTP", async () => {
			const preview = await bitwardenImportProvider.parse(realExportFile());
			const { data, category } = itemByTitle(preview, "GitHub");

			expect(category).toBe("login");
			expect(data.url).toBe("https://github.com");
			expect(data.username).toBeUndefined();
			expect(data.password).toBeUndefined();
			expect(data.totpSecret).toBeUndefined();
		});

		test("generates the right code from a raw base32 TOTP seed", async () => {
			const preview = await bitwardenImportProvider.parse(realExportFile());
			const { data } = itemByTitle(preview, "Figma");

			expect(data.totpSecret).toBe(TOTP_SECRET);
			expect(data.totpAlgorithm).toBeUndefined();
			expect(data.totpDigits).toBeUndefined();
			expect(
				await generateTotpAt({ secret: data.totpSecret ?? "" }, FIXED_CLOCK),
			).toBe("742275");
		});

		test("generates the right code from an otpauth TOTP URI", async () => {
			const preview = await bitwardenImportProvider.parse(realExportFile());
			const { data } = itemByTitle(preview, "Google");

			expect(data.totpSecret).toBe(TOTP_SECRET);
			expect(data.totpAlgorithm).toBe("SHA256");
			expect(data.totpDigits).toBe(8);
			expect(data.totpPeriod).toBe(60);
			expect(
				await generateTotpAt(
					{
						secret: data.totpSecret ?? "",
						algorithm: data.totpAlgorithm,
						digits: data.totpDigits,
						period: data.totpPeriod,
					},
					FIXED_CLOCK,
				),
			).toBe("45806924");
		});

		test("maps a login with two URIs and a hidden custom field", async () => {
			const preview = await bitwardenImportProvider.parse(realExportFile());
			const { data } = itemByTitle(preview, "Google");

			expect(data.urls).toEqual(["https://google.com", "https://google.de"]);
			expect(data.notes).toBe("Dies ist ein Test");
			expect(data.customFields).toEqual([
				{
					id: "8c14e0d6-2b7f-4a91-b3d5-1f6098c4ea77-custom-1",
					label: "Key",
					value: "123",
					type: "password",
				},
			]);
		});

		test("maps the card, joining string expMonth and expYear", async () => {
			const preview = await bitwardenImportProvider.parse(realExportFile());
			const card = itemByTitle(preview, "Kreditkarte");

			expect(card.category).toBe("credit-card");
			expect(card.data.cardholderName).toBe("Ada Lovelace");
			expect(card.data.cardNumber).toBe("4111111111111111");
			expect(card.data.cvv).toBe("123");
			expect(card.data.expiryDate).toBe("01/2024");
		});

		test("maps the German identity, preserving non-ASCII and both address lines", async () => {
			const preview = await bitwardenImportProvider.parse(realExportFile());
			const identity = itemByTitle(preview, "Ada");

			expect(identity.category).toBe("identity");
			expect(identity.data.firstName).toBe("Ada");
			expect(identity.data.lastName).toBe("Lovelace");
			expect(identity.data.email).toBe("ada.lovelace@example.com");
			expect(identity.data.ssn).toBe("123");
			expect(identity.data.passportNumber).toBe("123");
			expect(identity.data.driversLicense).toBe("123");
			expect(identity.data.addresses).toEqual([
				{
					id: "d05b7c93-4e2a-48f1-8a60-c37b95d1e402-address-1",
					street: "Königsberger Straße 7b\nEtage 2",
					city: "München",
					state: "BY",
					zip: "80331",
					country: "Deutschland",
				},
			]);
			expect(identity.data.phoneNumbers?.[0]?.number).toBe("4915100000000");
			expect(
				identity.data.customFields?.map((field) => [field.label, field.value]),
			).toEqual([
				["Title", "Herr"],
				["Company", "Analytical Engines GmbH"],
				["Username", "adalovelace"],
			]);
		});

		test("maps the secure note", async () => {
			const preview = await bitwardenImportProvider.parse(realExportFile());
			const note = itemByTitle(preview, "Test Notiz");

			expect(note.category).toBe("secure-note");
			expect(note.data.note).toBe("Hallo Test Notiz");
		});

		test("skips the SSH key with a warning instead of importing it", async () => {
			const preview = await bitwardenImportProvider.parse(realExportFile());

			expect(
				preview.sourceItems.some((item) => item.title === "Test SSH"),
			).toBe(false);
			expect(
				preview.warnings.find(
					(warning) => warning.code === "unsupported-item-type",
				)?.params,
			).toMatchObject({ title: "Test SSH", sourceCategory: "ssh-key" });
		});

		test("carries no SSH private key material into the preview", async () => {
			const preview = await bitwardenImportProvider.parse(realExportFile());

			expect(JSON.stringify(preview)).not.toContain("PRIVATE KEY");
		});

		test("reports exactly the two expected lossiness warnings", async () => {
			const preview = await bitwardenImportProvider.parse(realExportFile());

			expect(warningCodes(preview).sort()).toEqual([
				"linked-field-skipped",
				"unsupported-item-type",
			]);
		});

		describe("CSV form of the same vault", () => {
			test("carries an undocumented archivedDate column", () => {
				// Bitwarden's published header lists 11 columns; real exports emit a
				// 12th. The parser only *requires* the documented ones, so an export
				// that grows a column keeps working.
				const header = realExportCsv.split("\r\n")[0];

				expect(header).toBe(
					"folder,favorite,type,name,notes,fields,reprompt,archivedDate,login_uri,login_username,login_password,login_totp",
				);
			});

			test("uses CRLF records with a bare LF inside a quoted field", () => {
				// The hardest real-world quoting case, and the reason this parser is
				// hand-rolled: record separators and in-field newlines differ.
				expect(realExportCsv).toContain("\r\n");
				expect(realExportCsv).toContain('"Test: t123\nBool: true');
				expect(realExportCsv.endsWith("\n")).toBe(false);
			});

			test("maps folders and unfoldered rows onto source vaults", async () => {
				const preview = await bitwardenImportProvider.parse(realCsvFile());

				expect(
					preview.sourceVaults.map((vault) => [vault.name, vault.itemCount]),
				).toEqual([
					["Test 2", 2],
					["No Folder", 2],
				]);
				expect(preview.summary.itemCount).toBe(4);
				expect(preview.summary.skippedCount).toBe(0);
			});

			test("splits a quoted comma-separated login_uri into multiple URLs", async () => {
				const preview = await bitwardenImportProvider.parse(realCsvFile());
				const google = itemByTitle(preview, "Google");

				expect(google.data.urls).toEqual([
					"https://google.com",
					"https://google.de",
				]);
				expect(google.data.url).toBe("https://google.com");
			});

			test("splits the multi-line fields column into custom fields", async () => {
				const preview = await bitwardenImportProvider.parse(realCsvFile());
				const figma = itemByTitle(preview, "Figma");

				expect(figma.favorite).toBe(true);
				// CSV cannot express field types, so the hidden/boolean/linked
				// distinction the JSON export carries is flattened to text here.
				// `link: undefined` is exactly what Bitwarden writes for a linked
				// field; it is imported verbatim rather than guessed away.
				expect(figma.data.customFields).toEqual([
					{
						id: "bitwarden-folder-1-row-2-custom-1",
						label: "Test",
						value: "t123",
						type: "text",
					},
					{
						id: "bitwarden-folder-1-row-2-custom-2",
						label: "Bool",
						value: "true",
						type: "text",
					},
					{
						id: "bitwarden-folder-1-row-2-custom-3",
						label: "link",
						value: "undefined",
						type: "text",
					},
				]);
			});

			test("imports a login row with no username, password or TOTP", async () => {
				const preview = await bitwardenImportProvider.parse(realCsvFile());
				const github = itemByTitle(preview, "GitHub");

				expect(github.data.url).toBe("https://github.com");
				expect(github.data.username).toBeUndefined();
				expect(github.data.password).toBeUndefined();
				expect(github.data.totpSecret).toBeUndefined();
			});

			test("imports the note row as a secure note", async () => {
				const preview = await bitwardenImportProvider.parse(realCsvFile());
				const note = itemByTitle(preview, "Test Notiz");

				expect(note.category).toBe("secure-note");
				expect(note.data.note).toBe("Hallo Test Notiz");
			});

			test("generates the right codes from both TOTP forms", async () => {
				const preview = await bitwardenImportProvider.parse(realCsvFile());
				const figma = itemByTitle(preview, "Figma").data;
				const google = itemByTitle(preview, "Google").data;

				expect(
					await generateTotpAt({ secret: figma.totpSecret ?? "" }, FIXED_CLOCK),
				).toBe("742275");
				expect(
					await generateTotpAt(
						{
							secret: google.totpSecret ?? "",
							algorithm: google.totpAlgorithm,
							digits: google.totpDigits,
							period: google.totpPeriod,
						},
						FIXED_CLOCK,
					),
				).toBe("45806924");
			});

			test("skips an archived row instead of importing it", async () => {
				// Bitwarden leaves archivedDate empty for live items; fill it in on the
				// Figma row to prove the column is honoured rather than ignored.
				const withArchivedRow = realExportCsv.replace(
					",0,,https://figma.com,",
					",0,2026-07-29T10:00:00.000Z,https://figma.com,",
				);
				expect(withArchivedRow).not.toBe(realExportCsv);

				const preview = await bitwardenImportProvider.parse(
					new File([withArchivedRow], "bitwarden_export.csv", {
						type: "text/csv",
					}),
				);

				expect(preview.sourceItems.some((item) => item.title === "Figma")).toBe(
					false,
				);
				expect(preview.summary.skippedCount).toBe(1);
				expect(
					preview.warnings.find(
						(warning) => warning.code === "archived-skipped",
					)?.params,
				).toMatchObject({ title: "Figma" });
			});

			test("shows the documented CSV lossiness against the JSON export", async () => {
				const fromCsv = await bitwardenImportProvider.parse(realCsvFile());
				const fromJson = await bitwardenImportProvider.parse(realExportFile());

				// CSV carries only logins and notes: the card, the identity and the
				// SSH key are absent from the file entirely, not skipped by us.
				expect(fromCsv.sourceItems.map((item) => item.title).sort()).toEqual([
					"Figma",
					"GitHub",
					"Google",
					"Test Notiz",
				]);
				expect(fromJson.sourceItems.map((item) => item.title).sort()).toEqual([
					"Ada",
					"Figma",
					"GitHub",
					"Google",
					"Kreditkarte",
					"Test Notiz",
				]);
				// ...and password history only survives in JSON.
				expect(
					itemByTitle(fromCsv, "Figma").data.passwordHistory,
				).toBeUndefined();
				expect(
					itemByTitle(fromJson, "Figma").data.passwordHistory,
				).toHaveLength(1);
			});
		});
	});
});
