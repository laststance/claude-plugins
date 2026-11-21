import type { SerenaManualResult } from './loadSerenaManual'

/** What the briefing is written from. */
export type BriefingFacts = {
  /** The project root Serena activated (or is to activate). */
  projectRoot: string
  /** The manual, or why it could not be read. */
  manualResult: SerenaManualResult
  /** Whether Serena offers `activate_project`, which it does only when nothing was activated at startup. */
  hasActivateProjectTool: boolean
  /** Whether Serena's tools sit behind ToolSearch (the `loadTools` option turned off). */
  isToolsDeferred: boolean
}

/**
 * Writes the system prompt section that tells Claude Serena is ready, so nothing depends on Claude choosing to activate it; called by {@link register}'s `prompt.compose` hook.
 *
 * @param facts - The project, the manual and how Serena's tools are offered.
 * @returns
 * - With the manual: the ready notice, then the manual itself
 * - Without it: the ready notice and an instruction to call `initial_instructions`
 * - When `activate_project` is offered: an instruction to call it first, with the root
 * @example
 * buildBriefingText({ projectRoot: '/w/app', manualResult: { isLoaded: true, manual: '<serena>…' }, hasActivateProjectTool: false, isToolsDeferred: false })
 * // => "# Serena\n\nSerena's MCP server activated the project at `/w/app` when this session started…\n\n<serena>…"
 */
export function buildBriefingText(facts: BriefingFacts): string {
  const lines = ['# Serena', '']

  // Started with --project-from-cwd, Serena has no activate_project tool and the project is already active
  if (facts.hasActivateProjectTool) {
    lines.push(
      `Serena's MCP server runs without \`--project-from-cwd\`, so no project is active yet: call \`mcp__serena__activate_project\` with \`${facts.projectRoot}\` before any other Serena tool.`,
    )
  } else {
    lines.push(
      `Serena's MCP server activated the project at \`${facts.projectRoot}\` when this session started, from the working directory. Nothing needs activating: there is no \`activate_project\` step to take.`,
    )
  }

  if (facts.isToolsDeferred) {
    lines.push(
      "Serena's tools are behind ToolSearch: load the ones you need (for example `select:mcp__serena__find_symbol,mcp__serena__get_symbols_overview`) before code navigation.",
    )
  }

  if (!facts.manualResult.isLoaded) {
    lines.push(
      `Serena's manual could not be read (${facts.manualResult.failure}): call \`mcp__serena__initial_instructions\` before using Serena's tools.`,
    )
    return lines.join('\n')
  }

  lines.push(
    "The Serena Instructions Manual follows, so there is no need to call `initial_instructions`. Use Serena's symbolic tools for code navigation and editing as it describes.",
    '',
    facts.manualResult.manual,
  )
  return lines.join('\n')
}
