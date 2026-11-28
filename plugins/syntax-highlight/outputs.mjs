// Decides how an Output block is coloured: which Language the whole block is, and which Output shapes its lines may
// have. Shared by the hooks module (to skip blocks with nothing to colour) and tokenize.mjs (to colour them): no Node,
// no I/O. Every rule is deterministic: the same command and output always plan the same way.

import { lex, programOf } from './shell.mjs'

/**
 * @typedef {object} OutputPlan
 * @property {string | null} language - Language of the whole block, as a language id or file extension the worker
 *   resolves to a grammar (`md`, `json`, `diff`), or null when the command names none.
 * @property {string[]} shapes - Ids of the Output shapes the command can print (`ls`, `grep`, ...), in test order.
 * @property {string[]} counted - The files the command gave `wc`, as written (`release notes.md`).
 * @property {string[]} grepped - The files and folders with a space in their name a grep in the command searches.
 */

// ---------- Output shapes ----------

const STRING = '"(?:[^"\\\\]|\\\\.)*"'
const PLUTIL_VALUE = [
  { match: STRING, name: 'string.quoted.double.plutil' },
  { match: '\\b(?:true|false)\\b', name: 'constant.language.plutil' },
  { match: '-?\\b\\d+(?:\\.\\d+)?\\b', name: 'constant.numeric.plutil' },
  { match: '<[0-9a-fA-F ]+>', name: 'constant.other.data.plutil' },
]

/**
 * The Output shapes, in the order a line is tested against them. `programs` turn a shape on when the command runs one
 * of them. Whether a line has the shape is two tests: `strong`, the rows nothing but this command prints (an `ls -l`
 * mode string, a `path:12:` hit), and `weak`, the looser rows prose can look like (a line ending in `:`, a bare `12:`),
 * or null. In a block with a Language only `strong` counts, so prose stays in the Language; without one, `strong` or
 * `weak` does. Each runs in linear time: the render hook tests every line synchronously, up to 200,000 characters.
 * `patterns` colour such a line (TextMate rules, one line at a time); their regex sources are read by both JavaScript
 * and oniguruma, so they keep to syntax both share.
 */
