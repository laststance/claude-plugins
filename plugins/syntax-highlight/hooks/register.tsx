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
/**
 * What of a Bash result this mod draws: the stdout it colours, and the rows Claude Code has of its own under it (the
 * stderr as it is drawn, and whether there are rows whose height this mod cannot count: an edit diff, images).
 */
type Colourable = { stdout: string; stderr: string; hasUncountedRows: boolean; hasSiblings: boolean }

const SHOW_CODE = 'mcp__syntax-highlight__show_code'
const DIM_TO = '#999999'
const MAX_CACHED = 200
// Calls kept track of: each call's command, whether its result waits for it, and whether its rows were coloured once.
// A short string or a flag each, so far more than MAX_CACHED: a call forgotten while its rows are still drawn would be
// coloured again on every redraw, without end, once more rows are drawn than this keeps
const MAX_CALLS = 20_000
// At most this many colouring workers run at once: a resumed session draws many rows together, and each worker is a
// node process that loads the grammars
const MAX_WORKERS = 4
// The nodes an Output block's rows may take in one drawn tree. The engine refuses a tree past 20,000 (index.d.ts,
// ClientElements), and the rest of this one (the ⎿, the fold, the sibling rows) takes a few more. An expanded block
// past it (some 5,000 short lines, or fewer with many colours each) is drawn by Claude Code
const MAX_DRAWN_NODES = 15_000
// The characters of text an Output block's rows may show in one drawn tree. The engine draws the first 100,000 and cuts
// the rest with no mark, and the rest of the tree (the ⎿, the fold) shows a few more. An expanded block past it (with
// BASH_MAX_OUTPUT_LENGTH raised) is drawn by Claude Code, whole
const MAX_DRAWN_CHARACTERS = 95_000
// The rows Claude Code keeps on the main screen below the transcript: the prompt box, its hints and the status line
const PROMPT_ROWS = 8
// characters a drawn Text refuses: the C0 controls but tab, newline and carriage return, DEL and C1 (an ANSI colour's
// ESC). A tree holding one is refused whole
const REFUSED_IN_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/
// An Output block is coloured up to this many lines or characters; the rest is drawn as it is
const MAX_OUTPUT_LINES = 2000
const MAX_OUTPUT_CHARS = 200_000
// How long a finished Bash call waits for its Output block to be coloured, so the block is ready when first drawn
const OUTPUT_WAIT_MS = 1500
// Claude Code's own fold of a collapsed result: rows shown, and the columns its indent takes from the width
const FOLD_ROWS = 3
const FOLD_INDENT = 10
// What a grouped row draws around a command line's runs (the dot, `Bash`, the bracket, each a Text and its text), and
// the columns that prefix takes from the line
const COMMAND_LINE_NODES = 8
const COMMAND_INDENT = 7
// What the rest of a grouped row takes in its tree beside its command and output rows: its boxes, the ⎿ and both fold
// hints, as nodes and as characters
const ROW_FRAME_NODES = 12
const ROW_FRAME_CHARACTERS = 120
// A redraw asked for a grouped row (its group folded or unfolded, or was learned after the row was drawn) waits this
// long, so the group events of one drawing pass ask for one redraw between them
const REGROUP_REDRAW_DELAY_MS = 50
// A call asks for at most this many such redraws in one burst: two views of one call that each undid the other's record
// would otherwise redraw without end
const MAX_REGROUP_REDRAWS = 20
// A burst ends once no such redraw has been asked for this long, and every call may ask again: a person folding and
// unfolding a group does so seconds apart, a loop of redraws milliseconds apart
const REGROUP_QUIET_MS = 2000

// the colours of commands and snippets, by their text
const cache = new Map<string, Colours>()
// commands and snippets whose colours are being made, by their text: kept out of `cache`, whose bound could push one
// out while it waits for a worker, before its row is ever coloured, and every redraw would then queue it again
const colouring = new Set<string>()
// command and snippet rows drawn in colour, by call: one whose colours were pushed out of `cache` since is drawn by
// Claude Code rather than coloured again, so redrawing more rows than `cache` holds cannot start workers without end
const colouredRows = new Map<string, true>()
// calls whose expanded Output block Claude Code drew first and the main screen cannot redraw whole (see
// isTooTallToRedraw): the block stays as Claude Code drew it while expanded
const keptAsDrawn = new Map<string, true>()
// the colours of Output blocks, per call and plan, each with the text it was made from: a lookup for any other text
// misses (another mod can rewrite a call's record after the tool.call hook coloured it, as secret-guard masks secrets),
// and the key stays short. Two versions are kept, so two drawings of one call's text (the record before and after a
// rewrite, two surfaces) do not push each other out and start workers in turn
const outputColours = new Map<string, Array<{ source: string; colours: Colours }>>()
// Output blocks whose colours are being made, by call, plan and exact text: kept out of `outputColours`, whose bound
// could push out a version still waiting for its worker, and a redraw would then colour it again
const colouringOutputs = new Set<string>()
const pendingKey = (payload: OutputPayload) => `${outputKey(payload)}\u0000${payload.output}`
// Output blocks whose colours were made and then pushed out of a full outputColours: Claude Code draws them as they
// are, as colouring one again would push out another, and with more blocks drawn than it holds every redraw would start
// workers without end
const pushedOut = new Map<string, true>()
// each call's command, which plans its Output block
const commands = new Map<string, string>()
// outputPayload's answers, per call and command, each with the capped text it was planned from, so a redraw does not
// plan the same block again
const payloads = new Map<string, { head: string; payload: OutputPayload | null }>()
// calls whose Output block was drawn before their command was known (a resumed session draws results first)
const waitingForCommand = new Map<string, true>()
// Bash calls drawn as rows of a group on the terminal's main screen, by call: true when Claude Code drew the group
// collapsed and this mod unfolded it (the row folds its command and output), false when Claude Code expanded it
// (ctrl+o, verbose). A grouped row draws its result itself; no ToolResult is drawn for it
const grouped = new Map<string, boolean>()
// expanded Bash rows with a result that were answered before any group named them: a group that names one later asks
// for a redraw, so the row gains its output (verbose mode draws a resumed group's rows before the group)
const drawnBare = new Map<string, true>()
// how many redraws each call has asked for as a grouped row in the current burst, against MAX_REGROUP_REDRAWS
const regroupRedraws = new Map<string, number>()
// every such request made, counted or refused: each one waits REGROUP_QUIET_MS and, when none came after it, ends the burst
let regroupAsks = 0
// whether a redraw for grouped rows is already waiting out its delay
let isRegroupRedrawAsked = false
// grouped rows first drawn before their colours were back and too tall for the main screen to redraw, by call and
// fold state: such a row keeps its plain styling in that state (its text is still read from each drawing's record)
const keptPlain = new Map<string, true>()
let options: Options = { editor: 'auto', theme: '', strength: 0.55, codeStrength: 1, outputStrength: 0.75, collapsedLines: 3 }

