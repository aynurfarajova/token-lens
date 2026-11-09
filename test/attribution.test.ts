import { expect, test } from 'claude-code/testing'

import { Attributor, sanitizeUsage, sizeToTokens, splitProportional } from '../src/core/attribution'

const u = (input: number, read: number, create: number, output: number, model = 'claude-opus-5-5') => ({
  input_tokens: input,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: create,
  output_tokens: output,
  model,
})

const mk = () => new Attributor({ rebuildMinTokens: 4096 })

test('normal turn: first request baselines, the next splits the delta to its tool', async () => {
  const a = mk()
  const r0 = a.step('main', u(100, 0, 20_000, 300), 0)
  expect(r0.isFirst).toBe(true)
  expect(r0.ctx).toBe(20_100)
  expect(r0.delta).toBe(0)
  expect(r0.isRebuild).toBe(false)

  a.toolResult('main', { id: 't1', tool: 'Read', size: 4000 }) // ~1000 tokens by size
  const r1 = a.step('main', u(50, 20_100, 1_300, 200), 1000)
  // ctx = 21_450; delta = 21_450 - 20_100 - 300 = 1_050
  expect(r1.isFirst).toBe(false)
  expect(r1.rawDelta).toBe(1050)
  expect(r1.delta).toBe(1050)
  expect(r1.attributions).toEqual([{ id: 't1', tool: 'Read', estTokens: 1050, basis: 'delta' }])
  expect(r1.other).toBe(0)
  expect(r1.hitRatio).toBeGreaterThan(0.9)
  expect(r1.gapMs).toBe(1000)
})

test('parallel tools: the delta is split by result size and sums exactly', async () => {
  const a = mk()
  a.step('main', u(10, 0, 10_000, 100), 0)
  a.toolResult('main', { id: 'a', tool: 'Bash', size: 3000 })
  a.toolResult('main', { id: 'b', tool: 'Read', size: 1000 })
  a.toolResult('main', { id: 'c', tool: 'Bash', size: 0 })
  const r = a.step('main', u(10, 10_010, 1_090, 50), 10)
  // ctx 11_110; delta = 11_110 - 10_010 - 100 = 1_000; size est 750+250 = 1000, cap 1700
  expect(r.delta).toBe(1000)
  const by = Object.fromEntries(r.attributions.map(x => [x.id, x.estTokens]))
  expect(by.a).toBe(750)
  expect(by.b).toBe(250)
  expect(by.c).toBe(0)
  expect(r.attributions.reduce((s, x) => s + x.estTokens, 0) + r.other).toBe(r.delta)
})

test('a large reminder in the delta is not pinned on a small tool (capped, rest is other)', async () => {
  const a = mk()
  a.step('main', u(0, 0, 10_000, 0), 0)
  a.toolResult('main', { id: 't', tool: 'Bash', size: 400 }) // ~100 tokens
  const r = a.step('main', u(0, 10_000, 5_000, 0), 1)
  expect(r.delta).toBe(5000)
  const cap = Math.ceil(100 * 1.5) + 200
  expect(r.attributions[0]!.estTokens).toBe(cap)
  expect(r.other).toBe(5000 - cap)
})

test('compaction: context shrinks → no negative attribution, baseline resets, size fallback', async () => {
  const a = mk()
  a.step('main', u(0, 150_000, 1_000, 500), 0)
  a.toolResult('main', { id: 't', tool: 'Read', size: 800 })
  const r = a.step('main', u(0, 0, 30_000, 400), 5)
  expect(r.shrank).toBe(true)
  expect(r.delta).toBe(0)
  expect(r.attributions).toEqual([{ id: 't', tool: 'Read', estTokens: 200, basis: 'size' }])
  // Next request measures against the new, smaller baseline.
  const r2 = a.step('main', u(0, 30_000, 600, 100), 6)
  expect(r2.rawDelta).toBe(30_600 - 30_000 - 400)
  expect(r2.delta).toBe(200)
})

test('/clear (rebaseline all): next request is a first request, no rebuild flagged', async () => {
  const a = mk()
  a.step('main', u(0, 50_000, 1_000, 100), 0)
  a.step('sub-1', u(0, 0, 8_000, 100), 0)
  a.rebaseline()
  const r = a.step('main', u(0, 0, 18_000, 100), 10)
  expect(r.isFirst).toBe(true)
  expect(r.isRebuild).toBe(false)
  expect(a.step('sub-1', u(0, 0, 9_000, 0), 11).isFirst).toBe(true)
})

