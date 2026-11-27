import type { EngineInterface, Register } from 'claude-code'

import { hasColour, planOutput, type OutputPlan } from '../outputs.mjs'

/** One styled stretch of a line, as tokenize.mjs prints it. */
type Run = { t: string; fg: string | null; b: boolean; i: boolean; u: boolean }
/** What tokenize.mjs prints: the lines of the text, and whose theme coloured them. */
type Result = { lines: Run[][]; editor: string; theme: string }
/** A Bash call's Output block to colour: the part within the colouring cap, its command and call, and its plan. */
type OutputPayload = { output: string; command: string; id: string; plan: OutputPlan }
/** What tokenize.mjs is asked to colour: a Bash command, a snippet in a language, or a command's Output block. */
type Payload = { command: string } | { code: string; language: string } | OutputPayload
/**
 * A payload's colours while cached: the lines; still being made; failed, or an Output block with nothing coloured (both
 * left for Claude Code to draw).
 */
type Colours = Result | 'pending' | 'failed' | 'plain'
type Options = { editor: string; theme: string; strength: number; codeStrength: number; outputStrength: number; collapsedLines: number }
/** The fields of a Bash result this mod reads; the rest it leaves to Claude Code. */
type BashOutput = {
  stdout?: unknown
  stderr?: unknown
  interrupted?: unknown
  isImage?: unknown
  backgroundTaskId?: unknown
  returnCodeInterpretation?: unknown
  bashEditDiff?: unknown
  viewedImagePaths?: unknown
}
/** What of a Bash result this mod draws: the stdout it colours, and whether Claude Code has rows of its own under it. */
type Colourable = { stdout: string; hasSiblings: boolean }

const SHOW_CODE = 'mcp__syntax-highlight__show_code'
const DIM_TO = '#999999'
const MAX_CACHED = 200
// Calls whose command, and whether their result waits for it, are kept: a short string or a flag each, so far more
// than MAX_CACHED. A command forgotten while its rows are still drawn makes its result wait again and its row ask for a
// redraw again, on every pass, once more results are drawn than this keeps
const MAX_CALLS = 20_000
// An Output block is coloured up to this many lines or characters; the rest is drawn as it is
const MAX_OUTPUT_LINES = 2000
const MAX_OUTPUT_CHARS = 200_000
// How long a finished Bash call waits for its Output block to be coloured, so the block is ready when first drawn
const OUTPUT_WAIT_MS = 1500
// Claude Code's own fold of a collapsed result: rows shown, and the columns its indent takes from the width
const FOLD_ROWS = 3
const FOLD_INDENT = 10

// the colours of commands and snippets, by their text
const cache = new Map<string, Colours>()
// the colours of Output blocks, per call and plan, each with the text it was made from: a lookup for any other text
// misses (another mod can rewrite a call's record after the tool.call hook coloured it, as secret-guard masks secrets),
// and the key stays short
const outputColours = new Map<string, { source: string; colours: Colours }>()
// each call's command, which plans its Output block
const commands = new Map<string, string>()
// outputPayload's answers, per call and command, each with the capped text it was planned from, so a redraw does not
// plan the same block again
const payloads = new Map<string, { head: string; payload: OutputPayload | null }>()
// calls whose Output block was drawn before their command was known (a resumed session draws results first)
const waitingForCommand = new Map<string, true>()
let options: Options = { editor: 'auto', theme: '', strength: 0.55, codeStrength: 1, outputStrength: 0.75, collapsedLines: 3 }

const channels = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))

// pulls a theme colour toward grey: strength 1 keeps it, 0 makes it grey
const soften = (hex: string, strength: number) => {
  if (strength >= 1) return hex
  const grey = channels(DIM_TO)
  const mixed = channels(hex).map((c, n) => {
    const g = grey[n] ?? 0
    return Math.round(g + (c - g) * strength)
  })
  return `#${mixed.map(c => c.toString(16).padStart(2, '0')).join('')}`
}

// a command's or a snippet's colours are found by its text
const keyOf = (payload: Exclude<Payload, OutputPayload>) => ('code' in payload ? `code:${payload.language}:${payload.code}` : `cmd:${payload.command}`)

// an Output block's colours are kept per call and plan: a command learned later (a resumed session) plans it differently
const outputKey = (payload: OutputPayload) => `${payload.id}:${payload.plan.language ?? ''}:${payload.plan.shapes.join(',')}`

