import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { firefoxImportProvider } from "../import/providers/firefox";
import type { ImportPreview, ImportSourceItem } from "../import/types";
import { ImportProviderError } from "../import/types";

/**
 * Firefox's exporter header, verbatim from `LoginExport.sys.mjs`. Every cell is
 * quoted in a real export, which is itself part of what these tests pin.
 */
const CSV_HEADER =
	'"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"';

/**
 * Synthetic rows exercising the cases the committed fixture cannot reach —
 * mostly values Firefox's own login manager refuses to store, so no genuine
 * export could ever contain them.
 */
const CSV_RECORDS = [
	CSV_HEADER,
	'"https://github.com","octocat","hunter2",,"https://github.com","{6f0d5a1c-3b8e-4a2f-9c17-5e4b8d2a7f31}","1784538843000","1785325338000","1784538843000"',
	'"https://intranet.example.com","realm-user","realm-pass","Restricted Area",,"{47d2a6e9-8f15-4c03-a92b-3e6d0b7c1af8}","1784909141000","1784909141000","1784909141000"',
	'"https://www.example.org","","kein-benutzername",,"https://www.example.org",,,,',
];

const CSV_EXPORT = CSV_RECORDS.join("\r\n");

function csvFile(content: string, name = "logins.csv"): File {
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
		await firefoxImportProvider.parse(file);
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(ImportProviderError);
	expect((thrown as ImportProviderError).code).toBe(
		code as ImportProviderError["code"],
	);
}

