import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Plugin } from 'claude-code/testing'

// the test kit runs on a runtime with timers; Claude Code's types leave them out, as a mod has none of its own
declare function setTimeout(callback: () => void, ms: number): unknown

const PLUGIN = 'syntax-highlight'
const CLAUDE_CODE_DRAWS = 'claude code draws this row'
const CWD_NOTICE = '\nShell cwd was reset to /Users/me/project'
const MEMORY_COMMAND = 'cd /Users/me/.claude/projects/app/memory; cat deploy-lock.md'
const MEMORY_STDOUT = '---\nname: deploy-lock\nmetadata:\n  type: feedback\n---\n\n**Why:** the lock check reads the runner log first.\n'

/** What the engine stand-in saw: each result Claude Code was asked to draw, the worker's inputs, the redraws asked. */
type Seen = { drawnByClaudeCode: Record<string, unknown>[]; workerInputs: Record<string, unknown>[]; invalidations: number }

/**
 * Stands in for Claude Code beneath the mod: draws any row it is asked for as one Text, answers the worker
 * (tokenize.mjs) with every line coloured red, and counts the redraws the mod asks for.
 *
 * @param on - The test's `on`, whose hooks sit beneath every plugin.
 * @returns what the stand-in saw, filled in as the test runs
 * @example
 * const seen = standInForClaudeCode(on)
 * // after a ToolResult that Claude Code drew: seen.drawnByClaudeCode[0] → the output record it was given
 */