const SHAPES = [
  {
    id: 'ls',
    // `ls -l` / `ls -la`: mode, links, owner, group, size, date, name; `total N`; `dir:` headers of a multi-folder list
    programs: ['ls', 'gls'],
    strong: /^(?:[-bcdlpsD][-rwxsStT]{9}[@+.]?\s+\d+\s|total \d+$)/,
    // `total` followed by more, and a `dir:` header, which any prose line ending in `:` also looks like
    weak: /^(?:total \d|\S.*:$)/,
    patterns: [
      { match: '^(total)(\\s+)(\\S+)$', captures: { 1: { name: 'keyword.other.total.ls' }, 3: { name: 'constant.numeric.ls' } } },
      ...['d', 'l', 'x', 'f'].map(kind => ({
        match: `^(${kind === 'd' ? 'd' : kind === 'l' ? 'l' : '[-bcpsD]'})(${kind === 'x' ? '[-rwxsStT]{2}[xsS][-rwxsStT]{6}|[-rwxsStT]{5}[xsS][-rwxsStT]{3}|[-rwxsStT]{8}[xtT]' : '[-rwxsStT]{9}'})([@+.]?)(\\s+)(\\d+)(\\s+)(\\S+)(\\s+)(\\S+)(\\s+)(\\S+(?:,\\s*\\d+)?)(\\s+)(\\S+\\s+\\S+\\s+\\S+)(\\s)(.*)$`,
        captures: {
          1: { name: 'keyword.other.type.ls' },
          2: { name: 'storage.modifier.mode.ls' },
          3: { name: 'comment.xattr.ls' },
          5: { name: 'constant.numeric.links.ls' },
          7: { name: 'variable.other.owner.ls' },
          9: { name: 'variable.other.group.ls' },
          11: { name: 'constant.numeric.size.ls' },
          13: { name: 'comment.date.ls' },
          15: kind === 'd' ? { name: 'entity.name.type.directory.ls' }
            : kind === 'l' ? { patterns: [{ match: '(.*?)( -> )(.*)', captures: { 1: { name: 'entity.name.tag.symlink.ls' }, 2: { name: 'keyword.operator.arrow.ls' }, 3: { name: 'string.unquoted.target.ls' } } }] }
              : kind === 'x' ? { name: 'entity.name.function.executable.ls' } : {},
        },
      })),
      { match: '^(\\S.*)(:)$', captures: { 1: { name: 'entity.name.section.folder.ls' } } },
    ],
  },
  {
    id: 'plutil',
    // `plutil -p`: `"key" => value` and `0 => value`
    programs: ['plutil'],
    strong: /^\s*(?:"(?:[^"\\]|\\.)*"|\d+) => /,
    weak: null,
    patterns: [
      {
        match: `^(\\s*)(${STRING})( => )(.*)$`,
        captures: { 2: { name: 'support.type.property-name.plutil' }, 3: { name: 'keyword.operator.arrow.plutil' }, 4: { patterns: PLUTIL_VALUE } },
      },
      {
        match: '^(\\s*)(\\d+)( => )(.*)$',
        captures: { 2: { name: 'constant.numeric.index.plutil' }, 3: { name: 'keyword.operator.arrow.plutil' }, 4: { patterns: PLUTIL_VALUE } },
      },
    ],
  },
  {
    id: 'git-status',
    // `git status --short` (`XY path`, `## branch...upstream [ahead 1]`) and the long form's `modified:   path` rows
    programs: ['git status'],
    // `XY path` with a status letter and nothing after the path but a rename's `-> path` (git quotes a path with a
    // space), `## branch...upstream` (dot-separated branch parts keep it linear), long-form rows
    strong: /^(?:(?:[MTADRCU?!][ MTADRCU?!]| [MTADRCU?!]) (?:"(?:[^"\\]|\\.)*"|[^\s"]\S*)(?: -> (?:"(?:[^"\\]|\\.)*"|[^\s"]\S*))?$|## [^\s.]+(?:\.[^\s.]+)*\.\.\.\S+(?: \[[^\]]+\])?$|\t(?:modified|new file|deleted|renamed|typechange|both modified|both added):\s|On branch \S+$)/,
    // status letters before more words, which prose (`MR 12 is merged`) and a diff's context line (` A simple
    // approach`) also are; a blank status; `## branch` with no upstream, which a Markdown heading (`## Usage`) also is
    weak: /^(?:[MTADRCU?!][ MTADRCU?!] \S| [MTADRCU?!] \S| {3}\S|## \S|On branch \S)/,
    patterns: [
      {
        match: '^([ MTADRCU?!])([ MTADRCU?!])( )(.*)$',
        captures: {
          1: { patterns: [{ match: 'M|T', name: 'markup.changed.git-status' }, { match: 'A|\\?', name: 'markup.inserted.git-status' }, { match: 'D', name: 'markup.deleted.git-status' }, { match: 'R|C|U|!', name: 'keyword.other.git-status' }] },
          2: { patterns: [{ match: 'M|T', name: 'markup.changed.git-status' }, { match: 'A|\\?', name: 'markup.inserted.git-status' }, { match: 'D', name: 'markup.deleted.git-status' }, { match: 'R|C|U|!', name: 'keyword.other.git-status' }] },
        },
      },
      { match: '^(## )(\\S+?)(?:(\\.\\.\\.)(\\S+))?( \\[.*\\])?$', captures: { 2: { name: 'entity.name.function.branch.git-status' }, 4: { name: 'string.unquoted.upstream.git-status' }, 5: { name: 'constant.numeric.ahead-behind.git-status' } } },
      { match: '^(On branch )(\\S+)', captures: { 2: { name: 'entity.name.function.branch.git-status' } } },
      { match: '^(\\t)(modified|typechange|both modified)(:)', captures: { 2: { name: 'markup.changed.git-status' } } },
      { match: '^(\\t)(new file|both added)(:)', captures: { 2: { name: 'markup.inserted.git-status' } } },
      { match: '^(\\t)(deleted)(:)', captures: { 2: { name: 'markup.deleted.git-status' } } },
      { match: '^(\\t)(renamed)(:)', captures: { 2: { name: 'keyword.other.git-status' } } },
    ],
  },
  {
    id: 'wc',
    // `wc -l a b`: counts, then the name (`total` for the sum)
    programs: ['wc'],
    // a first count whose spaces and digits fill exactly 8 columns, as BSD wc pads it (` %7d`), before any name
    // (`release notes.md` too), or counts before a
    // path-like name or `total`; a count indented less and followed by a word (`  3 items`) is prose. The name is read
    // with [^\n] and not `.`, which stops at a \r or U+2028 a line can hold and makes the counts before it backtrack
    // quadratically
    strong: /^(?:(?=(?: {7}\d| {6}\d{2}| {5}\d{3}| {4}\d{4}| {3}\d{5}| {2}\d{6}| \d{7}| \d{8,})(?:\s|$)) *\d+(?:\s+\d+)*(?:\s+\S[^\n]*)?|\s*\d+(?:\s+\d+)*\s+(?:[^\s./]*[./]\S*|total))$/,
    // any line of counts and text, which `2 deployments failed` also is
    weak: /^\s*\d+(?:\s+\d+)*(?:\s+\S[^\n]*)?$/,
    patterns: [
      { match: '^(\\s*)(\\d+(?:\\s+\\d+)*)(\\s+)(total)$', captures: { 2: { name: 'constant.numeric.count.wc' }, 4: { name: 'keyword.other.total.wc' } } },
      // a count has blank space or the line's end after it: the year of `2026-11-28.md` is part of the name
      { match: '^(\\s*)(\\d+(?:\\s+\\d+)*)(?=\\s|$)', captures: { 2: { name: 'constant.numeric.count.wc' } } },
    ],
  },
  {
    id: 'grep',
    // `grep -n` / `rg`: `path:line:text`, context rows `path-line-text`, `path:text` across files, `line:text` in one
    // file, `--` between groups
    programs: ['grep', 'egrep', 'fgrep', 'ggrep', 'rg', 'ag', 'git grep'],
    // `path:line:` where the path has a `/` or `.` (the first class leaves out `./`, so the match is linear); the
    // groups give the hit's path and line number to adoptContextRows
    strong: /^([^:\s./]*[./][^:\s]*):(\d+):/,
    // context rows, `path:` without a line, a bare `12:` from one file, `--`: dates, times and `7-day` look the same
    weak: /^(?:[^:\s][^:]*?[:-]\d+[:-]|[^:\s/]*\/[^:]*:|[^:\s/]+\.[A-Za-z0-9]+:|\d+[:-]|--$)/,
    patterns: [
      { match: '^(--)$', captures: { 1: { name: 'comment.separator.grep' } } },
      {
        match: '^([^:\\s][^:]*?)([:-])(\\d+)([:-])',
        captures: { 1: { name: 'entity.name.type.path.grep' }, 2: { name: 'punctuation.separator.grep' }, 3: { name: 'constant.numeric.line.grep' }, 4: { name: 'punctuation.separator.grep' } },
      },
      { match: '^([^:\\s]*/[^:]*|[^:\\s/]+\\.[A-Za-z0-9]+)(:)', captures: { 1: { name: 'entity.name.type.path.grep' }, 2: { name: 'punctuation.separator.grep' } } },
      { match: '^(\\d+)([:-])', captures: { 1: { name: 'constant.numeric.line.grep' }, 2: { name: 'punctuation.separator.grep' } } },
    ],
  },
]