describe("Firefox import provider", () => {
	describe("canParse", () => {
		test("accepts .csv", () => {
			expect(firefoxImportProvider.canParse(csvFile(CSV_EXPORT))).toBe(true);
		});

		test("rejects unrelated extensions", () => {
			expect(
				firefoxImportProvider.canParse(new File([""], "logins.json")),
			).toBe(false);
			expect(
				firefoxImportProvider.canParse(new File([""], "export.1pux")),
			).toBe(false);
		});

		test("parse rejects a file it cannot parse rather than guessing", async () => {
			await expectParseError(
				new File([CSV_EXPORT], "logins.json"),
				"unsupported-file-type",
			);
		});
	});

	describe("mapping", () => {
		test("maps url, username and password onto a login item", async () => {
			const preview = await firefoxImportProvider.parse(csvFile(CSV_EXPORT));
			const item = itemByTitle(preview, "github.com");

			expect(preview.providerId).toBe("firefox");
			expect(item.category).toBe("login");
			expect(item.favorite).toBe(false);
			expect(item.data.url).toBe("https://github.com");
			expect(item.data.urls).toEqual(["https://github.com"]);
			expect(item.data.username).toBe("octocat");
			expect(item.data.password).toBe("hunter2");
		});

		test("groups everything into one Firefox source vault", async () => {
			const preview = await firefoxImportProvider.parse(csvFile(CSV_EXPORT));

			expect(preview.sourceVaults).toEqual([
				{
					id: "firefox-logins",
					name: "Firefox",
					itemCount: 3,
					skippedCount: 0,
				},
			]);
			expect(preview.summary.vaultCount).toBe(1);
			expect(preview.summary.itemCount).toBe(3);
			expect(
				preview.sourceItems.every(
					(item) => item.sourceVaultId === "firefox-logins",
				),
			).toBe(true);
		});

		test("carries an HTTP-auth realm across as a custom field", async () => {
			const preview = await firefoxImportProvider.parse(csvFile(CSV_EXPORT));
			const item = itemByTitle(preview, "intranet.example.com");

			expect(item.data.customFields).toEqual([
				{
					id: "firefox-row-3-custom-1",
					label: "HTTP Realm",
					value: "Restricted Area",
					type: "text",
				},
			]);
		});

		test("leaves form logins without a custom field", async () => {
			const preview = await firefoxImportProvider.parse(csvFile(CSV_EXPORT));

			expect(
				itemByTitle(preview, "github.com").data.customFields,
			).toBeUndefined();
		});

		test("an empty-string httpRealm does not become a field", async () => {
			const preview = await firefoxImportProvider.parse(
				csvFile(
					[
						CSV_HEADER,
						'"http://legacy.example.net","legacy-user","legacy-pass","",,,,,',
					].join("\r\n"),
				),
			);

			expect(
				itemByTitle(preview, "legacy.example.net").data.customFields,
			).toBeUndefined();
		});

		test("keeps an empty username off the item instead of storing a blank", async () => {
			const preview = await firefoxImportProvider.parse(csvFile(CSV_EXPORT));
			const item = itemByTitle(preview, "example.org");

			expect(item.data.username).toBeUndefined();
			expect(item.data.password).toBe("kein-benutzername");
		});

		test("drops formActionOrigin, guid and timestamps entirely", async () => {
			// The form action points at a different host than the origin: importing
			// it as a URL would attach the login to a site it does not belong to.
			const preview = await firefoxImportProvider.parse(
				csvFile(
					[
						CSV_HEADER,
						'"https://portal.example.com","sso-user","sso-pass",,"https://sso.example.net","{2f6d8a04-9c73-4b15-8e02-4a9d7f1c6b38}","1784909141000","1785325338000","1784909141000"',
					].join("\r\n"),
				),
			);
			const item = itemByTitle(preview, "portal.example.com");

			expect(item.data.urls).toEqual(["https://portal.example.com"]);
			const serialized = JSON.stringify(item.data);
			expect(serialized).not.toContain("sso.example.net");
			expect(serialized).not.toContain("2f6d8a04");
			expect(serialized).not.toContain("1784909141000");
		});

		test("skips the Firefox Sync account row and keeps its neighbours", async () => {
			const preview = await firefoxImportProvider.parse(
				csvFile(
					[
						CSV_HEADER,
						'"https://github.com","octocat","hunter2",,"https://github.com",,,,',
						'"chrome://FirefoxAccounts","a1b2c3d4","{""version"":1,""kSync"":""0f1e2d3c""}","Firefox Accounts credentials",,,,,',
						'"https://example.net","other","secret",,"https://example.net",,,,',
					].join("\r\n"),
				),
			);

			expect(preview.sourceItems.map((item) => item.title)).toEqual([
				"github.com",
				"example.net",
			]);
			expect(warningCodes(preview)).toEqual(["sync-account-skipped"]);
			expect(preview.summary.skippedCount).toBe(1);
			expect(preview.sourceVaults[0]?.skippedCount).toBe(1);
			expect(JSON.stringify(preview.sourceItems)).not.toContain("kSync");
		});

		test("skips a row carrying no url, username or password", async () => {
			const preview = await firefoxImportProvider.parse(
				csvFile(
					[
						CSV_HEADER,
						'"https://github.com","octocat","hunter2",,"https://github.com",,,,',
						",,,,,,,,",
					].join("\r\n"),
				),
			);

			expect(preview.sourceItems).toHaveLength(1);
			expect(warningCodes(preview)).toEqual(["invalid-item"]);
			expect(preview.summary.skippedCount).toBe(1);
		});
	});

	describe("derived titles", () => {
		test("uses the host and strips a leading www.", async () => {
			const preview = await firefoxImportProvider.parse(
				csvFile(
					[
						CSV_HEADER,
						'"https://www.example.org/login?next=/","user","pass",,"https://www.example.org",,,,',
						'"https://www7.example.com:8080","port-user","port-pass",,"https://www7.example.com:8080",,,,',
					].join("\r\n"),
				),
			);

			// The port is part of the host and is kept: it distinguishes two logins
			// that would otherwise be named identically.
			expect(preview.sourceItems.map((item) => item.title)).toEqual([
				"example.org",
				"www7.example.com:8080",
			]);
		});

		test("falls back to the raw origin when there is no host", async () => {
			const preview = await firefoxImportProvider.parse(
				csvFile(
					[
						CSV_HEADER,
						'"file://","file: username","file: password",,"file://",,,,',
					].join("\r\n"),
				),
			);

			expect(preview.sourceItems[0]?.title).toBe("file://");
			expect(warningCodes(preview)).toEqual([]);
		});

		test("warns and numbers the item when the url is empty", async () => {
			const preview = await firefoxImportProvider.parse(
				csvFile([CSV_HEADER, ',"orphan","pass",,,,,,'].join("\r\n")),
			);

			expect(preview.sourceItems[0]?.title).toBe("Imported item 1");
			expect(preview.sourceItems[0]?.data.url).toBeUndefined();
			expect(warningCodes(preview)).toEqual(["missing-title"]);
		});
	});

	describe("CSV structure", () => {
		test("accepts the real exporter's CRLF records with no trailing newline", async () => {
			const preview = await firefoxImportProvider.parse(csvFile(CSV_EXPORT));

			expect(CSV_EXPORT.endsWith("\n")).toBe(false);
			expect(preview.sourceItems).toHaveLength(3);
		});

		test("accepts LF records and a trailing newline", async () => {
			const preview = await firefoxImportProvider.parse(
				csvFile(`${CSV_RECORDS.join("\n")}\n`),
			);

			expect(preview.sourceItems).toHaveLength(3);
		});

		test("accepts a BOM", async () => {
			const preview = await firefoxImportProvider.parse(
				csvFile(`﻿${CSV_EXPORT}`),
			);

			expect(preview.sourceItems).toHaveLength(3);
		});

		test("unescapes doubled quotes", async () => {
			const preview = await firefoxImportProvider.parse(
				csvFile(
					[
						CSV_HEADER,
						'"https://quote.example.com","quoter","pa""ss,word",,"https://quote.example.com",,,,',
					].join("\r\n"),
				),
			);

			expect(itemByTitle(preview, "quote.example.com").data.password).toBe(
				'pa"ss,word',
			);
		});

		test("keeps a newline inside a quoted value", async () => {
			// Firefox's login manager rejects newlines in credentials, so no genuine
			// export contains one. The parser must not corrupt the file if it does.
			const preview = await firefoxImportProvider.parse(
				csvFile(
					[
						CSV_HEADER,
						'"https://multiline.example.com","user","line one\nline two",,"https://multiline.example.com",,,,',
					].join("\r\n"),
				),
			);

			expect(itemByTitle(preview, "multiline.example.com").data.password).toBe(
				"line one\nline two",
			);
		});

		test("tolerates a column appended by a future Firefox release", async () => {
			const preview = await firefoxImportProvider.parse(
				csvFile(
					[
						`${CSV_HEADER},"timesUsed"`,
						'"https://github.com","octocat","hunter2",,"https://github.com",,,,,"7"',
					].join("\r\n"),
				),
			);

			expect(itemByTitle(preview, "github.com").data.password).toBe("hunter2");
		});
	});

	describe("structural failures stop the whole parse", () => {
		test("empty file", async () => {
			await expectParseError(csvFile("   \n  "), "csv-empty-file");
		});

		test("header only", async () => {
			await expectParseError(csvFile(CSV_HEADER), "no-items-found");
		});

		test("unclosed quote", async () => {
			await expectParseError(
				csvFile(
					[
						CSV_HEADER,
						'"https://github.com","octocat","hunter2,,"https://github.com",,,,',
					].join("\r\n"),
				),
				"csv-malformed-quoting",
			);
		});

		test("truncated final row", async () => {
			await expectParseError(
				csvFile(
					[CSV_HEADER, '"https://github.com","octocat","hunter2"'].join("\r\n"),
				),
				"csv-row-column-mismatch",
			);
		});

		test("row with too many columns", async () => {
			await expectParseError(
				csvFile(
					[
						CSV_HEADER,
						'"https://github.com","octocat","hunter2",,"https://github.com",,,,,"extra"',
					].join("\r\n"),
				),
				"csv-row-column-mismatch",
			);
		});

		test("duplicate header", async () => {
			await expectParseError(
				csvFile(
					[
						`${CSV_HEADER},"username"`,
						'"https://github.com","octocat","hunter2",,"https://github.com",,,,,"dup"',
					].join("\r\n"),
				),
				"csv-duplicate-header",
			);
		});
	});

	describe("header drift", () => {
		test("rejects a Chrome CSV", async () => {
			await expectParseError(
				csvFile(
					[
						"name,url,username,password,note",
						"GitHub,https://github.com,octocat,hunter2,",
					].join("\n"),
				),
				"csv-missing-header",
			);
		});

		test("rejects a nine-column file with renamed columns", async () => {
			await expectParseError(
				csvFile(
					[
						'"origin","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"',
						'"https://github.com","octocat","hunter2",,"https://github.com",,,,',
					].join("\r\n"),
				),
				"csv-missing-header",
			);
		});

		test("names every missing column so the user can see what changed", async () => {
			let thrown: unknown;
			try {
				await firefoxImportProvider.parse(
					csvFile(
						[
							'"url","username","password"',
							'"https://github.com","octocat","hunter2"',
						].join("\r\n"),
					),
				);
			} catch (error) {
				thrown = error;
			}

			expect((thrown as ImportProviderError).params?.headers).toBe(
				"httpRealm, formActionOrigin, guid, timeCreated, timeLastUsed, timePasswordChanged",
			);
		});
	});

	describe("toDecryptedItemData", () => {
		test("passes the parsed item through", async () => {
			const preview = await firefoxImportProvider.parse(csvFile(CSV_EXPORT));
			const item = itemByTitle(preview, "github.com");

			expect(firefoxImportProvider.toDecryptedItemData(item)).toEqual({
				category: "login",
				data: item.data,
				favorite: false,
			});
		});

		test("refuses an item from another provider", async () => {
			const preview = await firefoxImportProvider.parse(csvFile(CSV_EXPORT));
			const foreign = {
				...itemByTitle(preview, "github.com"),
				providerId: "bitwarden" as const,
			};

			expect(() => firefoxImportProvider.toDecryptedItemData(foreign)).toThrow(
				ImportProviderError,
			);
		});
	});

	describe("determinism", () => {
		test("two parses of the same file produce identical previews", async () => {
			const first = await firefoxImportProvider.parse(csvFile(CSV_EXPORT));
			const second = await firefoxImportProvider.parse(csvFile(CSV_EXPORT));

			expect(JSON.stringify(first)).toBe(JSON.stringify(second));
			expect(first.sourceItems.map((item) => item.id)).toEqual([
				"firefox-row-2",
				"firefox-row-3",
				"firefox-row-4",
			]);
		});
	});

	describe("committed fixture (fixtures/firefox)", () => {
		const fixtureUrl = new URL(
			"./fixtures/firefox/logins.csv",
			import.meta.url,
		);
		const fixtureBytes = readFileSync(fixtureUrl);
		const fixtureText = fixtureBytes.toString("utf8");

		function fixtureFile(): File {
			return new File([fixtureText], "logins.csv", { type: "text/csv" });
		}

		test("matches the checksum recorded in the fixture README", () => {
			expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe(
				"c9e59b7b5a0bcea8393000cecce96bfa00a62a6d0604b7334520427b0baac85d",
			);
		});

		test("is shaped exactly like Firefox's exporter output", () => {
			// Null properties write a bare empty field, empty strings write `""`,
			// records are CRLF-separated and the file has no trailing newline.
			expect(fixtureText.startsWith(CSV_HEADER)).toBe(true);
			expect(fixtureText.includes("\r\n")).toBe(true);
			expect(fixtureText.endsWith("\n")).toBe(false);
			expect(fixtureText).toContain('"hunter2",,"https://github.com"');
			expect(fixtureText).toContain('"https://www.example.org","",');
		});

		test("imports every login except the Sync account entry", async () => {
			const preview = await firefoxImportProvider.parse(fixtureFile());

			expect(preview.sourceItems.map((item) => item.title)).toEqual([
				"github.com",
				"konto.example.de",
				"example.org",
				"quote.example.com",
				"intranet.example.com",
				"www7.example.com:8080",
				"portal.example.com",
				"legacy.example.net",
				"file://",
			]);
			expect(warningCodes(preview)).toEqual(["sync-account-skipped"]);
			expect(preview.summary).toEqual({
				vaultCount: 1,
				itemCount: 9,
				skippedCount: 1,
				warningCount: 1,
				errorCount: 0,
			});
		});

		test("round-trips non-ASCII credentials", async () => {
			const preview = await firefoxImportProvider.parse(fixtureFile());
			const item = itemByTitle(preview, "konto.example.de");

			expect(item.data.username).toBe("jörg.müller@example.de");
			expect(item.data.password).toBe("paßwort-123");
		});

		test("round-trips a password containing a quote and a comma", async () => {
			const preview = await firefoxImportProvider.parse(fixtureFile());

			expect(itemByTitle(preview, "quote.example.com").data.password).toBe(
				'pa"ss,word',
			);
		});

		test("carries only the HTTP-auth realm across as a custom field", async () => {
			const preview = await firefoxImportProvider.parse(fixtureFile());
			const withFields = preview.sourceItems.filter(
				(item) => item.data.customFields !== undefined,
			);

			expect(withFields.map((item) => item.title)).toEqual([
				"intranet.example.com",
			]);
			expect(withFields[0]?.data.customFields?.[0]?.value).toBe(
				"Restricted Area",
			);
		});

		test("carries no exporter timestamps or guids into any item", async () => {
			const preview = await firefoxImportProvider.parse(fixtureFile());
			const serialized = JSON.stringify(preview.sourceItems);

			expect(serialized).not.toContain("1784538843000");
			expect(serialized).not.toContain("6f0d5a1c");
			expect(serialized).not.toContain("sso.example.net");
		});
	});
});
