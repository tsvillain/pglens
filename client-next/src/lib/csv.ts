/**
 * Minimal RFC 4180 CSV parser for the import wizard.
 *
 * Parses in the browser so the mapping step can show headers and a sample
 * without a server round-trip. Handles quoted fields (embedded commas, quotes
 * doubled as `""`, and newlines), CRLF or LF line endings, and a trailing
 * newline. The delimiter is configurable (comma default) for TSV pastes.
 *
 * It is deliberately not a streaming parser — import sizes are interactive
 * (the route caps the request), so a single in-memory pass is fine.
 */

export interface ParsedCsv {
  /** First row, treated as the header. Empty array if the file is empty. */
  headers: string[]
  /** Every subsequent row, each padded/truncated to `headers.length`. */
  rows: string[][]
}

/** Parse CSV text into a flat array of records (no header handling). */
function parseRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false
  let i = 0
  const n = text.length

  // Strip a leading UTF-8 BOM so the first header isn't prefixed with ﻿.
  if (text.charCodeAt(0) === 0xfeff) i = 1

  const pushField = () => {
    record.push(field)
    field = ''
  }
  const pushRecord = () => {
    pushField()
    records.push(record)
    record = []
  }

  while (i < n) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i += 1
      continue
    }
    if (ch === delimiter) {
      pushField()
      i += 1
      continue
    }
    if (ch === '\n') {
      pushRecord()
      i += 1
      continue
    }
    if (ch === '\r') {
      // Treat CRLF and a lone CR as one line break.
      pushRecord()
      if (text[i + 1] === '\n') i += 2
      else i += 1
      continue
    }
    field += ch
    i += 1
  }

  // Flush the final record unless the file ended on a clean newline (which
  // would otherwise yield a spurious empty trailing record).
  if (field !== '' || record.length > 0) pushRecord()

  return records
}

export interface ParseCsvOptions {
  delimiter?: string
  /** When false, a synthetic `column_1…` header is generated and every line is
   * treated as data. Default true (first line is the header row). */
  hasHeader?: boolean
}

export function parseCsv(text: string, options: ParseCsvOptions = {}): ParsedCsv {
  const { delimiter = ',', hasHeader = true } = options
  const records = parseRecords(text, delimiter)
  if (records.length === 0) return { headers: [], rows: [] }

  let headers: string[]
  let dataRecords: string[][]
  if (hasHeader) {
    headers = records[0]
    dataRecords = records.slice(1)
  } else {
    const width = records.reduce((m, r) => Math.max(m, r.length), 0)
    headers = Array.from({ length: width }, (_, i) => `column_${i + 1}`)
    dataRecords = records
  }

  const width = headers.length
  const rows = dataRecords.map((r) => {
    if (r.length === width) return r
    // Normalize ragged rows so downstream mapping stays aligned: pad short
    // rows with '' and drop overflow cells.
    const out = r.slice(0, width)
    while (out.length < width) out.push('')
    return out
  })

  return { headers, rows }
}