/**
 * A theme colour as its red, green and blue channels, or null when it is not a hex colour.
 *
 * Themes write colours as `#RRGGBB`, and also as `#RGB` and `#RGBA` (vesper, laserwave, synthwave-84) or `#RRGGBBAA`
 * (light-plus): the short forms are widened and an alpha is dropped, as a terminal draws text opaque. Called by
 * {@link soften}.
 *
 * @param hex - The colour as the theme wrote it.
 * @returns `[r, g, b]` from 0 to 255, or null for anything else
 * @example
 * channels('#fff') // => [255, 255, 255]
 * channels('#000000ff') // => [0, 0, 0]
 */
const channels = (hex: string) => {
  const digits = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex)?.[1]
  if (digits === undefined) return null
  // #RGB and #RGBA repeat each digit; the alpha, last, is dropped either way
  const full = digits.length <= 4 ? [...digits].map(d => d + d).join('') : digits
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16))
}

// pulls a theme colour toward grey: strength 1 keeps it, 0 makes it grey
const soften = (hex: string, strength: number) => {
  const colour = channels(hex)
  // a colour that is not hex is drawn as the theme wrote it
  if (strength >= 1 || colour === null) return hex
  const grey = channels(DIM_TO) ?? [0, 0, 0]
  const mixed = colour.map((c, n) => {
    const g = grey[n] ?? 0
    return Math.round(g + (c - g) * strength)
  })
  return `#${mixed.map(c => c.toString(16).padStart(2, '0')).join('')}`
}

// a command's or a snippet's colours are found by its text
const keyOf = (payload: Exclude<Payload, OutputPayload>) => ('code' in payload ? `code:${payload.language}:${payload.code}` : `cmd:${payload.command}`)

// an Output block's colours are kept per call and plan: a command learned later (a resumed session) plans it differently
const outputKey = (payload: OutputPayload) => `${payload.id}:${payload.plan.language ?? ''}:${payload.plan.shapes.join(',')}`

/**
 * Keeps a bounded map from growing past `max` entries ({@link MAX_CACHED} unless given), oldest out first.
 *
 * @param onPushOut - Told the key of an entry pushed out to make room.
 */
const remember = <V,>(map: Map<string, V>, key: string, value: V, max = MAX_CACHED, onPushOut?: (key: string) => void) => {
  map.set(key, value)
  if (map.size <= max) return
  const oldest = map.keys().next().value as string
  map.delete(oldest)
  onPushOut?.(oldest)
}

/**
 * The colours cached for a payload: a command's or a snippet's by its text, an Output block's only when they were made
 * from the same text, and `'plain'` for an Output block whose colours were pushed out of the cache.
 *
 * Called by every hook before it colours or draws.
 *
 * @param payload - What was asked to be coloured.
 * @returns the cached colours, or undefined when none were made for this text
 * @example
 * coloursOf({ command: 'ls -la' }) // => { lines: [[{ t: 'ls', fg: '#8cb6ff', ... }, ...]], editor: 'vscode', theme: '...' }
 */
const coloursOf = (payload: Payload): Colours | undefined => {
  if (!('output' in payload)) {
    const key = keyOf(payload)
    return colouring.has(key) ? 'pending' : cache.get(key)
  }
  // a version waiting for its worker is answered first, whatever the bounded cache kept
  if (colouringOutputs.has(pendingKey(payload))) return 'pending'
  const key = outputKey(payload)
  const kept = outputColours.get(key)
  // colours of the same call and plan made from other text (the record before another mod rewrote it) are no answer
  if (kept !== undefined) return kept.find(version => version.source === payload.output)?.colours
  // coloured once and pushed out since: Claude Code draws it, so redrawing many blocks cannot start workers forever
  return pushedOut.has(key) ? 'plain' : undefined
}

