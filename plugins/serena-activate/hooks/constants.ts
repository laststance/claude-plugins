/** Every Serena tool's name starts with this, as Claude Code names a configured MCP server's tools. */
export const SERENA_TOOL_PREFIX = 'mcp__serena__'

/** Only offered when Serena runs without `--project-from-cwd`; its presence means nothing is active yet. */
export const ACTIVATE_PROJECT_TOOL = 'mcp__serena__activate_project'

/** The Serena context whose manual matches how Claude Code runs Serena (`--context claude-code`). */
export const SERENA_CONTEXT = 'claude-code'

/**
 * What marks a project root, checked in every directory from the working directory up.
 *
 * The same rule as Serena's `--project-from-cwd`: the nearest directory holding either one wins.
 */
export const PROJECT_MARKERS = ['.serena/project.yml', '.git'] as const

/** The system prompt section this mod adds; `<plugin>:<name>` as plugin sections are named. */
export const BRIEFING_SECTION_ID = 'serena-activate:briefing'

/** How long `serena print-system-prompt` may take; a cold start takes about a second. */
export const PRINT_SYSTEM_PROMPT_TIMEOUT_MS = 30_000
