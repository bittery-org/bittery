import { ImportProviderError } from "./types";

/**
 * Result of a strict CSV parse: a header row plus data rows of equal width.
 */
export interface CsvTable {
	headers: string[];
	rows: string[][];
}

export interface ParseCsvOptions {
	/**
	 * Headers that must all be present. Comparison is case-insensitive and
	 * whitespace-trimmed, matching how exporters vary their casing.
	 */
	requiredHeaders: string[];
}

const BOM = "﻿";

/**
 * Strict RFC 4180 CSV parser.
 *
 * Deliberately unforgiving: it never pads short rows, never truncates long
 * rows, and never tolerates malformed quoting. Any structural problem throws an
 * `ImportProviderError` before a table is returned, so an import can never be
 * built from a partially understood file.
 */
export function parseCsv(text: string, options: ParseCsvOptions): CsvTable {
	const source = stripBom(text);
	if (source.trim().length === 0) {
		throw new ImportProviderError("csv-empty-file");
	}

	const records = tokenizeCsv(source);

	if (records.length === 0) {
		throw new ImportProviderError("csv-empty-file");
	}

	const headerRecord = records[0];
	if (!headerRecord) {
		throw new ImportProviderError("csv-empty-file");
	}

	const headers = headerRecord.map((header) => header.trim());
	assertNoDuplicateHeaders(headers);
	assertRequiredHeaders(headers, options.requiredHeaders);

	const rows: string[][] = [];
	for (let index = 1; index < records.length; index += 1) {
		const record = records[index];
		if (!record) {
			continue;
		}
		if (record.length !== headers.length) {
			throw new ImportProviderError("csv-row-column-mismatch", {
				// Row number as the user sees it in a spreadsheet: header is row 1.
				rowNumber: index + 1,
				expectedColumns: headers.length,
				actualColumns: record.length,
			});
		}
		rows.push(record);
	}

	return { headers, rows };
}

/**
 * Build a column-name lookup for a parsed table. Names are normalized the same
 * way `parseCsv` validates them, so providers can read columns case-insensitively.
 */
export function buildColumnIndex(headers: string[]): Map<string, number> {
	const index = new Map<string, number>();
	headers.forEach((header, position) => {
		index.set(normalizeHeader(header), position);
	});
	return index;
}

/**
 * Read a column from a row, returning an empty string when the column is absent.
 */
export function readCsvColumn(
	row: string[],
	columnIndex: Map<string, number>,
	header: string,
): string {
	const position = columnIndex.get(normalizeHeader(header));
	if (position === undefined) {
		return "";
	}
	return row[position] ?? "";
}

function stripBom(text: string): string {
	return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

function normalizeHeader(header: string): string {
	return header.trim().toLowerCase();
}

function assertNoDuplicateHeaders(headers: string[]): void {
	const seen = new Set<string>();
	for (const header of headers) {
		const key = normalizeHeader(header);
		if (seen.has(key)) {
			throw new ImportProviderError("csv-duplicate-header", { header });
		}
		seen.add(key);
	}
}

function assertRequiredHeaders(
	headers: string[],
	requiredHeaders: string[],
): void {
	const present = new Set(headers.map(normalizeHeader));
	const missing = requiredHeaders.filter(
		(required) => !present.has(normalizeHeader(required)),
	);
	if (missing.length > 0) {
		throw new ImportProviderError("csv-missing-header", {
			headers: missing.join(", "),
		});
	}
}

/**
 * RFC 4180 state machine. Accepts CRLF, LF and lone CR as record separators,
 * quoted fields containing separators or newlines, and `""` as an escaped quote.
 */
function tokenizeCsv(text: string): string[][] {
	const records: string[][] = [];
	let record: string[] = [];
	let field = "";
	let inQuotes = false;
	let fieldStarted = false;
	let quotedFieldClosed = false;

	const endField = () => {
		record.push(field);
		field = "";
		fieldStarted = false;
		quotedFieldClosed = false;
	};

	const endRecord = () => {
		endField();
		records.push(record);
		record = [];
	};

	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];

		if (inQuotes) {
			if (char === '"') {
				if (text[index + 1] === '"') {
					field += '"';
					index += 1;
					continue;
				}
				inQuotes = false;
				quotedFieldClosed = true;
				continue;
			}
			field += char;
			continue;
		}

		if (char === '"') {
			// A quote may only open a field. A quote after unquoted characters,
			// or after a field's own closing quote, is junk.
			if (fieldStarted) {
				throw new ImportProviderError("csv-malformed-quoting");
			}
			inQuotes = true;
			fieldStarted = true;
			continue;
		}

		// After a closing quote only a separator or a record break may follow.
		if (quotedFieldClosed && char !== "," && char !== "\r" && char !== "\n") {
			throw new ImportProviderError("csv-malformed-quoting");
		}

		if (char === ",") {
			endField();
			continue;
		}

		if (char === "\r") {
			if (text[index + 1] === "\n") {
				index += 1;
			}
			endRecord();
			continue;
		}

		if (char === "\n") {
			endRecord();
			continue;
		}

		field += char;
		fieldStarted = true;
	}

	if (inQuotes) {
		// Truncated file: a quote was opened and never closed.
		throw new ImportProviderError("csv-malformed-quoting");
	}

	// A trailing newline produces no final record; anything else does.
	if (field.length > 0 || record.length > 0) {
		endRecord();
	}

	// Blank lines carry no record. Exporters routinely emit them at the end of
	// the file, and a blank line can never be a valid multi-column row.
	return records.filter(
		(candidate) => !(candidate.length === 1 && candidate[0] === ""),
	);
}
