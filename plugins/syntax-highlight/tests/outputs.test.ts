import { describe, expect, test } from 'claude-code/testing'

import { BLOCK, SHAPE_IDS, assignLines, hasColour, planOutput } from '../outputs.mjs'

describe('the Language of a whole Output block', () => {
  test('a Markdown file printed after cd is coloured as Markdown', () => {
    // Arrange
    const command = 'cd ~/.claude/skills/desktop-walkthrough/references && cat pitfalls.md records.md'

    // Act
    const plan = planOutput(command, '# Pitfalls from real runs')

    // Assert
    expect(plan).toEqual({ language: 'md', shapes: [], counted: [], columns: [], grepped: [] })
  })

  test('a file printed through head keeps the file\'s Language', () => {
    // Arrange
    const command = 'cat src/app.ts | head -40'

    // Act
    const plan = planOutput(command, 'export const app = 1')

    // Assert
    expect(plan.language).toBe('ts')
  })

  test('lines printed with sed -n take the file\'s Language', () => {
    // Arrange
    const command = "sed -n '10,40p' docs/setup.md"

    // Act
    const plan = planOutput(command, '## Setup')

    // Assert
    expect(plan.language).toBe('md')
  })

  test('files of different Languages printed together get no Language', () => {
    // Arrange
    const command = 'cat README.md src/index.ts'

    // Act
    const plan = planOutput(command, '# Readme')

    // Assert
    expect(plan.language).toBeNull()
  })

  test('jq output is coloured as JSON, but not its raw strings', () => {
    // Arrange
    const json = 'curl -s https://api.example.com/items | jq .'
    const raw = 'curl -s https://api.example.com/items | jq -r .name'

    // Act
    const jsonPlan = planOutput(json, '{"a": 1}')
    const rawPlan = planOutput(raw, 'widget')

    // Assert
    expect(jsonPlan.language).toBe('json')
    expect(rawPlan.language).toBeNull()
  })

  test('git diff is coloured as a diff, its --stat summary is not', () => {
    // Arrange
    const patch = 'git diff HEAD~1 -- src'
    const stat = 'git diff --stat'

    // Act
    const patchPlan = planOutput(patch, 'diff --git a/x b/x')
    const statPlan = planOutput(stat, ' x | 2 +-')

    // Assert
    expect(patchPlan.language).toBe('diff')
    expect(statPlan.language).toBeNull()
  })

  test('printed JSON is recognised when the command names no Language', () => {
    // Arrange
    const command = 'curl -s https://api.example.com/items'

    // Act
    const plan = planOutput(command, '{\n  "items": [1, 2]\n}')

    // Assert
    expect(plan.language).toBe('json')
  })

  test('plutil -p output, which opens with a brace, is not taken for JSON', () => {
    // Arrange
    const command = 'plutil -p Info.plist'

    // Act
    const plan = planOutput(command, '{\n  "CFBundleName" => "Grok Bot"\n}')

    // Assert
    expect(plan).toEqual({ language: null, shapes: ['plutil'], counted: [], columns: [], grepped: [] })
  })
})

