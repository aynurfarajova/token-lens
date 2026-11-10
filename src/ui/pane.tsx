// The /tokens pane: Live / Tools / Tips. A pure function of the view: the
// render hook hands in the surface's element table and the press handlers
// (closures over `$`, which never leaves the hook).

import type { Elements } from 'claude-code'
import type { LensLang, LensTab, LensView } from '../../types'
import { compact, estimate, percent } from '../core/format'
import { bar } from '../core/view'
import { hasKey, t } from '../i18n/index'
import { FACE } from './faces'
import { RASTERS, RASTER_COLUMNS, RASTER_ROWS, mascotSvg } from './mascot'
import { hitText } from './text'

export type UiEls = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'> & {
  /** Terminal only: the sprite as half-block cells, animated by $.ui.blit. */
  Raster?: Elements['terminal']['Raster']
  /** Desktop, vscode, mobile: the sprite as an SVG stepping by SMIL. */
  Svg?: Elements['desktop']['Svg']
}

export const MASCOT_KEY = 'mascot'

/** The mascot for the surface at hand, and always its words beside it. */
function mascot(E: UiEls, v: LensView) {
  const { Box, Text, Raster, Svg } = E
  const label = t(v.lang, `mood.${v.mood}`)
  const sprite = Raster ? (
    <Raster key={MASCOT_KEY} columns={RASTER_COLUMNS} rows={RASTER_ROWS} cells={RASTERS[v.mood][0]!} />
  ) : Svg ? (
    <Svg source={mascotSvg(v.mood, v.animate)} alt={`Lumi: ${label}`} width={64} height={64} />
  ) : null
  return (
    <Box flexDirection="row" gap={2} alignItems="center">
      {sprite}
      <Box flexDirection="column">
        <Text bold>Lumi</Text>
        <Text>
          {FACE[v.mood]} <Text dimColor>{label}</Text>
        </Text>
      </Box>
    </Box>
  )
}
export type PaneHandlers = { tab: (tab: LensTab) => void; dismiss: (key: string) => void }

export const TABS: readonly LensTab[] = ['live', 'tools', 'tips']

/** Severity is spelled out, and colored: color is never the only signal. */
export const SEV_COLOR = { info: 'subtle', warn: 'warning', strong: 'error' } as const

export function ctxColor(v: Pick<LensView, 'ctx' | 'window' | 'contextWarn' | 'contextStrong'>): 'success' | 'warning' | 'error' | 'subtle' {
  if (v.ctx === null) return 'subtle'
  const r = v.ctx / v.window
  return r >= v.contextStrong ? 'error' : r >= v.contextWarn ? 'warning' : 'success'
}

/** A plain word for how much of the last request was reused from the saved part. */
export function hitGrade(ratio: number | null): 'good' | 'ok' | 'low' | null {
  if (ratio === null || !Number.isFinite(ratio)) return null
  return ratio >= 0.8 ? 'good' : ratio >= 0.5 ? 'ok' : 'low'
}

/** "Read (read file)": the tool's own name first, then a plain word when there is one. */
export function toolName(lang: LensLang, tool: string): string {
  const key = `tool.${tool}`
  return hasKey(key) ? `${tool} (${t(lang, key)})` : tool
}

function live(E: UiEls, v: LensView, cols: number) {
  const { Box, Text } = E
  const L = v.lang
  const ratio = v.ctx === null ? null : v.ctx / v.window
  const tot = (x: LensView['session']['main']) => ({
    requests: x.requests,
    total: compact(x.input + x.cacheRead + x.cacheCreation + x.output),
    read: compact(x.cacheRead),
  })
  const grade = v.last === null ? null : hitGrade(v.last.hitRatio)
  return (
    <Box flexDirection="column" gap={1}>
      {mascot(E, v)}
      <Box flexDirection="column">
        <Text bold>{t(L, 'live.context')}</Text>
        <Text color={ctxColor(v)} wrap="truncate">
          {bar(ratio, Math.min(40, cols - 22))} {percent(ratio)}
        </Text>
        <Text dimColor wrap="truncate">
          {v.ctx === null ? '–' : compact(v.ctx)} / {compact(v.window)}
          {v.windowKnown ? '' : t(L, 'label.assumed')}
        </Text>
        <Text dimColor wrap="wrap">{t(L, 'live.contextHint')}</Text>
      </Box>
      {v.last === null ? (
        <Text dimColor>{t(L, 'live.none')}</Text>
      ) : (
        <Box flexDirection="column">
          <Text bold>
            {t(L, 'live.last', { total: compact(v.last.input + v.last.cacheRead + v.last.cacheCreation + v.last.output) })}
          </Text>
          <Text wrap="wrap">{t(L, 'live.lastRead', { read: compact(v.last.cacheRead) })}</Text>
          <Text wrap="wrap">{t(L, 'live.lastWrite', { write: compact(v.last.cacheCreation) })}</Text>
          <Text wrap="wrap">{t(L, 'live.lastInput', { input: compact(v.last.input) })}</Text>
          <Text wrap="wrap">{t(L, 'live.lastOutput', { output: compact(v.last.output) })}</Text>
          {grade === null ? null : (
            <Text color={grade === 'good' ? 'success' : grade === 'ok' ? 'warning' : 'error'}>
              {t(L, 'live.hit', { hit: percent(v.last.hitRatio), grade: t(L, `live.hit.${grade}`) })}
            </Text>
          )}
        </Box>
      )}
      <Box flexDirection="column">
        <Text bold>{t(L, v.turn.isRunning ? 'live.turnRunning' : 'live.turnLast')}</Text>
        <Text>{t(L, 'live.turnLine', { main: compact(v.turn.main), sub: compact(v.turn.sub) })}</Text>
      </Box>
      <Box flexDirection="column">
        <Text bold>{t(L, 'live.session')}</Text>
        <Text wrap="wrap">{t(L, 'live.sessionMain', tot(v.session.main))}</Text>
        {v.session.sub.requests > 0 ? <Text wrap="wrap">{t(L, 'live.sessionSub', tot(v.session.sub))}</Text> : null}
      </Box>
      <Box flexDirection="column">
        <Text dimColor wrap="wrap">
          {v.ttlKnown ? t(L, 'live.ttlKnown', { ttl: `${v.ttlMinutes} ${L === 'az' ? 'dəq' : 'min'}` }) : t(L, 'live.ttlAssumed')}
        </Text>
        {v.windowKnown ? null : <Text dimColor>{t(L, 'live.windowAssumed')}</Text>}
        {v.muted ? <Text dimColor>{t(L, 'live.muted')}</Text> : null}
      </Box>
    </Box>
  )
}

