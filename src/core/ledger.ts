import { cleanLabel } from './format'

// Bounded containers and the session's aggregates. Pure: no `$`, no I/O.
// Nothing here holds tool arguments, outputs or prompts: a tool entry keeps
// the tool's name, a display label (a basename at most) and numbers.

/** Fixed-capacity FIFO; the oldest entry leaves when full. */
export class RingBuffer<T> {
  private items: (T | undefined)[]
  private start = 0
  private count = 0

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be >= 1')
    this.items = new Array(capacity)
  }

  get size(): number {
    return this.count
  }

  push(item: T): void {
    const end = (this.start + this.count) % this.capacity
    this.items[end] = item
    if (this.count < this.capacity) this.count += 1
    else this.start = (this.start + 1) % this.capacity
  }

  /** Oldest first. */
  toArray(): T[] {
    const out: T[] = []
    for (let i = 0; i < this.count; i += 1) out.push(this.items[(this.start + i) % this.capacity] as T)
    return out
  }

  /** Newest first, stopping at the first match. */
  findLast(pred: (item: T) => boolean): T | undefined {
    for (let i = this.count - 1; i >= 0; i -= 1) {
      const item = this.items[(this.start + i) % this.capacity] as T
      if (pred(item)) return item
    }
    return undefined
  }

  clear(): void {
    this.items = new Array(this.capacity)
    this.start = 0
    this.count = 0
  }
}

/** Least-recently-used map with a fixed capacity. */
export class Lru<K, V> {
  private map = new Map<K, V>()

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be >= 1')
  }

  get size(): number {
    return this.map.size
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key) as V
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      this.map.delete(oldest.value)
    }
  }

  delete(key: K): void {
    this.map.delete(key)
  }

  keys(): K[] {
    return [...this.map.keys()]
  }

  values(): V[] {
    return [...this.map.values()]
  }

  clear(): void {
    this.map.clear()
  }
}

/** How a tool entry's estimate was made: split from the request delta, or from the result's size alone. */
export type EstimateBasis = 'delta' | 'size'

export type ToolEntry = {
  id: string
  tool: string
  agent: string
  /** A basename at most; never a full path, never arguments. */
  label?: string
  estTokens: number
  basis: EstimateBasis
  isError: boolean
  at: number
}

export type ToolAggregate = { calls: number; estTokens: number; errors: number }

/** Exact, API-reported counts. */
export type Totals = {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

export type Scope = 'main' | 'sub'

export type Aggregates = {
  byTool: Record<string, ToolAggregate>
  totals: Record<Scope, Totals>
  ruleHits: Record<string, number>
}

export const emptyTotals = (): Totals => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 })

const MAX_TOOL_KINDS = 64
const OTHER_TOOL = '(other)'

/** Collapses MCP names to their server so the per-tool table stays small and holds no arguments. */
export function toolKind(tool: string): string {
  if (tool.startsWith('mcp__')) {
    const server = tool.split('__')[1]
    return server ? `mcp:${cleanLabel(server, 40)}` : 'mcp'
  }
  return cleanLabel(tool, 60)
}

export class Ledger {
  readonly entries: RingBuffer<ToolEntry>
  private byTool = new Map<string, ToolAggregate>()
  private totals: Record<Scope, Totals> = { main: emptyTotals(), sub: emptyTotals() }
  private ruleHits = new Map<string, number>()

  constructor(ringSize: number) {
    this.entries = new RingBuffer<ToolEntry>(ringSize)
  }

  private agg(tool: string): ToolAggregate {
    let kind = toolKind(tool)
    if (!this.byTool.has(kind) && this.byTool.size >= MAX_TOOL_KINDS) kind = OTHER_TOOL
    let a = this.byTool.get(kind)
    if (!a) {
      a = { calls: 0, estTokens: 0, errors: 0 }
      this.byTool.set(kind, a)
    }
    return a
  }

  addTool(entry: ToolEntry): void {
    const a = this.agg(entry.tool)
    a.calls += 1
    a.estTokens += entry.estTokens
    if (entry.isError) a.errors += 1
    this.entries.push({ ...entry })
  }

  /** Replaces an entry's size-based estimate with a delta-based one. O(ring) at worst, bounded. */
  refine(id: string, estTokens: number, basis: EstimateBasis): void {
    const entry = this.entries.findLast(e => e.id === id)
    if (!entry) return
    const a = this.agg(entry.tool)
    a.estTokens = Math.max(0, a.estTokens - entry.estTokens + estTokens)
    entry.estTokens = estTokens
    entry.basis = basis
  }