/** Caches a payload's colours where {@link coloursOf} finds them. Called by {@link highlight}. */
const keepColours = (payload: Payload, colours: Colours) => {
  if ('output' in payload) {
    // a version waiting for its worker stays apart; only made colours take one of the two places per call and plan
    if (colours === 'pending') {
      colouringOutputs.add(pendingKey(payload))
      return
    }
    colouringOutputs.delete(pendingKey(payload))
    const key = outputKey(payload)
    // this text's version replaces its older self; of the other versions, the newest stays
    const others = (outputColours.get(key) ?? []).filter(version => version.source !== payload.output)
    remember(outputColours, key, [...others.slice(-1), { source: payload.output, colours }], MAX_CACHED, pushed => remember(pushedOut, pushed, true, MAX_CALLS))
  } else {
    const key = keyOf(payload)
    // a command waiting for its colours stays apart until they are made; then they join the bounded cache
    if (colours === 'pending') colouring.add(key)
    else {
      colouring.delete(key)
      remember(cache, key, colours)
    }
  }
}

// whether any run of a result has a colour or a style
const isColoured = (result: Result) => result.lines.some(runs => runs.some(r => r.fg !== null || r.b || r.i || r.u))

let workersRunning = 0
// highlights waiting for a worker slot, the newest first: in a resumed session the rows drawn last are the ones the
// screen can still redraw, and a call that just returned is waiting for its colours
const workersWaiting: Array<() => void> = []

/** Takes a worker slot, waiting while {@link MAX_WORKERS} are taken. Called by {@link highlight}. */
const startWork = (): Promise<void> => {
  if (workersRunning < MAX_WORKERS) {
    workersRunning++
    return Promise.resolve()
  }
  return new Promise(go => workersWaiting.push(go))
}

/** Gives a worker slot back: to the newest highlight waiting for one, else to the pool. Called by {@link highlight}. */
const endWork = () => {
  const next = workersWaiting.pop()
  if (next !== undefined) next()
  else workersRunning--
}

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
  await startWork()

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
  } finally {
    endWork()
  }
  $.ui.invalidate('ui.render')
}

/**
 * The stderr Claude Code's Bash renderer draws: without the `<sandbox_violations>` reports Claude Code appends to it
 * and takes out again before drawing (2.1.332), trimmed.
 *
 * Read with indexOf rather than a lazy regex, so an unclosed report in a long stderr stays linear. Called by
 * {@link colourableResult}.
 *
 * @param stderr - A Bash result's stderr.
 * @returns the stderr as drawn; empty when only reports or blank space were in it
 * @example
 * shownStderr('\n<sandbox_violations>\nnetwork denied\n</sandbox_violations>') // => ''
 */
const shownStderr = (stderr: string) => {
  const OPEN = '<sandbox_violations>'
  const CLOSE = '</sandbox_violations>'
  let shown = ''
  let from = 0
  // cut out each report, from its opening tag to the first closing tag after it; an unclosed one stays, as in Claude Code
  for (let open = stderr.indexOf(OPEN); open !== -1; open = stderr.indexOf(OPEN, from)) {
    const close = stderr.indexOf(CLOSE, open + OPEN.length)
    if (close === -1) break
    shown += stderr.slice(from, open)
    from = close + CLOSE.length
  }
  return (shown + stderr.slice(from)).trim()
}

/**
 * The part of a Bash result this mod colours, and whether Claude Code still has sibling rows to draw under it.
 *
 * Sibling rows are what Claude Code's own Bash renderer draws after the stdout: stderr (in practice only its
 * "Shell cwd was reset to …" notice, since a command's own stderr is merged into stdout), an edit diff and viewed
 * images. The `ToolResult` hook draws the coloured stdout and lets Claude Code draw those rows beneath it. A
 * persisted-output note alone is not one, nor a stderr holding only Claude Code's sandbox-violations report: for an
 * emptied stdout with nothing else, Claude Code draws "(No output)". Nor is an exit code's explanation (`diff` exiting
 * 1 for "Files differ"), which Claude Code draws only in place of an empty stdout. Called by the `tool.call` hook (to
 * colour before the first draw) and the `ToolResult` hook.
 *
 * @param output - The tool's result record.
 * @returns the stdout with its trailing blank space cut and the sibling rows (the stderr as drawn, whether an edit diff
 *   or images follow, whether any sibling row exists), or null when Claude Code should draw the whole result (an
 *   interrupt, an image, a background task, no stdout, or a character a drawn Text refuses, as an ANSI colour's ESC)
 * @example
 * colourableResult({ stdout: 'a\nb\n', stderr: '' })
 * // => { stdout: 'a\nb', stderr: '', hasUncountedRows: false, hasSiblings: false }
 * colourableResult({ stdout: 'a', stderr: '\nShell cwd was reset to /x' })
 * // => { stdout: 'a', stderr: 'Shell cwd was reset to /x', hasUncountedRows: false, hasSiblings: true }
 * colourableResult({ stdout: 'a', interrupted: true }) // => null
 */
