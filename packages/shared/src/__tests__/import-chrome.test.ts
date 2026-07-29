import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromeImportProvider } from "../import/providers/chrome";
import type { ImportPreview, ImportSourceItem } from "../import/types";
import { ImportProviderError } from "../import/types";

const CURRENT_HEADER = "name,url,username,password,note";
const LEGACY_HEADER = "name,url,username,password";

/**
 * Synthetic rows for the cases Chromium's own writer tests do not cover:
 * embedded commas, escaped quotes, non-ASCII text, empty username and empty
 * note. Quoting follows `csv_writer.cc`: a field is quoted only when it
 * contains a comma, a quote or a line break, and inner quotes are doubled.
 */
const SYNTHETIC_ROWS = [
	CURRENT_HEADER,
	'"Comma, Inc.",https://comma.example.com/,user@example.com,"pa,ss","note, with comma"',
	'quote.example.com,https://quote.example.com/,"he said ""hi""","p""wd","He said ""hi"""',
	"münchen.example.com,https://münchen.example.com/,jörg@example.com,Straße1ß,Notiz mit Umlauten: äöüß",
	"nouser.example.com,https://nouser.example.com/,,onlypassword,",
	'multiline.example.com,https://multiline.example.com/,a,b,"line one\nline two"',
];

const SYNTHETIC_EXPORT = SYNTHETIC_ROWS.join("\n");
/** Same content as a Windows export: CRLF records, CRLF inside quoted notes. */
const SYNTHETIC_EXPORT_CRLF = SYNTHETIC_ROWS.join("\r\n").replace(
	"line one\nline two",
	"line one\r\nline two",
);

function fixture(name: string): string {
	return readFileSync(
		new URL(`./fixtures/chrome/${name}`, import.meta.url),
		"utf8",
	);
}

function csvFile(content: string, name = "Chrome Passwords.csv"): File {
	return new File([content], name, { type: "text/csv" });
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
		await chromeImportProvider.parse(file);
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(ImportProviderError);
	expect((thrown as ImportProviderError).code).toBe(
		code as ImportProviderError["code"],
	);
}

