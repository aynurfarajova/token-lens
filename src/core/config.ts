// Configuration: defaults, and a normaliser that turns the manifest's flat
// userConfig values into a clamped, typed Config. Pure.

export type Lang = 'en' | 'az'

export type Thresholds = {
  /** R1: reads of one file, with no write in between, before it fires. */
  repeatRead: number
  /** R2: estimated tokens of one tool result. */
  hugeOutputTokens: number
  /** R3: estimated tokens of a Read with no offset/limit. */
  fullFileReadTokens: number
  /** R4: consecutive errored tool results. */
  errorLoop: number
  /** R7: context fill ratios. */
  contextWarn: number
  contextStrong: number
  /** R8: subagent share of a turn's tokens. */
  subagentShare: number
  /** Positive signal: cache hit ratio. */
  cacheGoodRatio: number
  /** R5: smallest cache write that can count as a rebuild. */
  rebuildMinTokens: number
}

export type Config = {
  language: Lang
  thresholds: Thresholds
  toasts: boolean
  maxToasts: number
  cooldownMinutes: number
  band: boolean
  /** Animate the mascot (off = one still frame, for reduced motion). */
  animation: boolean
  ringSize: number
  lruSize: number
}

export const DEFAULTS: Config = {
  language: 'en',
  thresholds: {
    repeatRead: 3,
    hugeOutputTokens: 8000,
    fullFileReadTokens: 5000,
    errorLoop: 3,
    contextWarn: 0.7,
    contextStrong: 0.85,
    subagentShare: 0.5,
    cacheGoodRatio: 0.8,
    rebuildMinTokens: 4096,
  },
  toasts: true,
  maxToasts: 5,
  cooldownMinutes: 10,
  band: true,
  animation: true,
  ringSize: 500,
  lruSize: 200,
}

/** Context window assumed until the engine measures one. */
export const ASSUMED_WINDOW = 200_000
/** Prompt-cache TTL assumed until a model-switch event states one. */
export const ASSUMED_TTL_MS = 5 * 60_000

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return fallback
}

/**
 * Reads userConfig values (flat keys, as the manifest declares them) into a
 * Config. Unknown or out-of-range values fall back to, or clamp near, the
 * defaults; this never throws.
 */
export function normalizeConfig(options: Readonly<Record<string, unknown>> | undefined): Config {
  const o = options ?? {}
  const d = DEFAULTS
  const t = d.thresholds
  // Percent values are rounded first so 0.7 stays 0.7 (0.7 * 100 is 70.00000000000001).
  const pct = (v: unknown, def: number, min: number, max: number) => Math.round(num(v, Math.round(def * 100), min, max)) / 100
  const warn = pct(o.context_warn_percent, t.contextWarn, 10, 99)
  const strong = Math.max(warn, pct(o.context_strong_percent, t.contextStrong, 10, 100))
  return {
    language: o.language === 'az' ? 'az' : 'en',
    thresholds: {
      repeatRead: Math.round(num(o.repeat_read_threshold, t.repeatRead, 2, 50)),
      hugeOutputTokens: Math.round(num(o.huge_output_tokens, t.hugeOutputTokens, 500, 200_000)),
      fullFileReadTokens: Math.round(num(o.full_file_read_tokens, t.fullFileReadTokens, 500, 200_000)),
      errorLoop: Math.round(num(o.error_loop_threshold, t.errorLoop, 2, 50)),
      contextWarn: warn,
      contextStrong: strong,
      subagentShare: pct(o.subagent_share_percent, t.subagentShare, 1, 100),
      cacheGoodRatio: t.cacheGoodRatio,
      rebuildMinTokens: t.rebuildMinTokens,
    },
    toasts: bool(o.toasts, d.toasts),
    maxToasts: Math.round(num(o.max_toasts, d.maxToasts, 0, 50)),
    cooldownMinutes: num(o.cooldown_minutes, d.cooldownMinutes, 0, 24 * 60),
    band: bool(o.band, d.band),
    animation: bool(o.animation, d.animation),
    ringSize: Math.round(num(o.ring_size, d.ringSize, 50, 5000)),
    lruSize: Math.round(num(o.lru_size, d.lruSize, 20, 2000)),
  }
}
