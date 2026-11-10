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

/** A tip is one step per line; empty lines are dropped. */
export function tipSteps(tip: string): string[] {
  return tip.split('\n').map(s => s.trim()).filter(s => s.length > 0)
}

export function hitText(lang: LensLang, hit: HitLike): { message: string; tip: string; steps: string[] } {
  if (!RULE_IDS.has(hit.rule)) return { message: hit.rule, tip: '', steps: [] }
  const def = ruleById(hit.rule as RuleId)
  const params = fmtParams(hit.params)
  const tip = t(lang, tipKey(def.tip, hit.variant), params)
  return { message: t(lang, def.message as StringKey, params), tip, steps: tipSteps(tip) }
}

/** One line for a toast: what happened, then the first step. The Tips tab has the rest. */
export function toastLine(lang: LensLang, hit: HitLike): string {
  const { message, steps } = hitText(lang, hit)
  return steps.length > 0 ? `${message}. ${steps[0]}` : message
}
