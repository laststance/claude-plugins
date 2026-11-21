import type { EngineInterface, Register } from 'claude-code'

import { ACTIVATE_PROJECT_TOOL, BRIEFING_SECTION_ID, SERENA_TOOL_PREFIX } from './constants'
import { buildBriefingText } from './utils/buildBriefingText'
import { findProjectRoot } from './utils/findProjectRoot'
import { loadSerenaManual } from './utils/loadSerenaManual'
import type { SerenaManualResult } from './utils/loadSerenaManual'

/** The project Serena activated and its manual, looked up once per session. */
type SerenaProject = {
  projectRoot: string
  manualResult: SerenaManualResult
}

/** The session's one lookup, shared by every hook; {@link register} makes it and session start resets it. */
type SerenaProjectLookup = {
  /** The lookup in flight or settled; absent until a hook first needs it. */
  pending: Promise<SerenaProject | undefined> | undefined
  /** Whether the person was already shown how the briefing went this session. */
  hasReportedOutcome: boolean
}

/**
 * Names the Serena tools this session has, so the briefing is only added where Serena is connected; called by {@link register}'s `prompt.compose` hook.
 *
 * @param $ - The engine interface, for `$.tool.list`.
 * @param offeredToolNames - The tool names the request being composed offers the model.
 * @returns
 * - The Serena tool names the request offers, when it offers any
 * - Otherwise the Serena tool names in the session's full tool list (tools behind ToolSearch included)
 * - An empty list when Serena is not connected
 * @example
 * await listSerenaToolNames($, ['Bash', 'mcp__serena__find_symbol']) // => ['mcp__serena__find_symbol']
 * await listSerenaToolNames($, ['Bash', 'Read']) // Serena not connected => []
 */
async function listSerenaToolNames(
  $: EngineInterface,
  offeredToolNames: readonly string[],
): Promise<readonly string[]> {
  const offeredSerenaToolNames = offeredToolNames.filter(name => name.startsWith(SERENA_TOOL_PREFIX))
  if (offeredSerenaToolNames.length > 0) {
    return offeredSerenaToolNames
  }

  // A tool behind ToolSearch may be missing from what a request offers; the session's tool list has them all
  const sessionTools = await $.tool.list()
  return sessionTools.map(tool => tool.name).filter(name => name.startsWith(SERENA_TOOL_PREFIX))
}

/**
 * Looks up the project Serena activated and reads its manual; started at session start and awaited by the hooks of {@link register}.
 *
 * @param $ - The engine interface of the hook that starts the lookup.
 * @param startDirectory - The session's working directory at startup, where Serena looked for the project.
 * @returns
 * - `{ projectRoot, manualResult }` inside a project (a directory with `.serena/project.yml` or `.git` at or above it)
 * - `undefined` outside any project, where Serena activated nothing
 * @example
 * await prepareSerenaProject($, '/Users/me/work/app/src')
 * // => { projectRoot: '/Users/me/work/app', manualResult: { isLoaded: true, manual: '<serena>…' } }
 */
async function prepareSerenaProject($: EngineInterface, startDirectory: string): Promise<SerenaProject | undefined> {
  const projectRoot = await findProjectRoot($, startDirectory)
  if (projectRoot === undefined) {
    return undefined
  }

  return { projectRoot, manualResult: await loadSerenaManual($, projectRoot) }
}

/**
 * Answers the session's project lookup, starting it from the working directory when no hook has yet; called by the hooks of {@link register}.
 *
 * @param $ - The engine interface of the hook asking.
 * @param lookup - The session's shared lookup, filled in by the first caller.
 * @returns The same answer as {@link prepareSerenaProject}, computed once per session.
 * @example
 * await lookUpSerenaProject($, { pending: undefined, hasReportedOutcome: false })
 * // => { projectRoot: '/Users/me/work/app', manualResult: { isLoaded: true, manual: '<serena>…' } }
 */
async function lookUpSerenaProject(
  $: EngineInterface,
  lookup: SerenaProjectLookup,
): Promise<SerenaProject | undefined> {
  lookup.pending ??= $.session.cwd().then(startDirectory => prepareSerenaProject($, startDirectory))
  return lookup.pending
}

/**
 * Registers the hooks that brief Claude on Serena without waiting for Claude to activate it; the engine calls it at load and on every reload.
 *
 * - `session.start` starts looking up the project and its manual, so the first request does not wait for it.
 * - `tool.describe` moves Serena's tools out from behind ToolSearch (the `loadTools` option, on by default).
 * - `prompt.compose` adds the briefing, with the manual, as the system prompt's last section.
 *
 * @param on - Adds a hook beneath the engine's behaviour.
 * @param options - The `userConfig` values; `loadTools: false` leaves Serena's tools behind ToolSearch.
 * @returns Nothing; the hooks it adds are the mod.
 * @example
 * // A session started in /Users/me/work/app, with Serena configured as an MCP server
 * // => the system prompt ends with "# Serena … activated the project at `/Users/me/work/app` …" and the manual
 */
export const register: Register = (on, options) => {
  const isLoadingTools = options.loadTools !== false
  // A reload makes a fresh one, and session.start fills it again
  const lookup: SerenaProjectLookup = { pending: undefined, hasReportedOutcome: false }

  on('session.start', async ($, e, next) => {
    // Started unawaited, so the session is ready without waiting on Serena's CLI
    lookup.pending = prepareSerenaProject($, e.cwd)
    // A hook awaiting the lookup sees a failure; this keeps one nobody awaits from going unhandled
    lookup.pending.catch(() => undefined)
    lookup.hasReportedOutcome = false

    return next(e)
  })

  // Serena's tools in the prompt's list need no ToolSearch step before Claude can call them
  if (isLoadingTools) {
    on('tool.describe', { tool: /^mcp__serena__/ }, async ($, e, next) => {
      const described = await next(e)
      const serenaProject = await lookUpSerenaProject($, lookup)
      // Outside a project Serena has nothing active, so its tools stay out of the way
      if (serenaProject === undefined) {
        return described
      }

      return { ...described, isDeferred: false }
    })
  }

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const serenaToolNames = await listSerenaToolNames($, e.tools)
    // No Serena MCP server in this session: nothing to brief on
    if (serenaToolNames.length === 0) {
      return composed
    }
    const serenaProject = await lookUpSerenaProject($, lookup)
    if (serenaProject === undefined) {
      return composed
    }

    // Tell the person once per session what Claude was briefed with
    if (!lookup.hasReportedOutcome) {
      lookup.hasReportedOutcome = true
      const projectName = serenaProject.projectRoot.split('/').pop() || serenaProject.projectRoot
      if (serenaProject.manualResult.isLoaded) {
        $.ui.status(`Serena ✓ ${projectName}`)
      } else {
        $.ui.toast(`serena-activate: ${serenaProject.manualResult.failure}`)
      }
    }

    const briefingText = buildBriefingText({
      projectRoot: serenaProject.projectRoot,
      manualResult: serenaProject.manualResult,
      hasActivateProjectTool: serenaToolNames.includes(ACTIVATE_PROJECT_TOOL),
      isToolsDeferred: !isLoadingTools,
    })

    return {
      sections: [...composed.sections, { id: BRIEFING_SECTION_ID, text: briefingText, scope: 'session' }],
    }
  })
}