describe('Output shapes in an Output block', () => {
  test('a block mixing grep hits, an ls listing and plutil pairs colours each line by its shape', () => {
    // Arrange
    const command =
      'echo "--- obsidian lines"; grep -Hn -i obsidian ~/.zprofile; ls -la /Applications/Obsidian.app/Contents/MacOS/; plutil -p Info.plist | grep -E CFBundleName -A3 | head -30'
    const lines = [
      '--- obsidian lines',
      '/Users/me/.zprofile:3:# Added by Obsidian',
      '/Applications/Obsidian.app/Contents/MacOS/:',
      'total 408',
      'drwxr-xr-x   4 me  admin     128 10 Nov 16:39 .',
      '-rwxr-xr-x@  1 me  admin   69632 10 Nov 16:39 Obsidian',
      '  "CFBundleName" => "Grok Bot"',
      '    0 => {',
      '--',
    ]

    // Act
    const plan = planOutput(command, lines.join('\n'))
    const scopes = assignLines(lines, plan)

    // Assert
    expect(plan).toEqual({ language: null, shapes: ['ls', 'plutil', 'grep'], counted: [], columns: [], grepped: ['~/.zprofile'] })
    expect(scopes).toEqual([
      null,
      'text.output.grep',
      'text.output.ls',
      'text.output.ls',
      'text.output.ls',
      'text.output.ls',
      'text.output.plutil',
      'text.output.plutil',
      'text.output.grep',
    ])
  })

  test('wc counts before a Markdown file keep their own colours inside the Markdown block', () => {
    // Arrange
    const command = 'cd ~/.claude/skills/desktop-walkthrough/references && wc -l *.md && cat this-mac.md'
    const lines = ['      95 developing.md', '     319 total', '# This Mac', '', '- One display']

    // Act
    const plan = planOutput(command, lines.join('\n'))
    const scopes = assignLines(lines, plan)

    // Assert
    expect(plan).toEqual({ language: 'md', shapes: ['wc'], counted: ['*.md'], columns: [1], grepped: [] })
    expect(scopes).toEqual(['text.output.wc', 'text.output.wc', BLOCK, BLOCK, BLOCK])
  })

  test('grep -n over one file colours the line numbers it prints without a path', () => {
    // Arrange
    const command = 'grep -n export src/app.ts'
    const lines = ['1:export const greet = 1', '2:export function main() {}']

    // Act
    const scopes = assignLines(lines, planOutput(command, lines.join('\n')))

    // Assert
    expect(scopes).toEqual(['text.output.grep', 'text.output.grep'])
  })

  test('git status --short marks each changed path by its status', () => {
    // Arrange
    const command = 'git status -sb'
    const lines = ['## main...origin/main [ahead 1]', ' M src/a.ts', '?? notes.md']

    // Act
    const plan = planOutput(command, lines.join('\n'))
    const scopes = assignLines(lines, plan)

    // Assert
    expect(plan.shapes).toEqual(['git-status'])
    expect(scopes).toEqual(['text.output.git-status', 'text.output.git-status', 'text.output.git-status'])
  })

  test('a line ending in a colon is a folder header only when ls ran', () => {
    // Arrange
    const line = 'Things to check:'

    // Act
    const withLs = assignLines([line], planOutput('ls -R src', line))
    const withEcho = assignLines([line], planOutput('echo "Things to check:"', line))

    // Assert
    expect(withLs).toEqual(['text.output.ls'])
    expect(withEcho).toEqual([null])
  })

  test('a row drawn before its command was seen is tested against every Output shape', () => {
    // Arrange
    const unknownCommand = ''

    // Act
    const plan = planOutput(unknownCommand, 'src/a.ts:12:const a = 1')

    // Assert
    expect(plan).toEqual({ language: null, shapes: SHAPE_IDS, counted: [], columns: [], grepped: [] })
  })
})

describe('blocks left to Claude Code', () => {
  test('plain echo output has nothing to colour, so Claude Code draws it as is', () => {
    // Arrange
    const lines = ['hello', 'world']

    // Act
    const isColoured = hasColour(lines, planOutput('echo hello; echo world', lines.join('\n')))

    // Assert
    expect(isColoured).toBe(false)
  })
})

// The Output block that led to 0.1.1, rewritten with made-up words but kept line for line in shape: two memory files
// printed after a cd outside the project (frontmatter, timestamps, wiki links, nested lists, colon-ended lines), then
// two names from `ls | grep`. 0.1.0 coloured its `metadata:` and `/ship …:` lines as ls folder headers and grep paths.
const MEMORY_READ_COMMAND =
  'cd /Users/me/.claude/projects/app/memory; cat deploy-lock.md tag-order.md 2>/dev/null; ls ~/.claude/skills/gstack/bin | grep -i docs'
const MEMORY_READ_OUTPUT = [
  '---',
  'name: deploy-check-runs-before-every-tag',
  'description: "Run the deploy-check helper before you tag with /ship when 12.5\'s lock fires: the runner may still hold it"',
  'metadata:',
  '  node_type: memory',
  '  type: feedback',
  '  originSessionId: 1a234567-8b90-1c23-45de-6f78ab90c12d',
  '  modified: 2026-11-20T09:15:42.118Z',
  '---',
  '',
  "The helper.sh's stale-check finds deploy locks that the last runner left behind when its lock timed out",
  '',
  '**Why:** In run 0412 (2026-11-03) the lock held for three hours and every tag waited: the runner crashed, then a `release` re-check.',
  '',
  '**How to apply:**',
  '- Order: lock check → wait for the runner → re-check and tag (not optional, `deploy-check --wait`)',
  '- Keep the lock timeout shorter than the runner timeout. Treat a lock as stale (check `git status`) when no runner holds it.',
  '',
  'Related: [[deploy-lock-stale-runner]], [[tag-only-after-the-check-passes]], [[runner-timeout-and-lock-order]].',
  '---',
  'name: ship-tags-after-the-deploy-check-passes',
  'description: "/ship tag-order notes for the deploy check and the runner queue: run the check first so no stale lock ships"',
  'metadata:',
  '  node_type: memory',
  '  type: feedback',
  '  originSessionId: 2b345678-9c01-2d34-56ef-7a89bc01d23e',
  '  modified: 2026-11-24T18:03:07.524Z',
  '---',
  '',
  '/ship notes from runs 0412 (PR 128) and 0419 (PR 133):',
  '',
  '- **Run the deploy check before tagging, even when the runner looks idle and the queue reads empty.**',
  '  - R412 found (no runner held the lock at tag time): a stale lock from a crashed runner blocked the deploy, then a retry tagged twice',
  "  - R419 (runner 2.104): `deploy-check --wait` returned `stale_lock_found` and the tag went out before the runner's own fix",
  '  - Same root as R412: tag the run in order (lock, wait, check), so no stale lock leaves a broken tag behind',
  '  - Lock timeouts shorter than runner timeouts keep it safe: wait for the check, then a re-check runs the tag123fix pass',
  "- **Lock before tag, over speed.** Waiting for the runner's re-check (its state is in the run log) costs a minute",
  '',
  '**Why:** each skipped check came back as a stale-lock incident in the next deploy (R412, R419).',
  "**How to apply:** on every 12 tags, compare the deploy check with the runner's queue log. On each 3",
  'gstack-docs-candidate',
  'gstack-docs-only',
]

