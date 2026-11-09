// Waste rules: a data table plus a small engine that turns signals into hits.
// Pure. Every rule is a heuristic: thresholds are configurable and each hit
// carries a tip, never a verdict. The engine never sees tool arguments; the
// classifier below reads them transiently and returns only booleans, a path
// (kept in memory for R1) and a display basename.

import type { Thresholds } from './config'
import { cleanLabel } from './format'
import { Lru } from './ledger'
import type { StepReport } from './attribution'

export type Severity = 'info' | 'warn' | 'strong'
export type RuleId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8'

export type RuleDef = {
  id: RuleId
  slug: string
  severity: Severity
  /** i18n keys; messages take `{param}` placeholders. */
  message: string
  tip: string
}

export const RULES: readonly RuleDef[] = [
  { id: 'R1', slug: 'repeat-read', severity: 'warn', message: 'rule.R1.msg', tip: 'rule.R1.tip' },
  { id: 'R2', slug: 'huge-output', severity: 'warn', message: 'rule.R2.msg', tip: 'rule.R2.tip' },
  { id: 'R3', slug: 'full-file-read', severity: 'info', message: 'rule.R3.msg', tip: 'rule.R3.tip' },
  { id: 'R4', slug: 'error-loop', severity: 'warn', message: 'rule.R4.msg', tip: 'rule.R4.tip' },
  { id: 'R5', slug: 'cache-rebuild', severity: 'warn', message: 'rule.R5.msg', tip: 'rule.R5.tip' },
  { id: 'R6', slug: 'idle-cache-cooling', severity: 'info', message: 'rule.R6.msg', tip: 'rule.R6.tip' },
  { id: 'R7', slug: 'context-pressure', severity: 'warn', message: 'rule.R7.msg', tip: 'rule.R7.tip' },
  { id: 'R8', slug: 'subagent-heavy', severity: 'info', message: 'rule.R8.msg', tip: 'rule.R8.tip' },
]

export const ruleById = (id: RuleId): RuleDef => RULES.find(r => r.id === id)!

export type HitParams = Record<string, string | number>

export type Hit = {
  rule: RuleId
  severity: Severity
  agent: string
  /** What the hit is about (a basename, a tool kind); part of the tip's identity. */
  subject?: string
  /** Picks a tip variant (R2: bash/read/other; R5: cause). */
  variant?: string
  params: HitParams
  at: number
}

export type Positive = 'cache-hit' | 'targeted-search' | 'small-edit'

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warn: 1, strong: 2 }

// ── classification (args read transiently, never kept) ───────────────────

const READ_TOOLS = new Set(['Read'])
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'LSP', 'ToolSearch'])
const SEARCH_COMMANDS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'fd', 'find', 'locate'])

export type ToolClass = {
  kind: 'read' | 'write' | 'search' | 'bash' | 'other'
  /** Full path, for in-memory repeat detection only. */
  path?: string
  /** Display label: the basename alone. */
  label?: string
  /** Read with offset or limit (or pages). */
  hasRange: boolean
}

/** Longest path kept (in memory, for R1) and longest command prefix read. */
export const MAX_PATH = 1024
const MAX_COMMAND = 512

/** The last path segment, cleaned for display. */
export function basename(p: string): string {
  const tail = p.slice(-MAX_PATH)
  const parts = tail.split(/[\\/]/).filter(Boolean)
  return cleanLabel(parts[parts.length - 1] ?? tail, 80)
}

/** First word of a shell command, skipping env assignments and `sudo`/`time`. */
export function commandHead(command: string): string {
  const words = command.slice(0, MAX_COMMAND).trim().split(/\s+/)
  for (const w of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue
    if (w === 'sudo' || w === 'time' || w === 'command' || w === 'exec') continue
    return basename(w)
  }
  return ''
}

/**
 * Classifies a tool call from its name and arguments. Returns no argument
 * values except the file path (memory only) and its basename (display).
 */
export function classifyTool(tool: string, args: Readonly<Record<string, unknown>>): ToolClass {
  const name = String(tool)
  const rawPath = typeof args.file_path === 'string' ? args.file_path : typeof args.notebook_path === 'string' ? args.notebook_path : undefined
  // The tail holds the file name: keep that end when a path is absurdly long.
  const pathArg = rawPath === undefined ? undefined : rawPath.slice(-MAX_PATH)
  if (READ_TOOLS.has(name)) {
    const hasRange = args.offset !== undefined || args.limit !== undefined || args.pages !== undefined
    return { kind: 'read', path: pathArg, label: pathArg ? basename(pathArg) : undefined, hasRange }
  }
  if (WRITE_TOOLS.has(name)) return { kind: 'write', path: pathArg, label: pathArg ? basename(pathArg) : undefined, hasRange: false }
  if (SEARCH_TOOLS.has(name)) return { kind: 'search', hasRange: false }
  if (name === 'Bash') {
    const cmd = typeof args.command === 'string' ? args.command.slice(0, MAX_COMMAND) : ''
    const head = commandHead(cmd)
    const isSearch = SEARCH_COMMANDS.has(head) || (head === 'git' && /^\s*git\s+grep\b/.test(cmd))
    return { kind: isSearch ? 'search' : 'bash', hasRange: false }
  }
  return { kind: 'other', hasRange: false }
}

