/**
 * Client-side export of a query result set (roadmap §5.4 — the result grid
 * "inherits export"). Unlike the no-code table export, which streams a whole
 * table server-side, an Advanced-mode result is already fully in memory (it's
 * exactly what the editor fetched), so serializing in the browser is the right
 * fit and needs no extra round-trip.
 */

import { downloadBlob } from '@/lib/download'

export type ResultExportFormat = 'csv' | 'json'

type Row = Record<string, unknown>

/** Render one value for a CSV cell: NULL → empty, objects → JSON, else string. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text =
    typeof value === 'object' ? JSON.stringify(value) : String(value)
  // Quote when the field contains a comma, quote, or newline (RFC 4180).
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

/** Serialize rows to RFC 4180 CSV with a header row in `columns` order. */
export function resultToCsv(columns: string[], rows: Row[]): string {
  const lines = [columns.map(csvCell).join(',')]
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(row[c])).join(','))
  }
  return lines.join('\r\n')
}

/** Serialize rows to pretty-printed JSON (array of objects). */
export function resultToJson(rows: Row[]): string {
  return JSON.stringify(rows, null, 2)
}

const MIME: Record<ResultExportFormat, string> = {
  csv: 'text/csv;charset=utf-8',
  json: 'application/json',
}

/** Serialize and download the active result set in `format`. */
export function downloadResult(
  format: ResultExportFormat,
  baseName: string,
  columns: string[],
  rows: Row[],
) {
  const text =
    format === 'csv' ? resultToCsv(columns, rows) : resultToJson(rows)
  downloadBlob(text, `${baseName}.${format}`, MIME[format])
}
