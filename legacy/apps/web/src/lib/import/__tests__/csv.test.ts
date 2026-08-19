import { describe, expect, test } from "bun:test";
import { buildColumnIndex, parseCsv, readCsvColumn } from "../csv";
import { ImportProviderError } from "../types";

const REQUIRED = ["a", "b", "c"];

function expectErrorCode(
	run: () => unknown,
	code: string,
): ImportProviderError {
	let thrown: unknown;
	try {
		run();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(ImportProviderError);
	const providerError = thrown as ImportProviderError;
	expect(providerError.code).toBe(code as ImportProviderError["code"]);
	return providerError;
}

describe("parseCsv", () => {
	describe("well-formed input", () => {
		test("parses a simple table", () => {
			const table = parseCsv("a,b,c\n1,2,3\n4,5,6", {
				requiredHeaders: REQUIRED,
			});

			expect(table.headers).toEqual(["a", "b", "c"]);
			expect(table.rows).toEqual([
				["1", "2", "3"],
				["4", "5", "6"],
			]);
		});

		test("strips a UTF-8 BOM from the first header", () => {
			const table = parseCsv("﻿a,b,c\n1,2,3", {
				requiredHeaders: REQUIRED,
			});

			expect(table.headers[0]).toBe("a");
		});

		test("accepts CRLF line endings", () => {
			const table = parseCsv("a,b,c\r\n1,2,3\r\n", {
				requiredHeaders: REQUIRED,
			});

			expect(table.rows).toEqual([["1", "2", "3"]]);
		});

		test("accepts lone CR line endings", () => {
			const table = parseCsv("a,b,c\r1,2,3\r", { requiredHeaders: REQUIRED });

			expect(table.rows).toEqual([["1", "2", "3"]]);
		});

		test("keeps commas inside quoted fields", () => {
			const table = parseCsv('a,b,c\n"one,two",2,3', {
				requiredHeaders: REQUIRED,
			});

			expect(table.rows[0]?.[0]).toBe("one,two");
		});

		test("keeps newlines inside quoted fields", () => {
			const table = parseCsv('a,b,c\n"line one\nline two",2,3', {
				requiredHeaders: REQUIRED,
			});

			expect(table.rows).toHaveLength(1);
			expect(table.rows[0]?.[0]).toBe("line one\nline two");
		});

		test("unescapes doubled quotes", () => {
			const table = parseCsv('a,b,c\n"say ""hi""",2,3', {
				requiredHeaders: REQUIRED,
			});

			expect(table.rows[0]?.[0]).toBe('say "hi"');
		});

		test("preserves empty quoted and unquoted fields", () => {
			const table = parseCsv('a,b,c\n"",,3', { requiredHeaders: REQUIRED });

			expect(table.rows[0]).toEqual(["", "", "3"]);
		});

		test("preserves non-ASCII content", () => {
			const table = parseCsv("a,b,c\nMünchen,日本語,3", {
				requiredHeaders: REQUIRED,
			});

			expect(table.rows[0]?.[0]).toBe("München");
			expect(table.rows[0]?.[1]).toBe("日本語");
		});

		test("ignores a trailing newline", () => {
			const table = parseCsv("a,b,c\n1,2,3\n", { requiredHeaders: REQUIRED });

			expect(table.rows).toHaveLength(1);
		});

		test("ignores a whitespace-only trailing line", () => {
			const table = parseCsv("a,b,c\n1,2,3\n   \n", {
				requiredHeaders: REQUIRED,
			});

			expect(table.rows).toEqual([["1", "2", "3"]]);
		});

		test("ignores interior blank lines", () => {
			const table = parseCsv("a,b,c\n1,2,3\n\n4,5,6", {
				requiredHeaders: REQUIRED,
			});

			expect(table.rows).toEqual([
				["1", "2", "3"],
				["4", "5", "6"],
			]);
		});

		test("matches required headers case-insensitively", () => {
			const table = parseCsv("A,B,C\n1,2,3", { requiredHeaders: REQUIRED });

			expect(table.rows).toHaveLength(1);
		});

		test("allows extra headers beyond the required set", () => {
			const table = parseCsv("a,b,c,d\n1,2,3,4", {
				requiredHeaders: REQUIRED,
			});

			expect(table.headers).toEqual(["a", "b", "c", "d"]);
		});

		test("returns a header-only table with zero rows", () => {
			const table = parseCsv("a,b,c", { requiredHeaders: REQUIRED });

			expect(table.rows).toEqual([]);
		});
	});

	describe("structural failures", () => {
		test("rejects an empty file", () => {
			expectErrorCode(
				() => parseCsv("", { requiredHeaders: REQUIRED }),
				"csv-empty-file",
			);
		});

		test("rejects a whitespace-only file", () => {
			expectErrorCode(
				() => parseCsv("  \n\n ", { requiredHeaders: REQUIRED }),
				"csv-empty-file",
			);
		});

		test("rejects an unclosed quote", () => {
			expectErrorCode(
				() =>
					parseCsv('a,b,c\n"unterminated,2,3', { requiredHeaders: REQUIRED }),
				"csv-malformed-quoting",
			);
		});

		test("rejects a row truncated mid-quote", () => {
			expectErrorCode(
				() => parseCsv('a,b,c\n1,2,3\n"partial', { requiredHeaders: REQUIRED }),
				"csv-malformed-quoting",
			);
		});

		test("rejects junk after a closing quote", () => {
			expectErrorCode(
				() => parseCsv('a,b,c\n"one"junk,2,3', { requiredHeaders: REQUIRED }),
				"csv-malformed-quoting",
			);
		});

		test("rejects a quote opening mid-field", () => {
			expectErrorCode(
				() => parseCsv('a,b,c\none"two",2,3', { requiredHeaders: REQUIRED }),
				"csv-malformed-quoting",
			);
		});

		test("rejects duplicate headers and names the duplicate", () => {
			const error = expectErrorCode(
				() => parseCsv("a,b,a\n1,2,3", { requiredHeaders: REQUIRED }),
				"csv-duplicate-header",
			);

			expect(error.params?.header).toBe("a");
		});

		test("rejects a missing required header and names it", () => {
			const error = expectErrorCode(
				() => parseCsv("a,b\n1,2", { requiredHeaders: REQUIRED }),
				"csv-missing-header",
			);

			expect(error.params?.headers).toBe("c");
		});

		test("rejects a row with too many columns", () => {
			const error = expectErrorCode(
				() => parseCsv("a,b,c\n1,2,3,4", { requiredHeaders: REQUIRED }),
				"csv-row-column-mismatch",
			);

			expect(error.params).toMatchObject({
				rowNumber: 2,
				expectedColumns: 3,
				actualColumns: 4,
			});
		});

		test("rejects a row with too few columns", () => {
			const error = expectErrorCode(
				() => parseCsv("a,b,c\n1,2,3\n4,5", { requiredHeaders: REQUIRED }),
				"csv-row-column-mismatch",
			);

			expect(error.params).toMatchObject({
				rowNumber: 3,
				expectedColumns: 3,
				actualColumns: 2,
			});
		});

		test("keeps spreadsheet row numbers across interior blank lines", () => {
			const error = expectErrorCode(
				() => parseCsv("a,b,c\n1,2,3\n\n\n4,5", { requiredHeaders: REQUIRED }),
				"csv-row-column-mismatch",
			);

			expect(error.params?.rowNumber).toBe(5);
		});

		test("keeps row numbers across newlines inside quoted fields", () => {
			const error = expectErrorCode(
				() =>
					parseCsv('a,b,c\n"line one\nline two",2,3\n4,5', {
						requiredHeaders: REQUIRED,
					}),
				"csv-row-column-mismatch",
			);

			expect(error.params?.rowNumber).toBe(4);
		});
	});
});

describe("column helpers", () => {
	test("reads columns case-insensitively regardless of order", () => {
		const table = parseCsv("C,A,B\n3,1,2", { requiredHeaders: REQUIRED });
		const columns = buildColumnIndex(table.headers);
		const row = table.rows[0] ?? [];

		expect(readCsvColumn(row, columns, "a")).toBe("1");
		expect(readCsvColumn(row, columns, "b")).toBe("2");
		expect(readCsvColumn(row, columns, "c")).toBe("3");
	});

	test("returns an empty string for an absent column", () => {
		const table = parseCsv("a,b,c\n1,2,3", { requiredHeaders: REQUIRED });
		const columns = buildColumnIndex(table.headers);

		expect(readCsvColumn(table.rows[0] ?? [], columns, "missing")).toBe("");
	});
});
