/**
 * Lightweight CSV parsing for table previews — dependency-free and
 * preview-focused.
 *
 * This is deliberately not a general-purpose CSV library: it only needs to
 * turn a text file into a renderable table, so it trades edge-case pedantry
 * (multi-line quoted fields are still handled) for a small, readable state
 * machine. Parsing is capped at `CSV_PREVIEW_MAX_ROWS` data rows so a huge
 * file renders instantly instead of freezing the panel; the total row count is
 * then approximated from the remaining text so the UI can still say "showing
 * the first N rows".
 */

/** Hard cap on parsed data rows (header excluded) — beyond this the preview is truncated. */
export const CSV_PREVIEW_MAX_ROWS = 500;

/** Columns to *render* in the table; extra columns are hidden, never dropped. */
export const CSV_PREVIEW_MAX_COLUMNS = 24;

export type CsvParseOptions = {
	/** Hard cap on parsed data rows (header excluded). Defaults to CSV_PREVIEW_MAX_ROWS. */
	maxRows?: number;
	/** Explicit single-character delimiter. When omitted, the delimiter is auto-detected. */
	delimiter?: string;
};

export type CsvParseResult = {
	/** First record, used as the table header. */
	headers: string[];
	/** Data records (everything after the header). */
	rows: string[][];
	/** Approximate total data rows in the file; exceeds rows.length when truncated. */
	totalRows: number;
	/** True when rows were cut short by maxRows. */
	truncated: boolean;
	/** The delimiter that was actually used. */
	delimiter: string;
};

/** Normalise maxRows: any non-positive or non-finite value falls back to the default. */
function normalizeMaxRows(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1)
		return CSV_PREVIEW_MAX_ROWS;
	return Math.floor(value);
}

/** Normalise an explicit delimiter: only a single character is honoured. */
function normalizeDelimiter(value: string | undefined, source: string): string {
	if (typeof value === "string" && value.length === 1) return value;
	return detectDelimiter(source);
}

/** Count newlines in a string, the cheap total-row estimate used on truncation. */
function countNewlines(source: string): number {
	let count = 0;
	for (let i = 0; i < source.length; i += 1) {
		const ch = source[i];
		if (ch === "\n") count += 1;
		else if (ch === "\r") {
			count += 1;
			if (source[i + 1] === "\n") i += 1;
		}
	}
	return count;
}

/**
 * Estimate how many records the remaining (unparsed) text holds. Physical
 * lines map 1:1 to records for well-formed CSV; multi-line quoted fields and
 * blank lines make this an over-estimate, which is fine for a preview hint.
 */
function estimateRemainingRecords(text: string): number {
	if (!text) return 0;
	const newlines = countNewlines(text);
	// A trailing newline terminates the last record; without one, the final
	// unterminated line is a record of its own.
	const endsWithNewline = /[\r\n]$/.test(text);
	return newlines + (endsWithNewline ? 0 : 1);
}

/**
 * Pick the delimiter by counting candidates on the first physical line,
 * outside quotes. Comma stays the default when nothing else wins, so a
 * single-column CSV still parses sensibly.
 */
function detectDelimiter(source: string): string {
	const candidates = [",", "\t", ";"];
	const counts = new Map<string, number>();
	for (const candidate of candidates) counts.set(candidate, 0);

	let inQuotes = false;
	const head = source.slice(0, 8192);
	for (const ch of head) {
		if (ch === '"') {
			inQuotes = !inQuotes;
		} else if (!inQuotes) {
			if (ch === "\n" || ch === "\r") break;
			if (counts.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
		}
	}
	// The most frequent candidate wins; comma stays the default when the first
	// line has none (single-column content or prose). Ties resolve in favour of
	// the earlier candidate, i.e. comma over tab over semicolon.
	let best = ",";
	let bestCount = 0;
	for (const [candidate, count] of counts) {
		if (count > bestCount) {
			best = candidate;
			bestCount = count;
		}
	}
	return best;
}

/**
 * Parse CSV text into header + rows.
 *
 * - Quoted fields may contain the delimiter, newlines and escaped quotes (`""`).
 * - Blank lines are skipped; rows with fewer columns than the header are padded
 *   by the caller, not here.
 * - At most `maxRows` data rows are parsed; `totalRows` is then an estimate of
 *   the remaining records so the UI can still communicate scale.
 */
export function parseCsv(
	source: string,
	options: CsvParseOptions = {},
): CsvParseResult {
	const maxRows = normalizeMaxRows(options.maxRows);
	const delimiter = normalizeDelimiter(options.delimiter, source);
	if (!source) {
		return {
			headers: [],
			rows: [],
			totalRows: 0,
			truncated: false,
			delimiter,
		};
	}

	const records: string[][] = [];
	let field = "";
	let row: string[] = [];
	let inQuotes = false;
	let rowHadContent = false;
	let dataRowCount = 0;
	let truncated = false;
	let lastWasNewline = false;
	let cutIndex = -1;

	const pushField = () => {
		row.push(field);
		field = "";
	};
	const pushRow = () => {
		// Skip physically empty lines (single empty field, nothing else).
		if (rowHadContent || row.length > 1 || row[0] !== "") {
			records.push(row);
			// The first kept record is the header; only data rows count towards
			// maxRows.
			if (records.length > 1) dataRowCount += 1;
		}
		row = [];
		rowHadContent = false;
	};

	for (let i = 0; i < source.length; i += 1) {
		const ch = source[i];
		if (inQuotes) {
			if (ch === '"') {
				if (source[i + 1] === '"') {
					field += '"';
					i += 1;
				} else {
					inQuotes = false;
				}
			} else {
				field += ch;
				rowHadContent = true;
			}
			continue;
		}
		if (ch === '"' && field === "") {
			inQuotes = true;
			rowHadContent = true;
			continue;
		}
		if (ch === delimiter) {
			pushField();
			continue;
		}
		if (ch === "\n") {
			pushField();
			pushRow();
			lastWasNewline = true;
			// Truncate only when a row actually follows; a file that ends
			// exactly at the cap is complete, not cut short.
			if (dataRowCount >= maxRows && i < source.length - 1) {
				truncated = true;
				cutIndex = i;
				break;
			}
			continue;
		}
		if (ch === "\r") {
			if (source[i + 1] === "\n") i += 1;
			pushField();
			pushRow();
			lastWasNewline = true;
			if (dataRowCount >= maxRows && i < source.length - 1) {
				truncated = true;
				cutIndex = i;
				break;
			}
			continue;
		}
		field += ch;
		rowHadContent = true;
		lastWasNewline = false;
	}

	if (!lastWasNewline) {
		pushField();
		pushRow();
	}

	const headers = records[0] ?? [];
	const rows = records.slice(1);
	const totalRows = truncated
		? rows.length + estimateRemainingRecords(source.slice(cutIndex + 1))
		: rows.length;
	return { headers, rows, totalRows, truncated, delimiter };
}