describe('Output shapes inside a Language block', () => {
  test('two memory files read after a cd outside the project stay Markdown on all 42 lines, from frontmatter to the ls | grep names', () => {
    // Arrange
    const lines = MEMORY_READ_OUTPUT

    // Act
    const plan = planOutput(MEMORY_READ_COMMAND, lines.join('\n'))
    const scopes = assignLines(lines, plan)

    // Assert
    expect(plan).toEqual({ language: 'md', shapes: ['ls', 'grep'], counted: [], columns: [], grepped: [] })
    expect(scopes).toEqual(new Array(42).fill(BLOCK))
  })

  test('a Markdown heading stays a heading when the command also ran git status', () => {
    // Arrange
    const command = 'git status -sb; cat notes.md'
    const lines = ['## Release notes', '## Usage', '## main', 'Text under them.']

    // Act
    const scopes = assignLines(lines, planOutput(command, lines.join('\n')))

    // Assert
    expect(scopes).toEqual([BLOCK, BLOCK, BLOCK, BLOCK])
  })

  test('a sentence opening with a number stays Markdown when the command also ran wc', () => {
    // Arrange
    const command = 'wc -l notes.md && cat notes.md'
    const lines = ['2 deployments failed', '3 of them on Friday.']

    // Act
    const scopes = assignLines(lines, planOutput(command, lines.join('\n')))

    // Assert
    expect(scopes).toEqual([BLOCK, BLOCK])
  })

  test('indented prose with a number stays Markdown when the command also ran wc, while wc\'s own rows keep their colours', () => {
    // Arrange
    const command = 'wc -l notes.md && cat notes.md'
    const lines = ['      12 notes.md', '  3 items', '    42', '  2024 release', ' 9 doc.md', '25 total']

    // Act
    const scopes = assignLines(lines, planOutput(command, lines.join('\n')))

    // Assert
    expect(scopes).toEqual(['text.output.wc', BLOCK, BLOCK, BLOCK, 'text.output.wc', 'text.output.wc'])
  })

  test('a wc count right-aligned in 8 columns keeps its colours before a file name with a space, while a number followed by wide spacing, or a second number ending in column 8, stays Markdown', () => {
    // Arrange
    const command = 'wc -l "release notes.md" && cat "release notes.md"'
    const lines = ['       6 release notes.md', '      12', '2       **attempts**', '1      2 **pending**', '# Release notes']

    // Act
    const scopes = assignLines(lines, planOutput(command, lines.join('\n')))

    // Assert
    expect(scopes).toEqual(['text.output.wc', 'text.output.wc', BLOCK, BLOCK, BLOCK])
  })

  test('a Markdown line opening with status letters stays Markdown when the command also ran git status, while the status rows keep their colours', () => {
    // Arrange
    const command = 'git status -s && cat notes.md'
    const lines = [' M src/app.ts', '?? "a b.txt"', 'R  old.md -> new.md', '# Notes', 'MR 12 is merged', 'A  quick note', ' A new approach']

    // Act
    const scopes = assignLines(lines, planOutput(command, lines.join('\n')))

    // Assert
    expect(scopes).toEqual(['text.output.git-status', 'text.output.git-status', 'text.output.git-status', BLOCK, BLOCK, BLOCK, BLOCK])
  })

  test('a diff\'s context lines opening with a capital letter stay in the diff when the command also ran git status', () => {
    // Arrange
    const command = 'git status --short && git diff'
    const lines = [' M README.md', 'diff --git a/README.md b/README.md', '@@ -1,3 +1,3 @@', ' A simple approach is best.', '-Old line', '+New line', ' M = 5 stays']

    // Act
    const scopes = assignLines(lines, planOutput(command, lines.join('\n')))

    // Assert
    expect(scopes).toEqual(['text.output.git-status', BLOCK, BLOCK, BLOCK, BLOCK, BLOCK, BLOCK])
  })

  test('times, durations and dates stay Markdown when the Markdown is piped through grep', () => {
    // Arrange
    const command = 'cat notes.md | grep -i deploy'
    const lines = ['09:30 deploy', '7-day trial before deploy', 'Shipped on 2026-11-24 after the deploy review']

    // Act
    const scopes = assignLines(lines, planOutput(command, lines.join('\n')))

    // Assert
    expect(scopes).toEqual([BLOCK, BLOCK, BLOCK])
  })

  test('rows only a command prints keep their own colours inside a Markdown block', () => {
    // Arrange
    const command = 'cat notes.md; grep -n deploy src/app.ts src/b.ts; ls -l docs; git status -sb'
    const lines = [
      '# Notes',
      'src/app.ts:12:const deploy = 1',
      '-rw-r--r--  1 me  staff  120 Nov 27 10:00 a.md',
      'total 48',
      '## main...origin/main [ahead 1]',
      ' M src/app.ts',
    ]

    // Act
    const scopes = assignLines(lines, planOutput(command, lines.join('\n')))

    // Assert
    expect(scopes).toEqual([
      BLOCK,
      'text.output.grep',
      'text.output.ls',
      'text.output.ls',
      'text.output.git-status',
      'text.output.git-status',
    ])
  })

  test('a single-file grep -n hit next to Markdown takes the Markdown colour, as a bare line number reads like prose', () => {
    // Arrange
    const command = 'cat notes.md; grep -n deploy src/app.ts'
    const lines = ['# Notes', '12:const deploy = 1']

    // Act
    const scopes = assignLines(lines, planOutput(command, lines.join('\n')))

    // Assert
    expect(scopes).toEqual([BLOCK, BLOCK])
  })
})