const colourableResult = (output: unknown): Colourable | null => {
  const out = output as BashOutput | null
  if (out === null || typeof out !== 'object' || typeof out.stdout !== 'string') return null
  if (out.interrupted === true || out.isImage === true || out.backgroundTaskId) return null
  // trimEnd, not a /\s+$/ replace: that retries from every space of a long run inside the text, quadratic in its length
  const stdout = out.stdout.trimEnd()
  // a tree holding a character Text refuses is refused, and with the sibling rows asked for, their drawing would stand
  // alone with the stdout taken out
  if (stdout === '' || REFUSED_IN_TEXT.test(stdout)) return null
  const stderr = typeof out.stderr === 'string' ? shownStderr(out.stderr) : ''
  const hasImages = Array.isArray(out.viewedImagePaths) && out.viewedImagePaths.length > 0
  // an edit diff and images take rows that only Claude Code, which draws them, can count
  const hasUncountedRows = Boolean(out.bashEditDiff) || hasImages
  return { stdout, stderr, hasUncountedRows, hasSiblings: stderr !== '' || hasUncountedRows }
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
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u
const cellsOf = (ch: string) => (WIDE.test(ch) ? 2 : 1)

/**
 * Whether an expanded Output block on the terminal's main screen is too tall for the screen to redraw whole.
 *
 * The main screen cannot rewrite rows that have scrolled off it, so a block Claude Code drew before its colours were
 * back (a resumed session, a slow worker) and then redrawn in colour would leave the scrolled-off rows of the first
 * drawing above the new one, doubled. The sibling rows under the stdout are part of that drawing: stderr's rows are
 * counted with the stdout's, and a block with an edit diff or images, whose rows cannot be counted here, is taken as
 * too tall. Collapsed, a block takes a few rows; in fullscreen the screen redraws all of itself. Called by the
 * `ToolResult` hook whenever Claude Code draws a block it colours.
 *
 * @param drawn - The block's stdout and its sibling rows, from {@link colourableResult}.
 * @param isExpanded - Whether every line is drawn (ctrl+o, verbose), not the fold.
 * @param viewport - The render event's screen size and kind; absent where no surface has measured.
 * @returns true when the block's wrapped rows, its sibling rows and the prompt below them pass the main screen's height
 * @example
 * const mainScreen = { columns: 80, rows: 24, isFullscreen: false }
 * isTooTallToRedraw({ stdout: fortyLines, stderr: '', hasUncountedRows: false, hasSiblings: false }, true, mainScreen) // => true
 * isTooTallToRedraw({ stdout: 'a', stderr: '', hasUncountedRows: true, hasSiblings: true }, true, mainScreen) // => true
 */
const isTooTallToRedraw = (drawn: Colourable, isExpanded: boolean, viewport: { columns: number; rows: number; isFullscreen?: boolean } | undefined) => {
  if (!isExpanded || viewport === undefined || viewport.isFullscreen !== false) return false
  if (drawn.hasUncountedRows) return true
  const width = Math.max(viewport.columns - FOLD_INDENT, 10)
  let rows = PROMPT_ROWS
  // add each line's wrapped rows, the stdout's and then the stderr's, in the cells a terminal gives it (two for a wide
  // character), stopping once past the screen
  for (const line of (drawn.stderr === '' ? drawn.stdout : `${drawn.stdout}\n${drawn.stderr}`).split('\n')) {
    let cells = 0
    for (const ch of line) cells += cellsOf(ch)
    rows += Math.max(1, Math.ceil(cells / width))
    if (rows > viewport.rows) return true
  }
  return false
}

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
  let total = 0
  // a finished row is kept while it may be shown (the first FOLD_ROWS, and a fourth); the rest are only counted
  const endRow = (row: Run[]) => {
    total++
    if (rows.length <= FOLD_ROWS) rows.push(row)
  }
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
          endRow(row)
          row = []
          used = 0
          part = ''
        }
        part += ch
        used += cells
      }
      if (part !== '') row.push({ ...run, t: part })
    }
    endRow(row)
  }
  const hidden = total - FOLD_ROWS
  if (hidden === 1) return { rows, hidden: 0 }
  return { rows: rows.slice(0, FOLD_ROWS), hidden: Math.max(0, hidden) }
}

/**
 * Lines of text as uncoloured rows, one run each (an empty line, no run), as {@link renderRuns} takes them.
 *
 * Called for the part of an Output block past the colouring cap, and by {@link groupedRow} for a command or an output
 * whose colours are not back.
 *
 * @param lines - The lines of text.
 * @returns one row of runs per line
 * @example
 * plainRows(['a', '']) // => [[{ t: 'a', fg: null, b: false, i: false, u: false }], []]
 */
const plainRows = (lines: string[]): Run[][] => lines.map(line => (line === '' ? [] : [{ t: line, fg: null, b: false, i: false, u: false }]))

/**
 * How many terminal rows lines of text take once wrapped, counted up to a limit.
 *
 * Called by {@link groupedRow} to tell whether its whole row passes the main screen's height.
 *
 * @param lines - The lines of text.
 * @param width - The cells a row holds.
 * @param limit - Counting stops once the rows pass this many.
 * @returns the rows the lines take, or a number past `limit` once they pass it
 * @example
 * wrappedRows(['abcdef', ''], 4, 100) // => 3
 */
const wrappedRows = (lines: string[], width: number, limit: number) => {
  let rows = 0
  // each line takes at least one row, and one more for every `width` cells past the first (two cells for a wide character)
  for (const line of lines) {
    let cells = 0
    for (const ch of line) cells += cellsOf(ch)
    rows += Math.max(1, Math.ceil(cells / width))
    if (rows > limit) break
  }
  return rows
}

