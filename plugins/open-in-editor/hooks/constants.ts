import type { CommandSpec } from 'claude-code'

/**
 * One editor this mod can open the project in.
 *
 * `app` is the macOS application name handed to `open -a`, so the editor's
 * own CLI (`code`, `zed`, ...) does not need to be on the PATH.
 */
export type Editor = {
  /** The slash command name, without the slash. */
  command: CommandSpec['name']
  /** How the editor is named in the typeahead and the output line. */
  label: string
  /** The `.app` name LaunchServices resolves (`/Applications` or `~/Applications`). */
  app: string
}

/** Every editor the mod registers a slash command for, in typeahead order. */
export const EDITORS: readonly Editor[] = [
  { command: 'vscode', label: 'VS Code', app: 'Visual Studio Code' },
  { command: 'cursor', label: 'Cursor', app: 'Cursor' },
  // Devin Desktop ships as Devin.app; it shares Windsurf's bundle id, so it is opened by name
  { command: 'devin-desktop', label: 'Devin Desktop', app: 'Devin' },
  { command: 'webstorm', label: 'WebStorm', app: 'WebStorm' },
  { command: 'phpstorm', label: 'PhpStorm', app: 'PhpStorm' },
  { command: 'zed', label: 'Zed', app: 'Zed' },
]

/** How long `open -a` may take before the launch counts as failed. */
export const OPEN_TIMEOUT_MS = 15_000
