// token-lens state contract: what the pane and band read through $.state.
// Plain JSON. It holds numbers, tool names and file basenames only: never
// arguments, output, prompts or full paths.

export type LensLang = 'en' | 'az'
export type LensMood = 'idle' | 'happy' | 'thinking' | 'worried' | 'alarmed' | 'sleepy'
export type LensSeverity = 'info' | 'warn' | 'strong'
export type LensTab = 'live' | 'tools' | 'tips'

export type LensTotals = { requests: number; input: number; output: number; cacheRead: number; cacheCreation: number }

export type LensTip = {
  key: string
  rule: string
  severity: LensSeverity
  variant?: string
  params: Record<string, string | number>
  count: number
}

export type LensView = {
  lang: LensLang
  mood: LensMood
  /** Main context in tokens (exact, from the last request); null before one. */
  ctx: number | null
  window: number
  windowKnown: boolean
  /** Context fill ratios that mean warning / strong warning. */
  contextWarn: number
  contextStrong: number
  ttlKnown: boolean
  /** Prompt-cache TTL in minutes (5 assumed unless ttlKnown). */
  ttlMinutes: number
  /** The last main request, exact as the API reported it. */
  last: { input: number; output: number; cacheRead: number; cacheCreation: number; hitRatio: number | null } | null
  /** Exact tokens (context + output) of the running or last turn, by loop. */
  turn: { main: number; sub: number; isRunning: boolean }
  session: { main: LensTotals; sub: LensTotals }
  /** Estimated tokens per tool kind (~). */
  tools: { tool: string; calls: number; estTokens: number; errors: number }[]
  /** Costliest single calls (~): tool kind and basename only. */
  topCalls: { tool: string; label?: string; estTokens: number }[]
  tips: LensTip[]
  lastWarning: LensTip | null
  muted: boolean
  /** Whether the mascot animates (the `animation` option). */
  animate: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'token-lens': {
      view: Shaped<LensView | null>
      tab: LensTab
    }
  }
}
