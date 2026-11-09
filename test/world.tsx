// The fake engine beneath the plugin, shared by the mod-kit tests. The kit
// wants every hook beneath registered before the test's first call on `$`,
// so one configurable engine is set up first and steered through `w`.

import { mock } from 'claude-code/testing'
import type { On, ToolCallResult, TurnStepChunk, TurnStepResult } from 'claude-code'

export const usage = (input: number, read: number, create: number, output: number) => ({
  input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: create, output_tokens: output, model: 'claude-opus-5-5',
})

export type Step = { chunks: TurnStepChunk[]; result: TurnStepResult }

export function world(on: On, opts: { ownClock?: boolean; ownStore?: boolean } = {}) {
  const w = {
    now: 1_000_000,
    clockBroken: false,
    storeBroken: false,
    store: {} as Record<string, unknown>,
    toolAnswer: (_e: { tool: string }): ToolCallResult => ({ result: {}, text: '' }),
    steps: [] as Step[],
    classicAnswer: {} as Record<string, unknown>,
    seenTool: [] as unknown[],
    seenStep: [] as unknown[],
    toasts: [] as string[],
    opened: [] as string[],
    blits: [] as { key: string; columns: number; rows: number }[],
    blitDeny: false,
    logs: [] as { text: string; to: string }[],
    /** The mocked clock, unless the test brought its own. */
    clock: undefined as ReturnType<typeof mock.clock> | undefined,
  }
  if (opts.ownClock) {
    on('clock.now', () => {
      if (w.clockBroken) throw new Error('clock exploded')
      return { value: w.now }
    })
    on('clock.after', () => ({ deny: 'no timers in this test' }))
    on('clock.every', () => ({ deny: 'no ticks in this test' }))
  } else {
    w.clock = mock.clock(on, { now: w.now })
  }
  if (opts.ownStore) {
    on('store.get', (_$, e) => {
      if (w.storeBroken) throw new Error('disk')
      return { value: w.store[e.key] }
    })
    on('store.set', (_$, e) => {
      w.store[e.key] = JSON.parse(JSON.stringify(e.value))
      return { value: undefined }
    })
    on('store.delete', (_$, e) => {
      delete w.store[e.key]
      return { value: undefined }
    })
  } else {
    mock.store(on, {})
  }
  on('command.register', () => ({ value: { command: 'tokens' } }))
  on('ui.open', (_$, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.blit', (_$, e) => {
    if (w.blitDeny) return { value: { deny: 'not mounted' } }
    if ('cells' in e) w.blits.push({ key: e.key, columns: e.columns ?? -1, rows: e.rows ?? -1 })
    return { value: {} }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    w.logs.push({ text: e.text, to: e.to })
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('classic.SessionStart', () => w.classicAnswer)
  on('classic.PostCompact', () => ({}))
  on('tool.call', (_$, e) => {
    w.seenTool.push(e)
    return w.toolAnswer(e)
  })
  on('turn.step', async function* (_$, e) {
    w.seenStep.push(e)
    const s = w.steps.shift() ?? { chunks: [], result: { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null } }
    for (const c of s.chunks) yield c
    return s.result
  })
  return w
}

export async function drain<C, R>(s: AsyncGenerator<C, R> & { result: Promise<R> }) {
  const chunks: C[] = []
  for (;;) {
    const r = await s.next()
    if (r.done) return { chunks, result: r.value, settled: await s.result }
    chunks.push(r.value)
  }
}

/** A /tokens run as the engine raises it: the person pressed Enter in the composer. */
export const cmd = (args: string) => ({
  command: 'tokens', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 },
})

export const START = { cwd: '/w', surface: 'terminal' as const, isInteractive: true }
export const STEP = { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 }
export const CHUNKS: TurnStepChunk[] = [
  { kind: 'text', index: 0, text: 'Hello' },
  { kind: 'tool', index: 1, id: 'tu_1', name: 'Read' },
  { kind: 'input', index: 1, json: '{"file_path":"/a.ts"}' },
  { kind: 'stop', stopReason: 'tool_use', usage: usage(10, 20_000, 500, 40) },
]
export const STEP_RESULT: TurnStepResult = {
  turnId: 't1', index: 0, answer: 'Hello',
  toolUses: [{ name: 'Read', input: { file_path: '/a.ts' } }],
  stopReason: 'tool_use', usage: usage(10, 20_000, 500, 40),
}

