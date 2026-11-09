// Fail-open guard. Every piece of analysis runs inside it: an error is
// swallowed, said once per session as a dim transcript line, and the hook
// carries on returning exactly what the engine gave it.
//
// `$` is never passed around (the engine requires `$.noun.event(...)` at the
// call site), so each hook hands in a one-line logger closure instead.

export type Log = (text: string, options?: { to?: 'transcript' | 'debug' }) => void

const MAX_DEBUG_LINES = 20

export class Guard {
  private reported = false
  private debugLines = 0
  failures = 0

  constructor(private readonly prefix = 'token-lens') {}

  private report(log: Log, err: unknown): void {
    this.failures += 1
    // The error's name only on the transcript: our code never puts content in
    // errors, but a name cannot carry any even if something beneath did.
    const name = err instanceof Error ? err.name : typeof err
    try {
      if (!this.reported) {
        this.reported = true
        log(`${this.prefix}: internal error (${name}); Claude Code is unaffected. Details in --debug.`)
      }
      if (this.debugLines < MAX_DEBUG_LINES) {
        this.debugLines += 1
        const msg = err instanceof Error ? err.message.slice(0, 160) : ''
        log(`${this.prefix}: ${name}: ${msg}`, { to: 'debug' })
      }
    } catch {
      // Logging itself failed: nothing more to do.
    }
  }

  sync(log: Log, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.report(log, err)
    }
  }

  async run(log: Log, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn()
    } catch (err) {
      this.report(log, err)
    }
  }

  /** A new session (/clear) may say it once more. */
  resetSession(): void {
    this.reported = false
  }
}