/** Keeps a bounded map from growing past `max` entries ({@link MAX_CACHED} unless given), oldest out first. */
const remember = <V,>(map: Map<string, V>, key: string, value: V, max = MAX_CACHED) => {
  map.set(key, value)
  if (map.size > max) map.delete(map.keys().next().value as string)
}

/**
 * The colours cached for a payload: a command's or a snippet's by its text, an Output block's only when they were made
 * from the same text.
 *
 * Called by every hook before it colours or draws.
 *
 * @param payload - What was asked to be coloured.
 * @returns the cached colours, or undefined when none were made for this text
 * @example
 * coloursOf({ command: 'ls -la' }) // => { lines: [[{ t: 'ls', fg: '#8cb6ff', ... }, ...]], editor: 'vscode', theme: '...' }
 */
const coloursOf = (payload: Payload): Colours | undefined => {
  if (!('output' in payload)) return cache.get(keyOf(payload))
  const kept = outputColours.get(outputKey(payload))
  // colours of the same call and plan made from other text (the record before another mod rewrote it) are no answer
  return kept !== undefined && kept.source === payload.output ? kept.colours : undefined
}

/** Caches a payload's colours where {@link coloursOf} finds them. Called by {@link highlight}. */
const keepColours = (payload: Payload, colours: Colours) => {
  if ('output' in payload) remember(outputColours, outputKey(payload), { source: payload.output, colours })
  else remember(cache, keyOf(payload), colours)
}

// whether any run of a result has a colour or a style
const isColoured = (result: Result) => result.lines.some(runs => runs.some(r => r.fg !== null || r.b || r.i || r.u))

/**
 * Colours a payload in the node worker (tokenize.mjs) and caches the lines, then redraws.
 *
 * Called when a Bash call starts (its command), when it ends (its Output block), when `show_code` runs, and by a
 * render hook that finds nothing cached yet. A failure is cached too, so the row stays as Claude Code draws it, and so
 * is an Output block the worker leaves uncoloured (a Language with no grammar, `cat notes.zzunknown`).
 *
 * @param $ - The engine interface, for `$.process.run`.
 * @param payload - What to colour.
 * @returns once the lines are cached (or the failure is)
 * @example
 * await highlight($, { command: 'ls -la' })
 * coloursOf({ command: 'ls -la' }) // => { lines: [[{ t: 'ls', fg: '#8cb6ff', ... }, ...]], editor: 'vscode', theme: '...' }
 */
const highlight = async ($: EngineInterface, payload: Payload) => {
  keepColours(payload, 'pending')

  try {
    // the worker plans an Output block itself; the call id and the hook's plan are only for the cache
    const { id: _id, plan: _plan, ...asked } = payload as Payload & { id?: string; plan?: OutputPlan }
    const done = await $.process.run(['node', `${$.plugin.root}/tokenize.mjs`], {
      stdin: JSON.stringify({ ...asked, editor: options.editor, theme: options.theme }),
      timeoutMs: 8000,
    })
    if (done.exitCode !== 0) throw new Error(done.stderr.slice(0, 300))
    const result = JSON.parse(done.stdout) as Result
    // an Output block with nothing coloured is Claude Code's to draw, as a block with nothing to colour is
    keepColours(payload, 'output' in payload && !isColoured(result) ? 'plain' : result)
  } catch (error) {
    keepColours(payload, 'failed')
    $.ui.log(`syntax-highlight: ${String(error)}`, { to: 'debug' })
  }
  $.ui.invalidate('ui.render')
}

/**
 * The part of a Bash result this mod colours, and whether Claude Code still has sibling rows to draw under it.
 *
 * Sibling rows are what Claude Code's own Bash renderer draws after the stdout: stderr (in practice only its
 * "Shell cwd was reset to …" notice, since a command's own stderr is merged into stdout), an edit diff and viewed
 * images. The `ToolResult` hook draws the coloured stdout and lets Claude Code draw those rows beneath it. A
 * persisted-output note alone is not one: for an emptied stdout with only that note, Claude Code draws "(No output)".
 * Called by the `tool.call` hook (to colour before the first draw) and the `ToolResult` hook.
 *
 * @param output - The tool's result record.
 * @returns the stdout with its trailing blank space cut and whether sibling rows exist, or null when Claude Code should
 *   draw the whole result (an interrupt, an image, a background task, an exit code's explanation, no stdout)
 * @example
 * colourableResult({ stdout: 'a\nb\n', stderr: '' }) // => { stdout: 'a\nb', hasSiblings: false }
 * colourableResult({ stdout: 'a', stderr: '\nShell cwd was reset to /x' }) // => { stdout: 'a', hasSiblings: true }
 * colourableResult({ stdout: 'a', interrupted: true }) // => null
 */
