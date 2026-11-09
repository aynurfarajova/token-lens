// token-lens: thin wiring only. Events → core (src/core) → UI (src/ui).
//
// OBSERVE-ONLY CONTRACT
// - tool.call:  `const result = await next(e); analyze; return result` (the
//   very object next resolved, so core uses its own messages verbatim).
// - turn.step:  `const r = yield* next(e); analyze; return r` (chunks untouched).
// - every other hook calls `next(e)` with `e` as received and returns its result;
//   the band draws the engine's own band (next) and adds one line under it.
// - no tool.check / prompt.* / skill.prompt / session.compact hooks, no model,
//   network, process or filesystem calls. Analysis runs inside Guard: an
//   internal error never changes what the engine sees.
// - the pane opens only from /tokens; toasts pass the governor (threshold,
//   per-rule cooldown, session cap, mute).

import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { LensMood, LensTab } from '../types'
import { normalizeConfig, type Lang } from '../src/core/config'
import { Guard } from '../src/core/safe'
import { Tracker, type Output, type SessionSource } from '../src/core/tracker'
import { buildView } from '../src/core/view'
import { t } from '../src/i18n/index'
import { bandTree } from '../src/ui/band'
import { ANIMATION_TICK_MS, RASTERS, RASTER_COLUMNS, RASTER_ROWS, frameAt } from '../src/ui/mascot'
import { MASCOT_KEY, paneTree, type UiEls } from '../src/ui/pane'
import { toastLine } from '../src/ui/text'

export const STORE_KEY = 'aggregates-v1'
export const PREFS_KEY = 'prefs-v1'
export const PANE_ID = 'token-lens'
const TICK_MS = 15_000
const FLUSH_EVERY_TICKS = 4
const VIEW_DEBOUNCE_MS = 250
/** The animator stops itself after this long without one accepted blit. */
const ANIMATION_GIVE_UP_TICKS = 24 // 3 s at 8 ticks a second
const SOURCES: readonly SessionSource[] = ['startup', 'resume', 'clear', 'compact', 'fork']
const TABS: readonly LensTab[] = ['live', 'tools', 'tips']

// Bump the shape tag when LensView's fields change: a reload then declines
// what older code stored.
const viewAtom = atom({ plugin: 'token-lens', key: 'view' } as const, null, { shape: 'view-3' })
const tabAtom = atom({ plugin: 'token-lens', key: 'tab' } as const, 'live')

type Prefs = { language?: Lang; muted?: boolean }

function parsePrefs(v: unknown): Prefs {
  if (!v || typeof v !== 'object') return {}
  const o = v as Record<string, unknown>
  const p: Prefs = {}
  if (o.language === 'en' || o.language === 'az') p.language = o.language
  if (typeof o.muted === 'boolean') p.muted = o.muted
  return p
}

