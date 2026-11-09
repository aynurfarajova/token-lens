// Mod-kit tests for the observe-only contract: the plugin's hooks run in the
// engine's own host; the test's hooks beneath stand for the engine.

import { expect, test } from 'claude-code/testing'
import type { ToolCallResult, TurnStepResult } from 'claude-code'

import { CHUNKS, START, STEP, STEP_RESULT, cmd, drain, usage, world } from './world'

test('tool.call passes the input down unchanged and returns the result unchanged', async ($, on) => {
  const w = world(on)
  const answer: ToolCallResult = { result: { stdout: 'a\nb' }, text: 'a\nb' }
  w.toolAnswer = () => answer
  await $.session.start(START)
  const r = await $.tool.call({ tool: 'Bash', command: 'ls -la', description: 'list' })
  expect(r).toEqual(answer)
  expect(w.seenTool[0]).toMatchObject({ tool: 'Bash', command: 'ls -la', description: 'list' })
})

test('tool.call passes errored and denied results through unchanged', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const errored: ToolCallResult = { isError: true, result: 'boom', text: 'boom' }
  w.toolAnswer = () => errored
  expect(await $.tool.call({ tool: 'Read', file_path: '/x.ts' })).toEqual(errored)
  w.toolAnswer = () => ({ deny: 'nope' })
  expect(await $.tool.call({ tool: 'Edit', file_path: '/x.ts', old_string: 'a', new_string: 'b' })).toEqual({ deny: 'nope' })
})

test('turn.step forwards every chunk and the result unchanged; the request is untouched', async ($, on) => {
  const w = world(on)
  w.steps.push({ chunks: CHUNKS, result: STEP_RESULT })
  await $.session.start(START)
  const { chunks, result } = await drain($.turn.step({ ...STEP, effort: 'high' }))
  expect(chunks).toEqual(CHUNKS)
  expect(result).toEqual(STEP_RESULT)
  expect(w.seenStep[0]).toMatchObject({ ...STEP, effort: 'high' })
})

test('turn.step with no usage (interrupted) still passes through', async ($, on) => {
  world(on)
  await $.session.start(START)
  const { result } = await drain($.turn.step({ ...STEP, index: 1 }))
  expect(result).toEqual({ turnId: 't1', index: 1, answer: '', toolUses: [], stopReason: null, usage: null })
})

test('every other hook returns what the engine returned', async ($, on) => {
  const w = world(on)
  w.classicAnswer = { additionalContext: ['from-settings-hook'] }
  expect(await $.session.start({ cwd: '/w', surface: null, isInteractive: false })).toEqual({ cwd: '/w' })
  expect(await $.turn.start({ text: 'hi', turnId: 't9' })).toEqual({ turnId: 't9' })
  expect(await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't9', reason: 'answer' })).toEqual({ text: 'done' })
  expect(await $.session.measure({ context: { window: 1_000_000, tokens: 50_000, percent: 5 }, rateLimits: [], changed: ['context'] })).toEqual({ changed: ['context'] })
  expect(await $.classic.SessionStart({ source: 'resume', prompt_cache_likely_expired: true, context_tokens: 40_000 })).toEqual({ additionalContext: ['from-settings-hook'] })
  expect(await $.classic.PostCompact({ trigger: 'manual', compact_summary: 'x' })).toEqual({})
  expect(await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })).toEqual({ sessionId: 's1' })
})

test('an internal failure changes nothing and is logged once, without its message', async ($, on) => {
  const w = world(on, { ownClock: true })
  const answer: ToolCallResult = { result: { ok: true }, text: 'ok' }
  w.toolAnswer = () => answer
  w.steps.push({ chunks: CHUNKS, result: STEP_RESULT })
  await $.session.start(START)
  w.clockBroken = true // every analysis now throws inside its guard
  for (let i = 0; i < 5; i += 1) expect(await $.tool.call({ tool: 'Bash', command: 'true' })).toEqual(answer)
  const { chunks, result } = await drain($.turn.step(STEP))
  expect(chunks).toEqual(CHUNKS)
  expect(result).toEqual(STEP_RESULT)
  const shown = w.logs.filter(l => l.to !== 'debug')
  expect(shown).toHaveLength(1)
  expect(shown[0]!.text).toContain('Claude Code is unaffected')
  expect(shown[0]!.text).not.toContain('clock exploded')
})

test('a broken store at session start leaves the session start unchanged', async ($, on) => {
  const w = world(on, { ownStore: true })
  w.storeBroken = true
  expect(await $.session.start(START)).toEqual({ cwd: '/w' })
  expect(w.logs.filter(l => l.to !== 'debug')).toHaveLength(1)
})

test('/tokens answers with no text (nothing reaches the model) and confirms by toast', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const r = await $.command.run(cmd('mute'))
  expect(r.text).toBeUndefined()
  expect(r.context).toBeUndefined()
  expect(w.toasts).toEqual(['Token lens toasts muted.'])
  await $.command.run(cmd('lang az'))
  expect(w.toasts[1]).toBe('Token lens dili: Azərbaycan dili.')
  await $.command.run(cmd('bogus'))
  expect(w.toasts[2]).toContain('/tokens')
})

test('the stored data holds counts only: no paths, no arguments, no output', async ($, on) => {
  const w = world(on, { ownStore: true })
  w.toolAnswer = () => ({ result: {}, text: 'SECRET_OUTPUT_TEXT' })
  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', command: 'echo SECRET_ARG' })
  await $.tool.call({ tool: 'Read', file_path: '/home/me/secret-dir/keys.txt' })
  await $.command.run(cmd('mute'))
  await $.session.end({ reason: 'other', sessionId: 's', resume: { id: 's' } })
  const json = JSON.stringify(w.store)
  expect(json).toContain('"Bash"')
  expect(json).toContain('"muted":true')
  expect(json).not.toContain('SECRET')
  expect(json).not.toContain('secret-dir')
  expect(json).not.toContain('keys.txt')
})