const SHAPE_BY_ID = new Map(SHAPES.map(shape => [shape.id, shape]))

/** Every Output shape id, in test order: what an Output block of an unknown command is tested against. */
export const SHAPE_IDS = SHAPES.map(shape => shape.id)

/**
 * The TextMate scope an Output shape's grammar is registered under.
 *
 * @param id - An Output shape id from {@link SHAPE_IDS}.
 * @returns the scope, `text.output.<id>`
 * @example
 * shapeScope('ls') // => 'text.output.ls'
 */
export const shapeScope = id => `text.output.${id}`

/**
 * The TextMate grammar of every Output shape, keyed by scope, for the worker's grammar registry.
 *
 * @returns `{ [scope]: rawGrammar }`
 * @example
 * shapeGrammars()['text.output.ls'].patterns.length // => 6
 */
export const shapeGrammars = () =>
  Object.fromEntries(SHAPES.map(shape => [shapeScope(shape.id), { scopeName: shapeScope(shape.id), patterns: shape.patterns }]))

// ---------- the Language a command prints ----------

/** Programs that print nothing on success, so they never decide what an Output block holds. */
const SILENT = new Set(['cd', 'pushd', 'popd', 'export', 'unset', 'set', 'source', '.', 'alias', 'unalias', 'trap', 'mkdir', 'rmdir', 'touch', 'rm', 'mv', 'cp', 'ln', 'chmod', 'chown', 'true', 'false', ':', 'sleep', 'wait', 'shopt', 'setopt'])

/** Programs that print the files they are given (or their stdin, unchanged) */
const VIEWERS = new Set(['cat', 'bat', 'batcat', 'head', 'tail', 'less', 'more', 'nl', 'tac'])

