// Number and label formatting for the UI. Estimates take a "~" prefix; exact numbers never do.

/**
 * Makes an outside-supplied label (a file basename, a tool or MCP server
 * name) safe to draw: removes C0/C1 control characters (terminal escape
 * sequences, newlines), Unicode direction overrides and isolates (which can
 * make text read differently than it is), and zero-width characters, then
 * caps the length.
 */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g

export function cleanLabel(value: unknown, max = 80): string {
  const s = typeof value === 'string' ? value : String(value ?? '')
  const cleaned = s.slice(0, max * 4).replace(UNSAFE, '').trim()
  return (cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned) || '?'
}

export function compact(n: number): string {
  if (!Number.isFinite(n)) return '?'
  const a = Math.abs(n)
  if (a >= 1_000_000) return `${(n / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`
  if (a >= 1_000) return `${(n / 1_000).toFixed(a >= 10_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

export const exact = (n: number): string => compact(n)
export const estimate = (n: number): string => `~${compact(n)}`

export function percent(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return '–'
  return `${Math.round(ratio * 100)}%`
}
