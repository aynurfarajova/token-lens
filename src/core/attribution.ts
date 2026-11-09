// Per-request usage → per-tool estimates. Pure.
//
// The API reports usage per request, never per tool. Between two requests of
// the same agent the context grows by what was appended in between: the
// previous response (its output) plus the tool results and any reminders. So
//
//   ctx_n   = input + cache_read + cache_creation           (exact)
//   delta_n = max(0, ctx_n − ctx_{n−1} − output_{n−1})      (exact arithmetic)
//
// and delta is split over the tool results completed in between, in
// proportion to each result's serialized size. That split is an ESTIMATE and
// every consumer shows it with "~".

import { Lru } from './ledger'

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model?: string
}

export type ExactUsage = {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  model?: string
}

export type PendingTool = {
  id: string
  tool: string
  /** Serialized size of the result in characters; never the result itself. */
  size: number
}

export type Attribution = {
  id: string
  tool: string
  estTokens: number
  basis: 'delta' | 'size'
}

export type StepReport = {
  agent: string
  /** The request carried no usage (interrupted, failed, or not reported). */
  missing: boolean
  /** No baseline existed for this agent: first request, or after a re-baseline. */
  isFirst: boolean
  /** The context shrank below the previous request's: compaction or cleared results. */
  shrank: boolean
  ctx: number
  exact: ExactUsage | null
  /** cache_read / ctx; null when ctx is 0 or usage is missing. */
  hitRatio: number | null
  /** ctx − prevCtx − prevOutput, before clamping (may be negative). */
  rawDelta: number
  delta: number
  isRebuild: boolean
  attributions: Attribution[]
  /** Part of delta not given to any tool (prompt text, reminders, attachments). */
  other: number
  /** Milliseconds since this agent's previous request; null on the first. */
  gapMs: number | null
  prevModel?: string
  modelChanged: boolean
}

type AgentState = {
  lastCtx: number | null
  lastOutput: number
  lastAt: number | null
  lastModel?: string
  pending: PendingTool[]
}

export type AttributorOptions = {
  rebuildMinTokens: number
  maxAgents?: number
  maxPending?: number
}

/** Rough characters-per-token for English text and code. */
export const CHARS_PER_TOKEN = 4

export function sizeToTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

function nonNeg(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
}

/** Turns whatever the engine reported into clean non-negative integers, or null. */
export function sanitizeUsage(u: unknown): ExactUsage | null {
  if (!u || typeof u !== 'object') return null
  const o = u as Record<string, unknown>
  const exact: ExactUsage = {
    input: nonNeg(o.input_tokens),
    output: nonNeg(o.output_tokens),
    cacheRead: nonNeg(o.cache_read_input_tokens),
    cacheCreation: nonNeg(o.cache_creation_input_tokens),
  }
  if (typeof o.model === 'string' && o.model.length > 0) exact.model = o.model.slice(0, 120)
  return exact
}

export const ctxOf = (u: ExactUsage): number => u.input + u.cacheRead + u.cacheCreation

/** Splits `total` integer tokens over `weights`, largest-remainder, summing exactly to `total`. */
export function splitProportional(total: number, weights: readonly number[]): number[] {
  const n = weights.length
  if (n === 0 || total <= 0) return weights.map(() => 0)
  const w = weights.map(x => (Number.isFinite(x) && x > 0 ? x : 0))
  const sum = w.reduce((a, b) => a + b, 0)
  const shares = sum > 0 ? w.map(x => (x / sum) * total) : w.map(() => total / n)
  const floors = shares.map(Math.floor)
  let left = total - floors.reduce((a, b) => a + b, 0)
  const order = shares.map((s, i) => ({ i, r: s - Math.floor(s) })).sort((a, b) => b.r - a.r || a.i - b.i)
  for (let k = 0; left > 0 && k < order.length; k += 1, left -= 1) floors[order[k]!.i]! += 1
  return floors
}

export class Attributor {
  private agents: Lru<string, AgentState>
  private readonly maxPending: number

  constructor(private readonly opts: AttributorOptions) {
    this.agents = new Lru(opts.maxAgents ?? 64)
    this.maxPending = opts.maxPending ?? 256
  }

  private state(agent: string): AgentState {
    let s = this.agents.get(agent)
    if (!s) {
      s = { lastCtx: null, lastOutput: 0, lastAt: null, pending: [] }
      this.agents.set(agent, s)
    }
    return s
  }

