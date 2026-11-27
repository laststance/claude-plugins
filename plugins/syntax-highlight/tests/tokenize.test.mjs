// The worker (tokenize.mjs) is a Node program, which `claude plugin test` cannot start, so these run under Node's own
// test runner: node --test plugins/syntax-highlight/tests/tokenize.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tokenize.mjs')

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
  const done = spawnSync('node', [WORKER], { input: JSON.stringify({ output, command, theme: 'dark-plus' }), encoding: 'utf8', timeout: 20000 })
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