test('a GNU wc count before the name of a file the command counted keeps its colours, so the file after it opens with its frontmatter', () => {
  // Arrange: GNU wc writes a lone file's count unpadded, and the name has a space
  const command = 'wc -l "release notes.md" && cat "release notes.md"'
  const lines = ['7 release notes.md', '---', 'title: Release', '---', '', '2 release notes']

  // Act
  const scopes = assignLines(lines, planOutput(command, lines.join('\n')))

  // Assert: a count before a name wc was not given stays Markdown
  expect(scopes).toEqual(['text.output.wc', BLOCK, BLOCK, BLOCK, BLOCK, BLOCK])
})

test('a GNU wc count of a counted file whose name opens with a number keeps its colours', () => {
  // Arrange: the name's first word is a number, which reads like another count
  const command = 'wc -l "2026 release notes.md" && cat "2026 release notes.md"'
  const lines = ['7 2026 release notes.md', '---', 'title: Release', '---']

  // Act
  const scopes = assignLines(lines, planOutput(command, lines.join('\n')))

  // Assert
  expect(scopes).toEqual(['text.output.wc', BLOCK, BLOCK, BLOCK])
})

test('grep hits in a file or folder with a space in its name that the command grepped keep their colours in a Markdown block', () => {
  // Arrange: the file itself, and a folder searched recursively
  const cases = [
    { command: 'grep -Hn deploy "src/release notes.ts"; cat guide.md', lines: ['src/release notes.ts:12:deploy', '# Guide', '12: items'] },
    { command: 'grep -rn deploy "docs/my notes"; cat guide.md', lines: ['docs/my notes/a.md:3:deploy', '# Guide', '12: items'] },
    // the pattern given with -e and a context value before the file
    { command: 'grep -Hn -A 2 -e "release notes" "src/release notes.ts"; cat guide.md', lines: ['src/release notes.ts:3:x', '# Guide', 'release notes:12: deploy'] },
    // ag's -t takes no value (all text files), while rg's -t takes a file type
    { command: 'ag --nogroup --filename --nocolor -t deploy "src/release notes.ts"; cat guide.md', lines: ['src/release notes.ts:3:deploy', '# Guide', '12: items'] },
    { command: 'rg -n -t md "two words" "docs/a b"; cat guide.md', lines: ['docs/a b/x.md:3:two words', '# Guide', '12: items'] },
  ]

  for (const { command, lines } of cases) {
    // Act
    const scopes = assignLines(lines, planOutput(command, lines.join('\n')))

    // Assert: a bare `12:` row stays Markdown
    expect(scopes).toEqual(['text.output.grep', BLOCK, BLOCK])
  }
})