function tools(E: UiEls, v: LensView, cols: number) {
  const { Box, Text } = E
  const L = v.lang
  const nameW = Math.max(8, Math.min(24, cols - 30))
  const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
  if (v.tools.length === 0) return <Text dimColor>{t(L, 'tools.none')}</Text>
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>{t(L, 'tools.title')}</Text>
        {v.tools.map(row => (
          <Text key={`tool-${row.tool}`} mono wrap="truncate">
            {pad(toolName(L, row.tool), nameW)} {estimate(row.estTokens).padStart(7)}{'  '}
            <Text dimColor>{t(L, 'tools.row', { calls: row.calls, errors: row.errors })}</Text>
          </Text>
        ))}
      </Box>
      <Box flexDirection="column">
        <Text bold>{t(L, 'tools.top')}</Text>
        {v.topCalls.map((c, i) => (
          <Text key={`call-${i}`} mono wrap="truncate">
            {estimate(c.estTokens).padStart(7)}  {toolName(L, c.tool)}
            {c.label ? <Text dimColor> {c.label}</Text> : null}
          </Text>
        ))}
      </Box>
      <Text dimColor wrap="wrap">{t(L, 'tools.note')}</Text>
    </Box>
  )
}

function tips(E: UiEls, v: LensView, on: PaneHandlers) {
  const { Box, Text, Button } = E
  const L = v.lang
  if (v.tips.length === 0) return <Text dimColor>{t(L, 'tips.none')}</Text>
  return (
    <Box flexDirection="column" gap={1}>
      {v.tips.map(tip => {
        const { message, steps } = hitText(L, tip)
        return (
          <Box key={`tip-${tip.key}`} flexDirection="column">
            <Text wrap="wrap">
              <Text color={SEV_COLOR[tip.severity]} bold>[{t(L, `sev.${tip.severity}`)}]</Text> {message}
              {tip.count > 1 ? <Text dimColor> {t(L, 'tips.repeat', { count: tip.count })}</Text> : null}
            </Text>
            {steps.map((step, i) => (
              <Text key={`step-${tip.key}-${i}`} wrap="wrap">
                {steps.length > 1 ? `${i + 1}. ` : ''}
                {step}
              </Text>
            ))}
            <Button key={`dismiss:${tip.key}`} label={t(L, 'tips.dismiss')} onPress={() => on.dismiss(tip.key)} />
          </Box>
        )
      })}
    </Box>
  )
}

export function paneTree(E: UiEls, v: LensView | null, tab: LensTab, cols: number, on: PaneHandlers, lang: LensLang) {
  const { Box, Text, Button } = E
  const L = v?.lang ?? lang
  const labels: Record<LensTab, string> = {
    live: t(L, 'tab.live'),
    tools: t(L, 'tab.tools'),
    tips: t(L, 'tab.tips', { n: v?.tips.length ?? 0 }),
  }
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {TABS.map((id, i) => (
          <Button
            key={`tab-${id}`}
            label={labels[id]}
            hotkey={String(i + 1)}
            variant={id === tab ? 'primary' : 'secondary'}
            onPress={() => on.tab(id)}
          />
        ))}
      </Box>
      {v === null ? (
        <Text dimColor>{t(L, 'live.none')}</Text>
      ) : tab === 'tools' ? (
        tools(E, v, cols)
      ) : tab === 'tips' ? (
        tips(E, v, on)
      ) : (
        live(E, v, cols)
      )}
    </Box>
  )
}