/**
 * The hover scope of a call's rows. The engine takes a scope of 1 to 64 characters and refuses a tree holding a
 * longer one, so a long call id (a gateway's) keeps only its last 40 characters, where ids differ. Called by the
 * `ToolResult` and `ToolUse` hooks.
 *
 * @param kind - `out:` for an Output block, '' for a command row.
 * @param id - The call's tool_use_id.
 * @returns a scope of at most 61 characters
 * @example
 * scopeOf('out:', 'toolu_01AbC') // => 'syntax-highlight:out:toolu_01AbC'
 */
const scopeOf = (kind: string, id: string) => `syntax-highlight:${kind}${id.slice(-40)}`

/**
 * How many nodes an Output block's rows take in a drawn tree: each row is a Text, and each of its runs a Text holding
 * its text (an empty row, one run of a space), as {@link renderRuns} draws them.
 *
 * The `ToolResult` hook checks it against {@link MAX_DRAWN_NODES} before drawing: the engine refuses a tree past its
 * bound, and Claude Code's drawing then stands in its place.
 *
 * @param rows - The rows to be drawn, each a list of runs.
 * @returns the nodes the rows take
 * @example
 * drawnNodes([[{ t: 'a', fg: null, b: false, i: false, u: false }], []]) // => 6
 */
const drawnNodes = (rows: Run[][]) => rows.reduce((sum, runs) => sum + 1 + 2 * Math.max(runs.length, 1), 0)

/**
 * How many characters of text an Output block's rows show in a drawn tree, counted as the engine counts its 100,000:
 * an empty row draws one space ({@link renderRuns}).
 *
 * The `ToolResult` hook checks it against {@link MAX_DRAWN_CHARACTERS} before drawing: past it, the engine would cut the
 * block's end with no mark, where Claude Code draws it whole.
 *
 * @param rows - The rows to be drawn, each a list of runs.
 * @returns the characters the rows show
 * @example
 * drawnCharacters([[{ t: 'abc', fg: null, b: false, i: false, u: false }], []]) // => 3
 */
const drawnCharacters = (rows: Run[][]) => rows.reduce((sum, runs) => sum + (runs.length === 0 ? 1 : runs.reduce((n, run) => n + run.t.length, 0)), 0)

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

/**
 * Draws an Output block as Claude Code draws a result: behind `⎿`, one Text per row, and the fold's hint when rows
 * were left out.
 *
 * Called by the `ToolResult` hook for a standalone row's block and by {@link groupedRow} for a grouped row's, once the
 * caller has checked the rows against the tree's bounds.
 *
 * @param Box - The surface's Box element.
 * @param Text - The surface's Text element.
 * @param rows - The rows to draw, folded or not.
 * @param hidden - How many rows the fold left out; 0 draws no hint.
 * @param scope - The hover scope of the block's rows.
 * @returns the block's tree
 */
const drawOutput = (Box: any, Text: any, rows: Run[][], hidden: number, scope: string) => (
  <Box flexDirection="row">
    <Text dimColor>{'  ⎿  '}</Text>
    <Box flexDirection="column">
      {rows.map(runs => (
        <Text wrap="wrap" hover={{ scope }}>{renderRuns(Text, runs, options.outputStrength, scope, false)}</Text>
      ))}
      {hidden > 0 ? <Text dimColor>{`… +${hidden} line${hidden === 1 ? '' : 's'} (ctrl+o to expand)`}</Text> : null}
    </Box>
  </Box>
)

/**
 * Draws a Bash command's lines as Claude Code draws a tool row: `⏺ Bash(` before the first, an indent before the
 * rest, the closing bracket after the last, and the fold's hint when lines were left out.
 *
 * Called by the `ToolUse` hook for a standalone row and by {@link groupedRow} for a grouped one.
 *
 * @param Text - The surface's Text element.
 * @param shown - The command's lines to draw.
 * @param hidden - How many lines the fold left out; 0 draws no hint.
 * @param dot - The colour of the row's dot: `success`, `error` or `inactive` (still running).
 * @param scope - The hover scope of the row's lines.
 * @returns the row's elements, to be put in a column
 */
const drawCommand = (Text: any, shown: Run[][], hidden: number, dot: string, scope: string) => [
  ...shown.map((runs, n) => (
    <Text wrap="wrap" hover={{ scope }}>
      {n === 0 ? <Text color={dot}>⏺ </Text> : <Text>{'  '}</Text>}
      {n === 0 ? <Text weight="bold">Bash</Text> : <Text>{'    '}</Text>}
      <Text dimColor>{n === 0 ? '(' : ' '}</Text>
      {renderRuns(Text, runs, options.strength, scope)}
      {n === shown.length - 1 && hidden === 0 ? <Text dimColor>)</Text> : null}
    </Text>
  )),
  hidden > 0 ? <Text dimColor>{`      … +${hidden} line${hidden === 1 ? '' : 's'}) (ctrl+o to expand)`}</Text> : null,
]

/** What of a render event tells where it is drawn; the terminal always says whether it is fullscreen. */
type DrawnOn = { surface: string; viewport?: { columns: number; rows: number; isFullscreen?: boolean } }

