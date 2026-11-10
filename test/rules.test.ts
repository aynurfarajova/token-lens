import { expect, test } from 'claude-code/testing'

import type { StepReport } from '../src/core/attribution'
import { DEFAULTS, normalizeConfig } from '../src/core/config'
import { cleanLabel } from '../src/core/format'
import { toolKind } from '../src/core/ledger'
import { RULES, RuleEngine, TipBoard, ToastGovernor, basename, classifyTool, commandHead, type Hit } from '../src/core/rules'
import { en } from '../src/i18n/en'
import { hasKey, t, tipKey } from '../src/i18n/index'
import { tipSteps } from '../src/ui/text'

const T = DEFAULTS.thresholds
const engine = () => new RuleEngine(T, 200)

const read = (path: string, extra: Record<string, unknown> = {}) => classifyTool('Read', { file_path: path, ...extra })
const sig = (tool: string, cls: ReturnType<typeof classifyTool>, sizeTokens = 100, isError = false, agent = 'main', at = 0) => ({
  agent, tool, cls, sizeTokens, isError, at,
})

const report = (over: Partial<StepReport> = {}): StepReport => ({
  agent: 'main', missing: false, isFirst: false, shrank: false, ctx: 10_000,
  exact: { input: 0, output: 0, cacheRead: 9_000, cacheCreation: 1_000 },
  hitRatio: 0.9, rawDelta: 1000, delta: 1000, isRebuild: false, attributions: [], other: 0,
  gapMs: 1000, modelChanged: false, ...over,
})
const stepCtx = { windowTokens: 200_000, ttlMs: 300_000, compactedRecently: false }

test('classifier keeps only booleans, the path (memory) and a basename', async () => {
  expect(read('/a/b/secret.ts')).toEqual({ kind: 'read', path: '/a/b/secret.ts', label: 'secret.ts', hasRange: false })
  expect(read('/x.ts', { offset: 10 }).hasRange).toBe(true)
  expect(classifyTool('Edit', { file_path: '/x.ts', old_string: 'k', new_string: 'v' })).toEqual({
    kind: 'write', path: '/x.ts', label: 'x.ts', hasRange: false,
  })
  expect(classifyTool('Bash', { command: 'FOO=1 rg needle src' }).kind).toBe('search')
  expect(classifyTool('Bash', { command: 'git grep needle' }).kind).toBe('search')
  expect(classifyTool('Bash', { command: 'npm test' }).kind).toBe('bash')
  expect(classifyTool('Grep', { pattern: 'x' }).kind).toBe('search')
  expect(classifyTool('mcp__srv__tool', { a: 1 }).kind).toBe('other')
  expect(commandHead('sudo /usr/bin/find . -name x')).toBe('find')
})

test('R1 repeat-read: fires on the 3rd read; an edit in between resets it', async () => {
  const e = engine()
  expect(e.onTool(sig('Read', read('/p/a.ts'))).hits).toEqual([])
  expect(e.onTool(sig('Read', read('/p/a.ts'))).hits).toEqual([])
  const third = e.onTool(sig('Read', read('/p/a.ts'))).hits
  expect(third.map(h => h.rule)).toEqual(['R1'])
  expect(third[0]!.params.file).toBe('a.ts')
  expect(JSON.stringify(third)).not.toContain('/p/')

  const f = engine()
  f.onTool(sig('Read', read('/p/b.ts')))
  f.onTool(sig('Read', read('/p/b.ts')))
  f.onTool(sig('Edit', classifyTool('Edit', { file_path: '/p/b.ts' })))
  expect(f.onTool(sig('Read', read('/p/b.ts'))).hits).toEqual([])
})

test('R1 is per agent: a subagent reading the same file is not a repeat for main', async () => {
  const e = engine()
  e.onTool(sig('Read', read('/p/a.ts'), 100, false, 'main'))
  e.onTool(sig('Read', read('/p/a.ts'), 100, false, 'main'))
  expect(e.onTool(sig('Read', read('/p/a.ts'), 100, false, 'sub')).hits).toEqual([])
})