test('a grep hit in a file without an extension that the command grepped (Makefile:3:) keeps its colours in a Markdown block', () => {
  // Arrange: the strong form takes no path without a `.` or `/`; the command names the file
  const command = 'grep -Hn TODO Makefile; cat guide.md'
  const lines = ['Makefile:3:TODO tidy', '# Guide', 'Makefile: the build entry']

  // Act
  const plan = planOutput(command, lines.join('\n'))
  const scopes = assignLines(lines, plan)

  // Assert: the guide's own line that names the file without a line number stays Markdown
  expect(plan.grepped).toEqual(['Makefile'])
  expect(scopes).toEqual(['text.output.grep', BLOCK, BLOCK])
})

test('a date in a Markdown block (2026-11-28) stays Markdown after a grep of a file named 2026', () => {
  // Arrange: a context row of the file `2026` would read `2026-11-`, the same as the date
  const command = 'grep -Hn -e deploy 2026 -; cat guide.md'
  const lines = ['2026:3:deploy', '2026-11-28 release', '-12- items']

  // Act
  const plan = planOutput(command, lines.join('\n'))
  const scopes = assignLines(lines, plan)

  // Assert: stdin (`-`) is no named file
  expect(plan.grepped).toEqual(['2026'])
  expect(scopes).toEqual(['text.output.grep', BLOCK, BLOCK])
})

test('the context row after a grep hit in a file without an extension (Makefile-4-) keeps the grep colours, so its text opens no comment in the file printed next', () => {
  // Arrange: grep -A 1 prints the line after the hit as `Makefile-4-`, here opening a block comment
  const command = 'cat a.ts; grep -Hn -A 1 TODO Makefile; cat b.ts'
  const lines = ['const a = 1', 'Makefile:3:// TODO', 'Makefile-4-/*', 'const b = 2']

  // Act
  const scopes = assignLines(lines, planOutput(command, lines.join('\n')))

  // Assert
  expect(scopes).toEqual([BLOCK, 'text.output.grep', 'text.output.grep', BLOCK])
})

test('a grep row under the label given to stdin with -H (release notes.ts:3:) keeps the grep colours between two TypeScript files', () => {
  // Arrange: grep -H prints the label as the file name of the text piped in
  const command = 'head -n 1 a.ts; cat x.ts | grep -Hn --label="release notes.ts" TODO; cat b.ts'
  const lines = ['/* licence', 'release notes.ts:3:// TODO', 'const b = 2']

  // Act
  const plan = planOutput(command, lines.join('\n'))
  const scopes = assignLines(lines, plan)

  // Assert
  expect(plan.grepped).toEqual(['release notes.ts'])
  expect(scopes).toEqual([BLOCK, 'text.output.grep', BLOCK])
})

test('a label names no file when the grep reads a file of its own, so a guide line opening with the label stays Markdown', () => {
  // Arrange: grep reads only src/a.ts, and the label is for stdin
  const command = 'grep -Hn --label="release notes.md" TODO src/a.ts; cat guide.md'
  const lines = ['src/a.ts:3:// TODO', 'release notes.md:3: is where the notes start']

  // Act
  const plan = planOutput(command, lines.join('\n'))
  const scopes = assignLines(lines, plan)

  // Assert
  expect(plan.grepped).toEqual(['src/a.ts'])
  expect(scopes).toEqual(['text.output.grep', BLOCK])
})

test('a file printed after Markdown piped through a numbered grep takes its own Language (TypeScript), as the grep rows are no Markdown print', () => {
  // Arrange
  const output = 'notes.md:3:TODO\nconst a = 1'

  // Act
  const prefixed = planOutput('cat notes.md | grep -Hn --label=notes.md TODO; cat app.ts', output)
  const throughHead = planOutput('cat notes.md | grep -Hn --label=notes.md TODO | head -n 3; cat app.ts', output)
  const bareNumbers = planOutput('cat notes.md | grep -n TODO; cat app.ts', output)
  const unprefixed = planOutput('cat notes.md | grep -v draft; cat app.ts', output)
  const ownFile = planOutput('cat notes.md | grep -n TODO | cat app.ts; cat guide.md', output)

  // Assert: a filter without prefixes still prints Markdown, and a last stage reading its own file prints that file.
  // Rows under a bare `2:` cannot be told from TypeScript lines, so that block has no Language and `2:/* TODO` opens
  // no comment over app.ts
  expect(prefixed.language).toBe('ts')
  expect(throughHead.language).toBe('ts')
  expect(bareNumbers.language).toBe(null)
  expect(unprefixed.language).toBe(null)
  expect(ownFile.language).toBe(null)
})

