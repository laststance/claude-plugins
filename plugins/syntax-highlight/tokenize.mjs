// Deterministic syntax highlighter: VS Code's own TextMate grammars + the colour theme VS Code is set to.
// stdin: {"command": "..."} | {"code", "language"} | {"output", "command"}, plus "editor"?/"theme"?
// stdout: {"lines": [[{t, fg, b, i, u}, ...], ...]}
// A shell command is tokenized with the shell grammar; code embedded in it (node -e, python -c, heredocs ...)
// is found by a plain shell lexer (no AI) and re-tokenized with its own grammar.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { detectEditor, findGrammars, norm, readJsonc, readText, resolveTheme } from './editors.mjs'
import { BLOCK, assignLines, planOutput, shapeGrammars } from './outputs.mjs'
import { ASSIGN, WRAPPERS, base, lex } from './shell.mjs'

const require = createRequire(import.meta.url)
const { Registry, parseRawGrammar } = require('./vendor/vscode-textmate')
const oniguruma = require('./vendor/vscode-oniguruma')

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ---------- editor, theme, grammars ----------

const input = JSON.parse(fs.readFileSync(0, 'utf8'))
const config = readJsonc(path.join(HERE, 'config.json')) ?? {}

const editor = detectEditor(input.editor ?? config.editor)
const resolved = resolveTheme(editor.id, input.theme ?? config.theme)
const theme = resolved.theme
const wanted = resolved.name
const defaultFg = (theme.colors['editor.foreground'] ?? '#D4D4D4').toLowerCase()
const grammarIndex = findGrammars(editor.id)
const grammarFiles = grammarIndex.files

// ---------- TextMate registry ----------

const SHAPE_GRAMMARS = shapeGrammars()

const wasm = fs.readFileSync(path.join(HERE, 'vendor/vscode-oniguruma/release/onig.wasm'))
await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength))

const registry = new Registry({
  onigLib: Promise.resolve({
    createOnigScanner: sources => new oniguruma.OnigScanner(sources),
    createOnigString: s => new oniguruma.OnigString(s),
  }),
  theme: { name: wanted, settings: [{ settings: { foreground: defaultFg } }, ...theme.tokenColors] },
  loadGrammar: async scope => {
    // the Output shapes' grammars live in outputs.mjs, not in files
    if (SHAPE_GRAMMARS[scope]) return parseRawGrammar(JSON.stringify(SHAPE_GRAMMARS[scope]), `${scope}.json`)
    const file = grammarFiles[scope]
    const text = file && readText(file)
    return text ? parseRawGrammar(text, file) : null
  },
})
const colorMap = registry.getColorMap()

const grammars = new Map()
const grammarFor = async scope => {
  if (!grammars.has(scope)) grammars.set(scope, await registry.loadGrammar(scope).catch(() => null))
  return grammars.get(scope)
}

// one style per source character: null (default) or {fg, b, i, u}
const styleCache = new Map()
const styleOf = (fg, font) => {
  const key = `${fg}|${font}`
  if (!styleCache.has(key)) styleCache.set(key, { fg, b: !!(font & 2), i: !!(font & 1), u: !!(font & 4) })
  return styleCache.get(key)
}

const tokenizeText = async (scope, text) => {
  const styles = new Array(text.length).fill(null)
  const grammar = scope ? await grammarFor(scope) : null
  if (!grammar) return styles
  let stack = null
  let offset = 0
  for (const line of text.split('\n')) {
    const r = grammar.tokenizeLine2(line, stack)
    stack = r.ruleStack
    for (let k = 0; k < r.tokens.length; k += 2) {
      const start = r.tokens[k]
      const end = k + 2 < r.tokens.length ? r.tokens[k + 2] : line.length
      const meta = r.tokens[k + 1]
      const fg = (colorMap[(meta & 0x00ff8000) >>> 15] ?? defaultFg).toLowerCase()
      const font = (meta & 0x00007800) >>> 11
      if (fg === defaultFg && font === 0) continue
      const s = styleOf(fg === defaultFg ? null : fg, font)
      for (let c = start; c < end; c++) styles[offset + c] = s
    }
    offset += line.length + 1
  }
  return styles
}