test('R2 huge-output picks a variant; R3 full-file-read only below R2', async () => {
  const e = engine()
  const bash = e.onTool(sig('Bash', classifyTool('Bash', { command: 'npm test' }), 9000)).hits
  expect(bash.map(h => [h.rule, h.variant])).toEqual([['R2', 'bash']])
  const bigRead = e.onTool(sig('Read', read('/a.ts'), 9000)).hits
  expect(bigRead.map(h => [h.rule, h.variant])).toEqual([['R2', 'read']])
  const midRead = e.onTool(sig('Read', read('/b.ts'), 6000)).hits
  expect(midRead.map(h => h.rule)).toEqual(['R3'])
  expect(e.onTool(sig('Read', read('/c.ts', { limit: 50 }), 6000)).hits).toEqual([])
})

test('R4 error-loop: fires once at the threshold, resets on success', async () => {
  const e = engine()
  const bash = classifyTool('Bash', { command: 'make' })
  expect(e.onTool(sig('Bash', bash, 10, true)).hits).toEqual([])
  expect(e.onTool(sig('Bash', bash, 10, true)).hits).toEqual([])
  expect(e.onTool(sig('Bash', bash, 10, true)).hits.map(h => h.rule)).toEqual(['R4'])
  expect(e.onTool(sig('Bash', bash, 10, true)).hits).toEqual([]) // not every time past it
  e.onTool(sig('Bash', bash, 10, false))
  e.onTool(sig('Bash', bash, 10, true))
  e.onTool(sig('Bash', bash, 10, true))
  expect(e.onTool(sig('Bash', bash, 10, true)).hits.map(h => h.rule)).toEqual(['R4'])
})

test('R5 cache-rebuild infers the cause and labels compaction as info', async () => {
  const e = engine()
  const idle = e.onStep(report({ isRebuild: true, gapMs: 400_000 }), stepCtx, 0).hits[0]!
  expect([idle.rule, idle.variant, idle.severity]).toEqual(['R5', 'idle', 'warn'])
  expect(e.onStep(report({ isRebuild: true, modelChanged: true }), stepCtx, 0).hits[0]!.variant).toBe('model')
  const comp = e.onStep(report({ isRebuild: true }), { ...stepCtx, compactedRecently: true }, 0).hits[0]!
  expect([comp.variant, comp.severity]).toEqual(['compaction', 'info'])
  expect(e.onStep(report({ isRebuild: true }), stepCtx, 0).hits[0]!.variant).toBe('unknown')
})

test('R7 context-pressure: once per level, strong at 85%, hysteresis on the way down', async () => {
  const e = engine()
  expect(e.onStep(report({ ctx: 100_000 }), stepCtx, 0).hits).toEqual([])
  const warn = e.onStep(report({ ctx: 145_000 }), stepCtx, 0).hits
  expect(warn.map(h => [h.rule, h.severity])).toEqual([['R7', 'warn']])
  expect(e.onStep(report({ ctx: 150_000 }), stepCtx, 0).hits).toEqual([])
  const strong = e.onStep(report({ ctx: 175_000 }), stepCtx, 0).hits
  expect(strong.map(h => [h.rule, h.severity, h.params.percent])).toEqual([['R7', 'strong', 88]])
  // Drop just under 85%: within hysteresis, no re-arm, so no new hit coming back up.
  e.onStep(report({ ctx: 165_000 }), stepCtx, 0)
  expect(e.onStep(report({ ctx: 175_000 }), stepCtx, 0).hits).toEqual([])
  // After a compaction drops it well below, the warn level re-arms.
  e.onStep(report({ ctx: 30_000 }), stepCtx, 0)
  expect(e.onStep(report({ ctx: 145_000 }), stepCtx, 0).hits.map(h => h.rule)).toEqual(['R7'])
})

test('R7 ignores subagent contexts', async () => {
  expect(engine().onStep(report({ agent: 'sub', ctx: 190_000 }), stepCtx, 0).hits).toEqual([])
})