test('a here-string after a < file is what cat reads, so the block takes no Language from the file', () => {
  // Arrange: the shell applies redirections left to right, and the last one of stdin wins
  const output = 'plain text'

  // Act
  const hereStringLast = planOutput("cat < guide.md <<< 'plain text'", output)
  const fileLast = planOutput("cat <<< 'plain text' < guide.md", output)
  const stdoutAfter = planOutput('cat < guide.md 2> errors.log', output)
  const otherDescriptor = planOutput("cat < guide.md 3<<< 'other text'", output)

  // Assert
  expect(hereStringLast.language).toBe(null)
  expect(fileLast.language).toBe('md')
  expect(stdoutAfter.language).toBe('md')
  expect(otherDescriptor.language).toBe('md')
})

test('a label given to stdin without -H names no file, as grep does not print it', () => {
  // Arrange
  const command = 'cat intro.md; cat draft.md | grep --label="release notes.md" -v draft; cat guide.md'
  const lines = ['# Intro', 'release notes.md:3: is a line of the draft', '# Guide']

  // Act
  const plan = planOutput(command, lines.join('\n'))
  const scopes = assignLines(lines, plan)

  // Assert
  expect(plan.grepped).toEqual([])
  expect(scopes).toEqual([BLOCK, BLOCK, BLOCK])
})

test('Markdown read from a file given with < (cat - guide.md < intro.md) is coloured as Markdown, and stdin of another Language leaves the block plain', () => {
  // Arrange
  const output = '# Intro\n# Guide'

  // Act
  const sameLanguage = planOutput('cat -- - guide.md < intro.md', output)
  const onlyStdin = planOutput('cat < intro.md', output)
  const otherLanguage = planOutput('cat - guide.md < data.json', output)

  // Assert
  expect(sameLanguage.language).toBe('md')
  expect(onlyStdin.language).toBe('md')
  expect(otherLanguage.language).toBe(null)
})

test('a Markdown line that opens with the grep pattern (release notes:12:) stays Markdown, as the pattern is no file', () => {
  // Arrange: the pattern has a space, and the file grepped does not
  const command = "grep -n 'release notes' src/app.ts; cat guide.md"
  const lines = ['release notes:12: deploy', '# Guide']

  // Act
  const scopes = assignLines(lines, planOutput(command, lines.join('\n')))

  // Assert
  expect(scopes).toEqual([BLOCK, BLOCK])
})

test('a Markdown line that opens with the grep pattern stays Markdown when a flag before the pattern takes a value of its own (rg --color never)', () => {
  // Arrange: the flag takes the word after it, so the next word (two words in quotes) is the pattern, not a file
  const commands = [
    'rg --color never "release notes" src/app.ts; cat guide.md',
    'rg --color=never "release notes" src/app.ts; cat guide.md',
    'rg --colors match:fg:red "release notes" src/app.ts; cat guide.md',
    'rg -G "*.lock" --glob-not vendor "release notes" src/app.ts; cat guide.md',
    'rg --maxdepth 2 --max-filesize 1M --max-bytes 4096 "release notes" src/app.ts; cat guide.md',
    'rg --engine pcre2 --dfa-size-limit 1G --regex-size-limit 1G "release notes" src/app.ts; cat guide.md',
    'rg --context-separator .. --field-context-separator - --field-match-separator : --path-separator / "release notes" src/app.ts; cat guide.md',
    'rg --ignore-file .rgignore --type-add web:*.html --type-clear web --in paths.txt --in0 paths0.txt "release notes" src/app.ts; cat guide.md',
    'rg --hostname-bin hostname --hyperlink-format default "release notes" src/app.ts; cat guide.md',
    'grep -n --exclude-from ignored.txt --include-dir src --group-separator .. "release notes" src/app.ts; cat guide.md',
    'git grep -n --parent-basename site "release notes" src/app.ts; cat guide.md',
    'ag --nogroup -W 80 --width 80 --workers 2 "release notes" src/app.ts; cat guide.md',
    'ag --nogroup --color-line-number "1;33" --color-match "30;43" --color-path "1;32" --ackmate-dir-filter src "release notes" src/app.ts; cat guide.md',
  ]
  const lines = ['release notes:12: deploy', '# Guide']

  for (const command of commands) {
    // Act
    const scopes = assignLines(lines, planOutput(command, lines.join('\n')))

    // Assert
    expect({ command, scopes }).toEqual({ command, scopes: [BLOCK, BLOCK] })
  }
})

test('a Markdown line that opens with the git grep pattern stays Markdown when a folder given to git is itself named grep', () => {
  // Arrange: git's own flags take a word each before the subcommand, so the first `grep` is a folder, not the subcommand
  const commands = [
    'git -C grep grep -n "release notes" src/a.ts; cat guide.md',
    'git --namespace grep --config-env core.pager=PAGER --attr-source grep grep -n "release notes" src/a.ts; cat guide.md',
  ]
  const lines = ['release notes:12: deploy', '# Guide']

  for (const command of commands) {
    // Act
    const plan = planOutput(command, lines.join('\n'))
    const scopes = assignLines(lines, plan)

    // Assert: the grep is found past git's own flags, with its file and not its pattern
    expect({ command, grepped: plan.grepped }).toEqual({ command, grepped: ['src/a.ts'] })
    expect({ command, scopes }).toEqual({ command, scopes: [BLOCK, BLOCK] })
  }
})