/** Programs that pass lines of their stdin through, so a pipeline keeps the Language of what fed it */
const FILTERS = new Set(['head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'sort', 'uniq', 'less', 'more', 'tac', 'nl'])

/** Flags of a viewer that take a value, which is not a file (`head -n 20`, `tail -c 100`, `bat -l md`). */
const VALUE_FLAGS = new Set(['-n', '-c', '-l', '--lines', '--bytes', '--language', '-r', '--line-range', '--style', '--theme'])

const extensionOf = file => {
  const name = file.slice(file.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : null
}

/** The extension all the files share, or null when they differ, lack one or there are none. */
const sharedExtension = files => {
  const exts = new Set(files.map(extensionOf))
  if (exts.size !== 1) return null
  return [...exts][0]
}

/** The words of `args` that name files: not flags, and not the values of flags that take one; after `--`, all but `-`. */
const fileArgs = args => {
  const files = []
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    // `--` ends the flags: every word after it is a file, `-notes.md` too. Not `-` alone, which is stdin there as well
    // (`cat guide.md | cat -- -`)
    if (a === '--') {
      files.push(...args.slice(k + 1).filter(word => word !== '-'))
      break
    }
    if (VALUE_FLAGS.has(a)) { k++; continue }
    if (a === '-' || a.startsWith('-') || a.startsWith('+')) continue
    files.push(a)
  }
  return files
}

/** git's own flags that take the next word as their value (`git -C repo`, `git --namespace site`), as git 2.56 reads them. */
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source'])

/** A git subcommand past git's own flags (`git -C repo diff` -> `diff`), and the words after it. */
const gitSubcommand = args => {
  for (let k = 0; k < args.length; k++) {
    if (GIT_VALUE_FLAGS.has(args[k])) { k++; continue }
    if (args[k].startsWith('-')) continue
    return { sub: args[k], rest: args.slice(k + 1) }
  }
  return { sub: null, rest: [] }
}

/** The names a program is known by for {@link SHAPES}: `git status` for git's subcommands, else the program. */
const namesOf = program => {
  if (program.name !== 'git') return [program.name]
  const { sub } = gitSubcommand(program.args)
  return sub ? [`git ${sub}`] : []
}

/**
 * The Language a pipeline stage prints, given what fed it.
 *
 * @param program - The stage's program, from {@link programOf}.
 * @param fed - The Language of the stage's stdin (the stage before it in a pipeline), or null.
 * @returns a language id or extension, or null when the stage prints no known Language
 */
const languageOf = (program, fed) => {
  const { name, args } = program
  if (VIEWERS.has(name)) {
    const files = fileArgs(args)
    // a viewer with no file reads its stdin: what fed it passes through
    if (files.length === 0) return fed
    // `-` among the files prints stdin between them: one Language only when stdin's is the files' too
    const shared = sharedExtension(files)
    return args.includes('-') && shared !== fed ? null : shared
  }
  if (name === 'sed' && args.includes('-n')) {
    // `sed -n '1,40p' file.md` prints lines of the file as they are; the script is the first plain word (sed's -n takes
    // no value, unlike head's)
    const files = args.filter(a => !a.startsWith('-')).slice(1)
    return files.length === 0 ? fed : sharedExtension(files)
  }
  if (FILTERS.has(name)) {
    // a filter given files of its own (`grep -n x a.ts`) prints Output shapes, not the Language
    const plain = fileArgs(args)
    return plain.length <= 1 ? fed : null
  }
  if (name === 'jq' || name === 'gojq' || name === 'jaq') return args.some(a => /^-[a-zA-Z]*[rj]/.test(a) || a === '--raw-output') ? null : 'json'
  if (name === 'yq') return args.some((a, k) => (a === '-o' || a === '--output-format') && /^j/.test(args[k + 1] ?? '')) || args.includes('-oj') ? 'json' : 'yaml'
  if (name === 'plutil' && args.includes('-convert')) return args[args.indexOf('-convert') + 1] === 'json' ? 'json' : args[args.indexOf('-convert') + 1] === 'xml1' ? 'xml' : null
  if (name === 'diff') return args.some(a => /^-[a-zA-Z]*u/.test(a) || a === '--unified') ? 'diff' : null
  if (name === 'gh') return args[0] === 'api' ? 'json' : null
  if (name === 'git') {
    const { sub, rest } = gitSubcommand(args)
    if (sub === 'diff' || sub === 'show' || sub === 'format-patch') return rest.some(a => a === '--stat' || a === '--name-only' || a === '--name-status' || a === '--shortstat' || a === '--numstat') ? null : 'diff'
    if ((sub === 'log' || sub === 'stash') && rest.some(a => a === '-p' || a === '--patch')) return 'diff'
    return null
  }
  return null
}

/**
 * Plans how to colour the Output block of a command: the Language of the whole block, and the Output shapes its lines
 * may have.
 *
 * The Language comes from the commands that print: a stage piped into another prints nothing of its own, a silent
 * command (`cd`) prints nothing at all. When the printing commands name exactly one Language (`cd x && cat a.md`),
 * the block is that Language. Output shapes are turned on by any stage that runs their program, piped or not, since a
 * filter keeps a line's shape (`plutil -p f | grep Bundle`). A command that cannot be read (empty: a row drawn before
 * its command was seen) turns on every shape.
 *
 * @param command - The shell command the Bash call ran, or '' when unknown.
 * @param output - The block's text, for a JSON block whose command names no Language (`curl`, `gh pr view --json`).
 * @returns the plan
 * @example
 * planOutput('cd refs && cat pitfalls.md records.md', '# Pitfalls')
 * // => { language: 'md', shapes: [] }
 * planOutput('wc -l *.md && cat this-mac.md', '  95 developing.md\n# This Mac')
 * // => { language: 'md', shapes: ['wc'] }
 */
export const planOutput = (command, output) => {
  const segments = command.trim() === '' ? [] : lex(command)
  if (segments.length === 0) return { language: sniffJson(output), shapes: SHAPE_IDS, counted: [], grepped: [] }

  const names = new Set()
  const printed = new Set()
  const counted = []
  const grepped = []
  let fed = null
  for (const seg of segments) {
    const program = programOf(seg)
    const isPiped = seg.op === '|' || seg.op === '|&'
    if (program !== null) {
      for (const name of namesOf(program)) names.add(name)
      // every word of wc's that is no flag and no flag's value is a file it counts
      if (program.name === 'wc') counted.push(...operandsOf(program.args, WC_VALUE_FLAGS))
      // a grep's hits name its files, and the strong form takes no name with a space: those the command gave it are known
      if (namesOf(program).some(name => GREP_PROGRAMS.has(name))) grepped.push(...searchedOf(program).filter(arg => /\s/.test(arg)))
      fed = languageOf(program, fed)
    }
    // the last stage of a pipeline prints; a silent command prints nothing
    if (!isPiped) {
      if (program !== null && !SILENT.has(program.name)) printed.add(fed)
      fed = null
    }
  }

  const languages = [...printed].filter(lang => lang !== null)
  const language = languages.length === 1 ? languages[0] : languages.length === 0 ? sniffJson(output) : null
  const shapes = SHAPES.filter(shape => shape.programs.some(name => names.has(name))).map(shape => shape.id)
  return { language, shapes, counted, grepped }
}

/**
 * Whether the command prints its Language's text more than once with another program's Output-shape rows between the
 * prints (`head -n 1 a.ts; git status --short; cat b.ts`).
 *
 * The worker then starts the Language's grammar afresh after such rows, since each later print is a file of its own:
 * the first file's state (an open comment) must not run into it, and its frontmatter must open it. With one print, a
 * row of a shape inside it is the file's own text (an example in a fenced block), so the state runs on across it.
 * With several prints, a shape row inside one of the files (a git status line in a comment) restarts the grammar too:
 * the output does not say where each print ends.
 * Called by tokenize.mjs.
 *
 * @param command - The shell command the Bash call ran, or '' when unknown.
 * @returns true when a print of another program's Output shapes sits between two prints of the Language
 * @example
 * readsApart('cat a.md; wc -l b.md; cat b.md') // => true
 * readsApart('wc -l *.md && cat guide.md') // => false
 */
export const readsApart = command => {
  const segments = command.trim() === '' ? [] : lex(command)
  const shapePrograms = new Set(SHAPES.flatMap(shape => shape.programs))
  let hasPrintedLanguage = false
  let hasShapesSince = false
  let fed = null
  let names = []
  for (const seg of segments) {
    const program = programOf(seg)
    if (program !== null) {
      fed = languageOf(program, fed)
      names.push(...namesOf(program))
    }
    // only the last stage of a pipeline prints
    if (seg.op === '|' || seg.op === '|&') continue
    const prints = program !== null && !SILENT.has(program.name)
    if (prints && fed !== null) {
      // the Language printed again after another program's rows: a file of its own
      if (hasPrintedLanguage && hasShapesSince) return true
      hasPrintedLanguage = true
      hasShapesSince = false
    } else if (prints && names.some(name => shapePrograms.has(name))) {
      hasShapesSince = hasPrintedLanguage
    }
    fed = null
    names = []
  }
  return false
}

/** Blocks past this size are not parsed to see whether they are JSON. */
const MAX_SNIFF = 200_000

/** `json` when the whole text parses as a JSON object or array, else null. */
const sniffJson = output => {
  const text = output.trim()
  if (text.length > MAX_SNIFF || !/^[[{]/.test(text) || !/[\]}]$/.test(text)) return null
  try { JSON.parse(text); return 'json' } catch { return null }
}

// ---------- which line is coloured how ----------

/** What {@link assignLines} gives a line drawn in the block's Language. */
export const BLOCK = 'block'

/** The programs whose hits the `grep` shape colours, from its entry in {@link SHAPES}. */
const GREP_PROGRAMS = new Set(SHAPES.find(shape => shape.id === 'grep').programs)

/** GNU wc's flags that take the next word as their value (`wc --total never a.md`), which is no file to count. */
const WC_VALUE_FLAGS = new Set(['--files0-from', '--total'])

/**
 * The words of a command that are neither flags nor their values: every word after `--`, which ends the flags
 * (`wc -l -- -notes.md`), and the words before it that do not open with `-` or follow a flag that takes a value.
 * Called by {@link planOutput}.
 *
 * @param args - A program's words after its name.
 * @param valueFlags - The program's flags that take the next word as their value.
 * @returns the words, in order
 * @example
 * operandsOf(['-l', '--', '-notes.md'], WC_VALUE_FLAGS) // => ['-notes.md']
 * operandsOf(['--total', 'never', 'a.md'], WC_VALUE_FLAGS) // => ['a.md']
 */
const operandsOf = (args, valueFlags) => {
  const words = []
  for (let k = 0; k < args.length; k++) {
    if (args[k] === '--') {
      words.push(...args.slice(k + 1))
      break
    }
    // a flag's value is the next word; any other word that does not open with `-` is an operand
    if (valueFlags.has(args[k])) k++
    else if (!args[k].startsWith('-')) words.push(args[k])
  }
  return words
}

// flags that take a value, by program, and those of them that give the pattern (ag has none: its -f follows links).
// A flag missing here leaves its value among the words, where the first is taken for the pattern and the pattern for a
// file (`rg --color never "release notes" src`), so each list holds every such flag in the program's own help: GNU and
// BSD grep with git grep, rg 16 and ag 2.2. A value that is optional and joined with `=` (grep's `--color=never`) is
// not one
const GREP_FLAGS = {
  grep: {
    values: [
      '-e', '-f', '-d', '-D', '--regexp', '--file', '--include', '--exclude', '--exclude-from', '--exclude-dir', '--include-dir', '--label',
      '--binary-files', '--devices', '--directories', '--group-separator', '--max-depth', '--threads', '--parent-basename',
    ],
    patterns: ['-e', '-f', '--regexp', '--file'],
  },
  rg: {
    values: [
      '-e', '-f', '-g', '-G', '-t', '-T', '-j', '-M', '-E', '-r', '-d', '--regexp', '--file', '--glob', '--glob-not', '--iglob', '--type',
      '--type-not', '--type-add', '--type-clear', '--threads', '--max-columns', '--encoding', '--engine', '--replace', '--max-depth',
      '--maxdepth', '--max-filesize', '--max-bytes', '--sort', '--sortr', '--pre', '--pre-glob', '--ignore-file', '--in', '--in0', '--color',
      '--colors', '--context-separator', '--field-context-separator', '--field-match-separator', '--path-separator', '--hostname-bin',
      '--hyperlink-format', '--dfa-size-limit', '--regex-size-limit', '--generate',
    ],
    patterns: ['-e', '-f', '--regexp', '--file'],
  },
  ag: {
    values: [
      '-G', '-g', '-p', '-W', '--ignore', '--ignore-dir', '--depth', '--pager', '--path-to-ignore', '--file-search-regex', '--filename-pattern',
      '--width', '--workers', '--color-line-number', '--color-match', '--color-path', '--ackmate-dir-filter',
    ],
    patterns: [],
  },
}
// context and count flags take a number in every grep; ag's can go without one, so only a number is taken as theirs
const COUNT_FLAGS = new Set(['-A', '-B', '-C', '-m', '--after-context', '--before-context', '--context', '--max-count', '--after', '--before'])

/**
 * The files and folders a grep searches: its words that are not flags, flag values or the pattern.
 *
 * Flags are read as getopt reads them, with each program's own table (rg's `-t` takes a file type, ag's takes nothing):
 * in a group of short flags, the first that takes a value takes the rest of the group (`-efoo`) or else the next word
 * (`-ne foo`); a long flag takes the next word unless joined with `=`; `--` ends the flags. The pattern is the value of
 * `-e` or `-f`, else the first word left. Called by {@link planOutput}.
 *
 * @param program - A grep, rg, ag or git grep program, from programOf.
 * @returns the searched names, in order
 * @example
 * searchedOf({ name: 'grep', args: ['-n', 'release notes', 'src/app.ts'] }) // => ['src/app.ts']
 */
const searchedOf = program => {
  const { values, patterns } = GREP_FLAGS[program.name === 'rg' || program.name === 'ag' ? program.name : 'grep']
  const takesValue = flag => values.includes(flag) || COUNT_FLAGS.has(flag)
  // a count flag takes the next word only when it is a number
  const takesNext = (flag, next) => !COUNT_FLAGS.has(flag) || /^\d+$/.test(next ?? '')
  // git grep's words start after its subcommand, found as namesOf finds it: in `git -C grep grep`, the first `grep` is
  // a folder
  const args = program.name === 'git' ? gitSubcommand(program.args).rest : program.args
  const words = []
  let hasPatternFlag = false
  for (let k = 0; k < args.length; k++) {
    const arg = args[k]
    if (arg === '--') {
      words.push(...args.slice(k + 1))
      break
    }
    if (arg.startsWith('--')) {
      const flag = arg.split('=')[0]
      if (patterns.includes(flag)) hasPatternFlag = true
      if (takesValue(flag) && !arg.includes('=') && takesNext(flag, args[k + 1])) k++
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      // a group of short flags: the first that takes a value takes the rest of the group, or else the next word
      for (let c = 1; c < arg.length; c++) {
        const flag = `-${arg[c]}`
        if (!takesValue(flag)) continue
        if (patterns.includes(flag)) hasPatternFlag = true
        if (c === arg.length - 1 && takesNext(flag, args[k + 1])) k++
        break
      }
      continue
    }
    words.push(arg)
  }
  // without -e or -f, the first word is the pattern
  return hasPatternFlag ? words : words.slice(1)
}

/**
 * Whether a line is a grep hit in a file or folder with a space in its name that the command gave the grep:
 * `src/release notes.ts:12:` or, under a folder, `docs/my notes/a.md:3:`, with `-` for context rows.
 *
 * The strong form takes no path with a space, as prose can hold one before a colon; the command naming the file tells
 * them apart. Each check reads the line once. Called by {@link assignLines}.
 *
 * @param line - A line of the block.
 * @param grepped - The names with a space the command gave a grep, from {@link planOutput}.
 * @returns true when the line is a hit in one of them
 * @example
 * isHitOf('src/release notes.ts:12:deploy', new Set(['src/release notes.ts'])) // => true
 */
const isHitOf = (line, grepped) => {
  for (const name of grepped) {
    if (!line.startsWith(name)) continue
    const rest = line.slice(name.length)
    // the line number right after the name, or a path under the named folder before it
    if (/^[:-]\d+[:-]/.test(rest) || /^\/[^:\n]*[:-]\d+[:-]/.test(rest)) return true
  }
  return false
}

/**
 * Where the name starts in wc's row for a file the command gave it: counts, then that file's name as written.
 *
 * GNU wc writes a lone file's count unpadded (`7 release notes.md`), which the `wc` shape's strong form does not take
 * when the name has a space or no `.` or `/` (prose looks the same). The command naming the file tells them apart.
 * The name is matched at the line's end, so one that opens with a number (`7 2026 notes.md`) is found too, and of two
 * names that fit, the longer is the file's. Each check reads the line once. Called by {@link assignLines} (through
 * {@link isCountOf}) and by the worker, which draws the name in the default colour.
 *
 * @param line - A line of the block.
 * @param counted - The files the command gave `wc`, from {@link planOutput}.
 * @returns the index of the name's first character, or -1 when the line counts none of those files
 * @example
 * countedNameAt('7 release notes.md', new Set(['release notes.md'])) // => 2
 * countedNameAt('7 2026 notes.md', new Set(['2026 notes.md'])) // => 2
 * countedNameAt('7 release notes', new Set(['release notes.md'])) // => -1
 */
export const countedNameAt = (line, counted) => {
  // a row that does not open with a count is no wc row, whatever names follow
  if (!/^\s*\d/.test(line)) return -1
  let at = -1
  for (const name of counted) {
    if (!line.endsWith(name)) continue
    const counts = line.slice(0, line.length - name.length)
    // before the name: digits and spaces only, at least one count, and a space before the name
    if (/\s$/.test(counts) && /\d/.test(counts) && !/[^\d\s]/.test(counts) && (at === -1 || counts.length < at)) at = counts.length
  }
  return at
}

/** Whether a line is wc's row for a file the command gave it, by {@link countedNameAt}. Called by {@link assignLines}. */
const isCountOf = (line, counted) => countedNameAt(line, counted) !== -1

/** The characters a regex `.` stops at inside a line (`\n` splits the lines before any test). */
const DOT_STOPS = ['\r', ' ', ' ']

/**
 * Whether a line with a \r, U+2028 or U+2029 in it can still be wc's counts and a name: such a character may stand in
 * the blank space around the counts, and never in the name.
 *
 * The `wc` shape reads the name with `[^\n]`, which keeps its tests linear; 0.1.0 read it with `.`, which stops at
 * these characters, and a block with no Language colours exactly the lines 0.1.0 coloured. Reads the line a fixed
 * number of times. Called by {@link assignLines} before the `wc` shape's tests.
 *
 * @param line - A line of the block.
 * @returns false when the name would hold one of the characters; true for a line with none of them
 * @example
 * isNameUnbroken('1 release notes') // => false
 * isNameUnbroken('1\r2 notes.md') // => true
 */
const isNameUnbroken = line => {
  const last = Math.max(...DOT_STOPS.map(stop => line.lastIndexOf(stop)))
  if (last === -1) return true
  // up to the last of them there are counts and blank space only, as the name starts after it
  const before = line.slice(0, last + 1)
  if (/[^\d\s]/.test(before)) return false
  // after a count, more counts or the name must follow; with no count yet, the whole row starts after it
  return !/\d/.test(before) || /\S/.test(line.slice(last + 1))
}

/**
 * Gives the `grep` shape to the context rows around a hit (`grep -A 1`): `src/a.ts-13-text` beside `src/a.ts:12:text`.
 *
 * A context row alone reads like prose (`7-day trial`), so in a block with a Language no test takes it. The hit beside
 * it tells it apart: a context row names the same path and the line number next to its neighbour's. Left in the
 * Language, such a row can open a comment (`src/a.ts-13-/*`) that runs into the file printed after the grep. Each line
 * is read once per direction. Called by {@link assignLines}.
 *
 * @param lines - The block's lines.
 * @param scopes - What {@link assignLines} gave each line so far; the context rows found are set to the `grep` scope.
 * @example
 * const scopes = ['text.output.grep', 'block']
 * adoptContextRows(['src/a.ts:12:const a = 1', 'src/a.ts-13-/*'], scopes) // scopes[1] => 'text.output.grep'
 */
const adoptContextRows = (lines, scopes) => {
  const grep = shapeScope('grep')
  const { strong } = SHAPE_BY_ID.get('grep')
  // forwards for the rows after a hit (-A), backwards for the rows before it (-B)
  for (const step of [1, -1]) {
    let path = null
    let number = 0
    for (let k = step === 1 ? 0 : lines.length - 1; k >= 0 && k < lines.length; k += step) {
      const hit = scopes[k] === grep ? strong.exec(lines[k]) : null
      if (hit !== null) {
        path = hit[1]
        number = Number(hit[2])
      } else if (path !== null && lines[k].startsWith(`${path}-${number + step}-`)) {
        // a context row: the same file, the next line in this direction
        scopes[k] = grep
        number += step
      } else path = null
    }
  }
}

/**
 * Gives each line of an Output block what colours it: the first Output shape of the plan it has, else the block's
 * Language, else nothing.
 *
 * Called by the hooks module (through {@link hasColour}) and by the worker, so both read a block the same way. In a
 * block with a Language a line takes a shape only by its `strong` test: `metadata:` or `## Usage` in a Markdown file
 * stays Markdown even when the command also ran `ls` or `git status`.
 *
 * @param lines - The block's lines.
 * @param plan - From {@link planOutput}; the worker passes `language: null` when the Language has no grammar.
 * @returns per line, an Output shape's scope (`text.output.ls`), {@link BLOCK}, or null for a line left as it is
 * @example
 * assignLines(['  95 a.md', '# Title'], { language: 'md', shapes: ['wc'] })
 * // => ['text.output.wc', 'block']
 * assignLines(['metadata:'], { language: 'md', shapes: ['ls'] })
 * // => ['block']
 */
export const assignLines = (lines, plan) => {
  const shapes = plan.shapes.map(id => SHAPE_BY_ID.get(id)).filter(Boolean)
  // with a Language, only rows nothing but the command prints take a shape; prose stays in the Language
  const isStrongOnly = plan.language !== null
  const counted = new Set(plan.counted ?? [])
  const grepped = new Set(plan.grepped ?? [])
  const scopes = lines.map(line => {
    const shape = shapes.find(s => {
      // a wc row's name holds no character a regex `.` stops at
      if (s.id === 'wc' && !isNameUnbroken(line)) return false
      if (s.strong.test(line) || (s.id === 'wc' && isCountOf(line, counted)) || (s.id === 'grep' && isHitOf(line, grepped))) return true
      return !isStrongOnly && s.weak !== null && s.weak.test(line)
    })
    if (shape) return shapeScope(shape.id)
    return plan.language === null ? null : BLOCK
  })
  // a grep's context rows read like prose, so with a Language only the hit beside them tells them
  if (isStrongOnly && shapes.some(s => s.id === 'grep')) adoptContextRows(lines, scopes)
  return scopes
}

/**
 * Whether a plan colours anything of an Output block, so a block with nothing to colour is drawn by Claude Code as is.
 *
 * @param lines - The block's lines.
 * @param plan - From {@link planOutput}.
 * @returns true when the block has a Language or a line with one of the plan's Output shapes
 * @example
 * hasColour(['hello'], { language: null, shapes: ['ls'] }) // => false
 */
export const hasColour = (lines, plan) => plan.language !== null || assignLines(lines, plan).some(scope => scope !== null)