test('R6 idle-cache-cooling fires once in the last minute, labels assumed TTL', async () => {
  const e = engine()
  expect(e.tick(200_000, 0, 300_000, false, 50_000)).toEqual([])
  const hit = e.tick(250_000, 0, 300_000, false, 50_000)
  expect(hit.map(h => [h.rule, h.variant, h.params.seconds])).toEqual([['R6', 'assumed', 50]])
  expect(e.tick(260_000, 0, 300_000, false, 50_000)).toEqual([])
  expect(e.tick(301_000, 0, 300_000, false, 50_000)).toEqual([]) // already cold
  expect(e.tick(250_000 + 1_000_000, 1_000_000, 300_000, true, 50_000)[0]!.variant).toBe('known')
})

test('R8 subagent-heavy is informational and needs a meaningful turn', async () => {
  const e = engine()
  expect(e.onTurnEnd(1000, 5000, 0)).toEqual([])
  const h = e.onTurnEnd(10_000, 30_000, 0)
  expect(h.map(x => [x.rule, x.severity, x.params.percent])).toEqual([['R8', 'info', 75]])
  expect(e.onTurnEnd(30_000, 10_000, 0)).toEqual([])
})

test('positive signals: cache hit, targeted search, small edit', async () => {
  const e = engine()
  expect(e.onStep(report({ hitRatio: 0.95 }), stepCtx, 0).positive).toEqual(['cache-hit'])
  expect(e.onStep(report({ hitRatio: 0.95, isFirst: true }), stepCtx, 0).positive).toEqual([])
  expect(e.onTool(sig('Bash', classifyTool('Bash', { command: 'rg foo' }), 300)).positive).toEqual(['targeted-search'])
  expect(e.onTool(sig('Edit', classifyTool('Edit', { file_path: '/a' }), 50)).positive).toEqual(['small-edit'])
})

test('toast governor: severity threshold, per-rule cooldown, session cap, mute', async () => {
  const g = new ToastGovernor({ enabled: true, maxPerSession: 3, cooldownMs: 600_000, minSeverity: 'warn' })
  const hit = (rule: Hit['rule'], severity: Hit['severity'] = 'warn'): Hit => ({ rule, severity, agent: 'main', params: {}, at: 0 })
  expect(g.decide(hit('R3', 'info'), 0)).toBe(false)
  expect(g.decide(hit('R1'), 0)).toBe(true)
  expect(g.decide(hit('R1'), 1000)).toBe(false) // cooldown
  expect(g.decide(hit('R1'), 600_000)).toBe(true)
  expect(g.decide(hit('R2'), 600_001)).toBe(true)
  expect(g.decide(hit('R4'), 600_002)).toBe(false) // cap 3
  const m = new ToastGovernor({ enabled: true, maxPerSession: 5, cooldownMs: 0, minSeverity: 'warn' })
  m.muted = true
  expect(m.decide(hit('R1'), 0)).toBe(false)
  const off = new ToastGovernor({ enabled: false, maxPerSession: 5, cooldownMs: 0, minSeverity: 'warn' })
  expect(off.decide(hit('R7', 'strong'), 0)).toBe(false)
})

test('tip board: one row per rule+subject, dismissed stays dismissed, bounded', async () => {
  const b = new TipBoard(3)
  const h = (rule: Hit['rule'], subject?: string): Hit => ({ rule, severity: 'warn', agent: 'main', subject, params: {}, at: 0 })
  b.add(h('R1', 'a.ts'))
  b.add(h('R1', 'a.ts'))
  b.add(h('R1', 'b.ts'))
  expect(b.list().map(x => [x.key, x.count])).toEqual([['R1:b.ts', 1], ['R1:a.ts', 2]])
  b.dismiss('R1:a.ts')
  b.add(h('R1', 'a.ts'))
  expect(b.list().map(x => x.key)).toEqual(['R1:b.ts'])
  b.add(h('R2'))
  b.add(h('R4'))
  b.add(h('R7'))
  expect(b.list()).toHaveLength(3)
})