export const register: Register = (on, options) => {
  const cfg = normalizeConfig(options)
  const tracker = new Tracker(cfg)
  const guard = new Guard()
  let lang: Lang = cfg.language
  let prefs: Prefs = {}
  let timer: Timer | undefined
  let ticks = 0
  /** A surface has drawn for this session: toasts have somewhere to go. */
  let sawSurface = false
  /** Where our pane was last drawn: only a terminal pane is animated by blit. */
  let paneSurface: string | null = null
  /** The mood the latest view carries: what the animator steps through. */
  let shownMood: LensMood = 'idle'

  const makeView = (now: number) => {
    const v = buildView(tracker, lang, now)
    shownMood = v.mood
    return v
  }

  // Set in session.start, where `$` is in hand; no-ops until then. `$` is
  // spelled at each call site inside these closures, never passed around.
  let deliver = (_out: Output): void => {}
  let refreshView = (): void => {}
  let startAnimation = (): void => {}

  // ── session lifecycle ────────────────────────────────────────────────

  on('session.start', async ($, e, next) => {
    await guard.run((m, o) => $.ui.log(m, o), async () => {
      sawSurface = sawSurface || e.surface !== null || e.isInteractive
      prefs = parsePrefs(await $.store.get(PREFS_KEY))
      if (prefs.language) lang = prefs.language
      tracker.governor.muted = prefs.muted === true
      tracker.loadBase(await $.store.get(STORE_KEY))

      let viewPending = false
      refreshView = () => {
        if (viewPending) return
        viewPending = true
        $.clock.after(VIEW_DEBOUNCE_MS, () => {
          viewPending = false
          void guard.run((m, o) => $.ui.log(m, o), async () => {
            const now = await $.clock.now()
            await update($, viewAtom, () => makeView(now))
          })
        })
      }

      // The terminal mascot: one 8 Hz timer, a blit only when the frame
      // changes (each mood runs at 2-6 fps), never a re-render. It stops by
      // itself once blits are refused for 3 s: pane closed, another tab,
      // not a terminal.
      let anim: Timer | undefined
      let animTick = 0
      let lastOkTick = 0
      let lastFrame = ''
      startAnimation = () => {
        if (anim || !cfg.animation) return
        lastOkTick = animTick
        lastFrame = ''
        anim = $.clock.every(ANIMATION_TICK_MS, () => {
          animTick += 1
          if (animTick - lastOkTick > ANIMATION_GIVE_UP_TICKS) {
            anim?.cancel()
            anim = undefined
            return
          }
          const mood = shownMood
          const f = frameAt(mood, animTick)
          const frameKey = `${mood}:${f}`
          if (frameKey === lastFrame) {
            lastOkTick = animTick // nothing to paint is not a refusal
            return
          }
          lastFrame = frameKey
          void $.ui
            .blit({ requestId: PANE_ID, key: MASCOT_KEY, columns: RASTER_COLUMNS, rows: RASTER_ROWS, cells: RASTERS[mood][f]! })
            .then(
              r => {
                if (r.deny === undefined) lastOkTick = animTick
                else lastFrame = ''
              },
              () => {
                lastFrame = ''
              },
            )
        })
      }
      deliver = out => {
        if (sawSurface) for (const hit of out.toasts) $.ui.toast(toastLine(lang, hit))
        refreshView()
      }

      await $.command.register({
        name: 'tokens',
        description: t(lang, 'cmd.description'),
        argumentHint: '[mute|unmute|reset|close|lang az|en]',
        immediate: true,
      })
      timer?.cancel()
      timer = $.clock.every(TICK_MS, () => {
        void guard.run((m, o) => $.ui.log(m, o), async () => {
          deliver(tracker.tick(await $.clock.now()))
          ticks += 1
          if (cfg.animation && paneSurface === 'terminal' && (await $.ui.panes()).some(p => p.id === PANE_ID && p.isShown)) startAnimation()
          if (tracker.dirty && ticks % FLUSH_EVERY_TICKS === 0) {
            tracker.dirty = false
            await $.store.set(STORE_KEY, tracker.persisted())
          }
        })
      })
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await guard.run((m, o) => $.ui.log(m, o), async () => {
      tracker.dirty = false
      await $.store.set(STORE_KEY, tracker.persisted())
    })
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    await guard.run((m, o) => $.ui.log(m, o), async () => {
      const source = SOURCES.includes(e.source as SessionSource) ? (e.source as SessionSource) : 'startup'
      if (source === 'clear') guard.resetSession()
      deliver(tracker.sessionStart(source, { cacheLikelyExpired: e.prompt_cache_likely_expired, contextTokens: e.context_tokens }, await $.clock.now()))
    })
    return result
  }).catch(($, e, next) => next(e))

  on('classic.PostCompact', async ($, e, next) => {
    const result = await next(e)
    guard.sync((m, o) => $.ui.log(m, o), () => {
      tracker.compacted()
      refreshView()
    })
    return result
  }).catch(($, e, next) => next(e))

  on('classic.PostModelSwitch', async ($, e, next) => {
    const result = await next(e)
    guard.sync((m, o) => $.ui.log(m, o), () => {
      tracker.modelSwitch(e.cache_ttl)
      refreshView()
    })
    return result
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    guard.sync((m, o) => $.ui.log(m, o), () => {
      tracker.measure(e.context.window, e.context.tokens)
      refreshView()
    })
    return result
  })

  // ── turns and requests ───────────────────────────────────────────────

  on('turn.start', async ($, e, next) => {
    guard.sync((m, o) => $.ui.log(m, o), () => {
      tracker.turnStart(e.agentId)
      refreshView()
    })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    await guard.run((m, o) => $.ui.log(m, o), async () => {
      deliver(tracker.step(e.agentId ?? 'main', response.usage, await $.clock.now()))
    })
    return response
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await guard.run((m, o) => $.ui.log(m, o), async () => {
      deliver(tracker.turnComplete(e.agentId, await $.clock.now()))
    })
    return result
  })

  // ── tools ────────────────────────────────────────────────────────────

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    await guard.run((m, o) => $.ui.log(m, o), async () => {
      const text = typeof result.text === 'string' ? result.text
        : typeof result.deny === 'string' ? result.deny
        : typeof result.result === 'string' ? result.result
        : ''
      deliver(tracker.toolResult({
        agent: e.agentId ?? 'main',
        id: e.tool_use_id,
        tool: String(e.tool),
        args: e as unknown as Readonly<Record<string, unknown>>,
        size: text.length,
        isError: result.isError === true || typeof result.deny === 'string',
      }, await $.clock.now()))
    })
    return result
  }).catch(($, e, next) => next(e)) // a failure replays next's own result: never a deny

  // ── /tokens ──────────────────────────────────────────────────────────
  // Answers with no text: a command's text is a transcript row the model
  // reads, and this mod adds nothing to Claude's context. Confirmations are
  // toasts, which the model never sees.

  on('command.run', { command: 'tokens' }, async ($, e) => {
    await guard.run((m, o) => $.ui.log(m, o), async () => {
      const [sub = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
      const now = await $.clock.now()
      const writeView = () => update($, viewAtom, () => makeView(now))
      if (sub === '') {
        await writeView()
        await $.ui.open({ id: PANE_ID, title: t(lang, 'ui.title') })
        if (paneSurface === null || paneSurface === 'terminal') startAnimation()
      } else if (sub === 'close') {
        await $.ui.close({ id: PANE_ID })
      } else if (sub === 'mute' || sub === 'unmute') {
        tracker.governor.muted = sub === 'mute'
        prefs = { ...prefs, muted: tracker.governor.muted }
        await $.store.set(PREFS_KEY, { ...prefs })
        await writeView()
        $.ui.toast(t(lang, sub === 'mute' ? 'cmd.muted' : 'cmd.unmuted'))
      } else if (sub === 'reset') {
        tracker.resetAll()
        await $.store.delete(STORE_KEY)
        await writeView()
        $.ui.toast(t(lang, 'cmd.reset'))
      } else if (sub === 'lang' && (arg === 'en' || arg === 'az')) {
        lang = arg
        prefs = { ...prefs, language: arg }
        await $.store.set(PREFS_KEY, { ...prefs })
        await writeView()
        // Retitle the pane only if it is already open: never open it unasked.
        if ((await $.ui.panes()).some(p => p.id === PANE_ID)) await $.ui.open({ id: PANE_ID, title: t(lang, 'ui.title') })
        $.ui.toast(t(lang, 'cmd.lang'))
      } else {
        $.ui.toast(t(lang, 'cmd.usage'))
      }
    })
    return {}
  })

  // ── drawing ──────────────────────────────────────────────────────────

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    sawSurface = true
    paneSurface = e.surface
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // Plain property reads: a surface's table need not answer `in`.
    const table = els as Partial<UiEls>
    const Raster = e.surface === 'terminal' ? table.Raster : undefined
    const Svg = e.surface === 'terminal' ? undefined : table.Svg
    try {
      const view = await read($, viewAtom)
      const tab = await read($, tabAtom)
      return paneTree({ Box, Text, Button, Raster, Svg }, view, TABS.includes(tab) ? tab : 'live', e.props.bodyColumns, {
        tab: id => {
          void update($, tabAtom, () => id)
          if (id === 'live' && e.surface === 'terminal') startAnimation()
        },
        dismiss: key => {
          tracker.tips.dismiss(key)
          void $.clock.now().then(now => update($, viewAtom, () => makeView(now)))
        },
      }, lang)
    } catch {
      return <Text dimColor>token-lens: view unavailable</Text>
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    sawSurface = true
    const engine = await next(e)
    if (!cfg.band || e.props.hasSurvey) return engine
    try {
      const view = await read($, viewAtom)
      if (view === null || (view.ctx === null && view.lastWarning === null)) return engine
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {engine}
          {bandTree({ Box, Text }, view)}
        </Box>
      )
    } catch {
      return engine
    }
  })
}
