import { expect, test } from 'claude-code/testing'

import { MOODS } from '../src/core/mood'
import { PALETTE, RASTERS, RASTER_COLUMNS, RASTER_ROWS, SIZE, SPRITES, base64, frameAt, mascotSvg } from '../src/ui/mascot'
import { START, STEP, STEP_RESULT, cmd, drain, usage, world } from './world'

function decode(b64: string): number[] {
  const bin = atob(b64)
  const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0))
  const words: number[] = []
  for (let i = 0; i < bytes.length; i += 4) words.push((bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24)) >>> 0)
  return words
}

test('every mood has 2-4 frames of 16×16 palette pixels at ≤ 8 fps', async () => {
  for (const mood of MOODS) {
    const s = SPRITES[mood]
    expect(s.frames.length).toBeGreaterThanOrEqual(2)
    expect(s.frames.length).toBeLessThanOrEqual(4)
    expect(s.fps).toBeGreaterThan(0)
    expect(s.fps).toBeLessThanOrEqual(8)
    for (const f of s.frames) {
      expect(f).toHaveLength(SIZE)
      for (const row of f) {
        expect(row).toHaveLength(SIZE)
        for (const px of row) if (px !== null) expect(Object.keys(PALETTE)).toContain(px)
      }
    }
  }
})

test('the moods look different from each other', async () => {
  const firsts = MOODS.map(m => JSON.stringify(SPRITES[m].frames[0]))
  expect(new Set(firsts).size).toBe(MOODS.length)
})

test('base64 matches the standard alphabet and padding', async () => {
  expect(base64(new Uint8Array([77, 97, 110]))).toBe('TWFu')
  expect(base64(new Uint8Array([77, 97]))).toBe('TWE=')
  expect(base64(new Uint8Array([77]))).toBe('TQ==')
  const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) & 255)
  expect(base64(bytes)).toBe(btoa(String.fromCharCode(...bytes)))
})

test('raster cells: 16×8 half blocks, colors from the palette or the terminal default', async () => {
  const colors = new Set<number>([...Object.values(PALETTE), 0x01000000])
  for (const mood of MOODS) {
    for (const cells of RASTERS[mood]) {
      const words = decode(cells)
      expect(words).toHaveLength(RASTER_COLUMNS * RASTER_ROWS * 3)
      for (let i = 0; i < words.length; i += 3) {
        expect([0x20, 0x2580, 0x2584]).toContain(words[i])
        expect(colors.has(words[i + 1]!)).toBe(true)
        expect(colors.has(words[i + 2]!)).toBe(true)
      }
    }
  }
})

test('frameAt steps each mood at its own fps on the 8 Hz clock', async () => {
  // idle: 4 frames at 2 fps → a new frame every 4 ticks.
  expect([0, 1, 2, 3, 4, 8, 12, 16].map(t => frameAt('idle', t))).toEqual([0, 0, 0, 0, 1, 2, 3, 0])
  for (const mood of MOODS) {
    let changes = 0
    for (let t = 1; t <= 8; t += 1) if (frameAt(mood, t) !== frameAt(mood, t - 1)) changes += 1
    expect(changes).toBeLessThanOrEqual(8)
    expect(changes).toBeLessThanOrEqual(SPRITES[mood].fps)
  }
})

test('svg: one group per frame, SMIL only when animating, small', async () => {
  for (const mood of MOODS) {
    const svg = mascotSvg(mood)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.length).toBeLessThan(131_072)
    expect(svg.split('<g ').length - 1).toBe(SPRITES[mood].frames.length)
    expect(svg).toContain('<animate')
    expect(svg).not.toContain('<script')
    const still = mascotSvg(mood, false)
    expect(still.split('<g ').length - 1).toBe(1)
    expect(still).not.toContain('<animate')
  }
})

// ── through the engine ──────────────────────────────────────────────────

const PANE = {
  plugin: 'token-lens',
  component: 'Pane',
  requestId: 'token-lens',
  props: { title: 'Token lens', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('the pane draws a Raster on the terminal and an SVG elsewhere, always with words', async ($, on) => {
  world(on)
  await $.session.start(START)
  await $.command.run(cmd(''))
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const raster = await term.find({ type: 'Raster' })
  expect(raster?.key).toBe('mascot')
  expect(raster?.props.columns).toBe(16)
  expect(raster?.props.rows).toBe(8)
  expect(await term.find({ type: 'Text', text: /idle/ })).toBeDefined()
  await term.unmount()
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const svg = await ui.find({ type: 'Svg' })
    expect(String(svg?.props.alt)).toContain('idle')
    expect(String(svg?.props.source)).toContain('<animate')
    expect(await ui.find({ type: 'Text', text: /Lumi/ })).toBeDefined()
    await ui.unmount()
  }
})

test('terminal animation: frames by blit at the mood rate; stops itself when refused', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.command.run(cmd(''))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await w.clock!.advance(4_000) // idle: 2 fps
  const painted = w.blits.length
  expect(painted).toBeGreaterThanOrEqual(6)
  expect(painted).toBeLessThanOrEqual(10)
  expect(w.blits.every(b => b.key === 'mascot' && b.columns === 16 && b.rows === 8)).toBe(true)
  // The pane goes away: blits are refused, and the animator gives up.
  w.blitDeny = true
  await w.clock!.advance(4_000)
  const stopped = w.blits.length
  w.blitDeny = false
  await w.clock!.advance(10_000)
  expect(w.blits.length).toBe(stopped)
  await ui.unmount()
})

test('a busier mood animates faster, still ≤ 8 blits a second', async ($, on) => {
  const w = world(on)
  w.steps.push({ chunks: [], result: { ...STEP_RESULT, usage: usage(10, 0, 180_000, 40) } }) // 90% of 200k: alarmed
  await $.session.start(START)
  await drain($.turn.step(STEP))
  await $.command.run(cmd(''))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await w.clock!.advance(2_000)
  expect(w.blits.length).toBeGreaterThanOrEqual(8)
  expect(w.blits.length).toBeLessThanOrEqual(16)
  await ui.unmount()
})

test('animation off: a still frame, no blits, no SMIL', { options: { animation: false } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.command.run(cmd(''))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await w.clock!.advance(5_000)
  expect(w.blits).toEqual([])
  await ui.unmount()
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(String((await desk.find({ type: 'Svg' }))?.props.source)).not.toContain('<animate')
  await desk.unmount()
})
