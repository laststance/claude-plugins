// The worker (tokenize.mjs) is a Node program, which `claude plugin test` cannot start, so these run under Node's own
// test runner: node --test plugins/syntax-highlight/tests/tokenize.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tokenize.mjs')
// an empty home for the worker, made once for this file's tests
const HOME_FOR_WORKER = fs.mkdtempSync(path.join(os.tmpdir(), 'syntax-highlight-test-home-'))
after(() => fs.rmSync(HOME_FOR_WORKER, { recursive: true, force: true }))

/**
 * Colours an Output block with the real worker, the bundled grammars and the bundled Dark+ theme.
 *
 * @param output - The block's text.
 * @param command - The command that printed it.
 * @param worker - The worker's `editor` option and its home folder. By default `bundled`, which reads no editor
 *   installed on this machine, in an empty home, so the colours expected in this file are the same on every machine.
 * @returns the worker's lines: per line, its runs `{ t, fg, b, i, u }`
 * @example
 * colourOutput('# Title', 'cat a.md')[0][0] // => { t: '# Title', fg: '#569cd6', b: true, ... }
 */
const colourOutput = (output, command, { editor = 'bundled', home = HOME_FOR_WORKER } = {}) => {
  // a home of its own (HOME, and USERPROFILE on Windows), so the worker neither reads this machine's settings nor
  // writes its runners file there
  const env = { ...process.env, HOME: home, USERPROFILE: home, SYNTAX_HIGHLIGHT_RUNNERS: path.join(path.dirname(WORKER), 'runners.json') }
  // the Node that runs this suite, which need not be the `node` on the PATH
  const done = spawnSync(process.execPath, [WORKER], { input: JSON.stringify({ output, command, editor, theme: 'dark-plus' }), encoding: 'utf8', timeout: 20000, env })
  assert.equal(done.status, 0, done.stderr)
  return JSON.parse(done.stdout).lines
}

test('Markdown after a fenced example holding a git status row is still Markdown, not code', () => {
  // Arrange
  const output = ['# Guide', '', '```sh', ' M src/a.ts', '```', '', '**Why:** bold here'].join('\n')

  // Act
  const lines = colourOutput(output, 'git status -s; cat guide.md')

  // Assert: `**Why:**` is drawn bold as Markdown, not in the fence's code colour
  const why = lines[6][0]
  assert.equal(why.t, '**Why:**')
  assert.equal(why.b, true)
  assert.notEqual(why.fg, lines[2][0].fg)
})

test('frontmatter printed after wc counts keeps its frontmatter colours, as 0.1.0 drew it', () => {
  // Arrange: `wc -l *.md && cat guide.md` prints the counts first, so the file's frontmatter does not open the block
  const output = ['       9 doc.md', '      16 guide.md', '      25 total', '---', 'title: Release checklist', '---', '', '# Release checklist'].join('\n')

  // Act
  const lines = colourOutput(output, 'cd . && wc -l *.md && cat guide.md')

  // Assert: the counts keep their wc colours, the key and value take the frontmatter's, and the closing `---` is not
  // drawn as a heading underline
  assert.deepEqual(lines[2].map(run => [run.t, run.fg]), [['      ', null], ['25', '#b5cea8'], [' ', null], ['total', '#569cd6']])
  assert.deepEqual(lines[4].map(run => [run.t, run.fg]), [['title', '#569cd6'], [': ', null], ['Release checklist', '#ce9178']])
  assert.deepEqual(lines[5].map(run => [run.t, run.fg]), [['---', null]])
})

test('a grep hit printed next to a file of unknown type keeps its line-number colour', () => {
  // Arrange
  const command = 'cat notes.zzunknown && grep -n deploy app.ts'

  // Act
  const lines = colourOutput('12:const deploy = 1', command)

  // Assert: the `12` is coloured as a grep line number
  assert.deepEqual(lines[0].map(run => [run.t, run.fg]), [['12', '#b5cea8'], [':const deploy = 1', null]])
})

test('a grep hit printing `/*` between two TypeScript files leaves the second file TypeScript, not a comment', () => {
  // Arrange
  const output = ['const a = 1;', 'src/other.ts:3:/* TODO', 'const b = 2;'].join('\n')

  // Act
  const lines = colourOutput(output, 'cat a.ts; grep -Hn TODO src/other.ts; cat b.ts')

  // Assert: the second file is coloured as the first, and the grep row keeps its own colours
  assert.deepEqual(lines[2].map(run => [run.t, run.fg]), [['const', '#569cd6'], [' ', null], ['b', '#4fc1ff'], [' = ', null], ['2', '#b5cea8'], [';', null]])
  assert.deepEqual(lines[1].map(run => [run.t, run.fg]), [['src/other.ts', '#4ec9b0'], [':', null], ['3', '#b5cea8'], [':/* TODO', null]])
})

