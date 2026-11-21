import type { EngineInterface, Register } from 'claude-code'

import { EXPAND_COMMAND, VERBOSE_CONFIG_KEY } from './constants'

/** The `/expand` output line for each way a toggle can end. */
type ToggleExpandResultText =
  | 'Always expand: on. Tool output and thinking are shown in full, as ctrl+o shows them.'
  | 'Always expand: off. Long output folds again (ctrl+o to expand).'
  | `Could not turn always-expand ${'on' | 'off'}: ${string}`

/**
 * Reads whether rows are drawn in full now, from the `verbose` row of `/config`; called by {@link toggleExpand}.
 *
 * @param $ - The engine interface, for `$.config.list`.
 * @returns
 * - `true` when Verbose output is on (every row drawn in full)
 * - `false` when it is off, or the row is missing
 * @example
 * await readIsExpanded($) // /config shows Verbose output: true
 * // => true
 */
async function readIsExpanded($: EngineInterface): Promise<boolean> {
  const configRows = await $.config.list()
  const verboseRow = configRows.find(row => row.key === VERBOSE_CONFIG_KEY)
  return verboseRow?.value === true
}

/**
 * Flips Claude Code's `verbose` setting, which draws tool output and thinking in full as ctrl+o does; run by the `/expand` command of {@link register}.
 *
 * The setting is Claude Code's own, so the choice lasts across sessions until `/expand` runs again,
 * and rows already on screen are redrawn at once.
 *
 * @param $ - The engine interface of the command's hook.
 * @returns
 * - `Always expand: on. …` after turning it on
 * - `Always expand: off. …` after turning it off
 * - `Could not turn always-expand on|off: <reason>` when the setting refused the change (a managed setting, for one)
 * @example
 * await toggleExpand($) // Verbose output was off
 * // => "Always expand: on. Tool output and thinking are shown in full, as ctrl+o shows them."
 */
async function toggleExpand($: EngineInterface): Promise<ToggleExpandResultText> {
  const shouldExpand = !(await readIsExpanded($))
  const written = await $.config.set({ key: VERBOSE_CONFIG_KEY, value: shouldExpand })
  if (written.deny !== undefined) {
    return `Could not turn always-expand ${shouldExpand ? 'on' : 'off'}: ${written.deny}`
  }

  return shouldExpand
    ? 'Always expand: on. Tool output and thinking are shown in full, as ctrl+o shows them.'
    : 'Always expand: off. Long output folds again (ctrl+o to expand).'
}

/**
 * Registers `/expand`; the engine calls it at load and on every reload.
 *
 * @param on - Adds a hook beneath the engine's behaviour.
 * @returns Nothing; the hooks it adds are the mod.
 * @example
 * // `/expand` in a session with Verbose output off
 * // => every collapsed row ("… +12 lines (ctrl+o to expand)", "Thought for 3s") is drawn in full
 */
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: EXPAND_COMMAND,
      description: 'Toggle always-expanded tool output and thinking (as ctrl+o shows them)',
      // Flipping a display setting touches nothing of the turn, so it need not wait for it
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: 'expand' }, async $ => ({
    text: await toggleExpand($),
    // The model has no use for this line, so it stays out of requests
    isTextDisplayOnly: true,
  }))
}
