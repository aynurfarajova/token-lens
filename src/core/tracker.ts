// The session's analysis, as one object: events in, hits and toasts out.
// Pure (no `$`): register.tsx feeds it from hooks and acts on what it returns,
// so the whole flow is unit-testable. Tool arguments pass through
// `toolResult` only to be classified; nothing of them is stored.

import { Attributor, sizeToTokens, type StepReport } from './attribution'
import { ASSUMED_TTL_MS, ASSUMED_WINDOW, type Config } from './config'
import { cleanLabel } from './format'
import { Ledger, mergeAggregates, parseAggregates, type Aggregates } from './ledger'
import { moodOf, type Mood } from './mood'
import { RuleEngine, SEVERITY_RANK, TipBoard, ToastGovernor, classifyTool, type Hit, type RuleOutput, type Severity } from './rules'

export type Output = { hits: Hit[]; toasts: Hit[] }

export type SessionSource = 'startup' | 'resume' | 'clear' | 'compact' | 'fork'

export type ToolResultInput = {
  agent: string
  id: string
  tool: string
  /** The tool's arguments: classified here, never kept. */
  args: Readonly<Record<string, unknown>>
  /** Characters of the result as the model reads it. */
  size: number
  isError: boolean
}

const EMPTY: Output = { hits: [], toasts: [] }

export class Tracker {
  cfg: Config
  readonly ledger: Ledger
  private attributor: Attributor
  readonly rules: RuleEngine
  readonly tips: TipBoard
  readonly governor: ToastGovernor

  /** Measured by the engine (session.measure); null until then. */
  measuredWindow: number | null = null
  ttlMs = ASSUMED_TTL_MS
  ttlKnown = false
  turnRunning = false
  mainCtx: number | null = null
  lastMain: StepReport | null = null
  lastHit?: { severity: Severity; at: number }
  lastPositiveAt?: number
  /** Lifetime aggregates loaded from the store; the session's are added on read. */
  private base: Aggregates = parseAggregates(undefined)
  private turnTokens = { main: 0, sub: 0 }
  /** The last finished main turn's tokens, shown until the next turn starts. */
  lastTurnTokens = { main: 0, sub: 0 }
  private compactPending = false
  dirty = false

  constructor(cfg: Config) {
    this.cfg = cfg
    this.ledger = new Ledger(cfg.ringSize)
    this.attributor = new Attributor({ rebuildMinTokens: cfg.thresholds.rebuildMinTokens })
    this.rules = new RuleEngine(cfg.thresholds, cfg.lruSize)
    this.tips = new TipBoard(20)
    this.governor = new ToastGovernor(this.governorOptions(cfg))
  }

  private governorOptions(cfg: Config) {
    return { enabled: cfg.toasts, maxPerSession: cfg.maxToasts, cooldownMs: cfg.cooldownMinutes * 60_000, minSeverity: 'warn' as const }
  }

  configure(cfg: Config): void {
    this.cfg = cfg
    this.rules.setThresholds(cfg.thresholds)
    this.governor.setOptions(this.governorOptions(cfg))
  }

  get windowTokens(): number {
    return this.measuredWindow ?? ASSUMED_WINDOW
  }

  get windowKnown(): boolean {
    return this.measuredWindow !== null
  }

  lastRequestAt(): number | null {
    return this.attributor.lastRequestAt('main')
  }

  private emit(out: RuleOutput, now: number): Output {
    if (out.positive.length > 0) this.lastPositiveAt = now
    if (out.hits.length === 0) return out.positive.length > 0 ? { hits: [], toasts: [] } : EMPTY
    const toasts: Hit[] = []
    for (const hit of out.hits) {
      this.ledger.countRule(hit.rule)
      this.tips.add(hit)
      if (SEVERITY_RANK[hit.severity] >= SEVERITY_RANK.warn) this.lastHit = { severity: hit.severity, at: hit.at }
      if (this.governor.decide(hit, now)) toasts.push(hit)
    }
    this.dirty = true
    return { hits: out.hits, toasts }
  }

  toolResult(input: ToolResultInput, now: number): Output {
    // The tool's name may come from an MCP server: clean it before it is kept or shown.
    input = { ...input, tool: cleanLabel(input.tool, 80) }
    const cls = classifyTool(input.tool, input.args)
    const size = Number.isFinite(input.size) && input.size > 0 ? input.size : 0
    const sizeTokens = sizeToTokens(size)
    this.attributor.toolResult(input.agent, { id: input.id, tool: input.tool, size })
    this.ledger.addTool({
      id: input.id, tool: input.tool, agent: input.agent, label: cls.label,
      estTokens: sizeTokens, basis: 'size', isError: input.isError, at: now,
    })
    this.dirty = true
    return this.emit(this.rules.onTool({ agent: input.agent, tool: input.tool, cls, sizeTokens, isError: input.isError, at: now }), now)
  }

