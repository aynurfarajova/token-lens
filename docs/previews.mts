// Renders README previews of Lumi from the mod's own sprites.
// Usage, from the repo root: node docs/previews.mts .
// Needs Node 22.18+ (it imports src/ui/mascot.ts directly). Not part of the mod.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = resolve(process.argv[2] ?? '.')
const { mascotSvg } = await import(pathToFileURL(join(repo, 'src/ui/mascot.ts')).href)

const MOODS = ['idle', 'happy', 'thinking', 'worried', 'alarmed', 'sleepy'] as const
const out = join(repo, 'docs')
mkdirSync(join(out, 'lumi'), { recursive: true })

/** The sprite's inner groups, to nest inside a bigger picture. */
const inner = (mood: string) => (mascotSvg(mood, true) as string).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')
const sprite = (mood: string, x: number, y: number, size: number) =>
  `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges">${inner(mood)}</svg>`

// One file per mood, large and pixel-crisp.
for (const m of MOODS) {
  writeFileSync(join(out, 'lumi', `${m}.svg`), (mascotSvg(m, true) as string).replace('width="64" height="64"', 'width="128" height="128"') + '\n')
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const C = { bg: '#14161f', panel: '#1c1f2b', line: '#2c3142', text: '#e6e8ef', dim: '#8a90a6', teal: '#3cc6b4', ok: '#4cc38a', warn: '#f5c542', bad: '#e5484d', tab: '#2a6f68' }
const FONT = `font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"`

function tabs(x: number, y: number, active: number, tips: number) {
  const names = ['1 Live', '2 Tools', `3 Tips (${tips})`]
  let s = ''
  let cx = x
  names.forEach((n, i) => {
    const w = n.length * 8.4 + 20
    s += `<rect x="${cx}" y="${y}" width="${w}" height="24" rx="6" fill="${i === active ? C.tab : C.panel}" stroke="${C.line}"/>`
    s += `<text x="${cx + 10}" y="${y + 16.5}" font-size="13" fill="${i === active ? '#fff' : C.dim}" ${FONT}>${esc(n)}</text>`
    cx += w + 8
  })
  return s
}

function card(w: number, h: number, body: string, title: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" rx="14" fill="${C.bg}"/>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="14" fill="none" stroke="${C.line}"/>
<circle cx="22" cy="20" r="5" fill="#ff5f57"/><circle cx="40" cy="20" r="5" fill="#febc2e"/><circle cx="58" cy="20" r="5" fill="#28c840"/>
<text x="${w / 2}" y="24" text-anchor="middle" font-size="13" fill="${C.dim}" ${FONT}>${esc(title)}</text>
<line x1="0" y1="38" x2="${w}" y2="38" stroke="${C.line}"/>
${body}
</svg>
`
}

// Live tab: Lumi, the conversation bar, and the last message in plain words.
{
  const W = 820
  const H = 356
  let b = tabs(28, 56, 0, 2)
  b += `<rect x="28" y="100" width="148" height="148" rx="12" fill="${C.panel}" stroke="${C.line}"/>`
  b += sprite('happy', 38, 110, 128)
  b += `<text x="102" y="272" text-anchor="middle" font-size="15" font-weight="700" fill="${C.text}" ${FONT}>Lumi</text>`
  b += `<text x="102" y="292" text-anchor="middle" font-size="13" fill="${C.dim}" ${FONT}>[^‿^] efficient</text>`
  const x = 210
  let y = 112
  const line = (s: string, color = C.text, bold = false, size = 14) => {
    b += `<text x="${x}" y="${y}" font-size="${size}" ${bold ? 'font-weight="700"' : ''} fill="${color}" ${FONT}>${esc(s)}</text>`
    y += 22
  }
  line('How full the conversation is', C.text, true)
  const barW = 340
  b += `<rect x="${x}" y="${y - 13}" width="${barW}" height="12" rx="6" fill="${C.panel}" stroke="${C.line}"/>`
  b += `<rect x="${x}" y="${y - 13}" width="${barW * 0.52}" height="12" rx="6" fill="${C.ok}"/>`
  b += `<text x="${x + barW + 12}" y="${y - 2}" font-size="14" fill="${C.ok}" ${FONT}>52%</text>`
  y += 20
  line('104k / 200k', C.dim)
  line('The fuller it gets, the more every message costs.', C.dim, false, 13)
  y += 12
  line('Last message: 105k tokens in total', C.text, true)
  line('• Reused from the saved part (cheap): 104k')
  line('• Saved for the next messages: 259')
  line('• New text (your message, results): 2')
  line('• Claude’s answer: 705')
  line('Reused share: 99% (good)', C.ok)
  writeFileSync(join(out, 'preview-live.svg'), card(W, H, b, 'Token lens'))
}

// Tips tab: a warning with numbered, safe steps.
{
  const W = 820
  const H = 300
  let b = tabs(28, 56, 2, 2)
  b += `<rect x="28" y="100" width="84" height="84" rx="10" fill="${C.panel}" stroke="${C.line}"/>`
  b += sprite('worried', 34, 106, 72)
  const x = 136
  let y = 116
  const line = (s: string, color = C.text, size = 14) => {
    b += `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" ${FONT}>${esc(s)}</text>`
    y += 22
  }
  b += `<text x="${x}" y="${y}" font-size="14" font-weight="700" fill="${C.warn}" ${FONT}>[warning]</text>`
  b += `<text x="${x + 88}" y="${y}" font-size="14" fill="${C.text}" ${FONT}>3 errors in a row</text>`
  y += 28
  line('1. Press Esc to stop Claude so it does not repeat the same mistake.')
  line('2. Look at the error and tell Claude in one sentence what you expect.')
  line('3. Ask: "Before you continue, explain the cause of the error."')
  line('4. If turning off tests or skipping checks is suggested to hide')
  b += `<text x="${x + 26}" y="${y}" font-size="14" fill="${C.text}" ${FONT}>the error, say no.</text>`
  y += 22
  y += 10
  b += `<rect x="${x}" y="${y - 16}" width="76" height="24" rx="6" fill="${C.panel}" stroke="${C.line}"/>`
  b += `<text x="${x + 10}" y="${y + 0.5}" font-size="13" fill="${C.dim}" ${FONT}>Dismiss</text>`
  writeFileSync(join(out, 'preview-tips.svg'), card(W, H, b, 'Token lens'))
}

// The band above the prompt.
{
  const W = 820
  const H = 64
  const s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" rx="12" fill="${C.bg}"/>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="none" stroke="${C.line}"/>
<text x="20" y="38" font-size="14" ${FONT} fill="${C.text}">[•︵•] <tspan fill="${C.dim}">warning</tspan> · <tspan fill="${C.ok}">ctx 52%</tspan> · <tspan fill="${C.warn}">warning:</tspan> app.ts read 3× with no edit in between</text>
</svg>
`
  writeFileSync(join(out, 'preview-band.svg'), s)
}
console.log('ok')
