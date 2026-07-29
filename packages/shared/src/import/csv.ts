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

const BOM = "\uFEFF";

/**
 * A tokenized record plus the 1-based physical line it started on. The line is
 * carried through parsing so a reported row number always matches what the user
 * sees in a spreadsheet, even when blank lines sit between data rows.
 */
interface CsvRecord {
	fields: string[];
	lineNumber: number;
}

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

	// Blank lines carry no record. Exporters routinely emit them at the end of
	// the file, and a blank line can never be a valid multi-column row. They are
	// dropped only after tokenizing, so each surviving record keeps the line
	// number it had in the file.
	const records = tokenizeCsv(source).filter(
		(record) => !isBlankRecord(record.fields),
	);

	const headerRecord = records[0];
	if (!headerRecord) {
		throw new ImportProviderError("csv-empty-file");
	}

	const headers = headerRecord.fields.map((header) => header.trim());
	assertNoDuplicateHeaders(headers);
	assertRequiredHeaders(headers, options.requiredHeaders);

	const rows: string[][] = [];
	for (let index = 1; index < records.length; index += 1) {
		const record = records[index];
		if (!record) {
			continue;
		}
		if (record.fields.length !== headers.length) {
			throw new ImportProviderError("csv-row-column-mismatch", {
				// Row number as the user sees it in a spreadsheet: the line the
				// record starts on, so interior blank lines do not shift it.
				rowNumber: record.lineNumber,
				expectedColumns: headers.length,
				actualColumns: record.fields.length,
			});
		}
		rows.push(record.fields);
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
function tokenizeCsv(text: string): CsvRecord[] {
	const records: CsvRecord[] = [];
	let record: string[] = [];
	let field = "";
	let inQuotes = false;
	let fieldStarted = false;
	let quotedFieldClosed = false;
	let line = 1;
	let recordLine = 1;

	const endField = () => {
		record.push(field);
		field = "";
		fieldStarted = false;
		quotedFieldClosed = false;
	};

	const endRecord = () => {
		endField();
		records.push({ fields: record, lineNumber: recordLine });
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
			// Newlines inside a quoted field are content, but they still advance
			// the physical line the next record starts on.
			if (char === "\n" || (char === "\r" && text[index + 1] !== "\n")) {
				line += 1;
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
			line += 1;
			recordLine = line;
			continue;
		}

		if (char === "\n") {
			endRecord();
			line += 1;
			recordLine = line;
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

	return records;
}

/**
 * A record is blank when it is a single field holding nothing but whitespace —
 * the shape an empty or whitespace-only line tokenizes into.
 */
function isBlankRecord(fields: string[]): boolean {
	return fields.length === 1 && (fields[0] ?? "").trim() === "";
}
