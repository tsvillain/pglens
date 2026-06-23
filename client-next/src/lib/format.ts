/**
 * Display formatters for the Operations surfaces (roadmap §6.1, §6.2).
 *
 * Postgres bigint/numeric values arrive as strings through the driver while
 * int4/float8 arrive as numbers; every formatter accepts either and renders an
 * em-dash for null/unparseable input rather than "NaN".
 */

/** Coerce a driver value (number | numeric-string | null) to a finite number, or null. */
export function toNum(v: number | string | null | undefined): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** Human byte size (1024-based): "4.0 KB", "1.2 GB". */
export function formatBytes(v: number | string | null | undefined): string {
  const n = toNum(v)
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let val = n / 1024
  let i = 0
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024
    i++
  }
  return `${val.toFixed(val >= 10 ? 0 : 1)} ${units[i]}`
}

/** Coarse duration from seconds: "<1s", "45s", "3m 20s", "2h 5m". */
export function formatDuration(v: number | string | null | undefined): string {
  const s = toNum(v)
  if (s == null) return '—'
  if (s < 1) return '<1s'
  const sec = Math.floor(s)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const r = sec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${r}s`
  return `${r}s`
}

/** Execution time given in milliseconds: "0.4 ms", "12 ms", "1.5 s", "2.3 min". */
export function formatMs(v: number | string | null | undefined): string {
  const ms = toNum(v)
  if (ms == null) return '—'
  if (ms < 1) return `${ms.toFixed(2)} ms`
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} s`
  return `${(s / 60).toFixed(1)} min`
}

/** Compact integer count: "942", "12.3K", "4.5M". */
export function formatCount(v: number | string | null | undefined): string {
  const n = toNum(v)
  if (n == null) return '—'
  if (n < 1000) return String(Math.round(n))
  const units = ['K', 'M', 'B', 'T']
  let val = n / 1000
  let i = 0
  while (val >= 1000 && i < units.length - 1) {
    val /= 1000
    i++
  }
  return `${val.toFixed(val >= 10 ? 0 : 1)}${units[i]}`
}
