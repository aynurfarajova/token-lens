// Text faces for the mascot: the band's compact form and the fallback where
// no sprite can be drawn. Each mood also has a word (mood.* in i18n), so
// neither color nor shape is ever the only signal.

import type { LensMood } from '../../types'

export const FACE: Record<LensMood, string> = {
  idle: '[•_•]',
  happy: '[^‿^]',
  thinking: '[•_•]…',
  worried: '[•︵•]',
  alarmed: '[°□°]!',
  sleepy: '[-_-]z',
}
