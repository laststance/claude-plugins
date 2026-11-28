// Shell command lexer shared by tokenize.mjs (the node worker) and the hooks module: no Node, no I/O.
// It splits a command into segments (simple commands) with their words, heredocs and redirections, the way a shell
// reads them; each segment keeps the operator that ended it (`|`, `&&`, `;`, a newline, or null for the last).

const OP = /^(?:&>>?|\d*(?:<<<|<<-?|<>|>>|>&|<&|>\||>|<)(?:&?\d+-?)?|\|\||&&|\|&|[|&;()\n])/

export const lex = src => {
  const segments = []
  let seg = { words: [], heredocs: [], redirs: [] }
  const pending = []
  let next = null // flag for the next word: 'redir' | 'herestring' | 'heretag'
  let isStdin = false // the next 'redir' word is the file a `<` reads
  const endSegment = op => { if (seg.words.length || seg.heredocs.length) { seg.op = op; segments.push(seg) } seg = { words: [], heredocs: [], redirs: [] } }

  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t') { i++; continue }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue }
    const op = (/^\d*[<>]|^&>|^[|&;()\n]/.test(src.slice(i, i + 4)) ? OP.exec(src.slice(i, i + 12)) : null)
    if (op) {
      const o = op[0]
      i += o.length
      if (o === '\n') {
        for (const h of pending.splice(0)) {
          const bodyStart = i
          let j = i
          while (j <= src.length) {
            let e = src.indexOf('\n', j)
            if (e < 0) e = src.length
            const line = h.strip ? src.slice(j, e).replace(/^\t+/, '') : src.slice(j, e)
            if (line === h.tag) { h.body = [bodyStart, j]; i = Math.min(e + 1, src.length); break }
            if (e >= src.length) { h.body = [bodyStart, src.length]; i = src.length; break }
            j = e + 1
          }
        }
        endSegment('\n')
      } else if (/<<<$|<<-?$/.test(o.replace(/\d+/g, '').replace(/&.*/, ''))) {
        next = o.includes('<<<') ? 'herestring' : (o.includes('-') ? 'heretagStrip' : 'heretag')
      } else if (/[<>]/.test(o)) {
        next = /&\d*-?$/.test(o) ? null : 'redir'
        // `< file` (or `0< file`) feeds the segment's stdin: the word after it is kept as seg.stdin too
        isStdin = /^0?<$/.test(o)
      } else if (o !== '&>' && o !== '&>>') {
        endSegment(o)
      } else next = 'redir'
      continue
    }
    // a word
    const start = i
    let value = ''
    const map = []
    const push = (ch, at) => { value += ch; map.push(at) }
    while (i < src.length) {
      const ch = src[i]
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === ';' || ch === '|' || ch === '&' || ch === '<' || ch === '>' || ch === '(' || ch === ')') break
      if (ch === "'") {
        const e = src.indexOf("'", i + 1)
        const end = e < 0 ? src.length : e
        for (let k = i + 1; k < end; k++) push(src[k], k)
        i = e < 0 ? src.length : e + 1
      } else if (ch === '$' && src[i + 1] === "'") {
        let k = i + 2
        while (k < src.length && src[k] !== "'") { if (src[k] === '\\') { push(src[k], k); k++ } if (k < src.length) push(src[k], k); k++ }
        i = k + 1
      } else if (ch === '"') {
        let k = i + 1
        while (k < src.length && src[k] !== '"') {
          if (src[k] === '\\' && '$`"\\\n'.includes(src[k + 1] ?? '')) { if (src[k + 1] !== '\n') push(src[k + 1], k + 1); k += 2 }
          else { push(src[k], k); k++ }
        }
        i = k + 1
      } else if (ch === '\\') {
        if (src[i + 1] !== '\n' && i + 1 < src.length) push(src[i + 1], i + 1)
        i += 2
      } else if ((ch === '$' && src[i + 1] === '(') || ch === '`') {
        // command substitution kept inside the word, raw
        let depth = ch === '`' ? 0 : 1
        let k = i + (ch === '`' ? 1 : 2)
        push(ch, i); if (ch === '$') push('(', i + 1)
        while (k < src.length && (ch === '`' ? src[k] !== '`' : depth > 0)) {
          if (ch !== '`') { if (src[k] === '(') depth++; else if (src[k] === ')') depth-- }
          push(src[k], k); k++
        }
        i = k + 1
      } else { push(ch, i); i++ }
    }
    const word = { start, end: Math.min(i, src.length), value, map }
    // seg.stdin is what the last redirection of stdin reads, as the shell applies them left to right: the file after
    // `<`, or a word with no name for a heredoc or a here-string, whose text has no file
    if (next === 'heretag' || next === 'heretagStrip') {
      const h = { tag: value, strip: next === 'heretagStrip', body: null }
      pending.push(h); seg.heredocs.push(h)
      seg.stdin = { ...word, value: '' }
    } else if (next === 'herestring') {
      seg.herestring = word
      seg.stdin = { ...word, value: '' }
    } else if (next === 'redir') {
      seg.redirs.push(word)
      if (isStdin) seg.stdin = word
      isStdin = false
    }
    else seg.words.push(word)
    next = null
  }
  endSegment(null)
  return segments
}


/** Programs that run the next word as the real command (`env FOO=1 node`, `sudo ls`). */
export const WRAPPERS = new Set(['env', 'sudo', 'time', 'exec', 'command', 'nohup', 'uv', 'run', 'poetry', 'pipx', 'npx', 'bunx', 'pnpm', 'dlx', 'xcrun', 'caffeinate'])

/** A leading `NAME=value` word: an assignment, not the program. */
export const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

/** The file name of a word's path (`/usr/bin/git` -> `git`). */
export const base = w => w.value.slice(w.value.lastIndexOf('/') + 1)

/**
 * Finds the program a segment runs, past assignments and wrappers.
 *
 * @param seg - One segment from {@link lex}.
 * @returns `{ name, args }` (`args` the plain words after the program), or null for a segment of assignments only
 * @example
 * programOf(lex('sudo FOO=1 cat a.md')[0]) // => { name: 'cat', args: ['a.md'] }
 */
export const programOf = seg => {
  const ws = seg.words
  for (let k = 0; k < ws.length; k++) {
    const v = ws[k].value
    // assignments and wrappers stand before the program, a wrapper's own flags too
    if (ASSIGN.test(v) || WRAPPERS.has(v) || (k > 0 && WRAPPERS.has(ws[k - 1].value) && v.startsWith('-'))) continue
    return { name: base(ws[k]), args: ws.slice(k + 1).map(w => w.value) }
  }
  return null
}
