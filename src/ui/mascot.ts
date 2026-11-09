// "Lumi", token-lens's mascot: an ORIGINAL character designed for this repo.
// A round teal drop with big 3×3 eyes and an antenna carrying a gold token coin.
// It is deliberately unlike any brand mascot (no orange, no legs, no claws,
// no blocky crab shape) and is not derived from any existing artwork.
//
// Frames are 16×16 pixel grids built in code from one body and per-mood face
// overlays. They render three ways:
//   - terminal: a 16×8 Raster of half blocks (▀/▄), two pixels per cell,
//     animated by $.ui.blit (no re-render);
//   - desktop / vscode / mobile: one SVG whose frames step by SMIL;
//   - everywhere: a text label (mood.* in i18n) beside it.
// Pure: no `$`.

import type { LensMood } from '../../types'

export const SIZE = 16
export const RASTER_COLUMNS = 16
export const RASTER_ROWS = 8

type Px = keyof typeof PALETTE
type Grid = (Px | null)[][]

/** 0x00RRGGBB. */
export const PALETTE = {
  o: 0x1e4d57, // outline
  b: 0x3cc6b4, // body
  l: 0xa8f0e4, // highlight
  w: 0xffffff, // eye white
  p: 0x1b1b2f, // pupil, mouth, closed eye
  c: 0xf28ba8, // cheek
  g: 0xf5c542, // coin
  G: 0xc9971c, // coin edge / dim coin
  r: 0xe5484d, // alarm coin
  s: 0x7cc7ff, // sweat drop
  z: 0xe8e8f0, // sleep bubbles
} as const

export type Sprite = { fps: number; frames: Grid[] }

// ── building blocks ─────────────────────────────────────────────────────

const empty = (): Grid => Array.from({ length: SIZE }, () => Array<Px | null>(SIZE).fill(null))

function inBody(x: number, y: number): boolean {
  const dx = (x + 0.5 - 8) / 7
  const dy = (y + 0.5 - 10.7) / 5.5
  return y >= 5 && dx * dx + dy * dy <= 1
}

function body(): Grid {
  const g = empty()
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (!inBody(x, y)) continue
      const edge = !inBody(x - 1, y) || !inBody(x + 1, y) || !inBody(x, y - 1) || !inBody(x, y + 1)
      g[y]![x] = edge ? 'o' : 'b'
    }
  }
  for (const [x, y] of [[7, 6], [8, 6]] as const) if (g[y]![x] === 'b') g[y]![x] = 'l' // forehead shine
  // antenna stem
  g[3]![7] = 'o'
  g[4]![7] = 'o'
  return g
}

const set = (g: Grid, pts: readonly (readonly [number, number])[], px: Px | null) => {
  for (const [x, y] of pts) if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) g[y]![x] = px
}

function coin(g: Grid, kind: 'full' | 'edge' | 'red' | 'dim', drop = 0) {
  if (kind === 'edge') {
    set(g, [[7, 0 + drop], [7, 1 + drop], [7, 2 + drop]], 'G')
    return
  }
  const face: Px = kind === 'red' ? 'r' : kind === 'dim' ? 'G' : 'g'
  set(g, [[7, 0 + drop], [6, 1 + drop], [8, 1 + drop], [7, 2 + drop]], face)
  set(g, [[7, 1 + drop]], kind === 'full' ? 'G' : face)
}

type EyeLook = 'fwd' | 'upL' | 'upR' | 'wide'
const LEFT = 3
const RIGHT = 10
const EYE_Y = 8

/** 3×3 eyes: white, a 2×2 pupil whose top-left pixel stays white (the sparkle). */
function eyesOpen(g: Grid, look: EyeLook) {
  for (const ex of [LEFT, RIGHT]) {
    for (let dy = 0; dy < 3; dy += 1) for (let dx = 0; dx < 3; dx += 1) set(g, [[ex + dx, EYE_Y + dy]], 'w')
    if (look === 'wide') {
      set(g, [[ex + 1, EYE_Y + 1]], 'p') // tiny pupil: shock
      continue
    }
    // fwd looks slightly inward (toward the viewer); up looks to one side.
    const px = look === 'upL' ? 0 : look === 'upR' ? 1 : ex === LEFT ? 1 : 0
    const py = look === 'fwd' ? 1 : 0
    set(g, [[ex + px + 1, EYE_Y + py], [ex + px, EYE_Y + py + 1], [ex + px + 1, EYE_Y + py + 1]], 'p')
  }
}