test('a Markdown file printed after another file and a wc count opens with its own frontmatter', () => {
  // Arrange: `first.md`, then wc's row, then `second.md`, whose frontmatter must open it as a document of its own
  const output = ['# First', '      12 second.md', '---', 'title: Second', '---', '', 'Body'].join('\n')

  // Act
  const lines = colourOutput(output, 'cat first.md; wc -l second.md; cat second.md')

  // Assert: the frontmatter key and value take its colours, and its closing `---` is no heading underline
  assert.deepEqual(lines[3].map(run => [run.t, run.fg]), [['title', '#569cd6'], [': ', null], ['Second', '#ce9178']])
  assert.deepEqual(lines[4].map(run => [run.t, run.fg]), [['---', null]])
})

test('a file cut inside a block comment does not turn the next file it prints after git status into a comment', () => {
  // Arrange: the first line of `intro.ts` opens a comment, `git status` prints a row, then `app.ts` follows
  const output = ['/* licence', '?? notes.md', 'const version = 1;'].join('\n')

  // Act
  const lines = colourOutput(output, 'head -n 1 intro.ts; git status --short; cat app.ts')

  // Assert: app.ts is TypeScript, and the comment stays the first file's
  assert.deepEqual(lines[2].map(run => [run.t, run.fg]), [['const', '#569cd6'], [' ', null], ['version', '#4fc1ff'], [' = ', null], ['1', '#b5cea8'], [';', null]])
  assert.deepEqual(lines[0].map(run => [run.t, run.fg]), [['/* licence', '#6a9955']])
})

test('a Markdown file counted by GNU wc under a name with a space opens with its frontmatter', () => {
  // Arrange: the unpadded count GNU wc writes for a lone file, then the file
  const output = ['7 release notes.md', '---', 'title: Release', '---', '', 'Body'].join('\n')

  // Act
  const lines = colourOutput(output, 'wc -l "release notes.md" && cat "release notes.md"')

  // Assert: the count takes wc's colour, and the frontmatter key and value theirs
  assert.deepEqual(lines[0].map(run => [run.t, run.fg]), [['7', '#b5cea8'], [' release notes.md', null]])
  assert.deepEqual(lines[2].map(run => [run.t, run.fg]), [['title', '#569cd6'], [': ', null], ['Release', '#ce9178']])
})