test('a Markdown file piped through cat -- - stays Markdown, as - is stdin after -- too, and a file named -notes.md after -- is read', () => {
  // Arrange: stdin alone, a file whose name opens with -, stdin with a file of its Language, and with one of another
  const commands = ['cat guide.md | cat -- -', 'cat -- -notes.md', 'cat guide.md | cat -- - -more.md', 'cat guide.md | cat -- - -more.txt']

  // Act
  const languages = commands.map(command => planOutput(command, '# Guide').language)

  // Assert: stdin's Markdown passes through, the named file gives its own Language, and two Languages together give none
  expect(languages).toEqual(['md', 'md', 'md', null])
})

test('the context rows grep prints around a hit keep their colours inside a TypeScript block, told by the hit beside them', () => {
  // Arrange: the row before the hit (-B) and the row after it (-A) name the hit's file and the next line number
  const command = 'cat a.ts; grep -Hn -A 1 -B 1 TODO src/x.ts; cat b.ts'
  const lines = ['const a = 1;', 'src/x.ts-2-/*', 'src/x.ts:3:// TODO', 'src/x.ts-4-*/', 'const b = 2;']

  // Act
  const scopes = assignLines(lines, planOutput(command, lines.join('\n')))

  // Assert
  expect(scopes).toEqual([BLOCK, 'text.output.grep', 'text.output.grep', 'text.output.grep', BLOCK])
})

test('a line shaped like a grep context row stays in the Language when no hit beside it names its file and the next line', () => {
  // Arrange: prose with a number between dashes, a row of another file, and a row whose number is not the next one
  const command = 'cat notes.md; grep -Hn -A 1 TODO src/x.ts; cat guide.md'
  const lines = ['7-day trial', 'src/x.ts:3:// TODO', 'src/y.ts-4-another file', 'src/x.ts-9-not the next line', '# Guide']

  // Act
  const scopes = assignLines(lines, planOutput(command, lines.join('\n')))

  // Assert
  expect(scopes).toEqual([BLOCK, 'text.output.grep', BLOCK, BLOCK, BLOCK])
})

test('a Markdown line that opens with a number stays Markdown when the word after it is the value of a wc flag, not a file wc counted', () => {
  // Arrange: GNU wc's --total takes the next word, which is no file
  const command = 'wc -l --total never "release notes.md"; cat guide.md'
  const lines = ['7 release notes.md', '3 never']

  // Act
  const scopes = assignLines(lines, planOutput(command, lines.join('\n')))

  // Assert
  expect(scopes).toEqual(['text.output.wc', BLOCK])
})

test('a GNU wc count of a file named after -- (a name that opens with -) keeps its colours, and the file after it opens with its frontmatter', () => {
  // Arrange
  const command = "wc -l -- '-release notes.md'; cat -- '-release notes.md'"
  const lines = ['7 -release notes.md', '---', 'title: Release', '---']

  // Act
  const scopes = assignLines(lines, planOutput(command, lines.join('\n')))

  // Assert
  expect(scopes).toEqual(['text.output.wc', BLOCK, BLOCK, BLOCK])
})

describe('colouring never stalls on a pathological line', () => {
  /** A line of 200,000 characters (the colouring cap): `lead`, then `unit` repeated, then `end`. */
  const fill = (unit: string, lead = '', end = '') =>
    `${lead}${unit.repeat(Math.ceil(200_000 / unit.length))}`.slice(0, 200_000 - end.length) + end
  const LINES = [
    // made only of dots, slashes, colons, spaces and digits
    ...['.', '/', ':', ' ', '1', '/:', '1 ', '1:', '. ', './', '1.', '1/', '.:', '/1:'].map(unit => ({ label: JSON.stringify(unit), line: fill(unit) })),
    // `git status` rows whose path never ends the way one does: quotes, escapes, rename arrows
    ...['"', '\\"', 'a\\', 'a -> ', '"a" -> '].map(unit => ({ label: `?? ${JSON.stringify(unit)}`, line: fill(unit, '?? ') })),
    // the same kinds of run ending in a character a regex `.` stops at, which a line can still hold: \r, U+2028
    ...['1 ', ' ', '1', '. '].flatMap(unit => ['\r', ' '].map(end => ({ label: `${JSON.stringify(unit)} then ${JSON.stringify(end)}`, line: fill(unit, '', end) }))),
  ]

  test('every Output shape tests a 200,000-character line in under 50 ms, with and without a Language', () => {
    for (const shape of SHAPE_IDS) {
      for (const language of [null, 'md']) {
        for (const { label, line } of LINES) {
          // Arrange
          const plan = { language, shapes: [shape], counted: ['release notes.md'], grepped: ['src/release notes.ts'] }

          // Act: the fastest of three runs, so a busy machine does not fail a fast regex
          const elapsed = Math.min(...[1, 2, 3].map(() => {
            const started = performance.now()
            assignLines([line], plan)
            return performance.now() - started
          }))

          // Assert
          // gstack-timing-ok: the 50 ms bound is the contract; the render hook tests every line synchronously, so a slower regex stalls Claude Code's drawing
          expect({ shape, language, line: label, slow: elapsed >= 50 }).toEqual({ shape, language, line: label, slow: false })
        }
      }
    }
  })
})

