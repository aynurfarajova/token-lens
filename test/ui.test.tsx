// The pane, the band and the toasts, through the engine's own host, on every
// surface the mod can be drawn on.

import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { START, STEP, STEP_RESULT, cmd, drain, usage, world } from './world'

const PANE = {
  plugin: 'token-lens',
  component: 'Pane',
  requestId: 'token-lens',
  props: { title: 'Token lens', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const BAND = {
  plugin: 'token-lens',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const

const ALL = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const BIG = 'x'.repeat(40_000) // ~10k tokens: over R2's 8k

/** A short session: two main requests and three reads of one file in between. */
async function session($: Engine, w: ReturnType<typeof world>) {
  w.toolAnswer = () => ({ result: {}, text: 'x'.repeat(400) })
  w.steps.push({ chunks: [], result: { ...STEP_RESULT, usage: usage(10, 0, 20_000, 40) } })
  w.steps.push({ chunks: [], result: { ...STEP_RESULT, index: 1, usage: usage(10, 20_010, 400, 40) } })
  await $.session.start(START)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await drain($.turn.step(STEP))
  for (let i = 0; i < 3; i += 1) await $.tool.call({ tool: 'Read', file_path: '/repo/src/app.ts' })
  await drain($.turn.step({ ...STEP, index: 1 }))
}

test('/tokens opens the pane (and only /tokens does)', async ($, on) => {
  const w = world(on)
  await session($, w)
  await w.clock!.advance(60_000)
  expect(w.opened).toEqual([])
  await $.command.run(cmd(''))
  expect(w.opened).toEqual(['token-lens'])
})

test('the pane draws Live, Tools and Tips on every surface', async ($, on) => {
  const w = world(on)
  await session($, w)
  await $.command.run(cmd(''))
  for (const surface of ALL) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // Live: exact numbers, the window labelled as assumed until measured.
    expect(await ui.find({ type: 'Text', text: /How full the conversation is/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /\/ 200k/ }))?.text).toContain('(estimated)')
    expect(await ui.find({ type: 'Text', text: /Last message: 20k tokens in total/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Reused from the saved part \(cheap\): 20k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Saved for the next messages: 400/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /New text \(your message, results\): 10/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Claude’s answer: 40/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Reused share: 98% \(good\)/ })).toBeDefined()
    // Tools: estimates carry "~"; only the basename is shown.
    await ui.press({ key: 'tab-tools' })
    const read = await ui.find({ type: 'Text', text: /^Read/ })
    expect(read?.text).toContain('~')
    expect(await ui.find({ type: 'Text', text: /app\.ts/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\/repo\// })).toBeUndefined()
    // Tips: the repeat read, with its fix, dismissible.
    await ui.press({ key: 'tab-tips' })
    expect(await ui.find({ type: 'Text', text: /app\.ts read 3×/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1\. Tell Claude: .*search for the part you need/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^3\. This changes nothing in the file/ })).toBeDefined()
    await ui.press({ key: 'tab-live' })
    await ui.unmount()
  }
})

test('dismissing a tip removes it', async ($, on) => {
  const w = world(on)
  await session($, w)
  await $.command.run(cmd(''))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-tips' })
  await ui.press({ key: 'dismiss:R1:app.ts' })
  expect(await ui.find({ type: 'Text', text: /app\.ts read/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Nothing to improve/ })).toBeDefined()
  await ui.unmount()
})

test('a measured window replaces the assumed one', async ($, on) => {
  const w = world(on)
  await session($, w)
  await $.session.measure({ context: { window: 1_000_000, tokens: 20_410, percent: 2 }, rateLimits: [], changed: ['context'] })
  await $.command.run(cmd(''))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const line = await ui.find({ type: 'Text', text: /\/ 1\.0M/ })
  expect(line?.text).not.toContain('assumed')
  await ui.unmount()
})

test('the pane follows /tokens lang az', async ($, on) => {
  const w = world(on)
  await session($, w)
  await $.command.run(cmd('lang az'))
  await $.command.run(cmd(''))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Söhbət nə qədər doludur/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Son mesaj: cəmi 20k token/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Yadda saxlanandan təkrar istifadə \(ucuz\): 20k/ })).toBeDefined()
  await ui.press({ key: 'tab-tools' })
  expect(await ui.find({ type: 'Text', text: /^Read \(fayl oxuma\)/ })).toBeDefined()
  await ui.press({ key: 'tab-tips' })
  expect(await ui.find({ type: 'Text', text: /app\.ts faylı 3 dəfə təkrar oxundu/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^1\. Claude-a yazın:/ })).toBeDefined()
  await ui.unmount()
})

test('the band keeps the engine band and adds one line under it', async ($, on) => {
  const w = world(on)
  await session($, w)
  await w.clock!.advance(1_000) // the debounced view write
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
    const line = await ui.find({ type: 'Text', text: /ctx 10%/ })
    expect(line?.text).toContain('warning: app.ts read 3×')
    await ui.unmount()
  }
})

test('the band can be turned off', { options: { band: false } }, async ($, on) => {
  const w = world(on)
  await session($, w)
  await w.clock!.advance(1_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ctx/ })).toBeUndefined()
  await ui.unmount()
})

test('toasts: one per rule per cooldown, at most 5 per session', async ($, on) => {
  const w = world(on)
  w.toolAnswer = () => ({ result: {}, text: BIG })
  await $.session.start(START)
  // Back to back: the second R2 is inside its 10-minute cooldown.
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toContain('show only the errors and the last 50 lines')
  expect(w.toasts[0]).not.toContain('\n') // a toast carries only the first step
  // Past the cooldown each time: capped at 5 for the session.
  for (let i = 0; i < 8; i += 1) {
    await w.clock!.advance(11 * 60_000)
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
  }
  expect(w.toasts).toHaveLength(5)
})

test('toasts: info rules never toast; mute silences the rest', async ($, on) => {
  const w = world(on)
  w.toolAnswer = () => ({ result: {}, text: 'x'.repeat(24_000) }) // ~6k: R3 (info), not R2
  await $.session.start(START)
  await $.tool.call({ tool: 'Read', file_path: '/a/big.ts' })
  expect(w.toasts).toEqual([])
  await $.command.run(cmd('mute'))
  w.toolAnswer = () => ({ result: {}, text: BIG })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(w.toasts).toEqual(['Token lens pop-ups muted.'])
})

test('toasts: none where nothing draws (claude -p)', async ($, on) => {
  const w = world(on)
  w.toolAnswer = () => ({ result: {}, text: BIG })
  await $.session.start({ cwd: '/w', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(w.toasts).toEqual([])
  expect(w.logs.filter(l => l.to !== 'debug')).toEqual([])
})

test('the max-toasts option is honoured', { options: { max_toasts: 1 } }, async ($, on) => {
  const w = world(on)
  w.toolAnswer = () => ({ result: {}, text: BIG })
  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', command: 'a' })
  await $.tool.call({ tool: 'Read', file_path: '/x.ts' }) // R2 again: cooldown
  await w.clock!.advance(11 * 60_000)
  await $.tool.call({ tool: 'Bash', command: 'b' })
  expect(w.toasts).toHaveLength(1)
})