// ---------- which segments carry code, and in what language ----------


// Runners (which programs carry code, and in what language) live in runners.json, not here. The first run copies the
// default file shipped with the mod to ~/.claude/syntax-highlight/runners.json (or $SYNTAX_HIGHLIGHT_RUNNERS); edit that copy to add more.
//   { "program": "^lua(jit)?$", "language": "lua", "evalFlags": ["-e"], "evalPattern": null, "skipFlags": [], "stopFlags": [], "words": [], "after": null }
// "language" is a TextMate scope ("source.lua") or a short id/alias ("lua", "py", "js"); "evalFlags" are flags whose NEXT word is code
// (or "evalPattern", a regex for them); "skipFlags" swallow one argument; "stopFlags" end the scan; "after" is a subcommand like deno's "eval".
function loadRunners() {
  const file = process.env.SYNTAX_HIGHLIGHT_RUNNERS || path.join(process.env.HOME || '', '.claude/syntax-highlight/runners.json')
  const shipped = path.join(HERE, 'runners.json')
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(shipped, file) } catch {}
    try { text = fs.readFileSync(shipped, 'utf8') } catch { return [] }
  }
  try {
    return JSON.parse(text).map(r => {
      const flags = new Set(r.evalFlags || []), pat = r.evalPattern && new RegExp(r.evalPattern)
      return {
        re: new RegExp(r.program), get scope() { return /^(source|text)\./.test(r.language) ? r.language : EXT[r.language] || 'source.' + r.language },
        eval: w => flags.has(w) || !!pat?.test(w), skip: new Set(r.skipFlags || []),
        stop: new Set(r.stopFlags || []), words: new Set(r.words || []), after: r.after || undefined,
      }
    })
  } catch { return [] }
}
const RUNNERS = loadRunners()

const EXT = {
  py: 'source.python', js: 'source.js', mjs: 'source.js', cjs: 'source.js', jsx: 'source.js.jsx', ts: 'source.ts', mts: 'source.ts',
  cts: 'source.ts', tsx: 'source.tsx', json: 'source.json', rb: 'source.ruby', sh: 'source.shell', bash: 'source.shell', zsh: 'source.shell',
  yaml: 'source.yaml', yml: 'source.yaml', css: 'source.css', html: 'text.html.basic', md: 'text.html.markdown', sql: 'source.sql',
}

// -> [{scope, value, map}]
const findEmbedded = (src, segments) => {
  const out = []
  for (const seg of segments) {
    const ws = seg.words
    let r = -1, runner = null
    for (let k = 0; k < ws.length && k < 12; k++) {
      const v = ws[k].value
      const hit = RUNNERS.find(x => x.re.test(base(ws[k])))
      if (hit && !(k > 0 && v.startsWith('-'))) { r = k; runner = hit; break }
      if (ASSIGN.test(v) || WRAPPERS.has(v) || v.startsWith('-') || (k > 0 && ws[k - 1].value.startsWith('-'))) continue
      break
    }
    let code = null
    if (runner) {
      let usesStdin = true
      for (let k = r + 1; k < ws.length; k++) {
        const v = ws[k].value
        if (runner.after) { if (v === runner.after) { const c = ws.slice(k + 1).find(x => !x.value.startsWith('-')); if (c) { code = c; usesStdin = false } break } continue }
        if (runner.eval(v)) { code = ws[k + 1] ?? null; usesStdin = false; break }
        if (runner.stop?.has(v)) { usesStdin = false; break }
        if (runner.skip.has(v)) { k++; continue }
        if (runner.words?.has(v)) continue
        if (v === '-') continue
        if (v.startsWith('-')) continue
        usesStdin = false // a script file
        break
      }
      if (code) out.push({ scope: runner.scope, value: code.value, map: code.map })
      else if (usesStdin) {
        const h = seg.heredocs.find(x => x.body)
        if (h) { const [a, b] = h.body; out.push({ scope: runner.scope, value: src.slice(a, b), map: Array.from({ length: b - a }, (_, n) => a + n) }) }
        else if (seg.herestring) out.push({ scope: runner.scope, value: seg.herestring.value, map: seg.herestring.map })
      }
    } else {
      // cat > file.py <<'EOF' ... : language from the target's extension
      const h = seg.heredocs.find(x => x.body)
      const target = [...seg.redirs, ...(ws[0] && /^(tee)$/.test(base(ws[0])) ? ws.slice(1) : [])].map(w => w.value).find(v => EXT[v.slice(v.lastIndexOf('.') + 1).toLowerCase()])
      if (h && target) {
        const [a, b] = h.body
        out.push({ scope: EXT[target.slice(target.lastIndexOf('.') + 1).toLowerCase()], value: src.slice(a, b), map: Array.from({ length: b - a }, (_, n) => a + n) })
      }
    }
  }
  return out
}

