import type { Lang } from '../core/config'
import { az } from './az'
import { en, type StringKey } from './en'

export type { StringKey }

const TABLES: Record<Lang, Record<StringKey, string>> = { en, az }

export function hasKey(key: string): key is StringKey {
  return Object.prototype.hasOwnProperty.call(en, key)
}

/** Looks up `key` in `lang` (English fallback) and fills `{param}` placeholders. */
export function t(lang: Lang, key: StringKey, params: Readonly<Record<string, string | number>> = {}): string {
  const template = TABLES[lang]?.[key] ?? en[key] ?? key
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m,
  )
}

/** The i18n key of a rule's tip, honouring its variant when one exists. */
export function tipKey(base: string, variant?: string): StringKey {
  const k = variant ? `${base}.${variant}` : base
  if (hasKey(k)) return k
  if (hasKey(base)) return base
  return `${base}.other` as StringKey
}
