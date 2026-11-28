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
 * Colours an Output block with the real worker, its grammars and the bundled Dark+ theme.
 *
 * @param output - The block's text.
 * @param command - The command that printed it.
 * @returns the worker's lines: per line, its runs `{ t, fg, b, i, u }`
 * @example
 * colourOutput('# Title', 'cat a.md')[0][0] // => { t: '# Title', fg: '#569cd6', b: true, ... }
 */
const colourOutput = (output, command) => {
  // a home of its own, so the worker neither reads this machine's user grammars nor writes its runners file there
  const env = { ...process.env, HOME: HOME_FOR_WORKER, SYNTAX_HIGHLIGHT_RUNNERS: path.join(path.dirname(WORKER), 'runners.json') }
  // the Node that runs this suite, which need not be the `node` on the PATH
  const done = spawnSync(process.execPath, [WORKER], { input: JSON.stringify({ output, command, theme: 'dark-plus' }), encoding: 'utf8', timeout: 20000, env })
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
