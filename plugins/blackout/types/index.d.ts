/**
 * Whether the screen is blacked out.
 *
 * Kept in `$.state` (session scope), so it survives a hot reload but starts
 * off in every new session: a forgotten blackout never greets you on the
 * next launch.
 */
export type IsBlackedOut = boolean

declare module 'claude-code' {
  interface PluginState {
    blackout: { isOn: IsBlackedOut }
  }
}