describe("Chrome import provider", () => {
	describe("canParse", () => {
		test("accepts .csv only", () => {
			expect(chromeImportProvider.canParse(csvFile(SYNTHETIC_EXPORT))).toBe(
				true,
			);
			expect(chromeImportProvider.canParse(new File([""], "export.CSV"))).toBe(
				true,
			);
			expect(chromeImportProvider.canParse(new File([""], "export.json"))).toBe(
				false,
			);
			expect(chromeImportProvider.canParse(new File([""], "export.zip"))).toBe(
				false,
			);
		});

		test("rejects a non-csv file at parse time too", async () => {
			await expectParseError(
				new File([SYNTHETIC_EXPORT], "export.txt"),
				"unsupported-file-type",
			);
		});
	});

	describe("pinned Chromium exporter output (fixtures/chrome)", () => {
		test("maps the single-password export, note newline intact", async () => {
			const preview = await chromeImportProvider.parse(
				csvFile(fixture("chromium-single-password.csv")),
			);

			expect(preview.providerId).toBe("chrome");
			expect(preview.summary.itemCount).toBe(1);
			expect(preview.summary.skippedCount).toBe(0);
			expect(preview.warnings).toEqual([]);

			const item = itemByTitle(preview, "example.com");
			expect(item.category).toBe("login");
			expect(item.favorite).toBe(false);
			expect(item.data.url).toBe("https://example.com/");
			expect(item.data.urls).toEqual(["https://example.com/"]);
			expect(item.data.username).toBe("Someone");
			expect(item.data.password).toBe("Secret");
			expect(item.data.notes).toBe("Note Line 1\nNote Line 2");
		});

		test("reads the Windows CRLF export identically apart from the note's own newline", async () => {
			const windowsCsv = fixture("chromium-single-password-windows.csv");
			expect(windowsCsv).toContain("\r\n");

			const preview = await chromeImportProvider.parse(csvFile(windowsCsv));
			const item = itemByTitle(preview, "example.com");

			expect(item.data.password).toBe("Secret");
			// The record separator is consumed; the one inside the quoted note is
			// content and survives verbatim.
			expect(item.data.notes).toBe("Note Line 1\r\nNote Line 2");
		});

		test("keeps an android facet URI verbatim and imports its app name", async () => {
			const preview = await chromeImportProvider.parse(
				csvFile(fixture("chromium-android-and-web.csv")),
			);

			expect(preview.summary.itemCount).toBe(2);
			const netflix = itemByTitle(preview, "Netflix");
			expect(netflix.data.url).toBe(
				"android://Jzj5T2E45Hb33D-lk-EHZVCrb7a064dEicTwrTYQYGXO99JqE2YERhbMP1qLogwJiy87OsBzC09Gk094Z-U_hg==@com.netflix.mediaclient",
			);
			// An empty `note` column must not become an empty notes field.
			expect(netflix.data.notes).toBeUndefined();
		});

		test("imports every row of a multi-row export, duplicates included", async () => {
			const preview = await chromeImportProvider.parse(
				csvFile(fixture("chromium-sorted.csv")),
			);

			// Chrome writes one row per affiliated domain, so two rows can share a
			// name. Both must survive as separate items.
			expect(preview.summary.itemCount).toBe(4);
			expect(preview.sourceItems.map((item) => item.id)).toEqual([
				"chrome-row-2",
				"chrome-row-3",
				"chrome-row-4",
				"chrome-row-5",
			]);
			expect(
				preview.sourceItems.map((item) => [item.title, item.data.username]),
			).toEqual([
				["example.com", "a"],
				["example.com", "someone"],
				["example.org", "a"],
				["other.org", "a"],
			]);
		});

		test("accepts the older four-column layout", async () => {
			const preview = await chromeImportProvider.parse(
				csvFile(fixture("bitwarden-spec-simple-password.csv")),
			);

			const item = itemByTitle(preview, "www.example.com");
			expect(item.data.url).toBe("https://www.example.com/");
			expect(item.data.username).toBe("username@example.com");
			expect(item.data.password).toBe("wpC9qFvsbWQK5Z");
			expect(item.data.notes).toBeUndefined();
		});

		test("falls back to the android package when the name column is blank", async () => {
			const preview = await chromeImportProvider.parse(
				csvFile(fixture("bitwarden-spec-android.csv")),
			);

			const item = itemByTitle(preview, "com.xyz.example.app.android");
			expect(item.data.username).toBe("username@example.com");
			expect(item.data.url).toBe(
				"android://N2H9MndUUUt3JuQSWAKexOU9oJLJeHR4nyUGac5E1TXKppkY7xtdRl6l8vKo1hQWCqAEy4gsNLUBIbVxpdmhOP==@com.xyz.example.app.android/",
			);
			// The package name is a full recovery, not a loss.
			expect(warningCodes(preview)).toEqual([]);
		});
	});

	describe("value preservation", () => {
		test("preserves embedded commas, escaped quotes and non-ASCII text", async () => {
			const preview = await chromeImportProvider.parse(
				csvFile(SYNTHETIC_EXPORT),
			);

			const comma = itemByTitle(preview, "Comma, Inc.");
			expect(comma.data.password).toBe("pa,ss");
			expect(comma.data.notes).toBe("note, with comma");

			const quoted = itemByTitle(preview, "quote.example.com");
			expect(quoted.data.username).toBe('he said "hi"');
			expect(quoted.data.password).toBe('p"wd');
			expect(quoted.data.notes).toBe('He said "hi"');

			const nonAscii = itemByTitle(preview, "münchen.example.com");
			expect(nonAscii.data.username).toBe("jörg@example.com");
			expect(nonAscii.data.password).toBe("Straße1ß");
			expect(nonAscii.data.notes).toBe("Notiz mit Umlauten: äöüß");
		});

		test("drops empty username and empty note instead of storing blanks", async () => {
			const preview = await chromeImportProvider.parse(
				csvFile(SYNTHETIC_EXPORT),
			);
			const item = itemByTitle(preview, "nouser.example.com");

			expect(item.data.username).toBeUndefined();
			expect(item.data.notes).toBeUndefined();
			expect(item.data.password).toBe("onlypassword");
		});

		test("survives a BOM and CRLF records", async () => {
			const preview = await chromeImportProvider.parse(
				csvFile(`﻿${SYNTHETIC_EXPORT_CRLF}`),
			);

			expect(preview.summary.itemCount).toBe(5);
			expect(itemByTitle(preview, "multiline.example.com").data.notes).toBe(
				"line one\r\nline two",
			);
		});

		test("produces deterministic item ids across parses", async () => {
			const first = await chromeImportProvider.parse(csvFile(SYNTHETIC_EXPORT));
			const second = await chromeImportProvider.parse(
				csvFile(SYNTHETIC_EXPORT),
			);

			expect(first.sourceItems.map((item) => item.id)).toEqual(
				second.sourceItems.map((item) => item.id),
			);
			expect(itemByTitle(first, "Comma, Inc.").id).toBe("chrome-row-2");
		});

		test("groups everything under one localizable source vault", async () => {
			const preview = await chromeImportProvider.parse(
				csvFile(SYNTHETIC_EXPORT),
			);

			expect(preview.sourceVaults).toEqual([
				{
					id: "chrome-passwords",
					name: "Chrome Passwords",
					nameCode: "chrome-passwords",
					itemCount: 5,
					skippedCount: 0,
				},
			]);
			expect(preview.summary.vaultCount).toBe(1);
		});

		test("warns once when a row has neither a name nor an android package", async () => {
			const preview = await chromeImportProvider.parse(
				csvFile(`${CURRENT_HEADER}\n,https://example.com/,user,pw,`),
			);

			expect(warningCodes(preview)).toEqual(["missing-title"]);
			expect(preview.warnings[0]?.params).toEqual({
				itemNumber: 1,
				vaultName: "Chrome Passwords",
				title: "Imported item 1",
			});
			expect(itemByTitle(preview, "Imported item 1").data.password).toBe("pw");
		});
	});

	describe("documented unsupported data", () => {
		test("carries no TOTP, passkey, folder, favorite or custom-field data", async () => {
			const preview = await chromeImportProvider.parse(
				csvFile(SYNTHETIC_EXPORT),
			);

			for (const item of preview.sourceItems) {
				// The Chrome CSV format has no column for any of these, so nothing
				// may be invented for them.
				expect(item.category).toBe("login");
				expect(item.favorite).toBe(false);
				expect(item.data.totpSecret).toBeUndefined();
				expect(item.data.customFields).toBeUndefined();
				expect(item.data.passwordHistory).toBeUndefined();
			}
			expect(preview.sourceVaults).toHaveLength(1);
		});

		test("toDecryptedItemData rejects an item from another provider", () => {
			const foreign = {
				providerId: "bitwarden",
				id: "x",
				sourceVaultId: "y",
				title: "t",
				category: "login",
				favorite: false,
				data: { title: "t" },
			} as unknown as ImportSourceItem;

			expect(() => chromeImportProvider.toDecryptedItemData(foreign)).toThrow(
				ImportProviderError,
			);
		});
	});

	describe("structural failures return nothing", () => {
		test("rejects an empty file", async () => {
			await expectParseError(csvFile(""), "csv-empty-file");
		});

		test("rejects a header-only export", async () => {
			await expectParseError(csvFile(CURRENT_HEADER), "no-items-found");
		});

		test("rejects a file truncated mid-quote", async () => {
			await expectParseError(
				csvFile(`${CURRENT_HEADER}\n"unterminated,https://a.example.com/,u,p,`),
				"csv-malformed-quoting",
			);
		});

		test("rejects a row truncated after the header", async () => {
			await expectParseError(
				csvFile(`${CURRENT_HEADER}\nexample.com,https://example.com/,u`),
				"csv-row-column-mismatch",
			);
		});

		test("rejects a duplicated column", async () => {
			await expectParseError(
				csvFile(`${CURRENT_HEADER},note\na,b,c,d,e,f`),
				"csv-duplicate-header",
			);
		});

		test("rejects an unknown header variant", async () => {
			await expectParseError(
				csvFile("url,username,password\nhttps://a.example.com/,u,p"),
				"csv-unknown-header-variant",
			);
		});

		test("rejects a reordered header even though every column is present", async () => {
			await expectParseError(
				csvFile("url,name,username,password,note\nb,a,c,d,e"),
				"csv-unknown-header-variant",
			);
		});

		test("rejects a Chrome-like header carrying an extra column", async () => {
			await expectParseError(
				csvFile(`${CURRENT_HEADER},totp\na,b,c,d,e,f`),
				"csv-unknown-header-variant",
			);
		});

		test("rejects a Bitwarden CSV picked by mistake", async () => {
			await expectParseError(
				csvFile(
					"folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\nWork,0,login,A,,,0,,,,",
				),
				"csv-unknown-header-variant",
			);
		});

		test("names both accepted layouts in the error params", async () => {
			let thrown: unknown;
			try {
				await chromeImportProvider.parse(csvFile("a,b\n1,2"));
			} catch (error) {
				thrown = error;
			}

			expect((thrown as ImportProviderError).params).toEqual({
				headers: "a,b",
				expected: `${CURRENT_HEADER} | ${LEGACY_HEADER}`,
			});
		});
	});
});
