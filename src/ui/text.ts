// Turns hits and tips into localized lines. Pure.

import type { LensLang } from '../../types'
import { compact } from '../core/format'
import { ruleById, type RuleId } from '../core/rules'
import { t, tipKey, type StringKey } from '../i18n/index'

type HitLike = { rule: string; variant?: string; params: Readonly<Record<string, string | number>> }

const RULE_IDS = new Set(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8'])

/** Token counts are shown compact ("12k"); the message templates add the "~". */
function fmtParams(params: Readonly<Record<string, string | number>>): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(params)) out[k] = k === 'tokens' && typeof v === 'number' ? compact(v) : v
  return out
}

export function hitText(lang: LensLang, hit: HitLike): { message: string; tip: string } {
  if (!RULE_IDS.has(hit.rule)) return { message: hit.rule, tip: '' }
  const def = ruleById(hit.rule as RuleId)
  const params = fmtParams(hit.params)
  return {
    message: t(lang, def.message as StringKey, params),
    tip: t(lang, tipKey(def.tip, hit.variant), params),
  }
}

/** One line for a toast: what happened, then what to do. */
export function toastLine(lang: LensLang, hit: HitLike): string {
  const { message, tip } = hitText(lang, hit)
  return tip ? `${message}. ${tip}` : message
}