// ---------- main ----------

const src = String(input.output ?? input.code ?? input.command ?? '')
const language = input.language ? grammarIndex.languages[norm(input.language)] ?? null : null
const SHELL = 'source.shell'
let styles
if (input.output !== undefined) {
  // an Output block: each line takes the Output shape it has, else the block's Language (planned from the command)
  styles = new Array(src.length).fill(null)
  const lines = src.split('\n')
  const plan = planOutput(String(input.command ?? ''), src)
  const blockScope = plan.language === null ? null : grammarIndex.languages[norm(plan.language)] ?? null
  // a Language with no grammar (`cat notes.zzunknown`) colours nothing, so the block is read as having none and keeps
  // every Output shape's colours
  const effectivePlan = blockScope === null ? { ...plan, language: null } : plan
  const scopes = assignLines(lines, effectivePlan).map(scope => (scope === BLOCK ? blockScope : scope))
  const firstLanguageLine = blockScope === null ? -1 : scopes.indexOf(blockScope)
  if (firstLanguageLine !== -1) {
    // the Language takes the block in one pass from its first line on, so its state (frontmatter, an open fence) runs
    // on across the Output-shape rows inside it; those rows are coloured over it below. Rows before that first line
    // are another command's output (`wc -l *.md && cat guide.md`): the pass starts after them, so the file's
    // frontmatter still opens the Language's text
    const start = lines.slice(0, firstLanguageLine).reduce((length, line) => length + line.length + 1, 0)
    const whole = await tokenizeText(blockScope, src.slice(start))
    for (let c = 0; c < whole.length; c++) styles[start + c] = whole[c]
  }
  let offset = 0
  for (let k = 0; k < lines.length;) {
    // a run of lines sharing an Output shape is tokenized as one text with that shape's grammar
    let j = k
    while (j < lines.length && scopes[j] === scopes[k]) j++
    const text = lines.slice(k, j).join('\n')
    if (scopes[k] !== null && scopes[k] !== blockScope) {
      const inner = await tokenizeText(scopes[k], text)
      for (let c = 0; c < inner.length; c++) styles[offset + c] = inner[c]
    }
    offset += text.length + 1
    k = j
  }
} else if (input.code !== undefined) {
  // plain code in a named language (or the shell when none is named / known)
  styles = await tokenizeText(language ?? (input.language ? null : SHELL), src)
} else {
  styles = await tokenizeText(SHELL, src)
  for (const e of findEmbedded(src, lex(src))) {
    const inner = await tokenizeText(e.scope, e.value)
    for (let k = 0; k < inner.length; k++) styles[e.map[k]] = inner[k]
  }
}

const lines = []
let offset = 0
for (const line of src.split('\n')) {
  const runs = []
  for (let c = 0; c < line.length; c++) {
    const s = styles[offset + c]
    const last = runs[runs.length - 1]
    if (last && last.s === s) last.t += line[c]
    else runs.push({ s, t: line[c] })
  }
  lines.push(runs.map(({ s, t }) => ({ t, fg: s?.fg ?? null, b: !!s?.b, i: !!s?.i, u: !!s?.u })))
  offset += line.length + 1
}
process.stdout.write(JSON.stringify({ editor: editor.id, theme: wanted, themeSource: resolved.source, language: input.language ? (language ? input.language : null) : undefined, lines }))