/**
 * Whether a render event is drawn on the terminal's main screen, the one place grouped rows draw their output.
 *
 * In fullscreen the ctrl+o transcript draws a group's calls as standalone rows, each with its own `ToolResult`, and
 * nothing in a `ToolUse` event tells that view from the main one, where the same calls are grouped rows: a row that
 * drew its output there would show it twice. Other surfaces are not known to raise groups the same way. Called by the
 * `ToolGroup`, `ToolResult` and `ToolUse` hooks.
 *
 * @param e - The render event.
 * @returns true on the terminal when it is not fullscreen
 */
const isMainScreen = (e: DrawnOn) => e.surface === 'terminal' && e.viewport?.isFullscreen === false

/**
 * Asks for one redraw of the drawn rows on behalf of grouped calls whose record changed, after a short delay that
 * gathers the requests of one drawing pass.
 *
 * Called by the `ToolGroup` hook (a group folded or unfolded, or named a row already drawn without its output) and by
 * the `ToolResult` hook (a call drawn standalone after all). Each call may ask {@link MAX_REGROUP_REDRAWS} times in a
 * burst; past that its record still changes and its row keeps its last drawing until another redraw reaches it. A
 * burst ends once {@link REGROUP_QUIET_MS} pass with no request, so ctrl+o pressed seconds apart is never refused,
 * while requests that keep coming (two views undoing each other's record) stop at the bound.
 *
 * @param $ - The engine interface, for the delay and the redraw.
 * @param ids - The calls whose rows need the redraw.
 * @example
 * askRegroupRedraw($, ['toolu_01AbC']) // one `$.ui.invalidate('ui.render')` some 50 ms later
 */
const askRegroupRedraw = ($: EngineInterface, ids: string[]) => {
  const ask = ++regroupAsks
  // each request waits out the quiet time on its own; the last one of a burst finds no later request and lets every
  // call ask again
  void (async () => {
    try {
      await $.clock.sleep(REGROUP_QUIET_MS)
      if (regroupAsks === ask) regroupRedraws.clear()
    } catch {
      // a wait that fails leaves the counts as they are; a later request ends the burst
    }
  })()
  let isAllowed = false
  // count the request against each call; one call still under its bound is enough to ask
  for (const id of ids) {
    const asked = regroupRedraws.get(id) ?? 0
    if (asked >= MAX_REGROUP_REDRAWS) continue
    remember(regroupRedraws, id, asked + 1, MAX_CALLS)
    isAllowed = true
  }
  if (!isAllowed || isRegroupRedrawAsked) return
  isRegroupRedrawAsked = true
  void (async () => {
    try {
      await $.clock.sleep(REGROUP_REDRAW_DELAY_MS)
    } catch {
      // a delay that fails still ends in the redraw
    } finally {
      isRegroupRedrawAsked = false
    }
    $.ui.invalidate('ui.render')
  })()
}

/** The part of a `ToolUse` render event {@link groupedRow} reads. */
type GroupedRowEvent = DrawnOn & { props: { isRunning: boolean; isErrored: boolean; isInterrupted: boolean; output?: unknown } }

/**
 * Draws a Bash call that is a row of a group: its command and, once it has one, its result under it.
 *
 * A group's rows draw their result inline; Claude Code raises no `ToolResult` for them, so a row holding only the
 * command would show no output. The row is drawn in Claude Code's layout: folded like a collapsed standalone row
 * (the command to `collapsedLines`, the output to three rows) when this mod unfolded the group, in full when Claude
 * Code expanded it. A part whose colours are not back is drawn plain, with the rows it will have once coloured.
 * Called by the `ToolUse` hook for a call the `ToolGroup` hook recorded, on the terminal's main screen only.
 *
 * @param $ - The engine interface, to start colouring what has no colours yet.
 * @param e - The row's render event.
 * @param elements - The surface's Box and Text elements.
 * @param id - The call's `tool_use_id`.
 * @param command - The call's command, its trailing blank space cut.
 * @param isFolded - Whether the group was collapsed when Claude Code asked for it (see `grouped`).
 * @returns the row's tree, or null when Claude Code should draw the whole row: an error, an interrupt, a result
 *   {@link colourableResult} hands back or one with sibling rows (only Claude Code can draw them, and only with the row),
 *   an empty command, or a row past the bounds of one tree
 */