test('with the editor option at bundled, a Markdown grammar installed for VS Code is not read, while any other choice reads it', t => {
  // Arrange: a home holding a VS Code extension whose Markdown grammar colours every line as a comment
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'syntax-highlight-test-vscode-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const extension = path.join(home, '.vscode', 'extensions', 'test.markdown-as-comment-1.0.0')
  fs.mkdirSync(extension, { recursive: true })
  const manifest = {
    name: 'markdown-as-comment',
    contributes: {
      languages: [{ id: 'markdown', extensions: ['.md'] }],
      grammars: [{ language: 'markdown', scopeName: 'text.html.markdown', path: './markdown.json' }],
    },
  }
  fs.writeFileSync(path.join(extension, 'package.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(extension, 'markdown.json'), JSON.stringify({ scopeName: 'text.html.markdown', patterns: [{ match: '.+', name: 'comment.line.test' }] }))

  // Act: Vim has no TextMate grammars of its own, so that choice reads the ones installed for VS Code
  const bundled = colourOutput('# Title', 'cat a.md', { editor: 'bundled', home })
  const vim = colourOutput('# Title', 'cat a.md', { editor: 'vim', home })

  // Assert: the bundled grammar draws a heading, the installed one a comment
  assert.deepEqual(bundled, [[{ t: '# Title', fg: '#569cd6', b: true, i: false, u: false }]])
  assert.deepEqual(vim, [[{ t: '# Title', fg: '#6a9955', b: false, i: false, u: false }]])
})

test('a row shaped like a grep hit inside the one TypeScript file a command prints is never given to the grammar, so its `/*` opens no comment', () => {
  // Arrange: the command prints TypeScript once, so the grammar is started afresh nowhere: only leaving the row out of
  // it keeps the line after the row out of a comment
  const output = ['const a = 1;', 'src/other.ts:3:/* TODO', 'const b = 2;'].join('\n')

  // Act
  const lines = colourOutput(output, 'grep -c TODO src/other.ts; cat b.ts')

  // Assert
  assert.deepEqual(lines[2].map(run => [run.t, run.fg]), [['const', '#569cd6'], [' ', null], ['b', '#4fc1ff'], [' = ', null], ['2', '#b5cea8'], [';', null]])
})

test('a grep context row holding `/*` between two TypeScript files leaves the second file TypeScript, not a comment', () => {
  // Arrange: grep -A 1 prints the hit with colons and the row after it with hyphens
  const output = ['const a = 1;', 'src/x.ts:2:// TODO', 'src/x.ts-3-/*', 'const b = 2;'].join('\n')

  // Act
  const lines = colourOutput(output, 'cat a.ts; grep -Hn -A 1 TODO src/x.ts; cat b.ts')

  // Assert: the second file is TypeScript, and the context row keeps grep's colours
  assert.deepEqual(lines[3].map(run => [run.t, run.fg]), [['const', '#569cd6'], [' ', null], ['b', '#4fc1ff'], [' = ', null], ['2', '#b5cea8'], [';', null]])
  assert.deepEqual(lines[2].map(run => [run.t, run.fg]), [['src/x.ts', '#4ec9b0'], ['-', null], ['3', '#b5cea8'], ['-/*', null]])
})

test('a wc row for a file whose name opens with a number colours the counts alone, not the number in the name', () => {
  // Arrange: GNU wc's rows for a file named with a year, with one count and with three, and a dated name from a glob
  const output = ['7 2026 release notes.md', '       7      30     200 2026 release notes.md', '  12 2026-11-28.md', '# Guide'].join('\n')

  // Act
  const lines = colourOutput(output, 'wc -l "2026 release notes.md"; wc "2026 release notes.md"; wc -l *.md; cat guide.md')

  // Assert
  assert.deepEqual(lines[0].map(run => [run.t, run.fg]), [['7', '#b5cea8'], [' 2026 release notes.md', null]])
  assert.deepEqual(lines[1].map(run => [run.t, run.fg]), [['       ', null], ['7      30     200', '#b5cea8'], [' 2026 release notes.md', null]])
  assert.deepEqual(lines[2].map(run => [run.t, run.fg]), [['  ', null], ['12', '#b5cea8'], [' 2026-11-28.md', null]])
})

test('a file cut inside a block comment does not turn the file printed after a numbered grep of piped text into a comment', () => {
  // Arrange: the first line of `intro.ts` opens a comment; the text piped into grep comes out as grep's rows (-Hn with a
  // label), then `app.ts` follows
  const output = ['/* licence', 'src/x.ts:3:// TODO', 'const version = 1;'].join('\n')

  // Act
  const lines = colourOutput(output, 'head -n 1 intro.ts; cat src/x.ts | grep -Hn --label=src/x.ts TODO; cat app.ts')

  // Assert: app.ts is TypeScript, and the comment stays the first file's
  assert.deepEqual(lines[2].map(run => [run.t, run.fg]), [['const', '#569cd6'], [' ', null], ['version', '#4fc1ff'], [' = ', null], ['1', '#b5cea8'], [';', null]])
  assert.deepEqual(lines[0].map(run => [run.t, run.fg]), [['/* licence', '#6a9955']])
})

test('Markdown piped through a grep that writes no prefix, between two other files, keeps a fenced example holding a grep hit whole', () => {
  // Arrange: three prints of Markdown, the middle one through a grep that writes its lines as they are. The grep hit
  // inside the fence is a file's own text, and no row of another program sits between the prints, so the grammar runs
  // on across it
  const output = ['# Guide', '', '```sh', 'src/a.ts:12:const a = 1', '```', '', '**Why:** bold here'].join('\n')

  // Act
  const lines = colourOutput(output, 'cat intro.md; cat draft.md | grep -v draft; cat guide.md')

  // Assert: the fence closes where the file closes it, so `**Why:**` is bold Markdown, not the fence's code
  const why = lines[6][0]
  assert.equal(why.t, '**Why:**')
  assert.equal(why.b, true)
})

test('Markdown piped through a grep with two -e patterns keeps a fenced example holding a grep hit whole', () => {
  // Arrange: the values of -e are patterns, not files, so the grep filters the Markdown piped in
  const output = ['# Guide', '', '```sh', 'src/a.ts:12:const a = 1', '```', '', '**Why:** bold here'].join('\n')

  // Act
  const lines = colourOutput(output, 'cat intro.md; cat draft.md | grep -v -e draft -e WIP; cat guide.md')

  // Assert: `**Why:**` is bold Markdown, not the fence's code
  const why = lines[6][0]
  assert.equal(why.t, '**Why:**')
  assert.equal(why.b, true)
})

test('a wc row with three counts keeps its last count (2026) coloured when another wc in the command counted a file named 2026 report.md', () => {
  // Arrange: `wc -l` writes one count before `2026 report.md`; plain `wc` writes three before `report.md`, the last 2026 bytes
  const output = ['7 2026 report.md', '7 30 2026 report.md'].join('\n')

  // Act
  const lines = colourOutput(output, 'wc -l "2026 report.md"; wc report.md')

  // Assert
  assert.deepEqual(lines[0].map(run => [run.t, run.fg]), [['7', '#b5cea8'], [' 2026 report.md', null]])
  assert.deepEqual(lines[1].map(run => [run.t, run.fg]), [['7 30 2026', '#b5cea8'], [' report.md', null]])
})

test('Markdown piped through a grep given only a label for stdin (no -H) keeps a fenced example holding a grep hit whole', () => {
  // Arrange: grep prints the label only with -H, so its rows are the file's lines as they are
  const output = ['# Guide', '', '```sh', 'src/a.ts:12:const a = 1', '```', '', '**Why:** bold here'].join('\n')

  // Act
  const lines = colourOutput(output, 'cat intro.md; cat draft.md | grep --label=draft.md -v draft; cat guide.md')

  // Assert: `**Why:**` is bold Markdown, not the fence's code
  const why = lines[6][0]
  assert.equal(why.t, '**Why:**')
  assert.equal(why.b, true)
})
