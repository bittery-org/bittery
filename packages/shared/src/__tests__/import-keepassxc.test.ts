import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { keepassxcImportProvider } from "../import/providers/keepassxc";
import type { ImportPreview, ImportSourceItem } from "../import/types";
import { ImportProviderError } from "../import/types";
import { generateTotpAt } from "../totp";

/**
 * KeePassXC's exporter header, verbatim from `CsvExporter::exportHeader`. Every
 * cell is quoted in a real export — including empty ones — which is itself part
 * of what these tests pin.
 */
const CSV_HEADER =
	'"Group","Title","Username","Password","URL","Notes","TOTP","Icon","Last Modified","Created"';

/** The layout KeePassXC wrote before 2.6.3 added TOTP, Icon and the timestamps. */
const LEGACY_CSV_HEADER = '"Group","Title","Username","Password","URL","Notes"';

/** KeePass 1.x's documented header, which must be rejected by name. */
const KEEPASS1_CSV_HEADER =
	'"Account","Login Name","Password","Web Site","Comments"';

const FIXED_CLOCK = 1234567890;

/**
 * Synthetic rows covering cases the committed fixtures cannot reach — a group
 * name containing the path separator, an unparseable TOTP value, and structural
 * damage no exporter would produce.
 */
const CSV_RECORDS = [
	CSV_HEADER,
	'"Root","Router Admin","admin","adm1n!","192.168.1.1","","","0","2026-07-11T08:15:20Z","2026-07-02T10:04:11Z"',
	'"Root/Work","GitHub","octocat","hunter2","https://github.com","Work account.","otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&period=30&digits=6&issuer=GitHub","1","2026-07-21T14:32:09Z","2026-07-03T11:20:45Z"',
	'"Root/Work/Servers","db-primary","root","s3cr3t-db","ssh://db.internal.example.com:22","","","0","2026-07-24T18:41:12Z","2026-07-07T09:33:02Z"',
];

const CSV_EXPORT = `${CSV_RECORDS.join("\n")}\n`;

function csvFile(content: string, name = "export.csv"): File {
	return new File([content], name, { type: "text/csv" });
}

