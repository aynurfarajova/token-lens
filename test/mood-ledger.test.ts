import { expect, test } from 'claude-code/testing'

import { Ledger, Lru, RingBuffer, mergeAggregates, parseAggregates, toolKind } from '../src/core/ledger'
import { moodOf, type MoodInput } from '../src/core/mood'

const base: MoodInput = {
  now: 1_000_000, turnRunning: false, ctxRatio: 0.2, contextWarn: 0.7, contextStrong: 0.85,
  lastRequestAt: 1_000_000 - 1000, ttlMs: 300_000,
}

test('mood: priority alarmed > worried > thinking > sleepy > happy > idle', async () => {
  expect(moodOf(base)).toBe('idle')
  expect(moodOf({ ...base, lastPositiveAt: base.now - 10 })).toBe('happy')
  expect(moodOf({ ...base, lastPositiveAt: base.now - 10, lastRequestAt: base.now - 250_000 })).toBe('sleepy')
  expect(moodOf({ ...base, turnRunning: true, lastRequestAt: base.now - 250_000 })).toBe('thinking')
  expect(moodOf({ ...base, turnRunning: true, lastHit: { severity: 'warn', at: base.now - 5 } })).toBe('worried')
  expect(moodOf({ ...base, ctxRatio: 0.9, turnRunning: true })).toBe('alarmed')
  expect(moodOf({ ...base, lastHit: { severity: 'strong', at: base.now - 5 } })).toBe('alarmed')
})

test('mood: old hits and positives fade; info hits never worry', async () => {
  expect(moodOf({ ...base, lastHit: { severity: 'warn', at: base.now - 200_000 } })).toBe('idle')
  expect(moodOf({ ...base, lastHit: { severity: 'info', at: base.now - 5 } })).toBe('idle')
  expect(moodOf({ ...base, lastPositiveAt: base.now - 200_000 })).toBe('idle')
  expect(moodOf({ ...base, ctxRatio: null, lastRequestAt: null })).toBe('idle')
})

test('ring buffer and LRU stay bounded', async () => {
  const r = new RingBuffer<number>(3)
  for (let i = 0; i < 10; i += 1) r.push(i)
  expect(r.toArray()).toEqual([7, 8, 9])
  expect(r.findLast(x => x < 9)).toBe(8)
  const l = new Lru<string, number>(2)
  l.set('a', 1)
  l.set('b', 2)
  l.get('a')
  l.set('c', 3)
  expect(l.keys()).toEqual(['a', 'c'])
})

test('ledger: aggregates per tool kind, refine replaces an estimate, top calls', async () => {
  const g = new Ledger(4)
  g.addTool({ id: '1', tool: 'Read', agent: 'main', label: 'a.ts', estTokens: 100, basis: 'size', isError: false, at: 0 })
  g.addTool({ id: '2', tool: 'mcp__github__search', agent: 'main', estTokens: 50, basis: 'size', isError: true, at: 1 })
  g.refine('1', 400, 'delta')
  const top = g.topTools()
  expect(top[0]).toEqual({ tool: 'Read', agg: { calls: 1, estTokens: 400, errors: 0 } })
  expect(top[1]!.tool).toBe('mcp:github')
  expect(g.topCalls(1)[0]!.label).toBe('a.ts')
  g.addUsage('main', { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 })
  g.countRule('R1')
  const agg = g.aggregates()
  expect(agg.totals.main).toEqual({ requests: 1, input: 1, output: 2, cacheRead: 3, cacheCreation: 4 })
  expect(agg.ruleHits).toEqual({ R1: 1 })
  for (let i = 0; i < 20; i += 1) g.addTool({ id: `x${i}`, tool: 'Bash', agent: 'main', estTokens: 1, basis: 'size', isError: false, at: i })
  expect(g.entries.size).toBe(4)
  expect(toolKind('mcp__')).toBe('mcp')
})

test('persisted aggregates: merge adds, parse rejects garbage and holds no strings beyond names', async () => {
  const g = new Ledger(10)
  g.addTool({ id: '1', tool: 'Bash', agent: 'main', estTokens: 10, basis: 'size', isError: false, at: 0 })
  const a = g.aggregates()
  const merged = mergeAggregates(mergeAggregates(parseAggregates(undefined), a), a)
  expect(merged.byTool.Bash).toEqual({ calls: 2, estTokens: 20, errors: 0 })
  const back = parseAggregates(JSON.parse(JSON.stringify(merged)))
  expect(back).toEqual(merged)
  expect(parseAggregates({ byTool: { X: { calls: -1, estTokens: 'a' } }, totals: 7 }).byTool.X).toEqual({ calls: 0, estTokens: 0, errors: 0 })
  expect(JSON.stringify(back)).not.toContain('a.ts')
})