/** A blink: lids meet in the middle. */
function eyesBlink(g: Grid) {
  for (const ex of [LEFT, RIGHT]) set(g, [[ex, EYE_Y + 1], [ex + 1, EYE_Y + 1], [ex + 2, EYE_Y + 1]], 'p')
}

/** Asleep: heavy lids, low and curved. */
function eyesAsleep(g: Grid) {
  for (const ex of [LEFT, RIGHT]) set(g, [[ex, EYE_Y + 1], [ex + 1, EYE_Y + 2], [ex + 2, EYE_Y + 1]], 'p')
}

/** Joy: upturned arcs, ^ ^. */
function eyesHappy(g: Grid) {
  for (const ex of [LEFT, RIGHT]) set(g, [[ex + 1, EYE_Y], [ex, EYE_Y + 1], [ex + 2, EYE_Y + 1]], 'p')
}

/** Worry: brows slanting up toward the middle. */
const browsWorried = (g: Grid) => (set(g, [[7, 6], [8, 6]], 'b'), set(g, [[4, 7], [5, 7], [6, 6], [11, 7], [10, 7], [9, 6]], 'p')) // no shine under a furrowed brow

const mouthSmile = (g: Grid) => set(g, [[6, 12], [7, 13], [8, 13], [9, 12]], 'p') // ‿
const mouthGrin = (g: Grid) => (set(g, [[5, 12], [6, 12], [7, 12], [8, 12], [9, 12], [10, 12], [6, 13], [9, 13]], 'p'), set(g, [[7, 13], [8, 13]], 'c'))
const mouthHmm = (g: Grid) => set(g, [[8, 12], [9, 12]], 'p') // a sideways "hmm"
const mouthFrown = (g: Grid) => set(g, [[7, 12], [8, 12], [6, 13], [9, 13]], 'p') // ︵
const mouthOpen = (g: Grid) => set(g, [[7, 12], [8, 12], [7, 13], [8, 13]], 'p') // O
const mouthSnore = (g: Grid) => set(g, [[8, 13]], 'p')
const cheeks = (g: Grid) => set(g, [[3, 11], [12, 11]], 'c')

function shift(g: Grid, dx: number): Grid {
  const out = empty()
  for (let y = 0; y < SIZE; y += 1) for (let x = 0; x < SIZE; x += 1) {
    const nx = x + dx
    if (nx >= 0 && nx < SIZE) out[y]![nx] = g[y]![x]!
  }
  return out
}

function frame(build: (g: Grid) => void): Grid {
  const g = body()
  build(g)
  return g
}

// ── the moods ──────────────────────────────────────────────────────────

export const SPRITES: Record<LensMood, Sprite> = {
  idle: {
    fps: 2,
    frames: [
      frame(g => (coin(g, 'full'), eyesOpen(g, 'fwd'), mouthSmile(g))),
      frame(g => (coin(g, 'full'), eyesOpen(g, 'fwd'), mouthSmile(g))),
      frame(g => (coin(g, 'full'), eyesOpen(g, 'fwd'), mouthSmile(g))),
      frame(g => (coin(g, 'full'), eyesBlink(g), mouthSmile(g))),
    ],
  },
  happy: {
    fps: 3,
    frames: [
      frame(g => (coin(g, 'full'), eyesHappy(g), mouthGrin(g), cheeks(g))),
      frame(g => (set(g, [[7, 3]], null), coin(g, 'full', 1), eyesHappy(g), mouthGrin(g), cheeks(g))),
    ],
  },
  thinking: {
    fps: 4,
    frames: [
      frame(g => (coin(g, 'full'), eyesOpen(g, 'upL'), mouthHmm(g))),
      frame(g => (coin(g, 'edge'), eyesOpen(g, 'upL'), mouthHmm(g))),
      frame(g => (coin(g, 'full'), eyesOpen(g, 'upR'), mouthHmm(g))),
      frame(g => (coin(g, 'edge'), eyesOpen(g, 'upR'), mouthHmm(g))),
    ],
  },
  worried: {
    fps: 3,
    frames: [
      frame(g => (coin(g, 'full'), eyesOpen(g, 'fwd'), browsWorried(g), mouthFrown(g), set(g, [[14, 6], [14, 7]], 's'))),
      frame(g => (coin(g, 'full'), eyesOpen(g, 'fwd'), browsWorried(g), mouthFrown(g), set(g, [[14, 7], [14, 8]], 's'))),
    ],
  },
  alarmed: {
    fps: 6,
    frames: [
      frame(g => (coin(g, 'red'), eyesOpen(g, 'wide'), mouthOpen(g))),
      shift(frame(g => (coin(g, 'full'), eyesOpen(g, 'wide'), mouthOpen(g))), 1),
    ],
  },
  sleepy: {
    fps: 2,
    frames: [
      frame(g => (coin(g, 'dim'), eyesAsleep(g), mouthSnore(g), set(g, [[11, 4]], 'z'))),
      frame(g => (coin(g, 'dim'), eyesAsleep(g), mouthSnore(g), set(g, [[12, 2]], 'z'))),
      frame(g => (coin(g, 'dim'), eyesAsleep(g), mouthSnore(g), set(g, [[13, 0]], 'z'))),
    ],
  },
}