// ── engine ────────────────────────────────────────────────────────────────

export type ToolSignal = {
  agent: string
  tool: string
  cls: ToolClass
  /** Size-based token estimate of the result (~). */
  sizeTokens: number
  isError: boolean
  at: number
}

export type StepContext = {
  windowTokens: number
  ttlMs: number
  /** A compaction happened since this agent's previous request. */
  compactedRecently: boolean
}

export type RuleOutput = { hits: Hit[]; positive: Positive[] }

const SMALL_SEARCH_TOKENS = 2000
const SMALL_EDIT_TOKENS = 500
const R8_MIN_TURN_TOKENS = 10_000

export class RuleEngine {
  private reads: Lru<string, number>
  private errors: Lru<string, number>
  private ctxLevel = 0
  private r6FiredFor: number | null = null

  constructor(private t: Thresholds, lruSize: number) {
    this.reads = new Lru(lruSize)
    this.errors = new Lru(64)
  }

  setThresholds(t: Thresholds): void {
    this.t = t
  }

  onTool(sig: ToolSignal): RuleOutput {
    const hits: Hit[] = []
    const positive: Positive[] = []
    const { agent, cls, at } = sig

    // R4: consecutive errors per agent.
    if (sig.isError) {
      const n = (this.errors.get(agent) ?? 0) + 1
      this.errors.set(agent, n)
      if (n === this.t.errorLoop) hits.push({ rule: 'R4', severity: 'warn', agent, params: { count: n }, at })
    } else {
      this.errors.set(agent, 0)
    }

    // R1: same file read N× with no write to it in between (per agent).
    if (cls.path) {
      const key = `${agent}\u0000${cls.path}`
      if (cls.kind === 'write') {
        this.reads.delete(key)
      } else if (cls.kind === 'read' && !sig.isError) {
        const n = (this.reads.get(key) ?? 0) + 1
        this.reads.set(key, n)
        if (n >= this.t.repeatRead) {
          hits.push({ rule: 'R1', severity: 'warn', agent, subject: cls.label, params: { file: cls.label ?? '?', count: n }, at })
        }
      }
    }

    // R2 / R3: big results. R2 wins when both apply.
    if (!sig.isError && sig.sizeTokens > this.t.hugeOutputTokens) {
      const variant = cls.kind === 'read' ? 'read' : cls.kind === 'bash' || cls.kind === 'search' ? 'bash' : 'other'
      hits.push({ rule: 'R2', severity: 'warn', agent, subject: sig.tool, variant, params: { tool: sig.tool, tokens: sig.sizeTokens }, at })
    } else if (!sig.isError && cls.kind === 'read' && !cls.hasRange && sig.sizeTokens > this.t.fullFileReadTokens) {
      hits.push({ rule: 'R3', severity: 'info', agent, subject: cls.label, params: { file: cls.label ?? '?', tokens: sig.sizeTokens }, at })
    }

    if (!sig.isError && cls.kind === 'search' && sig.sizeTokens <= SMALL_SEARCH_TOKENS) positive.push('targeted-search')
    if (!sig.isError && cls.kind === 'write' && sig.sizeTokens <= SMALL_EDIT_TOKENS) positive.push('small-edit')
    return { hits, positive }
  }

  onStep(r: StepReport, ctx: StepContext, at: number): RuleOutput {
    const hits: Hit[] = []
    const positive: Positive[] = []
    if (r.missing) return { hits, positive }

    if (r.isRebuild) {
      const cause =
        ctx.compactedRecently || r.shrank ? 'compaction'
        : r.modelChanged ? 'model'
        : r.gapMs !== null && r.gapMs >= ctx.ttlMs ? 'idle'
        : 'unknown'
      // A rebuild right after a compaction is expected: informational.
      const severity: Severity = cause === 'compaction' ? 'info' : 'warn'
      hits.push({ rule: 'R5', severity, agent: r.agent, variant: cause, params: { tokens: r.exact?.cacheCreation ?? 0 }, at })
    }

    if (!r.isFirst && r.hitRatio !== null && r.hitRatio >= this.t.cacheGoodRatio) positive.push('cache-hit')

    // R7: main context only, once per level crossing, with 5-point hysteresis.
    if (r.agent === 'main' && ctx.windowTokens > 0) {
      const ratio = r.ctx / ctx.windowTokens
      const level = ratio >= this.t.contextStrong ? 2 : ratio >= this.t.contextWarn ? 1 : 0
      if (level > this.ctxLevel) {
        hits.push({
          rule: 'R7', severity: level === 2 ? 'strong' : 'warn', agent: 'main', variant: level === 2 ? 'strong' : 'warn',
          params: { percent: Math.round(ratio * 100) }, at,
        })
        this.ctxLevel = level
      } else if (level < this.ctxLevel) {
        const floor = (this.ctxLevel === 2 ? this.t.contextStrong : this.t.contextWarn) - 0.05
        if (ratio < floor) this.ctxLevel = level
      }
    }
    return { hits, positive }
  }