const groupedRow = ($: EngineInterface, e: GroupedRowEvent, elements: { Box: any; Text: any }, id: string, command: string, isFolded: boolean) => {
  if (e.props.isErrored || e.props.isInterrupted || command.trim() === '' || e.viewport === undefined) return null
  const hasOutput = e.props.output !== undefined
  const result = hasOutput ? colourableResult(e.props.output) : null
  if (hasOutput && (result === null || result.hasSiblings)) return null
  const { head, rest } = result === null ? { head: '', rest: [] } : capOutput(result.stdout)
  // not even the first line fits the colouring cap: Claude Code draws the row
  if (result !== null && head === '') return null

  // a command pushed out of the cache after its row was coloured is not coloured again (see colouredRows)
  const commandColours = coloursOf({ command }) ?? (colouredRows.has(id) ? 'plain' : undefined)
  if (commandColours === undefined) void highlight($, { command })
  const payload = result === null ? null : outputPayload(id, head)
  const outputColours = payload === null ? 'plain' : coloursOf(payload)
  if (payload !== null && outputColours === undefined) void highlight($, payload)

  const commandText = command.split('\n')
  const outputText = result === null ? [] : [...head.split('\n'), ...rest]
  const commandWidth = Math.max(e.viewport.columns - COMMAND_INDENT, 10)
  const outputWidth = Math.max(e.viewport.columns - FOLD_INDENT, 10)
  // a row whose colours are still to come is drawn again once they are back: one too tall for the main screen to redraw
  // whole keeps its plain styling in this fold state, so no scrolled-off rows of this drawing are left above a new one
  const kept = `${id}:${isFolded ? 'folded' : 'full'}`
  const isStillColouring = [commandColours, outputColours].some(colours => colours === undefined || colours === 'pending')
  if (isStillColouring && !keptPlain.has(kept)) {
    const shownCommand = isFolded ? commandText.slice(0, options.collapsedLines) : commandText
    // the blank line above the row and both fold hints are counted, as the prompt below is
    let rows = PROMPT_ROWS + 3 + wrappedRows(shownCommand, commandWidth, e.viewport.rows)
    // folded, the output takes its wrapped rows up to the fold's four (three and the hint, or all four)
    if (rows <= e.viewport.rows) rows += isFolded ? Math.min(FOLD_ROWS + 1, wrappedRows(outputText, outputWidth, FOLD_ROWS)) : wrappedRows(outputText, outputWidth, e.viewport.rows)
    if (rows > e.viewport.rows) remember(keptPlain, kept, true, MAX_CALLS)
  }
  const isKeptPlain = keptPlain.has(kept)

  const isCommandColoured = typeof commandColours === 'object' && !isKeptPlain
  const commandLines = isCommandColoured ? commandColours.lines : plainRows(commandText)
  // a command whose colours were made is noted even when the row is kept plain: once they are pushed out of the cache,
  // the row is not sent to a worker again, which would push out another row's and so on without end
  if (typeof commandColours === 'object') remember(colouredRows, id, true, MAX_CALLS)
  const shown = isFolded ? commandLines.slice(0, options.collapsedLines) : commandLines
  const hiddenLines = commandLines.length - shown.length
  const outputLines = typeof outputColours === 'object' && !isKeptPlain ? [...outputColours.lines, ...plainRows(rest)] : plainRows(outputText)
  const { rows, hidden } = isFolded ? foldRows(outputLines, outputWidth) : { rows: outputLines, hidden: 0 }
  // everything the row draws is counted, the command's own prefixes too: past the engine's bounds the tree is refused
  // or its end, the output, cut with no mark, where Claude Code draws the row whole
  const nodes = drawnNodes(shown) + COMMAND_LINE_NODES * shown.length + drawnNodes(rows) + ROW_FRAME_NODES
  const characters = drawnCharacters(shown) + COMMAND_INDENT * shown.length + drawnCharacters(rows) + ROW_FRAME_CHARACTERS
  if (nodes > MAX_DRAWN_NODES || characters > MAX_DRAWN_CHARACTERS) return null

  const { Box, Text } = elements

  return (
    <Box flexDirection="column" marginTop={1}>
      {drawCommand(Text, shown, hiddenLines, e.props.isRunning ? 'inactive' : 'success', scopeOf('', id))}
      {result === null ? null : drawOutput(Box, Text, rows, hidden, scopeOf('out:', id))}
    </Box>
  )
}

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
    remember(commands, e.tool_use_id, command, MAX_CALLS)
    // a subagent's or teammate's call is not drawn in this transcript as it ends: colouring it now would take workers
    // and cache places from rows that are, and hold the call up. A drawing of its rows colours them then
    if (e.agentId !== undefined) return next(e)
    if (command !== '' && coloursOf({ command }) === undefined) void highlight($, { command })

    const done = await next(e)
    const result = 'result' in done && done.result !== undefined && !done.isError ? colourableResult(done.result) : null
    const payload = result === null ? null : outputPayload(e.tool_use_id, capOutput(result.stdout).head)
    // wait a little for the colours: the result row is drawn once the call returns, and a terminal may not redraw it
    if (payload !== null && coloursOf(payload) === undefined) await Promise.race([highlight($, payload), $.clock.sleep(OUTPUT_WAIT_MS)])

    return done
  }).catch(($, e, next) => next(e))

  // a group of calls draws one collapsed line ("Running ..."), where Bash commands would stay unhighlighted: unfold it
  // into its own ToolUse rows (drawn below) whenever it holds a Bash call. Its Bash calls are recorded first, with
  // whether Claude Code drew the group collapsed, so each row draws its own result, folded or not (see groupedRow)
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (isMainScreen(e)) {
      const isFolded = !e.props.isExpanded
      const redrawn: string[] = []
      for (const call of e.props.calls) {
        const id = call.tool_use_id
        if (call.tool !== 'Bash' || typeof id !== 'string') continue
        const before = grouped.get(id)
        if (before === isFolded) continue
        remember(grouped, id, isFolded, MAX_CALLS)
        // a row drawn for the other fold state, or drawn without its output before this group named it, is drawn again
        if (drawnBare.delete(id) || before !== undefined) redrawn.push(id)
      }
      if (redrawn.length > 0) askRegroupRedraw($, redrawn)
    }
    if (e.props.isExpanded || !e.props.calls.some(call => call.tool === 'Bash')) return next(e)
    return next({ ...e, props: { ...e.props, isExpanded: true } })
  }).catch(($, e, next) => next(e))

  // a Bash call's Output block, drawn as Claude Code draws it (the ⎿ indent, the fold) with its text coloured, and
  // Claude Code's own sibling rows (the cwd notice, stderr, an edit diff, images) drawn by Claude Code beneath it
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.tool !== 'Bash') return next(e)
    const id = e.props.tool_use_id
    // a result drawn on its own belongs to a standalone row: a call recorded as a grouped row is one no longer, and its
    // row is drawn again without the output this block now shows
    if (isMainScreen(e) && grouped.delete(id)) askRegroupRedraw($, [id])
    if (e.props.isErrored) return next(e)
    const result = colourableResult(e.props.output)
    if (result === null) return next(e)
    const isExpanded = e.props.isExpanded === true
    // Claude Code draws the block until its colours are back; an expanded one too tall, with its sibling rows, for the
    // main screen to redraw whole stays as Claude Code drew it, so no scrolled-off rows of this drawing are left
    // doubled above a coloured one
    const drawnByClaudeCode = () => {
      if (isTooTallToRedraw(result, isExpanded, e.viewport)) remember(keptAsDrawn, id, true, MAX_CALLS)
      return next(e)
    }
    // drawn before its command is known (a resumed session draws results first): Claude Code draws it until the ToolUse
    // hook learns the command and asks for a redraw, so no worker colours it from a guess first
    if (!commands.has(id)) {
      remember(waitingForCommand, id, true, MAX_CALLS)
      return drawnByClaudeCode()
    }
    const { head, rest } = capOutput(result.stdout)
    const payload = outputPayload(id, head)
    if (payload === null) return next(e)

    const done = coloursOf(payload)
    if (done === undefined) void highlight($, payload)
    if (done === undefined || done === 'pending') return drawnByClaudeCode()
    if (done === 'failed' || done === 'plain' || (isExpanded && e.viewport?.isFullscreen === false && keptAsDrawn.has(id))) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const scope = scopeOf('out:', String(e.props.tool_use_id))
    const lines = [...done.lines, ...plainRows(rest)]
    // collapsed, the block folds as Claude Code folds it; expanded (ctrl+o, verbose), every line is drawn
    const width = Math.max((e.viewport?.columns ?? 80) - FOLD_INDENT, 10)
    const { rows, hidden } = isExpanded ? { rows: lines, hidden: 0 } : foldRows(lines, width)
    // a tree past the engine's bound on nodes is refused, and one past its characters is cut: Claude Code draws the block
    if (drawnNodes(rows) > MAX_DRAWN_NODES || drawnCharacters(rows) > MAX_DRAWN_CHARACTERS) return next(e)
    const block = drawOutput(Box, Text, rows, hidden, scope)
    // the sibling rows stay Claude Code's: it draws them for this result with the stdout taken out, and draws nothing
    // for a result with none ("(No output)"), so it is asked only when there are some. It is asked last, once the rest
    // is drawn, since a hook that fails after asking leaves that answer, stdout taken out, standing. The exit code's
    // explanation is left out too: Claude Code draws it only in place of an empty stdout, which this one is not
    const { returnCodeInterpretation: _explanation, ...output } = e.props.output as Record<string, unknown>
    const siblings = result.hasSiblings ? await next({ ...e, props: { ...e.props, output: { ...output, stdout: '' } } }) : null

    return (
      <Box flexDirection="column">
        {block}
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
      const isFolded = isMainScreen(e) ? grouped.get(id) : undefined
      // a row of a group draws its own result, which no ToolResult will; a row it cannot draw whole is Claude Code's
      if (isFolded !== undefined) return groupedRow($, e, $.ui.resolve(e), id, input.command.trimEnd(), isFolded) ?? next(e)
      // an expanded row with a result that no group has named yet: a group naming it later draws it again (see drawnBare)
      if (isMainScreen(e) && e.props.isExpanded === true && e.props.output !== undefined) remember(drawnBare, id, true, MAX_CALLS)
    }

    const payload: Exclude<Payload, OutputPayload> | null = isShow
      ? typeof input?.code === 'string' ? { code: input.code.trimEnd(), language: String(input.language ?? '') } : null
      : typeof input?.command === 'string' && input.command.trim() !== '' ? { command: input.command.trimEnd() } : null
    if (payload === null) return next(e)

    const row = e.props.tool_use_id === undefined ? null : String(e.props.tool_use_id)
    // a command row coloured before whose colours were pushed out of the cache since: Claude Code draws it, so redrawing
    // more rows than the cache holds starts no workers without end. A snippet is coloured again instead: its panel is
    // the one place show_code draws its code, and a session shows few
    const done = coloursOf(payload) ?? (row !== null && isBash && colouredRows.has(row) ? 'plain' : undefined)
    if (done === undefined) void highlight($, payload)
    if (done === undefined || done === 'pending' || done === 'failed' || done === 'plain') return next(e)
    if (row !== null) remember(colouredRows, row, true, MAX_CALLS)

    const { Box, Text } = $.ui.resolve(e)
    const scope = scopeOf('', String(e.props.tool_use_id ?? keyOf(payload).length))
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
        {drawCommand(Text, shown, hidden, dot, scope)}
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
