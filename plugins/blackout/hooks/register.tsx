import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  CLEAR_SCREEN_FORMAT,
  PAINT_SETTLE_MS,
  RECLEAR_INTERVAL_MS,
  RESTORE_FORMAT,
  TOGGLE_ACTION,
} from './constants'

/** True while the screen is blacked out; session-scoped, starts off. */
const isOn = atom({ plugin: 'blackout', key: 'isOn' } as const, false)

/**
 * The timer that erases the screen again while blacked out. A module value:
 * a hot reload stops `$.clock` timers and starts the module over, and
 * `session.start` then restarts it if the blackout is still on.
 */
let reclearTimer: Timer | undefined

/**
 * Render sites whose drawing is replaced by an empty Box while blacked out:
 * every transcript row, the turn's status lines and the footer labels, so
 * nothing new is painted while the screen is blank.
 */
const HIDDEN_SITES = [
  'UserMessage',
  'AssistantMessage',
  'ToolUse',
  'ToolResult',
  'ToolGroup',
  'CommandOutput',
  'Placed',
  'ToolProgress',
  'Spinner',
  'TurnDuration',
  'InfoNotice',
  'SessionMode',
  'Pane',
] as const

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Slash-command fallback for when the key is unbound or a dialog is up
    await $.command.register({
      name: 'blackout',
      description: 'Hide or show every line Claude Code draws (also ctrl+space)',
    })

    // After a hot reload the blackout may still be on; keep the screen blank
    if (await read($, isOn)) {
      startErasing($)
    }

    return next(e)
  })

  on('command.run', { command: 'blackout' }, async $ => {
    await toggleBlackout($)

    // No text: an output row would be one more line on a screen meant to be blank
    return {}
  })

  // An array matcher is one-of: a single hook covers every hidden site
  on('ui.render', { component: HIDDEN_SITES }, async ($, e, next) => {
    if (!(await read($, isOn))) {
      return next(e)
    }

    const { Box } = $.ui.resolve(e)

    return <Box />
  })

  // Plugins' `$.ui.log` lines are engine notice rows, not a render site; while
  // blacked out, new ones go to the debug log instead of the transcript
  on('ui.log', async ($, e, next) => {
    if (!(await read($, isOn))) {
      return next(e)
    }

    return next({ ...e, to: 'debug' })
  })

  // Other plugins' rows above the prompt: pass none on while blacked out
  on('ui.render', { component: 'AbovePromptList' }, async ($, e, next) => {
    if (!(await read($, isOn))) {
      return next(e)
    }

    return next({ ...e, props: { ...e.props, rows: [] } })
  })

  // The hint line under the prompt hosts the hidden toggle Button. A Button
  // naming an engine action is pressed by the person's key only while it is
  // mounted, and this line is drawn in every state, so the toggle always works.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const { Box, Button } = $.ui.resolve(e)
    const toggle = (
      <Box display="none">
        <Button
          key="blackout-toggle"
          label="blackout"
          action={TOGGLE_ACTION}
          onPress={() => toggleBlackout($)}
        />
      </Box>
    )

    // Blacked out: draw only the invisible toggle, not the engine's hint text
    if (await read($, isOn)) {
      return <Box>{toggle}</Box>
    }

    return (
      <Box>
        {await next(e)}
        {toggle}
      </Box>
    )
  })
}

/**
 * Flips the blackout and makes the terminal match it.
 *
 * The prompt box, the logo and the status line are no render sites, so no hook
 * can empty them. Turning on, this empties every site, waits for that frame to
 * paint, then erases the screen itself and keeps erasing it, since Claude Code
 * repaints only the cells that change. Turning off, it sends Claude Code a
 * SIGCONT: its renderer answers that signal (the one `fg` sends) by throwing
 * away what it thinks is on screen and repainting everything.
 *
 * Called by the hidden toggle Button (the bound key) and by `/blackout`.
 *
 * @param $ - The engine interface of the hook that handled the key or command.
 * @returns Resolves once the state is written and the terminal updated.
 *
 * @example
 * ```ts
 * await toggleBlackout($) // off → on: sites emptied, then the screen erased
 * await toggleBlackout($) // on → off: Claude Code repaints everything
 * ```
 */
const toggleBlackout = async ($: EngineInterface): Promise<void> => {
  const isTurningOn = !(await read($, isOn))
  await update($, isOn, () => isTurningOn)

  if (isTurningOn) {
    await $.clock.sleep(PAINT_SETTLE_MS)
    startErasing($)

    return
  }

  reclearTimer?.cancel()
  reclearTimer = undefined
  // The child's parent is the Claude Code process; a running process ignores
  // SIGCONT itself, and only the renderer's repaint handler acts on it
  await $.process.run([
    'sh',
    '-c',
    `printf '${RESTORE_FORMAT}' > /dev/tty; kill -CONT "$PPID"`,
  ])
}

/**
 * Erases the screen now and every {@link RECLEAR_INTERVAL_MS} after, until
 * the blackout turns off.
 *
 * Called when the blackout turns on, and by `session.start` after a reload.
 *
 * @param $ - The engine interface, to run the erase and own the timer.
 * @returns Nothing; the erases run in the background.
 *
 * @example
 * ```ts
 * startErasing($) // screen erased now, then again every 400 ms
 * ```
 */
const startErasing = ($: EngineInterface): void => {
  reclearTimer?.cancel()
  void eraseScreen($)
  reclearTimer = $.clock.every(RECLEAR_INTERVAL_MS, () => void eraseScreen($))
}

/**
 * Writes the erase sequence straight to the session's terminal, behind
 * Claude Code's back, so its renderer still believes the old cells are shown
 * and leaves them alone.
 *
 * @param $ - The engine interface, to run the child process.
 * @returns Resolves once the sequence is written.
 *
 * @example
 * ```ts
 * await eraseScreen($) // every cell on screen is blank, the cursor hidden
 * ```
 */
const eraseScreen = async ($: EngineInterface): Promise<void> => {
  // The child shares Claude Code's controlling terminal, so /dev/tty is it
  await $.process.run(['sh', '-c', `printf '${CLEAR_SCREEN_FORMAT}' > /dev/tty`])
}