  /** A main turn ended: its tokens split by loop. R8 is informational. */
  onTurnEnd(mainTokens: number, subTokens: number, at: number): Hit[] {
    const total = mainTokens + subTokens
    if (total < R8_MIN_TURN_TOKENS) return []
    const share = subTokens / total
    if (share <= this.t.subagentShare) return []
    return [{ rule: 'R8', severity: 'info', agent: 'main', params: { percent: Math.round(share * 100) }, at }]
  }

  /**
   * Clock tick: R6 fires once per idle period, in the last minute before the
   * cache's TTL ends. `ttlKnown` false labels the TTL as assumed.
   */
  tick(now: number, lastRequestAt: number | null, ttlMs: number, ttlKnown: boolean, ctxTokens: number | null): Hit[] {
    if (lastRequestAt === null || ctxTokens === null || ctxTokens <= 0) return []
    if (this.r6FiredFor === lastRequestAt) return []
    const idle = now - lastRequestAt
    const warnAt = Math.max(0, ttlMs - 60_000)
    if (idle < warnAt || idle >= ttlMs) return []
    this.r6FiredFor = lastRequestAt
    return [{
      rule: 'R6', severity: 'info', agent: 'main', variant: ttlKnown ? 'known' : 'assumed',
      params: { tokens: ctxTokens, seconds: Math.max(0, Math.round((ttlMs - idle) / 1000)) }, at: now,
    }]
  }

  /** After a compaction the files are no longer in context: re-reading them is legitimate. */
  forgetReads(): void {
    this.reads.clear()
  }

  reset(): void {
    this.reads.clear()
    this.errors.clear()
    this.ctxLevel = 0
    this.r6FiredFor = null
  }
}

// ── toast governor and tip board ──────────────────────────────────────────

export type GovernorOptions = {
  enabled: boolean
  maxPerSession: number
  cooldownMs: number
  minSeverity: Severity
}

/** Decides which hits may toast: threshold, per-rule cooldown, session cap, mute. */
export class ToastGovernor {
  muted = false
  private shown = 0
  private lastByRule = new Map<RuleId, number>()

  constructor(private opts: GovernorOptions) {}

  setOptions(opts: GovernorOptions): void {
    this.opts = opts
  }

  get count(): number {
    return this.shown
  }

  decide(hit: Hit, now: number): boolean {
    if (!this.opts.enabled || this.muted) return false
    if (SEVERITY_RANK[hit.severity] < SEVERITY_RANK[this.opts.minSeverity]) return false
    if (this.shown >= this.opts.maxPerSession) return false
    const last = this.lastByRule.get(hit.rule)
    if (last !== undefined && now - last < this.opts.cooldownMs) return false
    this.lastByRule.set(hit.rule, now)
    this.shown += 1
    return true
  }

  reset(): void {
    this.shown = 0
    this.lastByRule.clear()
  }
}

export type Tip = {
  key: string
  rule: RuleId
  severity: Severity
  variant?: string
  subject?: string
  params: HitParams
  count: number
  at: number
}

/** The Tips tab's list: one row per rule+subject, newest first, bounded, dismissible. */
export class TipBoard {
  private tips = new Lru<string, Tip>(1)
  private dismissed = new Lru<string, true>(1)

  constructor(max = 20) {
    this.tips = new Lru(max)
    this.dismissed = new Lru(Math.max(max * 2, 1))
  }

  static keyOf(hit: Pick<Hit, 'rule' | 'subject'>): string {
    return `${hit.rule}:${hit.subject ?? ''}`
  }

  add(hit: Hit): void {
    const key = TipBoard.keyOf(hit)
    if (this.dismissed.has(key)) return
    const prev = this.tips.get(key)
    this.tips.set(key, {
      key, rule: hit.rule, severity: hit.severity, variant: hit.variant, subject: hit.subject,
      params: { ...hit.params }, count: (prev?.count ?? 0) + 1, at: hit.at,
    })
  }

  dismiss(key: string): void {
    this.tips.delete(key)
    this.dismissed.set(key, true)
  }

  list(): Tip[] {
    return this.tips.values().reverse().map(t => ({ ...t, params: { ...t.params } }))
  }

  clear(): void {
    this.tips.clear()
    this.dismissed.clear()
  }
}