  /** A tool result completed in this agent's loop; it rides on the agent's next request. */
  toolResult(agent: string, t: PendingTool): void {
    const s = this.state(agent)
    s.pending.push({ id: t.id, tool: t.tool, size: nonNeg(t.size) })
    if (s.pending.length > this.maxPending) s.pending.splice(0, s.pending.length - this.maxPending)
  }

  lastRequestAt(agent = 'main'): number | null {
    return this.agents.get(agent)?.lastAt ?? null
  }

  lastCtx(agent = 'main'): number | null {
    return this.agents.get(agent)?.lastCtx ?? null
  }

  /**
   * Forgets the baseline (one agent, or all): after /clear, /resume, a fork,
   * or a compaction. Pending results stay and are estimated by size.
   */
  rebaseline(agent?: string): void {
    const states = agent === undefined ? this.agents.values() : [this.agents.get(agent)].filter(Boolean)
    for (const s of states as AgentState[]) {
      s.lastCtx = null
      s.lastOutput = 0
    }
  }

  /** Drops an agent entirely (its loop ended). */
  forget(agent: string): void {
    this.agents.delete(agent)
  }

  step(agent: string, usage: unknown, now: number): StepReport {
    const s = this.state(agent)
    const exact = sanitizeUsage(usage)
    const gapMs = s.lastAt === null ? null : Math.max(0, now - s.lastAt)

    if (!exact) {
      // Interrupted or failed request: nothing was measured. Keep the baseline
      // and the pending results for the next request that reports usage.
      return {
        agent, missing: true, isFirst: s.lastCtx === null, shrank: false, ctx: 0, exact: null,
        hitRatio: null, rawDelta: 0, delta: 0, isRebuild: false, attributions: [], other: 0,
        gapMs, prevModel: s.lastModel, modelChanged: false,
      }
    }

    const ctx = ctxOf(exact)
    const hasBaseline = s.lastCtx !== null
    const prevCtx = s.lastCtx ?? 0
    const rawDelta = hasBaseline ? ctx - prevCtx - s.lastOutput : 0
    const shrank = hasBaseline && ctx < prevCtx
    const delta = hasBaseline && !shrank ? Math.max(0, rawDelta) : 0

    const pending = s.pending
    s.pending = []
    const sizeEst = pending.map(p => sizeToTokens(p.size))
    const sizeTotal = sizeEst.reduce((a, b) => a + b, 0)

    let attributions: Attribution[]
    let other = delta
    const useSize = !hasBaseline || shrank || delta === 0
    if (pending.length === 0) {
      attributions = []
    } else if (useSize) {
      // No usable delta (first request, compaction, or the context did not
      // grow, e.g. earlier thinking was dropped): estimate from size alone.
      attributions = pending.map((p, i) => ({ id: p.id, tool: p.tool, estTokens: sizeEst[i]!, basis: 'size' as const }))
    } else {
      // The delta also carries reminders and attachments; cap what tools take
      // near their own size so one big reminder is not pinned on a tool.
      const cap = sizeTotal > 0 ? Math.ceil(sizeTotal * 1.5) + 200 : 50 * pending.length
      const toolsTotal = Math.min(delta, cap)
      const parts = splitProportional(toolsTotal, pending.map(p => p.size))
      attributions = pending.map((p, i) => ({ id: p.id, tool: p.tool, estTokens: parts[i]!, basis: 'delta' as const }))
      other = delta - toolsTotal
    }

    // A rebuild: the cache was written far beyond what this request added,
    // while little of the previous prefix was read back.
    const isRebuild =
      hasBaseline &&
      exact.cacheCreation >= this.opts.rebuildMinTokens &&
      exact.cacheCreation > 2 * delta + 1024 &&
      exact.cacheRead < 0.5 * prevCtx

    const prevModel = s.lastModel
    const modelChanged = prevModel !== undefined && exact.model !== undefined && prevModel !== exact.model

    s.lastCtx = ctx
    s.lastOutput = exact.output
    s.lastAt = now
    if (exact.model !== undefined) s.lastModel = exact.model

    return {
      agent, missing: false, isFirst: !hasBaseline, shrank, ctx, exact,
      hitRatio: ctx > 0 ? exact.cacheRead / ctx : null,
      rawDelta, delta, isRebuild, attributions, other, gapMs, prevModel, modelChanged,
    }
  }
}
