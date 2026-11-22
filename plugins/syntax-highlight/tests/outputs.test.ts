import { describe, expect, test } from 'claude-code/testing'

import { BLOCK, SHAPE_IDS, assignLines, hasColour, planOutput } from '../outputs.mjs'

describe('the Language of a whole Output block', () => {
  test('a Markdown file printed after cd is coloured as Markdown', () => {
    // Arrange
    const command = 'cd ~/.claude/skills/desktop-walkthrough/references && cat pitfalls.md records.md'

    // Act
    const plan = planOutput(command, '# Pitfalls from real runs')

    // Assert
    expect(plan).toEqual({ language: 'md', shapes: [] })
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
    expect(plan).toEqual({ language: null, shapes: ['plutil'] })
  })
})

describe('Output shapes in an Output block', () => {
  test('a block mixing grep hits, an ls listing and plutil pairs colours each line by its shape', () => {
    // Arrange
    const command =
      'echo "--- obsidian lines"; grep -n -i obsidian ~/.zprofile; ls -la /Applications/Obsidian.app/Contents/MacOS/; plutil -p Info.plist | grep -E CFBundleName -A3 | head -30'
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
    expect(plan).toEqual({ language: null, shapes: ['ls', 'plutil', 'grep'] })
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
    expect(plan).toEqual({ language: 'md', shapes: ['wc'] })
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
    expect(plan).toEqual({ language: null, shapes: SHAPE_IDS })
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
