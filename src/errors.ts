/**
 * Render an unknown thrown value as a log-safe string.
 *
 * Every failure path in RunnerLens is caught and logged rather than rethrown
 * (monitoring must never fail the user's workflow), and `catch` bindings are
 * typed `unknown` — so this is the single place that narrows them.
 */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