// ── terminal: half-block Raster cells ──────────────────────────────────

const DEFAULT_COLOR = 0x01000000
const UPPER = 0x2580 // ▀
const LOWER = 0x2584 // ▄
const SPACE = 0x20
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard padded base64 (no reliance on host helpers). */
export function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0
    const n = (a << 16) | (b << 8) | c
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? B64[n & 63]! : '='
  }
  return out
}

/** One frame as RasterProps.cells: 16×8 cells of [codePoint, fg, bg], little-endian u32. */
export function rasterCells(g: Grid): string {
  const words = new Uint32Array(RASTER_COLUMNS * RASTER_ROWS * 3)
  let i = 0
  for (let row = 0; row < RASTER_ROWS; row += 1) {
    for (let x = 0; x < RASTER_COLUMNS; x += 1) {
      const top = g[row * 2]![x]
      const bottom = g[row * 2 + 1]![x]
      let cp = SPACE
      let fg = DEFAULT_COLOR
      let bg = DEFAULT_COLOR
      if (top && bottom) {
        cp = UPPER
        fg = PALETTE[top]
        bg = PALETTE[bottom]
      } else if (top) {
        cp = UPPER
        fg = PALETTE[top]
      } else if (bottom) {
        cp = LOWER
        fg = PALETTE[bottom]
      }
      words[i++] = cp
      words[i++] = fg
      words[i++] = bg
    }
  }
  const bytes = new Uint8Array(words.length * 4)
  for (let k = 0; k < words.length; k += 1) {
    const w = words[k]!
    bytes[k * 4] = w & 0xff
    bytes[k * 4 + 1] = (w >>> 8) & 0xff
    bytes[k * 4 + 2] = (w >>> 16) & 0xff
    bytes[k * 4 + 3] = (w >>> 24) & 0xff
  }
  return base64(bytes)
}

/** Every frame of every mood, encoded once at load. */
export const RASTERS: Record<LensMood, string[]> = Object.fromEntries(
  (Object.keys(SPRITES) as LensMood[]).map(m => [m, SPRITES[m].frames.map(rasterCells)]),
) as Record<LensMood, string[]>

/** Which frame a free-running 8-ticks-per-second clock is on for a mood. */
export function frameAt(mood: LensMood, tick: number): number {
  const s = SPRITES[mood]
  return Math.floor((tick * s.fps) / 8) % s.frames.length
}

export const ANIMATION_TICK_MS = 125 // 8 ticks a second: no mood runs faster

// ── desktop / vscode / mobile: SVG with SMIL frames ────────────────────

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`

function frameRects(g: Grid): string {
  let out = ''
  for (let y = 0; y < SIZE; y += 1) {
    let x = 0
    while (x < SIZE) {
      const px = g[y]![x]
      if (!px) {
        x += 1
        continue
      }
      let w = 1
      while (x + w < SIZE && g[y]![x + w] === px) w += 1
      out += `<rect x="${x}" y="${y}" width="${w}" height="1" fill="${hex(PALETTE[px])}"/>`
      x += w
    }
  }
  return out
}

/** The mood's sprite as one SVG; frames step by SMIL unless `animate` is false. */
export function mascotSvg(mood: LensMood, animate = true): string {
  const s = SPRITES[mood]
  const n = animate ? s.frames.length : 1
  const dur = (s.frames.length / s.fps).toFixed(3)
  const keyTimes = Array.from({ length: n }, (_, i) => (i / n).toFixed(4)).join(';')
  let groups = ''
  for (let i = 0; i < n; i += 1) {
    const values = Array.from({ length: n }, (_, k) => (k === i ? '1' : '0')).join(';')
    const anim = n > 1
      ? `<animate attributeName="opacity" values="${values}" keyTimes="${keyTimes}" dur="${dur}s" calcMode="discrete" repeatCount="indefinite"/>`
      : ''
    groups += `<g opacity="${i === 0 ? 1 : 0}">${anim}${frameRects(s.frames[i]!)}</g>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="64" height="64" shape-rendering="crispEdges">${groups}</svg>`
}