test('every rule message and every tip variant resolves in en and az', async () => {
  const variants: Record<string, (string | undefined)[]> = {
    R2: ['bash', 'read', 'other'], R5: ['idle', 'model', 'compaction', 'unknown'], R6: ['known', 'assumed'], R7: ['warn', 'strong'],
  }
  for (const r of RULES) {
    expect(hasKey(r.message)).toBe(true)
    for (const v of variants[r.id] ?? [undefined]) {
      const k = tipKey(r.tip, v)
      expect(hasKey(k)).toBe(true)
      expect(t('az', k, { tokens: 1, file: 'f', count: 3, percent: 70, seconds: 9, tool: 'Bash' })).not.toContain('{')
    }
  }
  expect(t('en', 'rule.R1.msg', { file: 'a.ts', count: 3 })).toBe('a.ts read 3× with no edit in between')
  expect(Object.keys(en).length).toBeGreaterThan(20)
})

test('tips are plain steps that never put the project at risk', async () => {
  // Nothing that deletes, forces, skips hooks or hides output and errors.
  const RISKY = [/rm -/, /--force/, /--no-verify/, /git reset/, /git push/, /git checkout/, /\s-q\b/, /--silent/, /\/dev\/null/, /chmod/, /sudo/]
  const tipKeys = (Object.keys(en) as (keyof typeof en)[]).filter(k => /^rule\.R\d\.tip/.test(k))
  expect(tipKeys.length).toBeGreaterThan(10)
  for (const lang of ['en', 'az'] as const) {
    for (const k of tipKeys) {
      const text = t(lang, k, { tokens: 1 })
      for (const r of RISKY) expect(r.test(text)).toBe(false)
      for (const step of tipSteps(text)) expect(step.length).toBeGreaterThan(10)
    }
  }
})

test('config: defaults, clamping, and garbage', async () => {
  expect(normalizeConfig(undefined)).toEqual(DEFAULTS)
  const c = normalizeConfig({ language: 'az', repeat_read_threshold: 1, max_toasts: '7', context_warn_percent: 90, context_strong_percent: 50, toasts: 'false', ring_size: 1e9 })
  expect(c.language).toBe('az')
  expect(c.thresholds.repeatRead).toBe(2)
  expect(c.maxToasts).toBe(7)
  expect(c.thresholds.contextStrong).toBe(0.9) // never below warn
  expect(c.toasts).toBe(false)
  expect(c.ringSize).toBe(5000)
  expect(normalizeConfig({ language: 'fr', huge_output_tokens: 'lots' }).language).toBe('en')
})

test('hardening: outside-supplied names are cleaned before they are kept or shown', async () => {
  // Terminal escape sequences, newlines, direction overrides and zero-width characters go.
  expect(cleanLabel('\u001b[31mevil\u001b[0m.ts')).toBe('[31mevil[0m.ts')
  expect(cleanLabel('a\nb\rc\u0007.ts')).toBe('abc.ts')
  expect(cleanLabel('invoice\u202Efdp.exe')).toBe('invoicefdp.exe')
  expect(cleanLabel('x\u200By\u2066z\uFEFF')).toBe('xyz')
  expect(cleanLabel('\u0000\u0001')).toBe('?')
  expect(cleanLabel('y'.repeat(500)).length).toBe(80)
  expect(basename('/repo/\u001b]8;;http://x\u0007click\u001b]8;;\u0007.ts')).not.toMatch(/[\u0000-\u001f]/)
  expect(toolKind('mcp__evil\u001b[2Jserver__run')).toBe('mcp:evil[2Jserver')
  expect(toolKind('Bash\u202E')).toBe('Bash')
})

test('hardening: huge paths and commands are bounded', async () => {
  const cls = classifyTool('Read', { file_path: '/' + 'a/'.repeat(100_000) + 'f.ts' })
  expect(cls.path!.length).toBeLessThanOrEqual(1024)
  expect(cls.label).toBe('f.ts')
  expect(classifyTool('Bash', { command: 'rg ' + 'x '.repeat(1_000_000) }).kind).toBe('search')
})