describe('Output shapes in a block with no Language', () => {
  // the one line test each Output shape had in 0.1.0, copied as it shipped: 0.1.1 split each into a strong and a weak
  // form, and a block with no Language must still colour exactly the lines 0.1.0 coloured
  const LINE_TESTS_IN_0_1_0 = {
    ls: /^(?:[-bcdlpsD][-rwxsStT]{9}[@+.]?\s+\d+\s|total \d|\S.*:$)/,
    plutil: /^\s*(?:"(?:[^"\\]|\\.)*"|\d+) => /,
    'git-status': /^(?:[ MTADRCU?!]{2} \S|## \S|\t(?:modified|new file|deleted|renamed|typechange|both modified|both added):\s|On branch \S)/,
    wc: /^\s*\d+(?:\s+\d+)*(?:\s+\S.*)?$/,
    grep: /^(?:[^:\s][^:]*?[:-]\d+[:-]|[^:\s]*\/[^:]*:|[^:\s/]+\.[A-Za-z0-9]+:|\d+[:-]|--$)/,
  }
  // every line the tests in this file use, the forms each shape is written for, and 200-character runs of the
  // pathological fills (short enough for 0.1.0's slower grep test)
  const LINES = [
    ...MEMORY_READ_OUTPUT,
    '--- obsidian lines', '/Users/me/.zprofile:3:# Added by Obsidian', '/Applications/Obsidian.app/Contents/MacOS/:', 'total 408',
    'drwxr-xr-x   4 me  admin     128 10 Nov 16:39 .', '-rwxr-xr-x@  1 me  admin   69632 10 Nov 16:39 Obsidian',
    '  "CFBundleName" => "Grok Bot"', '    0 => {', '--',
    '      95 developing.md', '     319 total', '# This Mac', '- One display',
    '1:export const greet = 1', '2:export function main() {}',
    '## main...origin/main [ahead 1]', ' M src/a.ts', '?? notes.md', 'Things to check:', 'src/a.ts:12:const a = 1', 'hello',
    '## Release notes', '## Usage', '## main', 'Text under them.', '2 deployments failed', '3 of them on Friday.',
    '09:30 deploy', '7-day trial before deploy', 'Shipped on 2026-11-24 after the deploy review',
    '# Notes', 'src/app.ts:12:const deploy = 1', '-rw-r--r--  1 me  staff  120 Nov 27 10:00 a.md', 'total 48', ' M src/app.ts',
    '12:const deploy = 1',
    'On branch main', '\tmodified:   src/app.ts', '   src/app.ts', 'MM src/b.ts', 'src/app.ts-11-const before = 0',
    'notes.md:deploy on Friday', '  12  48 320 README.md', '120 total', '95 Makefile', 'src/:', 'total 0',
    // lines holding a character a regex `.` stops at (\r, U+2028, U+2029), in the name and among the counts
    '1 release notes', '2 deployments failed\r', '12\r', '1 2', '1 2\rnotes.md', ' 1 notes.md', '1 x', '       7 a b',
    ...['.', '/', ':', ' ', '1', '/:', '1 ', '1:', '. ', './', '1.', '1/', '.:', '/1:'].map(fill =>
      fill.repeat(Math.ceil(200 / fill.length)).slice(0, 200),
    ),
  ]

  test('every line takes exactly the Output shapes it took in 0.1.0', () => {
    for (const [shape, lineTestIn010] of Object.entries(LINE_TESTS_IN_0_1_0)) {
      // Arrange
      const plan = { language: null, shapes: [shape] }

      // Act
      const scopes = assignLines(LINES, plan)

      // Assert
      const differing = LINES.filter((line, k) => (scopes[k] === `text.output.${shape}`) !== lineTestIn010.test(line))
      expect({ shape, differing }).toEqual({ shape, differing: [] })
    }
  })
})