/** Builds a ten-column export from bare record bodies, header included. */
function exportOf(...records: string[]): string {
	return `${[CSV_HEADER, ...records].join("\n")}\n`;
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

function vaultNames(preview: ImportPreview): string[] {
	return preview.sourceVaults.map((vault) => vault.name);
}

function warningCodes(preview: ImportPreview): string[] {
	return preview.warnings.map((warning) => warning.code);
}

function totpCodeAt(item: ImportSourceItem, timestamp: number) {
	const { data } = item;
	return generateTotpAt(
		{
			secret: data.totpSecret ?? "",
			...(data.totpAlgorithm ? { algorithm: data.totpAlgorithm } : {}),
			...(data.totpDigits ? { digits: data.totpDigits } : {}),
			...(data.totpPeriod ? { period: data.totpPeriod } : {}),
		},
		timestamp,
	);
}

async function expectParseError(file: File, code: string): Promise<void> {
	let thrown: unknown;
	try {
		await keepassxcImportProvider.parse(file);
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(ImportProviderError);
	expect((thrown as ImportProviderError).code).toBe(
		code as ImportProviderError["code"],
	);
}

describe("KeePassXC import provider", () => {
	describe("canParse", () => {
		test("accepts .csv", () => {
			expect(keepassxcImportProvider.canParse(csvFile(CSV_EXPORT))).toBe(true);
		});

		test("rejects unrelated extensions", () => {
			expect(
				keepassxcImportProvider.canParse(new File([""], "database.kdbx")),
			).toBe(false);
			expect(
				keepassxcImportProvider.canParse(new File([""], "export.json")),
			).toBe(false);
		});

		test("parse rejects a file it cannot parse rather than guessing", async () => {
			await expectParseError(
				new File([CSV_EXPORT], "database.kdbx"),
				"unsupported-file-type",
			);
		});
	});

	describe("mapping", () => {
		test("maps title, username, password, url and notes onto a login item", async () => {
			const preview = await keepassxcImportProvider.parse(csvFile(CSV_EXPORT));
			const item = itemByTitle(preview, "GitHub");

			expect(preview.providerId).toBe("keepassxc");
			expect(item.category).toBe("login");
			expect(item.sourceCategory).toBe("login");
			// KeePassXC has no favourites.
			expect(item.favorite).toBe(false);
			expect(item.data.title).toBe("GitHub");
			expect(item.data.username).toBe("octocat");
			expect(item.data.password).toBe("hunter2");
			expect(item.data.url).toBe("https://github.com");
			expect(item.data.urls).toEqual(["https://github.com"]);
			expect(item.data.notes).toBe("Work account.");
		});

		test("normalizes a url without inventing one", async () => {
			const preview = await keepassxcImportProvider.parse(
				csvFile(
					exportOf(
						'"Root","Router Admin","admin","adm1n!","192.168.1.1","","","0","2026-07-11T08:15:20Z","2026-07-02T10:04:11Z"',
						'"Root","Wiki","reader","r","wiki.example.com","","","0","2026-07-11T08:15:20Z","2026-07-02T10:04:11Z"',
						'"Root/Work/Servers","db-primary","root","s3cr3t-db","ssh://db.internal.example.com:22","","","0","2026-07-24T18:41:12Z","2026-07-07T09:33:02Z"',
					),
				),
			);

			// A host-shaped value gains the scheme a browser needs...
			expect(itemByTitle(preview, "Wiki").data.url).toBe(
				"https://wiki.example.com",
			);
			// ...while a bare IP and a non-HTTP scheme are kept verbatim.
			expect(itemByTitle(preview, "Router Admin").data.url).toBe("192.168.1.1");
			expect(itemByTitle(preview, "db-primary").data.url).toBe(
				"ssh://db.internal.example.com:22",
			);
		});

		test("keeps empty columns off the item instead of storing blanks", async () => {
			const preview = await keepassxcImportProvider.parse(
				csvFile(
					exportOf(
						'"Root","WLAN Codes","","","","Gast-WLAN: 4711-8150","","0","2026-07-09T06:30:00Z","2026-07-09T06:30:00Z"',
					),
				),
			);
			const { data } = itemByTitle(preview, "WLAN Codes");

			expect(data.username).toBeUndefined();
			expect(data.password).toBeUndefined();
			expect(data.url).toBeUndefined();
			expect(data.urls).toBeUndefined();
			expect(data.notes).toBe("Gast-WLAN: 4711-8150");
			// A note-only entry is still a login: KeePassXC has no other entry type.
			expect(itemByTitle(preview, "WLAN Codes").category).toBe("login");
		});

		test("drops the icon and both timestamps entirely", async () => {
			const preview = await keepassxcImportProvider.parse(csvFile(CSV_EXPORT));
			const serialized = JSON.stringify(itemByTitle(preview, "GitHub").data);

			expect(serialized).not.toContain("2026-07-21T14:32:09Z");
			expect(serialized).not.toContain("2026-07-03T11:20:45Z");
		});

		test("skips a completely blank entry and keeps its neighbours", async () => {
			const preview = await keepassxcImportProvider.parse(
				csvFile(
					exportOf(
						'"Root/Work","GitHub","octocat","hunter2","https://github.com","","","1","2026-07-21T14:32:09Z","2026-07-03T11:20:45Z"',
						'"Root/Work","","","","","","","0","2026-07-06T12:00:00Z","2026-07-06T12:00:00Z"',
						'"Root/Work","Jenkins","ci-bot","ci-pass","https://ci.example.com","","","0","2026-07-19T07:02:58Z","2026-07-05T16:45:30Z"',
					),
				),
			);

			expect(preview.sourceItems.map((item) => item.title)).toEqual([
				"GitHub",
				"Jenkins",
			]);
			expect(warningCodes(preview)).toEqual(["invalid-item"]);
			expect(preview.summary.skippedCount).toBe(1);
			expect(preview.sourceVaults[0]?.skippedCount).toBe(1);
			expect(preview.sourceVaults[0]?.itemCount).toBe(2);
		});

		test("numbers and warns about an entry with no title", async () => {
			const preview = await keepassxcImportProvider.parse(
				csvFile(
					exportOf(
						'"Root/Work","","ghost","ghost-pass","","","","0","2026-07-06T12:00:00Z","2026-07-06T12:00:00Z"',
					),
				),
			);

			expect(preview.sourceItems[0]?.title).toBe("Imported item 1");
			expect(preview.warnings[0]).toEqual({
				code: "missing-title",
				params: {
					itemNumber: 1,
					vaultName: "Work",
					title: "Imported item 1",
				},
				sourceVaultId: "keepassxc-group-1",
				sourceItemId: "keepassxc-group-1-row-2",
			});
		});
	});

	describe("group paths", () => {
		test("drops the root segment and keeps the rest of the path verbatim", async () => {
			const preview = await keepassxcImportProvider.parse(csvFile(CSV_EXPORT));

			expect(vaultNames(preview)).toEqual(["No Group", "Work", "Work/Servers"]);
			expect(preview.sourceVaults).toEqual([
				{
					id: "keepassxc-no-group",
					name: "No Group",
					nameCode: "no-group",
					itemCount: 1,
					skippedCount: 0,
				},
				{
					id: "keepassxc-group-1",
					name: "Work",
					itemCount: 1,
					skippedCount: 0,
				},
				{
					id: "keepassxc-group-2",
					name: "Work/Servers",
					itemCount: 1,
					skippedCount: 0,
				},
			]);
			expect(preview.summary.vaultCount).toBe(3);
		});

		test("routes root-level entries into the synthetic No Group vault", async () => {
			const preview = await keepassxcImportProvider.parse(csvFile(CSV_EXPORT));
			const rootLevel = itemByTitle(preview, "Router Admin");

			expect(rootLevel.sourceVaultId).toBe("keepassxc-no-group");
			expect(
				preview.sourceVaults.find((vault) => vault.nameCode === "no-group")?.id,
			).toBe("keepassxc-no-group");
		});

		test("root-level entries share one vault regardless of the root group's name", async () => {
			// The root group's name is whatever the database was created with, and it
			// is localized: `Root` from the GUI wizard, `Passwörter` from a German CLI.
			const preview = await keepassxcImportProvider.parse(
				csvFile(
					exportOf(
						'"Passwörter","One","a","b","","","","0","2026-07-01T00:00:00Z","2026-07-01T00:00:00Z"',
						'"Passwörter","Two","c","d","","","","0","2026-07-01T00:00:00Z","2026-07-01T00:00:00Z"',
					),
				),
			);

			expect(vaultNames(preview)).toEqual(["No Group"]);
			expect(preview.sourceVaults[0]?.itemCount).toBe(2);
		});

		test("collects repeat visits to a group into one vault", async () => {
			const preview = await keepassxcImportProvider.parse(
				csvFile(
					exportOf(
						'"Root/Work","One","a","b","","","","0","2026-07-01T00:00:00Z","2026-07-01T00:00:00Z"',
						'"Root/Personal","Two","c","d","","","","0","2026-07-01T00:00:00Z","2026-07-01T00:00:00Z"',
						'"Root/Work","Three","e","f","","","","0","2026-07-01T00:00:00Z","2026-07-01T00:00:00Z"',
					),
				),
			);

			expect(vaultNames(preview)).toEqual(["Work", "Personal"]);
			expect(preview.sourceVaults.map((vault) => vault.id)).toEqual([
				"keepassxc-group-1",
				"keepassxc-group-2",
			]);
			expect(preview.sourceVaults[0]?.itemCount).toBe(2);
		});

		test("a group named with a slash is indistinguishable from a nested one", async () => {
			// `exportGroup` joins segments with `/` and does not escape a `/` inside a
			// group name, so the two shapes collapse into one source vault. Documented
			// in the fixture README rather than guessed at.
			const preview = await keepassxcImportProvider.parse(
				csvFile(
					exportOf(
						'"Root/Work/Servers","Nested","a","b","","","","0","2026-07-01T00:00:00Z","2026-07-01T00:00:00Z"',
						'"Root/Work/Servers","Literal","c","d","","","","0","2026-07-01T00:00:00Z","2026-07-01T00:00:00Z"',
					),
				),
			);

			expect(vaultNames(preview)).toEqual(["Work/Servers"]);
			expect(preview.sourceVaults[0]?.itemCount).toBe(2);
		});

		test("a real group called No Group stays separate from the synthetic bucket", async () => {
			const preview = await keepassxcImportProvider.parse(
				csvFile(
					exportOf(
						'"Root","At Root","a","b","","","","0","2026-07-01T00:00:00Z","2026-07-01T00:00:00Z"',
						'"Root/No Group","In Group","c","d","","","","0","2026-07-01T00:00:00Z","2026-07-01T00:00:00Z"',
					),
				),
			);

			// Same display name, different sources: only the synthetic one carries a
			// nameCode, and the root-level entry must not be filed under the group.
			expect(preview.sourceVaults).toEqual([
				{
					id: "keepassxc-no-group",
					name: "No Group",
					nameCode: "no-group",
					itemCount: 1,
					skippedCount: 0,
				},
				{
					id: "keepassxc-group-1",
					name: "No Group",
					itemCount: 1,
					skippedCount: 0,
				},
			]);
			expect(itemByTitle(preview, "At Root").sourceVaultId).toBe(
				"keepassxc-no-group",
			);
			expect(itemByTitle(preview, "In Group").sourceVaultId).toBe(
				"keepassxc-group-1",
			);
		});

		test("tolerates a database whose root group has no name", async () => {
			const preview = await keepassxcImportProvider.parse(
				csvFile(
					exportOf(
						'"","Root Level","a","b","","","","0","2026-07-01T00:00:00Z","2026-07-01T00:00:00Z"',
						'"/Work","Grouped","c","d","","","","0","2026-07-01T00:00:00Z","2026-07-01T00:00:00Z"',
					),
				),
			);

			expect(vaultNames(preview)).toEqual(["No Group", "Work"]);
		});
	});

	describe("TOTP", () => {
		test("generates the expected code from an exported otpauth URI at a fixed clock", async () => {
			const preview = await keepassxcImportProvider.parse(csvFile(CSV_EXPORT));
			const { data } = itemByTitle(preview, "GitHub");

			expect(data.totpSecret).toBe("JBSWY3DPEHPK3PXP");
			expect(data.totpIssuer).toBe("GitHub");
			expect(data.totpAccountName).toBe("octocat");
			expect(data.totpDigits).toBe(6);
			expect(data.totpPeriod).toBe(30);

			expect(
				await totpCodeAt(itemByTitle(preview, "GitHub"), FIXED_CLOCK),
			).toBe("742275");
		});

		test("carries digits and algorithm through to code generation", async () => {
			const preview = await keepassxcImportProvider.parse(
				csvFile(
					exportOf(
						'"Root/Finance","Broker","trader","broker-pass","https://broker.example.com","","otpauth://totp/Broker:trader?secret=JBSWY3DPEHPK3PXP&period=60&digits=8&issuer=Broker&algorithm=SHA256","0","2026-07-25T09:14:07Z","2026-07-10T15:05:55Z"',
					),
				),
			);
			const item = itemByTitle(preview, "Broker");

			expect(item.data.totpAlgorithm).toBe("SHA256");
			expect(item.data.totpDigits).toBe(8);
			expect(item.data.totpPeriod).toBe(60);
			expect(await totpCodeAt(item, FIXED_CLOCK)).toBe("45806924");
			expect(warningCodes(preview)).toEqual([]);
		});

		test("keeps the padding KeePassXC percent-encodes into the secret", async () => {
			const preview = await keepassxcImportProvider.parse(
				csvFile(
					exportOf(
						'"Root/Finance","Padded","trader","p","","","otpauth://totp/Padded:trader?secret=KZXW6ZDPNZSA%3D%3D%3D%3D&period=30&digits=6&issuer=Padded","0","2026-07-01T00:00:00Z","2026-07-01T00:00:00Z"',
					),
				),
			);
			const item = itemByTitle(preview, "Padded");

			expect(item.data.totpSecret).toBe("KZXW6ZDPNZSA====");
			// Padding is stripped before decoding, so the code matches the unpadded seed.
			expect(await totpCodeAt(item, FIXED_CLOCK)).toBe("161084");
		});

		test("warns when the exported encoder cannot be reproduced", async () => {
			const preview = await keepassxcImportProvider.parse(
				csvFile(
					exportOf(
						'"Root/Finance","Steam","gamer","steam-pass","https://steamcommunity.com","","otpauth://totp/Steam:gamer?secret=63U2ZWJCP2SIQP4T&period=30&digits=6&issuer=Steam&encoder=steam","0","2026-07-26T11:22:33Z","2026-07-12T08:08:08Z"',
					),
				),
			);

			// The secret still imports — it is the alphabet Bittery cannot reproduce.
			expect(itemByTitle(preview, "Steam").data.totpSecret).toBe(
				"63U2ZWJCP2SIQP4T",
			);
			expect(preview.warnings).toEqual([
				{
					code: "totp-settings-unsupported",
					params: { title: "Steam" },
					sourceVaultId: "keepassxc-group-1",
					sourceItemId: "keepassxc-group-1-row-2",
				},
			]);
		});

		test("warns when the exported digit count is outside 6-8", async () => {
			const preview = await keepassxcImportProvider.parse(
				csvFile(
					exportOf(
						'"Root/Finance","Ten Digits","user","pass","","","otpauth://totp/Ten:user?secret=JBSWY3DPEHPK3PXP&period=30&digits=10&issuer=Ten","0","2026-07-01T00:00:00Z","2026-07-01T00:00:00Z"',
					),
				),
			);

			expect(
				itemByTitle(preview, "Ten Digits").data.totpDigits,
			).toBeUndefined();
			expect(warningCodes(preview)).toEqual(["totp-settings-unsupported"]);
		});

		test("warns and imports no secret when the TOTP value is unusable", async () => {
			const preview = await keepassxcImportProvider.parse(
				csvFile(
					exportOf(
						'"Root/Work","Broken","user","pass","","","otpauth://totp/Broken:user?period=30&digits=6","0","2026-07-01T00:00:00Z","2026-07-01T00:00:00Z"',
					),
				),
			);

			expect(itemByTitle(preview, "Broken").data.totpSecret).toBeUndefined();
			expect(warningCodes(preview)).toEqual(["totp-secret-missing"]);
		});

		test("an empty TOTP column adds nothing and warns about nothing", async () => {
			const preview = await keepassxcImportProvider.parse(csvFile(CSV_EXPORT));

			expect(
				itemByTitle(preview, "Router Admin").data.totpSecret,
			).toBeUndefined();
			expect(warningCodes(preview)).toEqual([]);
		});
	});

	describe("CSV structure", () => {
		test("accepts the exporter's LF records and trailing newline", async () => {
			const preview = await keepassxcImportProvider.parse(csvFile(CSV_EXPORT));

			expect(CSV_EXPORT.endsWith("\n")).toBe(true);
			expect(preview.sourceItems).toHaveLength(3);
		});

		test("accepts CRLF records and no trailing newline", async () => {
			const preview = await keepassxcImportProvider.parse(
				csvFile(CSV_RECORDS.join("\r\n")),
			);

			expect(preview.sourceItems).toHaveLength(3);
		});

		test("accepts a BOM", async () => {
			const preview = await keepassxcImportProvider.parse(
				csvFile(`﻿${CSV_EXPORT}`),
			);

			expect(preview.sourceItems).toHaveLength(3);
		});

		test("unescapes doubled quotes", async () => {
			const preview = await keepassxcImportProvider.parse(
				csvFile(
					exportOf(
						'"Root/Work","Jenkins","ci-bot","pa""ss,word","https://ci.example.com","","","0","2026-07-19T07:02:58Z","2026-07-05T16:45:30Z"',
					),
				),
			);

			expect(itemByTitle(preview, "Jenkins").data.password).toBe('pa"ss,word');
		});

		test("keeps a multi-line note as one field", async () => {
			const preview = await keepassxcImportProvider.parse(
				csvFile(
					exportOf(
						'"Root/Work","Jenkins","ci-bot","ci-pass","https://ci.example.com","Rotate every quarter.\nOwner: platform team","","0","2026-07-19T07:02:58Z","2026-07-05T16:45:30Z"',
					),
				),
			);

			expect(itemByTitle(preview, "Jenkins").data.notes).toBe(
				"Rotate every quarter.\nOwner: platform team",
			);
			expect(preview.sourceItems).toHaveLength(1);
		});

		test("round-trips non-ASCII group names and credentials", async () => {
			const preview = await keepassxcImportProvider.parse(
				csvFile(
					exportOf(
						'"Root/Persönliche Konten","Kontoauszug","jörg.müller@example.de","paßwort-123","https://konto.example.de","Straße 5, „Sparbuch“","","0","2026-07-23T20:11:44Z","2026-07-08T13:52:19Z"',
					),
				),
			);
			const item = itemByTitle(preview, "Kontoauszug");

			expect(vaultNames(preview)).toEqual(["Persönliche Konten"]);
			expect(item.data.username).toBe("jörg.müller@example.de");
			expect(item.data.password).toBe("paßwort-123");
			expect(item.data.notes).toBe("Straße 5, „Sparbuch“");
		});
	});

	describe("structural failures stop the whole parse", () => {
		test("empty file", async () => {
			await expectParseError(csvFile("   \n  "), "csv-empty-file");
		});

		test("header only", async () => {
			await expectParseError(csvFile(`${CSV_HEADER}\n`), "no-items-found");
		});

		test("unclosed quote", async () => {
			await expectParseError(
				csvFile(
					exportOf(
						'"Root/Work","GitHub","octocat","hunter2,"https://github.com","","","0","2026-07-21T14:32:09Z","2026-07-03T11:20:45Z"',
					),
				),
				"csv-malformed-quoting",
			);
		});

		test("truncated final row", async () => {
			await expectParseError(
				csvFile(exportOf('"Root/Work","GitHub","octocat","hunter2"')),
				"csv-row-column-mismatch",
			);
		});

		test("row with too many columns", async () => {
			await expectParseError(
				csvFile(
					exportOf(
						'"Root/Work","GitHub","octocat","hunter2","https://github.com","","","0","2026-07-21T14:32:09Z","2026-07-03T11:20:45Z","extra"',
					),
				),
				"csv-row-column-mismatch",
			);
		});

		test("duplicate header", async () => {
			await expectParseError(
				csvFile(
					[
						'"Group","Title","Username","Password","URL","Notes","TOTP","Icon","Last Modified","Notes"',
						'"Root/Work","GitHub","octocat","hunter2","https://github.com","","","0","2026-07-21T14:32:09Z",""',
					].join("\n"),
				),
				"csv-duplicate-header",
			);
		});
	});

	describe("header drift", () => {
		test("accepts the pre-2.6.3 six-column layout", async () => {
			const preview = await keepassxcImportProvider.parse(
				csvFile(
					[
						LEGACY_CSV_HEADER,
						'"Root/Work","GitHub","octocat","hunter2","https://github.com","Work account."',
						"",
					].join("\n"),
				),
			);
			const item = itemByTitle(preview, "GitHub");

			expect(item.data.username).toBe("octocat");
			expect(item.data.notes).toBe("Work account.");
			// There is no TOTP column to read, and its absence is not a loss to warn about.
			expect(item.data.totpSecret).toBeUndefined();
			expect(warningCodes(preview)).toEqual([]);
		});

		test("rejects a KeePass 1.x CSV by name", async () => {
			await expectParseError(
				csvFile(
					[
						KEEPASS1_CSV_HEADER,
						'"GitHub","octocat","hunter2","https://github.com",""',
					].join("\n"),
				),
				"keepassxc-keepass1-export-unsupported",
			);
		});

		test("rejects a Bitwarden CSV", async () => {
			await expectParseError(
				csvFile(
					[
						"folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
						"Work,0,login,GitHub,,,0,https://github.com,octocat,hunter2,",
					].join("\n"),
				),
				"csv-unknown-header-variant",
			);
		});

		test("rejects a Chrome CSV", async () => {
			await expectParseError(
				csvFile(
					[
						"name,url,username,password,note",
						"GitHub,https://github.com,octocat,hunter2,",
					].join("\n"),
				),
				"csv-unknown-header-variant",
			);
		});

		test("rejects a reordered ten-column header", async () => {
			await expectParseError(
				csvFile(
					[
						'"Title","Group","Username","Password","URL","Notes","TOTP","Icon","Last Modified","Created"',
						'"GitHub","Root/Work","octocat","hunter2","https://github.com","","","0","",""',
					].join("\n"),
				),
				"csv-unknown-header-variant",
			);
		});

		test("rejects a header with a column appended by a future release", async () => {
			// Unlike Firefox's, this parser matches the layout exactly: a new column
			// means a KeePassXC version whose output has not been inspected yet.
			await expectParseError(
				csvFile(
					[
						`${CSV_HEADER},"Tags"`,
						'"Root/Work","GitHub","octocat","hunter2","https://github.com","","","0","","","work"',
					].join("\n"),
				),
				"csv-unknown-header-variant",
			);
		});

		test("names both accepted layouts so the user can see what changed", async () => {
			let thrown: unknown;
			try {
				await keepassxcImportProvider.parse(
					csvFile(
						['"Group","Title","Password"', '"Root","GitHub","hunter2"'].join(
							"\n",
						),
					),
				);
			} catch (error) {
				thrown = error;
			}

			expect((thrown as ImportProviderError).params?.headers).toBe(
				"Group,Title,Password",
			);
			expect((thrown as ImportProviderError).params?.expected).toBe(
				"group,title,username,password,url,notes,totp,icon,last modified,created | group,title,username,password,url,notes",
			);
		});
	});

	describe("toDecryptedItemData", () => {
		test("passes the parsed item through", async () => {
			const preview = await keepassxcImportProvider.parse(csvFile(CSV_EXPORT));
			const item = itemByTitle(preview, "GitHub");

			expect(keepassxcImportProvider.toDecryptedItemData(item)).toEqual({
				category: "login",
				data: item.data,
				favorite: false,
			});
		});

		test("refuses an item from another provider", async () => {
			const preview = await keepassxcImportProvider.parse(csvFile(CSV_EXPORT));
			const foreign = {
				...itemByTitle(preview, "GitHub"),
				providerId: "bitwarden" as const,
			};

			expect(() =>
				keepassxcImportProvider.toDecryptedItemData(foreign),
			).toThrow(ImportProviderError);
		});
	});

	describe("determinism", () => {
		test("two parses of the same file produce identical previews", async () => {
			const first = await keepassxcImportProvider.parse(csvFile(CSV_EXPORT));
			const second = await keepassxcImportProvider.parse(csvFile(CSV_EXPORT));

			expect(JSON.stringify(first)).toBe(JSON.stringify(second));
			expect(first.sourceItems.map((item) => item.id)).toEqual([
				"keepassxc-no-group-row-2",
				"keepassxc-group-1-row-3",
				"keepassxc-group-2-row-4",
			]);
		});
	});

	describe("committed fixtures (fixtures/keepassxc)", () => {
		const currentBytes = readFileSync(
			new URL(
				"./fixtures/keepassxc/keepassxc-2.7.8-macos.csv",
				import.meta.url,
			),
		);
		const legacyBytes = readFileSync(
			new URL(
				"./fixtures/keepassxc/keepassxc-2.6.2-six-column.csv",
				import.meta.url,
			),
		);
		const currentText = currentBytes.toString("utf8");
		const legacyText = legacyBytes.toString("utf8");

		function fixtureFile(text: string): File {
			return new File([text], "export.csv", { type: "text/csv" });
		}

		test("match the checksums recorded in the fixture README", () => {
			expect(createHash("sha256").update(currentBytes).digest("hex")).toBe(
				"8b14e25ba98facc97d63b3ebefceac780d3b626e59514c5032ad6460c449f1fb",
			);
			expect(createHash("sha256").update(legacyBytes).digest("hex")).toBe(
				"8060db28b2d4d7d24cb9dc72e3f62accde63e5661146e2f9a82e090b16baf183",
			);
		});

		test("are shaped exactly like KeePassXC's exporter output", () => {
			// Every cell quoted, LF records, and a trailing newline after the last row.
			expect(currentText.startsWith(`${CSV_HEADER}\n`)).toBe(true);
			expect(legacyText.startsWith(`${LEGACY_CSV_HEADER}\n`)).toBe(true);
			expect(currentText.includes("\r")).toBe(false);
			expect(currentText.endsWith("\n")).toBe(true);
			// Empty cells are `""`, never a bare empty field.
			expect(currentText).toContain('"Router Admin","admin","adm1n!"');
			expect(currentText).toContain('"192.168.1.1","","","0"');
		});

		test("imports every entry except the blank one", async () => {
			const preview = await keepassxcImportProvider.parse(
				fixtureFile(currentText),
			);

			expect(preview.sourceItems.map((item) => item.title)).toEqual([
				"Router Admin",
				"GitHub",
				"Jenkins",
				"db-primary",
				"Kontoauszug",
				"WLAN Codes",
				"Broker",
				"Steam",
				"Old Forum",
			]);
			expect(warningCodes(preview)).toEqual([
				"invalid-item",
				"totp-settings-unsupported",
			]);
			expect(preview.summary).toEqual({
				vaultCount: 6,
				itemCount: 9,
				skippedCount: 1,
				warningCount: 2,
				errorCount: 0,
			});
		});

		test("turns each group path into one source vault", async () => {
			const preview = await keepassxcImportProvider.parse(
				fixtureFile(currentText),
			);

			expect(preview.sourceVaults).toEqual([
				{
					id: "keepassxc-no-group",
					name: "No Group",
					nameCode: "no-group",
					itemCount: 1,
					skippedCount: 0,
				},
				{
					id: "keepassxc-group-1",
					name: "Work",
					itemCount: 2,
					skippedCount: 1,
				},
				{
					id: "keepassxc-group-2",
					name: "Work/Servers",
					itemCount: 1,
					skippedCount: 0,
				},
				{
					id: "keepassxc-group-3",
					name: "Persönliche Konten",
					itemCount: 2,
					skippedCount: 0,
				},
				{
					id: "keepassxc-group-4",
					name: "Finance",
					itemCount: 2,
					skippedCount: 0,
				},
				{
					id: "keepassxc-group-5",
					name: "Recycle Bin",
					itemCount: 1,
					skippedCount: 0,
				},
			]);
		});

		test("surfaces the recycle bin as an ordinary source vault", async () => {
			// The CSV carries no marker for it and the group name is localized, so
			// skipping it by name would silently drop live credentials.
			const preview = await keepassxcImportProvider.parse(
				fixtureFile(currentText),
			);
			const recycled = itemByTitle(preview, "Old Forum");

			expect(
				preview.sourceVaults.find(
					(vault) => vault.id === recycled.sourceVaultId,
				)?.name,
			).toBe("Recycle Bin");
		});

		test("round-trips the quote, comma and multi-line note the exporter wrote", async () => {
			const preview = await keepassxcImportProvider.parse(
				fixtureFile(currentText),
			);
			const item = itemByTitle(preview, "Jenkins");

			expect(item.data.password).toBe('pa"ss,word');
			expect(item.data.notes).toBe(
				"Rotate every quarter.\nOwner: platform team",
			);
		});

		test("round-trips non-ASCII credentials and group names", async () => {
			const preview = await keepassxcImportProvider.parse(
				fixtureFile(currentText),
			);
			const item = itemByTitle(preview, "Kontoauszug");

			expect(item.data.username).toBe("jörg.müller@example.de");
			expect(item.data.password).toBe("paßwort-123");
			expect(item.data.notes).toBe("Straße 5, „Sparbuch“");
		});

		test("generates working codes for both exported TOTP storage formats", async () => {
			const preview = await keepassxcImportProvider.parse(
				fixtureFile(currentText),
			);

			// Stored as an `otp` attribute in the source database.
			const github = itemByTitle(preview, "GitHub");
			expect(github.data.totpSecret).toBe("JBSWY3DPEHPK3PXP");
			expect(await totpCodeAt(github, FIXED_CLOCK)).toBe("742275");

			// Stored as `TOTP Seed` + `TOTP Settings` (`30;8`), which the exporter
			// converts to an `otpauth://` URI with a padded secret.
			const broker = itemByTitle(preview, "Broker");
			expect(broker.data.totpSecret).toBe("KZXW6ZDPNZSA====");
			expect(broker.data.totpDigits).toBe(8);
			expect(broker.data.totpPeriod).toBe(30);
			expect(await totpCodeAt(broker, FIXED_CLOCK)).toBe("42161084");
		});

		test("reports the Steam entry rather than generating a code that differs", async () => {
			const preview = await keepassxcImportProvider.parse(
				fixtureFile(currentText),
			);

			expect(itemByTitle(preview, "Steam").data.totpSecret).toBe(
				"63U2ZWJCP2SIQP4T",
			);
			expect(
				preview.warnings.filter(
					(warning) => warning.code === "totp-settings-unsupported",
				),
			).toEqual([
				{
					code: "totp-settings-unsupported",
					params: { title: "Steam" },
					sourceVaultId: "keepassxc-group-4",
					sourceItemId: "keepassxc-group-4-row-10",
				},
			]);
		});

		test("carries no icon index or exporter timestamp into any item", async () => {
			const preview = await keepassxcImportProvider.parse(
				fixtureFile(currentText),
			);
			const serialized = JSON.stringify(preview.sourceItems);

			expect(serialized).not.toContain("2026-07-11T08:15:20Z");
			expect(serialized).not.toContain("2026-07-24T18:41:12Z");
		});

		test("the six-column fixture imports the same items without TOTP", async () => {
			const preview = await keepassxcImportProvider.parse(
				fixtureFile(legacyText),
			);

			expect(preview.sourceItems.map((item) => item.title)).toEqual([
				"Router Admin",
				"GitHub",
				"Jenkins",
				"db-primary",
				"Kontoauszug",
				"WLAN Codes",
				"Broker",
				"Steam",
				"Old Forum",
			]);
			expect(
				preview.sourceItems.every((item) => item.data.totpSecret === undefined),
			).toBe(true);
			// No TOTP column means no TOTP loss to report — only the blank entry.
			expect(warningCodes(preview)).toEqual(["invalid-item"]);
			expect(preview.summary.vaultCount).toBe(6);
			expect(preview.summary.itemCount).toBe(9);
		});
	});
});
