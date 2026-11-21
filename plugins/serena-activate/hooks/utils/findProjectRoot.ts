import type { EngineInterface } from 'claude-code'

import { PROJECT_MARKERS } from '../constants'

/**
 * Finds the project Serena's `--project-from-cwd` activates, so the briefing names the same root; called by {@link register}'s briefing.
 *
 * Walks up from `startDirectory` and stops at the first directory holding `.serena/project.yml` or `.git`.
 *
 * @param $ - The engine interface, for `$.fs.exists`.
 * @param startDirectory - An absolute directory, the session's working directory at startup.
 * @returns
 * - The nearest ancestor (or the directory itself) holding a project marker
 * - `undefined` when no directory up to `/` holds one
 * @example
 * await findProjectRoot($, '/Users/me/work/app/src') // /Users/me/work/app has .git
 * // => "/Users/me/work/app"
 * await findProjectRoot($, '/private/tmp')
 * // => undefined
 */
export async function findProjectRoot($: EngineInterface, startDirectory: string): Promise<string | undefined> {
  let directory = startDirectory.replace(/\/+$/, '') || '/'

  // Each pass checks one directory, then moves to its parent until `/` is checked
  while (true) {
    const directoryPrefix = directory === '/' ? '' : directory
    for (const marker of PROJECT_MARKERS) {
      if (await $.fs.exists(`${directoryPrefix}/${marker}`)) {
        return directory
      }
    }

    if (directory === '/') {
      return undefined
    }
    const lastSlashIndex = directory.lastIndexOf('/')
    directory = lastSlashIndex <= 0 ? '/' : directory.slice(0, lastSlashIndex)
  }
}