const colourableResult = (output: unknown): Colourable | null => {
  const out = output as BashOutput | null
  if (out === null || typeof out !== 'object' || typeof out.stdout !== 'string') return null
  if (out.interrupted === true || out.isImage === true || out.backgroundTaskId || out.returnCodeInterpretation) return null
  // trimEnd, not a /\s+$/ replace: that retries from every space of a long run inside the text, quadratic in its length
  const stdout = out.stdout.trimEnd()
  if (stdout === '') return null
  const hasStderr = typeof out.stderr === 'string' && out.stderr.trim() !== ''
  const hasImages = Array.isArray(out.viewedImagePaths) && out.viewedImagePaths.length > 0
  return { stdout, hasSiblings: hasStderr || Boolean(out.bashEditDiff) || hasImages }
}

/**
 * Splits an Output block into the part that is coloured and the rest, past {@link MAX_OUTPUT_LINES} lines or
 * {@link MAX_OUTPUT_CHARS} characters.
 *
 * @param stdout - The block's text.
 * @returns `head`, the text sent to the worker, and `rest`, the lines drawn as they are
 */
const capOutput = (stdout: string) => {
  const lines = stdout.split('\n')
  let chars = 0
  let n = 0
  // count whole lines until either cap is reached
  while (n < lines.length && n < MAX_OUTPUT_LINES && chars + (lines[n] ?? '').length <= MAX_OUTPUT_CHARS) {
    chars += (lines[n] ?? '').length + 1
    n++
  }
  return { head: lines.slice(0, n).join('\n'), rest: lines.slice(n) }
}

/**
 * The payload that colours a Bash call's Output block, or null when nothing of the block takes a colour.
 *
 * Memoized per call and command in {@link payloads}, for the capped text it was planned from: a redraw of an unchanged
 * result does not plan its block again, while a command learned later (a resumed session) or a record another mod
 * rewrote after the `tool.call` hook saw it (secret-guard masks its secrets) misses the memo and plans afresh. Called
 * by the `tool.call` hook and the `ToolResult` hook.
 *
 * @param id - The call's `tool_use_id`.
 * @param head - The part of the block within the colouring cap, from {@link capOutput}.
 * @returns the payload, or null when nothing takes a colour or not even the first line fits the cap (the worker would
 *   hand back one empty row, a row the command never printed)
 */
const outputPayload = (id: string, head: string): OutputPayload | null => {
  const command = commands.get(id) ?? ''
  const memoKey = `${id}\u0000${command}`
  const memo = payloads.get(memoKey)
  // the record drawn can differ from the one the tool.call hook saw (a mod outside this one rewrote it)
  if (memo !== undefined && memo.head === head) return memo.payload
  const plan = planOutput(command, head)
  // nothing fits the cap, or nothing in it takes a colour: Claude Code draws the block
  const payload = head === '' || !hasColour(head.split('\n'), plan) ? null : { output: head, command, id, plan }
  remember(payloads, memoKey, { head, payload })
  return payload
}

// how many terminal cells a character takes: two for wide (CJK, full-width, emoji), else one
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]/u
const cellsOf = (ch: string) => (WIDE.test(ch) ? 2 : 1)

/**
 * Folds coloured lines the way Claude Code folds a collapsed result: each line broken into rows of the result's
 * width, the first {@link FOLD_ROWS} rows shown, and all four when only one would be left.
 *
 * @param lines - The coloured lines.
 * @param width - The cells a row holds (the view's columns less the result's indent).
 * @returns the rows to draw, and how many rows were left out
 * @example
 * foldRows(fiveShortLines, 80) // => { rows: [first three], hidden: 2 }
 */
const foldRows = (lines: Run[][], width: number) => {
  const rows: Run[][] = []
  for (const runs of lines) {
    let row: Run[] = []
    let used = 0
    // break the line into rows of `width` cells, splitting a run where a row ends
    for (const run of runs) {
      let part = ''
      for (const ch of run.t) {
        const cells = cellsOf(ch)
        if (used + cells > width && used > 0) {
          if (part !== '') row.push({ ...run, t: part })
          rows.push(row)
          row = []
          used = 0
          part = ''
        }
        part += ch
        used += cells
      }
      if (part !== '') row.push({ ...run, t: part })
    }
    rows.push(row)
  }
  const hidden = rows.length - FOLD_ROWS
  if (hidden === 1) return { rows, hidden: 0 }
  return { rows: rows.slice(0, FOLD_ROWS), hidden: Math.max(0, hidden) }
}

