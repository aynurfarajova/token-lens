// The one-line band above the prompt: face, mood word, context %, last warning.

import type { LensView } from '../../types'
import { percent } from '../core/format'
import { t } from '../i18n/index'
import { FACE } from './faces'
import { ctxColor, SEV_COLOR, type UiEls } from './pane'
import { hitText } from './text'

export function bandTree(E: Pick<UiEls, 'Box' | 'Text'>, v: LensView) {
  const { Box, Text } = E
  const L = v.lang
  const ratio = v.ctx === null ? null : v.ctx / v.window
  const w = v.lastWarning
  return (
    <Box flexDirection="row">
      <Text wrap="truncate">
        {FACE[v.mood]} <Text dimColor>{t(L, `mood.${v.mood}`)}</Text>
        {' · '}
        <Text color={ctxColor(v)}>{t(L, 'band.ctx', { percent: percent(ratio) })}</Text>
        {v.windowKnown ? '' : '*'}
        {w ? (
          <Text>
            {' · '}
            <Text color={SEV_COLOR[w.severity]}>{t(L, `sev.${w.severity}`)}:</Text> {hitText(L, w).message}
          </Text>
        ) : null}
      </Text>
    </Box>
  )
}
