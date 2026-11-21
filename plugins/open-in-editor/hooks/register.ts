import type { EngineInterface, Register } from 'claude-code'

import { EDITORS, OPEN_TIMEOUT_MS } from './constants'
import type { Editor } from './constants'

/** The command's output line, success or failure. */
type OpenProjectResultText =
  | `Opened ${string} in ${string}`
  | `Could not open ${string} in ${string}: ${string}`

/**
 * Opens the session's project root in one editor; run by each editor command's `command.run` hook from {@link register}.
 *
 * A failure is also toasted, since a mid-turn (`immediate`) run's output line is easy to miss.
 *
 * @param $ - The engine interface of the hook that runs the command.
 * @param editor - The editor the typed command names, one of {@link EDITORS}.
 * @returns
 * - When `open -a` exits 0: `Opened <root> in <label>`
 * - When the app is missing, `open` fails or times out: `Could not open <root> in <label>: <reason>`
 * @example
 * await openProject($, { command: 'zed', label: 'Zed', app: 'Zed' })
 * // => "Opened /Users/me/work/app in Zed"
 * await openProject($, { command: 'zed', label: 'Zed', app: 'Zed' }) // Zed.app not installed
 * // => "Could not open /Users/me/work/app in Zed: Unable to find application named 'Zed'"
 */
async function openProject($: EngineInterface, editor: Editor): Promise<OpenProjectResultText> {
  const projectRoot = await $.session.root()

  let failureReason: string
  try {
    // `open` hands the folder to LaunchServices and exits at once; no shell, so the path needs no quoting
    const { exitCode, stderr } = await $.process.run(['open', '-a', editor.app, projectRoot], {
      timeoutMs: OPEN_TIMEOUT_MS,
    })
    if (exitCode === 0) {
      return `Opened ${projectRoot} in ${editor.label}`
    }
    failureReason = stderr.trim() || `open exited with code ${exitCode}`
  } catch (error) {
    // The process could not start or outlived the timeout
    failureReason = error instanceof Error ? error.message : String(error)
  }

  const failureText: OpenProjectResultText = `Could not open ${projectRoot} in ${editor.label}: ${failureReason}`
  $.ui.toast(failureText)
  return failureText
}

/**
 * Registers one slash command per editor in {@link EDITORS}; the engine calls it at load and on every reload.
 *
 * @param on - Adds a hook beneath the engine's behaviour.
 * @returns Nothing; the hooks it adds are the mod.
 * @example
 * // typing `/zed` in a session started in /Users/me/work/app
 * // => Zed opens the folder, the transcript shows "Opened /Users/me/work/app in Zed"
 */
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const editor of EDITORS) {
      await $.command.register({
        name: editor.command,
        description: `Open this project in ${editor.label}`,
        // Opening an editor touches nothing of the turn, so it need not wait for it
        immediate: true,
      })
    }

    return next(e)
  })

  // One answering hook per command, so validate reads each as answering its own command
  for (const editor of EDITORS) {
    on('command.run', { command: editor.command }, async $ => ({
      text: await openProject($, editor),
      // The model has no use for this line, so it stays out of requests
      isTextDisplayOnly: true,
    }))
  }
}