/**
 * Draws runs as Text: a coloured run pulled toward grey by `strength`, brightened while hovered.
 *
 * @param Text - The surface's Text element.
 * @param runs - One line's runs.
 * @param strength - 1 keeps the theme's colours, 0 makes them grey.
 * @param scope - The hover scope that brightens the line's runs together.
 * @param dimPlain - Whether uncoloured text is dimmed too (Bash commands: yes; Output blocks: no, they read as text).
 */
const renderRuns = (Text: any, runs: Run[], strength: number, scope: string, dimPlain = strength < 1) =>
  runs.length === 0
    ? [<Text> </Text>]
    : runs.map(r =>
        r.fg === null && !r.b && !r.i && !r.u ? (
          dimPlain ? <Text dimColor hover={{ scope, dimColor: false }}>{r.t}</Text> : <Text>{r.t}</Text>
        ) : (
          <Text color={r.fg === null ? undefined : soften(r.fg, strength)} dimColor={r.fg === null && dimPlain} bold={r.b} italic={r.i} underline={r.u}
            hover={{ scope, ...(r.fg === null ? { dimColor: false } : { color: r.fg }) }}>
            {r.t}
          </Text>
        ),
      )

export const register: Register = (on, userOptions) => {
  options = { ...options, ...(userOptions as Partial<Options>) }

  // the tool Claude calls to show you code in a language of its choice
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'show_code',
      description:
        'Show the user a code snippet, syntax-highlighted in the given language with their editor theme. Use it when the user asks to see code, or when a snippet is the answer. The code is drawn in the terminal; do not repeat it in your reply.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The code to show, exactly as it should read.' },
          language: { type: 'string', description: 'Language id or alias, for example python, js, ts, bash, json, rust, sql.' },
          title: { type: 'string', description: 'Optional caption, for example a file name.' },
        },
        required: ['code', 'language'],
      },
      isDeferred: false,
    })

    return next(e)
  })

  on('tool.call', { tool: SHOW_CODE }, ($, e, next) => {
    const input = e as unknown as { code?: string; language?: string }
    const code = (input.code ?? '').trimEnd()
    void highlight($, { code, language: input.language ?? '' })

    return { result: `Showed ${code.split('\n').length} lines of ${input.language} to the user.` }
  }).catch(($, e, next) => ({ deny: 'syntax-highlight: could not show the code.' }))

  // colour a Bash call's command as it starts and its Output block as it ends, so both rows are ready when first drawn
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = e.command.trimEnd()
    if (command !== '' && coloursOf({ command }) === undefined) void highlight($, { command })
    remember(commands, e.tool_use_id, command, MAX_CALLS)

    const done = await next(e)
    const result = 'result' in done && done.result !== undefined && !done.isError ? colourableResult(done.result) : null
    const payload = result === null ? null : outputPayload(e.tool_use_id, capOutput(result.stdout).head)
    // wait a little for the colours: the result row is drawn once the call returns, and a terminal may not redraw it
    if (payload !== null && coloursOf(payload) === undefined) await Promise.race([highlight($, payload), $.clock.sleep(OUTPUT_WAIT_MS)])

    return done
  }).catch(($, e, next) => next(e))

  // a group of calls draws one collapsed line ("Running ..."), where Bash commands would stay unhighlighted: unfold it
  // into its own ToolUse rows (drawn below) whenever it holds a Bash call
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded || !e.props.calls.some(call => call.tool === 'Bash')) return next(e)
    return next({ ...e, props: { ...e.props, isExpanded: true } })
  }).catch(($, e, next) => next(e))

  // a Bash call's Output block, drawn as Claude Code draws it (the ⎿ indent, the fold) with its text coloured, and
  // Claude Code's own sibling rows (the cwd notice, stderr, an edit diff, images) drawn by Claude Code beneath it
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.tool !== 'Bash' || e.props.isErrored) return next(e)
    const result = colourableResult(e.props.output)
    if (result === null) return next(e)
    // drawn before its command is known: the ToolUse hook asks for a redraw once it learns it
    if (!commands.has(e.props.tool_use_id)) remember(waitingForCommand, e.props.tool_use_id, true, MAX_CALLS)
    const { head, rest } = capOutput(result.stdout)
    const payload = outputPayload(e.props.tool_use_id, head)
    if (payload === null) return next(e)

    const done = coloursOf(payload)
    if (done === undefined) void highlight($, payload)
    if (done === undefined || done === 'pending' || done === 'failed' || done === 'plain') return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const scope = `syntax-highlight:out:${e.props.tool_use_id}`
    const plain: Run[][] = rest.map(line => (line === '' ? [] : [{ t: line, fg: null, b: false, i: false, u: false }]))
    const lines = [...done.lines, ...plain]
    // collapsed, the block folds as Claude Code folds it; expanded (ctrl+o, verbose), every line is drawn
    const isExpanded = e.props.isExpanded === true
    const width = Math.max((e.viewport?.columns ?? 80) - FOLD_INDENT, 10)
    const { rows, hidden } = isExpanded ? { rows: lines, hidden: 0 } : foldRows(lines, width)
    // the sibling rows stay Claude Code's: it draws them for this result with the stdout taken out, and draws nothing
    // for a result with none ("(No output)"), so it is asked only when there are some
    const siblings = result.hasSiblings
      ? await next({ ...e, props: { ...e.props, output: { ...(e.props.output as Record<string, unknown>), stdout: '' } } })
      : null

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text dimColor>{'  ⎿  '}</Text>
          <Box flexDirection="column">
            {rows.map(runs => (
              <Text wrap="wrap" hover={{ scope }}>{renderRuns(Text, runs, options.outputStrength, scope, false)}</Text>
            ))}
            {hidden > 0 ? <Text dimColor>{`… +${hidden} line${hidden === 1 ? '' : 's'} (ctrl+o to expand)`}</Text> : null}
          </Box>
        </Box>
        {siblings}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const input = e.props.input as { command?: unknown; code?: unknown; language?: unknown; title?: unknown } | null
    const isShow = e.props.tool === SHOW_CODE
    const isBash = e.props.tool === 'Bash'
    if (!isShow && !isBash) return next(e)
    // the Output block's row has no command of its own: keep it for the ToolResult hook (a resumed session too)
    if (isBash && typeof input?.command === 'string') {
      const id = String(e.props.tool_use_id)
      remember(commands, id, input.command.trimEnd(), MAX_CALLS)
      // its Output block was drawn before the command was known: draw it again, once, planned from the command
      if (waitingForCommand.delete(id)) $.ui.invalidate('ui.render')
    }

    const payload: Exclude<Payload, OutputPayload> | null = isShow
      ? typeof input?.code === 'string' ? { code: input.code.trimEnd(), language: String(input.language ?? '') } : null
      : typeof input?.command === 'string' && input.command.trim() !== '' ? { command: input.command.trimEnd() } : null
    if (payload === null) return next(e)

    const done = coloursOf(payload)
    if (done === undefined) void highlight($, payload)
    if (done === undefined || done === 'pending' || done === 'failed' || done === 'plain') return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const scope = `syntax-highlight:${String(e.props.tool_use_id ?? keyOf(payload).length)}`
    const dot = e.props.isErrored || e.props.isInterrupted ? 'error' : e.props.isRunning ? 'inactive' : 'success'

    // marginTop keeps the blank line Claude Code leaves above a tool row
    if (isShow) {
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={dot}>⏺ </Text>
            <Text weight="bold">{typeof input?.title === 'string' && input.title !== '' ? input.title : 'Code'}</Text>
            <Text dimColor>{` (${String(input?.language ?? '')}) · ${done.theme}`}</Text>
          </Text>
          <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1} marginLeft={2}>
            {done.lines.map(runs => (
              <Text wrap="wrap" hover={{ scope }}>{renderRuns(Text, runs, options.codeStrength, scope)}</Text>
            ))}
          </Box>
        </Box>
      )
    }

    const shown = e.props.isExpanded ? done.lines : done.lines.slice(0, options.collapsedLines)
    const hidden = done.lines.length - shown.length

    return (
      <Box flexDirection="column" marginTop={1}>
        {shown.map((runs, n) => (
          <Text wrap="wrap" hover={{ scope }}>
            {n === 0 ? <Text color={dot}>⏺ </Text> : <Text>{'  '}</Text>}
            {n === 0 ? <Text weight="bold">Bash</Text> : <Text>{'    '}</Text>}
            <Text dimColor>{n === 0 ? '(' : ' '}</Text>
            {renderRuns(Text, runs, options.strength, scope)}
            {n === shown.length - 1 && hidden === 0 ? <Text dimColor>)</Text> : null}
          </Text>
        ))}
        {hidden > 0 ? <Text dimColor>{`      … +${hidden} line${hidden === 1 ? '' : 's'}) (ctrl+o to expand)`}</Text> : null}
      </Box>
    )
  })
}