  addUsage(scope: Scope, u: { input: number; output: number; cacheRead: number; cacheCreation: number }): void {
    const t = this.totals[scope]
    t.requests += 1
    t.input += u.input
    t.output += u.output
    t.cacheRead += u.cacheRead
    t.cacheCreation += u.cacheCreation
  }

  countRule(id: string): void {
    this.ruleHits.set(id, (this.ruleHits.get(id) ?? 0) + 1)
  }

  /** Tool kinds by estimated tokens, largest first. */
  topTools(): { tool: string; agg: ToolAggregate }[] {
    return [...this.byTool.entries()]
      .map(([tool, agg]) => ({ tool, agg: { ...agg } }))
      .sort((a, b) => b.agg.estTokens - a.agg.estTokens || b.agg.calls - a.agg.calls)
  }

  /** The costliest single calls still in the ring. */
  topCalls(n: number): ToolEntry[] {
    return this.entries
      .toArray()
      .sort((a, b) => b.estTokens - a.estTokens)
      .slice(0, Math.max(0, n))
      .map(e => ({ ...e }))
  }

  aggregates(): Aggregates {
    const byTool: Record<string, ToolAggregate> = {}
    for (const [k, v] of this.byTool) byTool[k] = { ...v }
    const ruleHits: Record<string, number> = {}
    for (const [k, v] of this.ruleHits) ruleHits[k] = v
    return { byTool, totals: { main: { ...this.totals.main }, sub: { ...this.totals.sub } }, ruleHits }
  }

  reset(): void {
    this.entries.clear()
    this.byTool.clear()
    this.totals = { main: emptyTotals(), sub: emptyTotals() }
    this.ruleHits.clear()
  }
}

/** Adds session aggregates into lifetime ones (for $.store). Counts only. */
export function mergeAggregates(into: Aggregates, add: Aggregates): Aggregates {
  const byTool: Record<string, ToolAggregate> = { ...into.byTool }
  for (const [k, v] of Object.entries(add.byTool)) {
    const prev = byTool[k] ?? { calls: 0, estTokens: 0, errors: 0 }
    byTool[k] = { calls: prev.calls + v.calls, estTokens: prev.estTokens + v.estTokens, errors: prev.errors + v.errors }
  }
  const sum = (a: Totals, b: Totals): Totals => ({
    requests: a.requests + b.requests,
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
  })
  const ruleHits: Record<string, number> = { ...into.ruleHits }
  for (const [k, v] of Object.entries(add.ruleHits)) ruleHits[k] = (ruleHits[k] ?? 0) + v
  return { byTool, totals: { main: sum(into.totals.main, add.totals.main), sub: sum(into.totals.sub, add.totals.sub) }, ruleHits }
}

/** Reads a stored value back as Aggregates, or empty ones when it is anything else. */
export function parseAggregates(v: unknown): Aggregates {
  const empty: Aggregates = { byTool: {}, totals: { main: emptyTotals(), sub: emptyTotals() }, ruleHits: {} }
  if (!v || typeof v !== 'object') return empty
  const o = v as Record<string, unknown>
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0)
  const totals = (x: unknown): Totals => {
    const t = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
    return { requests: n(t.requests), input: n(t.input), output: n(t.output), cacheRead: n(t.cacheRead), cacheCreation: n(t.cacheCreation) }
  }
  const byTool: Record<string, ToolAggregate> = {}
  if (o.byTool && typeof o.byTool === 'object') {
    for (const [k, raw] of Object.entries(o.byTool as Record<string, unknown>).slice(0, MAX_TOOL_KINDS)) {
      const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      byTool[cleanLabel(k, 80)] = { calls: n(a.calls), estTokens: n(a.estTokens), errors: n(a.errors) }
    }
  }
  const ruleHits: Record<string, number> = {}
  if (o.ruleHits && typeof o.ruleHits === 'object') {
    for (const [k, raw] of Object.entries(o.ruleHits as Record<string, unknown>).slice(0, 32)) ruleHits[k.slice(0, 8)] = n(raw)
  }
  const t = (o.totals && typeof o.totals === 'object' ? o.totals : {}) as Record<string, unknown>
  return { byTool, totals: { main: totals(t.main), sub: totals(t.sub) }, ruleHits }
}
