import type { EngineInterface } from 'claude-code'

import { PRINT_SYSTEM_PROMPT_TIMEOUT_MS, SERENA_CONTEXT } from '../constants'

/** What loading the manual came to: the manual's text, or why there is none. */
export type SerenaManualResult = { isLoaded: true; manual: string } | { isLoaded: false; failure: string }

/**
 * Reads the Serena Instructions Manual for a project from Serena's own CLI, the text its `initial_instructions` tool answers; called by {@link register}'s briefing.
 *
 * Tries `serena` on the PATH first, then `~/.local/bin/serena` (where `uv tool install` puts it).
 *
 * @param $ - The engine interface, for `$.process.run` and `$.env.get`.
 * @param projectRoot - The absolute project root Serena activated.
 * @returns
 * - `{ isLoaded: true, manual }` when `serena print-system-prompt` printed the manual
 * - `{ isLoaded: false, failure }` when Serena exited with an error, printed nothing, or was not found
 * @example
 * await loadSerenaManual($, '/Users/me/work/app')
 * // => { isLoaded: true, manual: '<serena>\nYou have semantic coding functions/tools...' }
 * await loadSerenaManual($, '/Users/me/work/app') // Serena not installed
 * // => { isLoaded: false, failure: 'serena was not found on the PATH or in ~/.local/bin' }
 */
export async function loadSerenaManual($: EngineInterface, projectRoot: string): Promise<SerenaManualResult> {
  const homeDirectory = await $.env.get('HOME')
  const serenaCommands = homeDirectory === undefined ? ['serena'] : ['serena', `${homeDirectory}/.local/bin/serena`]

  for (const serenaCommand of serenaCommands) {
    let exitCode: number
    let stdout: string
    let stderr: string
    try {
      ;({ exitCode, stdout, stderr } = await $.process.run(
        [serenaCommand, 'print-system-prompt', '--only-instructions', '--context', SERENA_CONTEXT, projectRoot],
        { cwd: projectRoot, timeoutMs: PRINT_SYSTEM_PROMPT_TIMEOUT_MS },
      ))
    } catch {
      // This command could not start (not installed there); try the next place
      continue
    }

    // Serena ran: its answer is final, whichever way it went
    if (exitCode !== 0) {
      return { isLoaded: false, failure: stderr.trim() || `serena exited with code ${exitCode}` }
    }
    const manual = stdout.trim()
    if (manual === '') {
      return { isLoaded: false, failure: 'serena printed an empty manual' }
    }
    return { isLoaded: true, manual }
  }

  return { isLoaded: false, failure: 'serena was not found on the PATH or in ~/.local/bin' }
}