  step(agent: string, usage: unknown, now: number): Output & { report: StepReport } {
    const report = this.attributor.step(agent, usage, now)
    if (!report.missing && report.exact) {
      this.ledger.addUsage(agent === 'main' ? 'main' : 'sub', report.exact)
      for (const a of report.attributions) this.ledger.refine(a.id, a.estTokens, a.basis)
      const tokens = report.ctx + report.exact.output
      if (this.turnRunning) {
        if (agent === 'main') this.turnTokens.main += tokens
        else this.turnTokens.sub += tokens
      }
      if (agent === 'main') {
        this.mainCtx = report.ctx
        this.lastMain = report
      }
      this.dirty = true
    }
    const out = this.rules.onStep(
      report,
      { windowTokens: this.windowTokens, ttlMs: this.ttlMs, compactedRecently: agent === 'main' && this.compactPending },
      now,
    )
    if (agent === 'main' && !report.missing) this.compactPending = false
    return { ...this.emit(out, now), report }
  }

  /** Tokens of the running turn, or of the last one when idle. */
  turn(): { main: number; sub: number; isRunning: boolean } {
    const t = this.turnRunning ? this.turnTokens : this.lastTurnTokens
    return { main: t.main, sub: t.sub, isRunning: this.turnRunning }
  }

  turnStart(agent: string | undefined): void {
    if (agent !== undefined) return
    this.turnRunning = true
    this.turnTokens = { main: 0, sub: 0 }
  }

  turnComplete(agent: string | undefined, now: number): Output {
    if (agent !== undefined) return EMPTY
    this.turnRunning = false
    const { main, sub } = this.turnTokens
    this.lastTurnTokens = { main, sub }
    this.turnTokens = { main: 0, sub: 0 }
    return this.emit({ hits: this.rules.onTurnEnd(main, sub, now), positive: [] }, now)
  }

  measure(window: number | undefined, tokens: number | undefined): void {
    if (typeof window === 'number' && Number.isFinite(window) && window > 0) this.measuredWindow = window
    if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0 && this.mainCtx === null) this.mainCtx = tokens
  }

  /** classic.SessionStart: re-baseline on everything but a plain startup. */
  sessionStart(source: SessionSource, info: { cacheLikelyExpired?: boolean; contextTokens?: number }, now: number): Output {
    if (source === 'startup') return EMPTY
    if (source === 'clear') {
      this.resetSession()
      return EMPTY
    }
    if (source === 'compact') {
      this.compacted()
      return EMPTY
    }
    // resume / fork (/branch): the transcript is the same, the baseline is not.
    this.attributor.rebaseline()
    this.lastMain = null
    if (typeof info.contextTokens === 'number' && info.contextTokens > 0) this.mainCtx = info.contextTokens
    if (info.cacheLikelyExpired && this.mainCtx !== null) {
      // The engine says so; the first request will re-cache the whole context.
      return this.emit({
        hits: [{ rule: 'R5', severity: 'info', agent: 'main', variant: 'idle', params: { tokens: this.mainCtx }, at: now }],
        positive: [],
      }, now)
    }
    return EMPTY
  }

  /** classic.PostCompact (or SessionStart 'compact'). */
  compacted(): void {
    this.attributor.rebaseline('main')
    this.rules.forgetReads()
    this.compactPending = true
    this.mainCtx = null
    this.lastMain = null
  }

  modelSwitch(ttl: unknown): void {
    if (ttl === '5m') this.ttlMs = 5 * 60_000
    else if (ttl === '1h') this.ttlMs = 60 * 60_000
    else return
    this.ttlKnown = true
  }

  tick(now: number): Output {
    return this.emit({ hits: this.rules.tick(now, this.lastRequestAt(), this.ttlMs, this.ttlKnown, this.mainCtx), positive: [] }, now)
  }

  mood(now: number): Mood {
    return moodOf({
      now,
      turnRunning: this.turnRunning,
      lastHit: this.lastHit,
      ctxRatio: this.mainCtx === null ? null : this.mainCtx / this.windowTokens,
      contextWarn: this.cfg.thresholds.contextWarn,
      contextStrong: this.cfg.thresholds.contextStrong,
      lastPositiveAt: this.lastPositiveAt,
      lastRequestAt: this.lastRequestAt(),
      ttlMs: this.ttlMs,
    })
  }

  // ── persistence (aggregates only) ──────────────────────────────────────

  loadBase(stored: unknown): void {
    this.base = parseAggregates(stored)
  }

  /** What $.store keeps: lifetime counts, the session's included. Idempotent. */
  persisted(): Aggregates {
    return mergeAggregates(this.base, this.ledger.aggregates())
  }

  /** /clear: the session's numbers fold into the lifetime ones and start over. */
  resetSession(): void {
    this.base = this.persisted()
    this.ledger.reset()
    this.tips.clear()
    this.governor.reset()
    this.rules.reset()
    this.attributor = new Attributor({ rebuildMinTokens: this.cfg.thresholds.rebuildMinTokens })
    this.mainCtx = null
    this.lastMain = null
    this.lastHit = undefined
    this.lastPositiveAt = undefined
    this.turnTokens = { main: 0, sub: 0 }
    this.lastTurnTokens = { main: 0, sub: 0 }
    this.compactPending = false
    this.dirty = true
  }

  /** /tokens reset: session and lifetime numbers both start over. */
  resetAll(): void {
    this.resetSession()
    this.base = parseAggregates(undefined)
  }
}