const standInForClaudeCode = (on: On): Seen => {
  const seen: Seen = { drawnByClaudeCode: [], workerInputs: [], invalidations: 0 }
  on('ui.render', ($, e) => {
    if (e.component === 'ToolResult') seen.drawnByClaudeCode.push(e.props.output as Record<string, unknown>)
    const { Text } = $.ui.resolve(e)

    return <Text>{CLAUDE_CODE_DRAWS}</Text>
  })
  on('process.run', (_, e) => {
    const asked = JSON.parse(String(e.init?.stdin ?? '{}')) as Record<string, unknown>
    seen.workerInputs.push(asked)
    const text = String(asked.output ?? asked.code ?? asked.command ?? '')
    const lines = text.split('\n').map(t => (t === '' ? [] : [{ t, fg: '#ff0000', b: false, i: false, u: false }]))

    return {
      value: { exitCode: 0, stdout: JSON.stringify({ editor: 'test', theme: 'test', lines }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('ui.invalidate', (_, e, next) => {
    seen.invalidations++

    return next(e)
  })
  on('clock.sleep', () => ({ value: undefined }))

  return seen
}

/** The Bash call's own row, which tells the mod the command (as a live call or a resumed session does). */
const commandRow = (id: string, command: string) =>
  ({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolUse',
    requestId: id,
    props: { tool_use_id: id, tool: 'Bash', input: { command }, isRunning: false, isErrored: false, isInterrupted: false, isExpanded: true },
  }) as const

/** The Bash call's Output block. */
const outputBlock = (id: string, output: Record<string, unknown>, isExpanded = true) =>
  ({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolResult',
    requestId: id,
    props: { tool_use_id: id, tool: 'Bash', output, isErrored: false, isExpanded },
  }) as const

test('a Markdown read after a cd outside the project is coloured top to bottom, with Claude Code still drawing its cwd notice once', async ($, on) => {
  // Arrange
  const seen = standInForClaudeCode(on)
  const row = await $.ui.mount(commandRow('call-1', MEMORY_COMMAND))
  const output = { stdout: MEMORY_STDOUT, stderr: CWD_NOTICE, interrupted: false, isImage: false }

  // Act
  const block = await $.ui.mount(outputBlock('call-1', output))
  await block.redraw()

  // Assert: the stdout rows are the mod's, the notice is Claude Code's, drawn once below them
  const texts = (await block.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.some(text => text.includes('name: deploy-lock'))).toBe(true)
  expect(texts.filter(text => text === CLAUDE_CODE_DRAWS)).toHaveLength(1)
  expect(texts.indexOf(CLAUDE_CODE_DRAWS)).toBeGreaterThan(texts.findIndex(text => text.includes('**Why:**')))
  expect(seen.drawnByClaudeCode.at(-1)).toEqual({ stdout: '', stderr: CWD_NOTICE, interrupted: false, isImage: false })
  await block.unmount()
  await row.unmount()
})

test('a collapsed cwd-notice result keeps the fold hint above Claude Code\'s notice', async ($, on) => {
  // Arrange
  standInForClaudeCode(on)
  const row = await $.ui.mount(commandRow('call-2', MEMORY_COMMAND))
  const output = { stdout: MEMORY_STDOUT, stderr: CWD_NOTICE, interrupted: false, isImage: false }

  // Act
  const block = await $.ui.mount(outputBlock('call-2', output, false))
  await block.redraw()

  // Assert
  const texts = (await block.findAll({ type: 'Text' })).map(t => t.text)
  const hint = texts.findIndex(text => /\+\d+ lines \(ctrl\+o to expand\)/.test(text))
  expect(hint).toBeGreaterThan(-1)
  expect(texts.filter(text => text === CLAUDE_CODE_DRAWS)).toHaveLength(1)
  expect(texts.indexOf(CLAUDE_CODE_DRAWS)).toBeGreaterThan(hint)
  await block.unmount()
  await row.unmount()
})

test('a command that edited files keeps Claude Code\'s edit diff under its coloured output', async ($, on) => {
  // Arrange
  const seen = standInForClaudeCode(on)
  const row = await $.ui.mount(commandRow('call-3', 'cat notes.md'))
  const bashEditDiff = { files: [{ filePath: '/repo/notes.md', hunks: [] }] }
  const output = { stdout: '# Notes\n', stderr: '', interrupted: false, isImage: false, bashEditDiff }

  // Act
  const block = await $.ui.mount(outputBlock('call-3', output))
  await block.redraw()

  // Assert
  const texts = (await block.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('# Notes')
  expect(texts.filter(text => text === CLAUDE_CODE_DRAWS)).toHaveLength(1)
  expect(seen.drawnByClaudeCode.at(-1)).toEqual({ stdout: '', stderr: '', interrupted: false, isImage: false, bashEditDiff })
  await block.unmount()
  await row.unmount()
})

test('images a command viewed stay under its coloured output, drawn by Claude Code', async ($, on) => {
  // Arrange
  const seen = standInForClaudeCode(on)
  const row = await $.ui.mount(commandRow('call-14', 'cat notes.md'))
  const output = { stdout: '# Notes\n', stderr: '', interrupted: false, isImage: false, viewedImagePaths: ['/repo/shot.png'] }

  // Act
  const block = await $.ui.mount(outputBlock('call-14', output))
  await block.redraw()

  // Assert
  const texts = (await block.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('# Notes')
  expect(texts.filter(text => text === CLAUDE_CODE_DRAWS)).toHaveLength(1)
  expect(seen.drawnByClaudeCode.at(-1)).toEqual({ ...output, stdout: '' })
  await block.unmount()
  await row.unmount()
})

test('any other stderr stays Claude Code\'s row under the coloured output, as the cwd notice does', async ($, on) => {
  // Arrange
  const seen = standInForClaudeCode(on)
  const row = await $.ui.mount(commandRow('call-17', 'cat notes.md'))
  const output = { stdout: '# Notes\n', stderr: 'warning: notes.md is not tracked', interrupted: false, isImage: false }

  // Act
  const block = await $.ui.mount(outputBlock('call-17', output))
  await block.redraw()

  // Assert
  const texts = (await block.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('# Notes')
  expect(texts.filter(text => text === CLAUDE_CODE_DRAWS)).toHaveLength(1)
  expect(seen.drawnByClaudeCode.at(-1)).toEqual({ ...output, stdout: '' })
  await block.unmount()
  await row.unmount()
})

test('plain coloured output, and output whose only extra is a persisted-output note, draw no "(No output)" row of Claude Code\'s', async ($, on) => {
  // Arrange
  const seen = standInForClaudeCode(on)
  const plain = { stdout: '# Notes\n', stderr: '', interrupted: false, isImage: false }
  const persisted = { ...plain, persistedOutputPath: '/tmp/out.txt', persistedOutputSize: 90000 }
  const rows = [await $.ui.mount(commandRow('call-4', 'cat notes.md')), await $.ui.mount(commandRow('call-5', 'cat notes.md'))]

  // Act
  const plainBlock = await $.ui.mount(outputBlock('call-4', plain))
  await plainBlock.redraw()
  const persistedBlock = await $.ui.mount(outputBlock('call-5', persisted))
  await persistedBlock.redraw()

  // Assert: once coloured, neither block asks Claude Code to draw an emptied result
  const plainTexts = (await plainBlock.findAll({ type: 'Text' })).map(t => t.text)
  const persistedTexts = (await persistedBlock.findAll({ type: 'Text' })).map(t => t.text)
  expect(plainTexts).toContain('# Notes')
  expect(plainTexts).not.toContain(CLAUDE_CODE_DRAWS)
  expect(persistedTexts).toContain('# Notes')
  expect(persistedTexts).not.toContain(CLAUDE_CODE_DRAWS)
  expect(seen.drawnByClaudeCode.filter(output => output.stdout === '')).toEqual([])
  for (const block of [plainBlock, persistedBlock, ...rows]) await block.unmount()
})

test('a result with nothing to colour, an interrupt, an image, a background task, an exit code\'s explanation or a first line past the colouring cap is drawn by Claude Code as it is', async ($, on) => {
  // Arrange
  const seen = standInForClaudeCode(on)
  const cases = [
    { id: 'call-6', output: { stdout: '', stderr: CWD_NOTICE, interrupted: false, isImage: false } },
    { id: 'call-7', output: { stdout: '# Notes\n', stderr: '', interrupted: true, isImage: false } },
    { id: 'call-15', output: { stdout: '# Notes\n', stderr: '', interrupted: false, isImage: true } },
    { id: 'call-16', output: { stdout: '# Notes\n', stderr: '', interrupted: false, isImage: false, backgroundTaskId: 'b1' } },
    { id: 'call-13', output: { stdout: 'no matches\n', stderr: '', interrupted: false, isImage: false, returnCodeInterpretation: 'No matches found' } },
    { id: 'call-8', output: { stdout: `${'x'.repeat(200_001)}\n# Notes\n`, stderr: '', interrupted: false, isImage: false } },
  ]

  for (const { id, output } of cases) {
    const row = await $.ui.mount(commandRow(id, 'cat notes.md'))

    // Act
    const block = await $.ui.mount(outputBlock(id, output))
    await block.redraw()

    // Assert: only Claude Code's drawing, given the result untouched
    expect((await block.findAll({ type: 'Text' })).map(t => t.text)).toEqual([CLAUDE_CODE_DRAWS])
    expect(seen.drawnByClaudeCode.at(-1)).toEqual(output)
    await block.unmount()
    await row.unmount()
  }
})

test('a result drawn before its command is known (a resumed session) is coloured again from the command once it arrives', async ($, on) => {
  // Arrange: the command's colours are already cached (the same command ran earlier), so drawing its row starts no
  // worker and asks for no redraw of its own; the Output block is then drawn with no command known
  const seen = standInForClaudeCode(on)
  const earlier = await $.ui.mount(commandRow('call-9', 'cat notes.md'))
  const output = { stdout: '## Heading\nBody text.\n', stderr: '', interrupted: false, isImage: false }
  const block = await $.ui.mount(outputBlock('call-10', output))
  await block.redraw()

  // Act: the block's own command row is drawn
  const row = await $.ui.mount(commandRow('call-10', 'cat notes.md'))
  await block.find({ type: 'Text' })

  // Assert: the worker coloured the block a second time, planned from the command
  const outputRuns = seen.workerInputs.filter(asked => typeof asked.output === 'string').map(asked => asked.command)
  expect(outputRuns).toEqual(['', 'cat notes.md'])
  for (const handle of [row, block, earlier]) await handle.unmount()
})

test('drawing a command row again asks for no further redraw of its Output block', async ($, on) => {
  // Arrange: a result drawn before its command, then the command row drawn once
  const seen = standInForClaudeCode(on)
  const earlier = await $.ui.mount(commandRow('call-11', 'cat notes.md'))
  const output = { stdout: '# Notes\n', stderr: '', interrupted: false, isImage: false }
  const block = await $.ui.mount(outputBlock('call-12', output))
  await block.redraw()
  const row = await $.ui.mount(commandRow('call-12', 'cat notes.md'))
  await block.find({ type: 'Text' })
  const invalidationsBefore = seen.invalidations

  // Act: the command row is drawn again with the same command
  await row.redraw()

  // Assert
  expect(seen.invalidations - invalidationsBefore).toBe(0)
  for (const handle of [row, block, earlier]) await handle.unmount()
})

// Generated by /gstack-ship coverage audit.
// Value: protects=Output block coloured when a Bash call returns, before first draw; fails_when=tool.call hook stops pre-colouring or colours interrupted/failed results; why_new=only ToolResult drawing tested; seam=none; no_claim=colours
test('a Bash call that returns Markdown with a cwd notice has its Output block coloured before any row is drawn, and an interrupted one is not', async ($, on) => {
  // Arrange
  const seen = standInForClaudeCode(on)
  on('tool.call', (_, e) => {
    const command = (e as { command?: string }).command ?? ''
    const interrupted = command.includes('interrupted')

    return { result: { stdout: MEMORY_STDOUT, stderr: CWD_NOTICE, interrupted, isImage: false } }
  })

  // Act
  await $.tool.call({ tool: 'Bash', command: MEMORY_COMMAND, tool_use_id: 'call-20' } as never)
  const coloured = seen.workerInputs.filter(asked => typeof asked.output === 'string')
  await $.tool.call({ tool: 'Bash', command: 'cat deploy-lock.md # interrupted', tool_use_id: 'call-21' } as never)
  const colouredAfterInterrupt = seen.workerInputs.filter(asked => typeof asked.output === 'string')

  // Assert
  expect(coloured).toHaveLength(1)
  expect(coloured[0]).toMatchObject({ command: MEMORY_COMMAND })
  expect(String(coloured[0]?.output)).toContain('name: deploy-lock')
  expect(colouredAfterInterrupt).toHaveLength(1)
})

/**
 * Stands in for a mod that masks secrets in a Bash call's output once the call has run, as secret-guard does, loaded in
 * `tier` (`prepend` runs outside this mod, `append` inside it). Its mask is as long as the secret, so the masked text
 * keeps the length of the text this mod's `tool.call` hook saw. Self-contained, as an inline plugin's `register` is.
 *
 * @param tier - The tier the masker loads in.
 * @returns the inline plugin, for a test's `plugins`
 */
const maskingMod = (tier: 'prepend' | 'append'): Plugin => ({
  name: 'masker',
  tier,
  register(on) {
    on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
      const ran = await next(e)
      const result = (ran as { result?: { stdout?: unknown } }).result
      if (typeof result?.stdout !== 'string') return ran

      return { result: { ...result, stdout: result.stdout.replaceAll('sk-live-4f9a2c7e1b', '******************') } } as typeof ran
    })
  },
})

for (const [tier, side] of [['prepend', 'outside'], ['append', 'inside']] as const) {
  test(`a secret masked by a mod running ${side} this one never reaches the coloured Output block`, { plugins: [maskingMod(tier)] }, async ($, on) => {
    // Arrange: Claude Code's Bash answers with the secret, and the masker rewrites the record once the call has run
    standInForClaudeCode(on)
    on('tool.call', () => ({ result: { stdout: '# Deploy\nAPI_TOKEN=sk-live-4f9a2c7e1b\n', stderr: '', interrupted: false, isImage: false } }))
    const id = `call-mask-${tier}`
    const done = await $.tool.call({ tool: 'Bash', command: 'cat deploy.md', tool_use_id: id } as never)
    const record = (done as { result?: Record<string, unknown> }).result ?? {}
    const row = await $.ui.mount(commandRow(id, 'cat deploy.md'))

    // Act
    const block = await $.ui.mount(outputBlock(id, record))
    await block.redraw()

    // Assert: the block is the mod's coloured drawing of the masked record, with no trace of the secret
    const texts = (await block.findAll({ type: 'Text' })).map(t => t.text)
    expect(record.stdout).toBe('# Deploy\nAPI_TOKEN=******************\n')
    expect(texts).toContain('API_TOKEN=******************')
    expect(texts.filter(text => text.includes('sk-live-4f9a2c7e1b'))).toEqual([])
    await block.unmount()
    await row.unmount()
  })
}

test('a Bash call whose colours come back within the wait has its Output block coloured on the first draw', async ($, on) => {
  // Arrange: the worker takes a real 40 ms and the wait's own timer never fires, so only the colours can end the wait
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{CLAUDE_CODE_DRAWS}</Text>
  })
  on('process.run', async (_, e) => {
    await new Promise(resolve => setTimeout(() => resolve(undefined), 40))
    const asked = JSON.parse(String(e.init?.stdin ?? '{}')) as Record<string, unknown>
    const text = String(asked.output ?? asked.command ?? '')
    const lines = text.split('\n').map(t => (t === '' ? [] : [{ t, fg: '#ff0000', b: false, i: false, u: false }]))

    return {
      value: { exitCode: 0, stdout: JSON.stringify({ editor: 'test', theme: 'test', lines }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('clock.sleep', () => new Promise<never>(() => {}))
  on('tool.call', () => ({ result: { stdout: '# Notes\nBody text.\n', stderr: '', interrupted: false, isImage: false } }))

  // Act
  const done = await $.tool.call({ tool: 'Bash', command: 'cat notes.md', tool_use_id: 'call-24' } as never)
  const block = await $.ui.mount(outputBlock('call-24', (done as { result?: Record<string, unknown> }).result ?? {}))

  // Assert: the first drawing, with no redraw asked for, is already the mod's
  const texts = (await block.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('# Notes')
  expect(texts).not.toContain(CLAUDE_CODE_DRAWS)
  await block.unmount()
})