test('negative raw delta without shrink (earlier thinking dropped): clamps to 0, size fallback', async () => {
  const a = mk()
  a.step('main', u(0, 0, 20_000, 3_000), 0) // 3k output incl. thinking
  a.toolResult('main', { id: 't', tool: 'Bash', size: 400 })
  const r = a.step('main', u(0, 20_000, 1_000, 10), 1) // ctx 21_000 ≥ 20_000 but raw = -2_000
  expect(r.shrank).toBe(false)
  expect(r.rawDelta).toBe(-2000)
  expect(r.delta).toBe(0)
  expect(r.attributions[0]).toEqual({ id: 't', tool: 'Bash', estTokens: 100, basis: 'size' })
})

test('missing usage (interrupted): nothing measured, baseline and pending kept', async () => {
  const a = mk()
  a.step('main', u(0, 0, 10_000, 100), 0)
  a.toolResult('main', { id: 't', tool: 'Read', size: 2000 })
  const miss = a.step('main', null, 1)
  expect(miss.missing).toBe(true)
  expect(miss.attributions).toEqual([])
  const r = a.step('main', u(0, 10_000, 700, 10), 2)
  expect(r.delta).toBe(600)
  expect(r.attributions).toEqual([{ id: 't', tool: 'Read', estTokens: 600, basis: 'delta' }])
})

test('garbage usage values are sanitized, never NaN', async () => {
  expect(sanitizeUsage({ input_tokens: -5, output_tokens: NaN, cache_read_input_tokens: '9', cache_creation_input_tokens: 3.7 })).toEqual({
    input: 0, output: 0, cacheRead: 0, cacheCreation: 3,
  })
  expect(sanitizeUsage(undefined)).toBeNull()
  expect(sanitizeUsage('x')).toBeNull()
})

test('subagents are tracked apart from main', async () => {
  const a = mk()
  a.step('main', u(0, 0, 30_000, 100), 0)
  const s0 = a.step('agent-7', u(0, 0, 6_000, 50), 1)
  expect(s0.isFirst).toBe(true)
  a.toolResult('agent-7', { id: 'x', tool: 'Bash', size: 400 })
  const s1 = a.step('agent-7', u(0, 6_000, 150, 10), 2)
  expect(s1.attributions[0]!.estTokens).toBe(100)
  const m1 = a.step('main', u(0, 30_000, 200, 10), 3)
  expect(m1.attributions).toEqual([])
  expect(m1.delta).toBe(100)
  expect(m1.other).toBe(100)
})

test('cache rebuild: big write on a non-first request with little read', async () => {
  const a = mk()
  a.step('main', u(0, 40_000, 2_000, 200), 0)
  const r = a.step('main', u(0, 0, 42_500, 100), 6 * 60_000)
  expect(r.isRebuild).toBe(true)
  expect(r.gapMs).toBe(360_000)
  // A normal step whose write matches its delta is not a rebuild.
  const ok = a.step('main', u(0, 42_500, 5_000, 10), 6 * 60_000 + 10)
  expect(ok.isRebuild).toBe(false)
})

test('model change is reported', async () => {
  const a = mk()
  a.step('main', u(0, 0, 10_000, 0, 'm1'), 0)
  const r = a.step('main', u(0, 0, 10_100, 0, 'm2'), 1)
  expect(r.modelChanged).toBe(true)
  expect(r.prevModel).toBe('m1')
})

test('bounded: pending per agent and agents overall are capped', async () => {
  const a = new Attributor({ rebuildMinTokens: 4096, maxAgents: 3, maxPending: 5 })
  for (let i = 0; i < 50; i += 1) a.toolResult('main', { id: `t${i}`, tool: 'Bash', size: 4 })
  const r = a.step('main', u(0, 0, 1000, 0), 0)
  expect(r.attributions).toHaveLength(5)
  for (let i = 0; i < 10; i += 1) a.step(`ag${i}`, u(0, 0, 100, 0), 0)
  expect(a.lastCtx('main')).toBeNull() // evicted by LRU
})

test('splitProportional and sizeToTokens', async () => {
  expect(splitProportional(10, [1, 1, 1])).toEqual([4, 3, 3])
  expect(splitProportional(0, [5, 5])).toEqual([0, 0])
  expect(splitProportional(7, [0, 0])).toEqual([4, 3])
  expect(sizeToTokens(0)).toBe(0)
  expect(sizeToTokens(5)).toBe(2)
  expect(sizeToTokens(NaN)).toBe(0)
})
