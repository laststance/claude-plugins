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

// Value: protects=a Bash result whose stdout is not a string, or is null, is left to Claude Code untouched; fails_when=the stdout type guard in colourableResult is removed and the ToolResult hook throws or draws a block;
//   why_new=this table covered empty, interrupted, image, background and capped results, not a malformed record; seam=none;
//   no_claim=real Claude Code drawing (stand-in draws a Text; worker answers red for every line)
test('a result with nothing to colour, an interrupt, an image, a background task, an ANSI colour or a first line past the colouring cap is drawn by Claude Code as it is', async ($, on) => {
  // Arrange
  const seen = standInForClaudeCode(on)
  const cases = [
    { id: 'call-6', output: { stdout: '', stderr: CWD_NOTICE, interrupted: false, isImage: false } },
    { id: 'call-7', output: { stdout: '# Notes\n', stderr: '', interrupted: true, isImage: false } },
    { id: 'call-15', output: { stdout: '# Notes\n', stderr: '', interrupted: false, isImage: true } },
    { id: 'call-16', output: { stdout: '# Notes\n', stderr: '', interrupted: false, isImage: false, backgroundTaskId: 'b1' } },
    // an ESC, which a drawn Text refuses
    { id: 'call-13', output: { stdout: '# Notes\n\u001b[31mfailed\u001b[0m\n', stderr: '', interrupted: false, isImage: false } },
    { id: 'call-8', output: { stdout: `${'x'.repeat(200_001)}\n# Notes\n`, stderr: '', interrupted: false, isImage: false } },
    // a record with no usable stdout: a number, no field at all, or no record
    { id: 'call-30', output: { stdout: 42, stderr: '', interrupted: false, isImage: false } },
    { id: 'call-31', output: { stderr: CWD_NOTICE, interrupted: false, isImage: false } },
    { id: 'call-32', output: null as unknown as Record<string, unknown> },
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

test('a result drawn before its command is known (a resumed session) is Claude Code\'s until the command arrives, then coloured once from it', async ($, on) => {
  // Arrange: the command's colours are already cached (the same command ran earlier), so drawing its row starts no
  // worker and asks for no redraw of its own; the Output block is then drawn with no command known
  const seen = standInForClaudeCode(on)
  const earlier = await $.ui.mount(commandRow('call-9', 'cat notes.md'))
  const output = { stdout: '## Heading\nBody text.\n', stderr: '', interrupted: false, isImage: false }
  const block = await $.ui.mount(outputBlock('call-10', output))
  await block.redraw()
  const textsBeforeCommand = (await block.findAll({ type: 'Text' })).map(t => t.text)

  // Act: the block's own command row is drawn
  const row = await $.ui.mount(commandRow('call-10', 'cat notes.md'))
  await block.find({ type: 'Text' })

  // Assert: no worker guessed at the block before its command; one coloured it from the command
  const outputRuns = seen.workerInputs.filter(asked => typeof asked.output === 'string').map(asked => asked.command)
  expect(textsBeforeCommand).toEqual([CLAUDE_CODE_DRAWS])
  expect(outputRuns).toEqual(['cat notes.md'])
  expect((await block.findAll({ type: 'Text' })).map(t => t.text)).toContain('## Heading')
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

test('a resumed session drawing more results than the colour caches hold, before their commands, stops asking for redraws once every command is known', { timeoutMs: 60_000 }, async ($, on) => {
  // Arrange: 201 results drawn before their command rows (one more than the colour caches keep), then the rows, then
  // everything drawn once more so every command has been seen
  const seen = standInForClaudeCode(on)
  const ids = Array.from({ length: 201 }, (_, n) => `call-resume-${n}`)
  const output = { stdout: 'ok\n', stderr: '', interrupted: false, isImage: false }
  const handles: Array<{ redraw: () => Promise<void>; unmount: () => Promise<void> }> = []
  for (const id of ids) handles.push(await $.ui.mount(outputBlock(id, output)))
  for (const id of ids) handles.push(await $.ui.mount(commandRow(id, 'echo ok')))
  for (const handle of handles) await handle.redraw()
  const invalidationsBefore = seen.invalidations

  // Act: every row is drawn again, as a resize or a scroll back draws it
  for (const handle of handles) await handle.redraw()

  // Assert
  expect(seen.invalidations - invalidationsBefore).toBe(0)
  for (const handle of handles) await handle.unmount()
})

test('a block the worker leaves uncoloured (a file type with no grammar) is drawn by Claude Code as it is, cwd notice included', async ($, on) => {
  // Arrange: Claude Code draws any row it is asked for, and the worker hands back every line without a colour
  const drawnByClaudeCode: unknown[] = []
  on('ui.render', ($, e) => {
    if (e.component === 'ToolResult') drawnByClaudeCode.push(e.props.output)
    const { Text } = $.ui.resolve(e)

    return <Text>{CLAUDE_CODE_DRAWS}</Text>
  })
  on('process.run', (_, e) => {
    const asked = JSON.parse(String(e.init?.stdin ?? '{}')) as Record<string, unknown>
    const text = String(asked.output ?? asked.command ?? '')
    const lines = text.split('\n').map(t => (t === '' ? [] : [{ t, fg: null, b: false, i: false, u: false }]))

    return {
      value: { exitCode: 0, stdout: JSON.stringify({ editor: 'test', theme: 'test', lines }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('clock.sleep', () => ({ value: undefined }))
  const output = { stdout: 'plain notes\n', stderr: CWD_NOTICE, interrupted: false, isImage: false }
  const row = await $.ui.mount(commandRow('call-25', 'cat notes.zzunknown'))

  // Act
  const block = await $.ui.mount(outputBlock('call-25', output))
  await block.redraw()

  // Assert: only Claude Code's drawing, given the result untouched
  expect((await block.findAll({ type: 'Text' })).map(t => t.text)).toEqual([CLAUDE_CODE_DRAWS])
  expect(drawnByClaudeCode.at(-1)).toEqual(output)
  await block.unmount()
  await row.unmount()
})

test('a result with a long run of spaces inside a line is drawn coloured at once, without stalling the call', async ($, on) => {
  // Arrange: a padded field 200,000 spaces wide, then a value, under a Markdown heading
  standInForClaudeCode(on)
  on('tool.call', () => ({ result: { stdout: `# Notes\nx${' '.repeat(200_000)}y\n`, stderr: '', interrupted: false, isImage: false } }))

  // Act
  const done = await $.tool.call({ tool: 'Bash', command: 'cat notes.md', tool_use_id: 'call-26' } as never)
  const block = await $.ui.mount(outputBlock('call-26', (done as { result?: Record<string, unknown> }).result ?? {}))
  await block.redraw()

  // Assert: the heading is the mod's coloured row; the over-long line follows it as it is
  const texts = (await block.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('# Notes')
  expect(texts).not.toContain(CLAUDE_CODE_DRAWS)
  await block.unmount()
})

test('more coloured results drawn at once than the colour cache holds start no further workers when drawn again', { timeoutMs: 60_000 }, async ($, on) => {
  // Arrange: 201 coloured results, each under its own command row, one more than the Output colour cache holds; then
  // everything drawn once more, so every block has been coloured or found pushed out
  const seen = standInForClaudeCode(on)
  const handles: Array<{ redraw: () => Promise<void>; unmount: () => Promise<void> }> = []
  for (let n = 0; n < 201; n++) {
    handles.push(await $.ui.mount(commandRow(`call-many-${n}`, `cat notes-${n}.md`)))
    handles.push(await $.ui.mount(outputBlock(`call-many-${n}`, { stdout: `# Notes ${n}\n`, stderr: '', interrupted: false, isImage: false })))
  }
  for (const handle of handles) await handle.redraw()
  const workersBefore = seen.workerInputs.length

  // Act: every row is drawn again, as a resize or a scroll back draws it
  for (const handle of handles) await handle.redraw()

  // Assert
  expect(seen.workerInputs.length - workersBefore).toBe(0)
  for (const handle of handles) await handle.unmount()
})

test('a stderr holding only Claude Code\'s sandbox-violations report draws no "(No output)" row of Claude Code\'s under the coloured output', async ($, on) => {
  // Arrange: Claude Code appends this report to stderr and takes it out again before drawing
  const seen = standInForClaudeCode(on)
  const row = await $.ui.mount(commandRow('call-27', 'cat notes.md'))
  const output = { stdout: '# Notes\n', stderr: '\n<sandbox_violations>\nnetwork: example.com denied\n</sandbox_violations>', interrupted: false, isImage: false }

  // Act
  const block = await $.ui.mount(outputBlock('call-27', output))
  await block.redraw()

  // Assert: the coloured block alone, and Claude Code never asked to draw an emptied result
  const texts = (await block.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('# Notes')
  expect(texts).not.toContain(CLAUDE_CODE_DRAWS)
  expect(seen.drawnByClaudeCode.filter(drawn => drawn.stdout === '')).toEqual([])
  await block.unmount()
  await row.unmount()
})

// Value: protects=a Bash call that ends in an error result starts no colouring worker for its Output block and is returned unchanged;
//   fails_when=the isError check in the tool.call hook is dropped and an error's stdout is coloured as an Output block;
//   why_new=the pre-colour test returns only successful and interrupted results; seam=none;
//   no_claim=real Claude Code error rows (the stand-in returns a canned error record)
test('a Bash call that fails is returned as it is, with no Output block coloured for its error text', async ($, on) => {
  // Arrange
  const seen = standInForClaudeCode(on)
  on('tool.call', () => ({ result: { stdout: MEMORY_STDOUT, stderr: '', interrupted: false, isImage: false }, isError: true }) as never)

  // Act
  await $.tool.call({ tool: 'Bash', command: MEMORY_COMMAND, tool_use_id: 'call-40' } as never)

  // Assert: the command is coloured on its way in, the error's text never is
  expect(seen.workerInputs.filter(asked => typeof asked.output === 'string')).toHaveLength(0)
  expect(seen.workerInputs.filter(asked => asked.command === MEMORY_COMMAND)).toHaveLength(1)
})

test('a result holding an ANSI colour and a cwd notice is drawn by Claude Code whole, its stdout kept', async ($, on) => {
  // Arrange: an ESC, which a drawn Text refuses, and a sibling row for Claude Code to draw
  const seen = standInForClaudeCode(on)
  const row = await $.ui.mount(commandRow('call-43', 'cd /tmp/build; cat build.log'))
  const output = { stdout: '# Build\n\u001b[31mfailed\u001b[0m\n', stderr: CWD_NOTICE, interrupted: false, isImage: false }

  // Act
  const block = await $.ui.mount(outputBlock('call-43', output))
  await block.redraw()

  // Assert: Claude Code draws the record as it is, stdout and all, and no worker colours the block
  expect((await block.findAll({ type: 'Text' })).map(t => t.text)).toEqual([CLAUDE_CODE_DRAWS])
  expect(seen.drawnByClaudeCode.at(-1)).toEqual(output)
  expect(seen.workerInputs.filter(input => 'output' in input)).toEqual([])
  for (const handle of [block, row]) await handle.unmount()
})

test('an expanded block with more rows than one drawing holds, and a cwd notice, is drawn by Claude Code whole, its stdout kept', async ($, on) => {
  // Arrange: 8,000 short lines take three nodes each, past the 20,000 the engine draws in one tree
  const seen = standInForClaudeCode(on)
  const row = await $.ui.mount(commandRow('call-44', 'cd /tmp/ids; cat ids.md'))
  const stdout = `${Array.from({ length: 8000 }, (_, n) => `id ${n}`).join('\n')}\n`
  const output = { stdout, stderr: CWD_NOTICE, interrupted: false, isImage: false }
  const collapsed = await $.ui.mount({ ...outputBlock('call-44', output, false), requestId: 'call-44-collapsed' })
  await collapsed.redraw()

  // Act
  const expanded = await $.ui.mount(outputBlock('call-44', output, true))
  await expanded.redraw()

  // Assert: expanded, Claude Code draws the record as it is; collapsed, the few rows of the fold stay coloured
  expect((await expanded.findAll({ type: 'Text' })).map(t => t.text)).toEqual([CLAUDE_CODE_DRAWS])
  expect(seen.drawnByClaudeCode.at(-1)).toEqual(output)
  expect((await collapsed.findAll({ type: 'Text' })).map(t => t.text)).toContain('id 0')
  for (const handle of [expanded, collapsed, row]) await handle.unmount()
})

test('a Bash call whose id is longer than a hover scope may be (a gateway\'s) has both rows coloured, its stdout kept above the cwd notice', async ($, on) => {
  // Arrange: a 56-character id, and a sibling row for Claude Code to draw
  const seen = standInForClaudeCode(on)
  const id = `toolu_gateway_${'a1b2c3'.repeat(7)}`
  const row = await $.ui.mount(commandRow(id, 'cd /tmp/site; cat notes.md'))
  const output = { stdout: '# Notes\n', stderr: CWD_NOTICE, interrupted: false, isImage: false }

  // Act
  const block = await $.ui.mount(outputBlock(id, output))
  for (const handle of [row, block]) await handle.redraw()

  // Assert: the mod draws both rows, and Claude Code draws only the cwd notice
  expect((await block.findAll({ type: 'Text' })).map(t => t.text)).toContain('# Notes')
  expect((await row.findAll({ type: 'Text' })).map(t => t.text)).not.toContain(CLAUDE_CODE_DRAWS)
  expect(seen.drawnByClaudeCode.at(-1)).toEqual({ stdout: '', stderr: CWD_NOTICE, interrupted: false, isImage: false })
  for (const handle of [block, row]) await handle.unmount()
})

test('a theme colour written in short hex (#fff, as some themes write it) is drawn as a full colour, not a broken one', async ($, on) => {
  // Arrange: a worker answering with the theme's short-hex white
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{CLAUDE_CODE_DRAWS}</Text>
  })
  on('process.run', () => {
    const lines = [[{ t: '# Notes', fg: '#fff', b: false, i: false, u: false }]]

    return { value: { exitCode: 0, stdout: JSON.stringify({ editor: 'test', theme: 'test', lines }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('clock.sleep', () => ({ value: undefined }))
  const row = await $.ui.mount(commandRow('call-52', 'cat notes.md'))

  // Act
  const block = await $.ui.mount(outputBlock('call-52', { stdout: '# Notes\n', stderr: '', interrupted: false, isImage: false }))
  await block.redraw()

  // Assert: white pulled toward grey by the Output blocks' strength (0.75), in six hex digits
  const colours = (await block.findAll({ type: 'Text' })).map(t => t.props.color).filter(colour => colour !== undefined)
  expect(colours).toEqual(['#e6e6e6'])
  for (const handle of [block, row]) await handle.unmount()
})

test('a diff -u that exits 1 because the files differ has its diff coloured', async ($, on) => {
  // Arrange: Claude Code explains the exit code, which it shows only for an empty stdout
  standInForClaudeCode(on)
  const row = await $.ui.mount(commandRow('call-46', 'diff -u old.md new.md'))
  const output = { stdout: '--- old.md\n+++ new.md\n@@ -1 +1 @@\n-draft\n+final\n', stderr: '', interrupted: false, isImage: false, returnCodeInterpretation: 'Files differ' }

  // Act
  const block = await $.ui.mount(outputBlock('call-46', output))
  await block.redraw()

  // Assert
  const texts = (await block.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('--- old.md')
  expect(texts).not.toContain(CLAUDE_CODE_DRAWS)
  for (const handle of [block, row]) await handle.unmount()
})

test('under a coloured diff that exits 1 after a cd, Claude Code draws the cwd notice without the exit code\'s explanation', async ($, on) => {
  // Arrange
  const seen = standInForClaudeCode(on)
  const row = await $.ui.mount(commandRow('call-47', 'cd /tmp/site && diff -u old.md new.md'))
  const output = { stdout: '--- old.md\n+++ new.md\n@@ -1 +1 @@\n-draft\n+final\n', stderr: CWD_NOTICE, interrupted: false, isImage: false, returnCodeInterpretation: 'Files differ' }

  // Act
  const block = await $.ui.mount(outputBlock('call-47', output))
  await block.redraw()

  // Assert: the record Claude Code draws the sibling rows from has no stdout and no explanation
  expect(seen.drawnByClaudeCode.at(-1)).toEqual({ stdout: '', stderr: CWD_NOTICE, interrupted: false, isImage: false })
  expect((await block.findAll({ type: 'Text' })).map(t => t.text)).toContain('+final')
  for (const handle of [block, row]) await handle.unmount()
})

test('an expanded block taller than the main screen that Claude Code drew first stays as drawn once its colours are back, so none of its rows are doubled', async ($, on) => {
  // Arrange: blocks drawn before their colours are back, as in a resumed session: 40 lines and 5 lines on a 24-row main
  // screen, and 40 lines on a fullscreen one, which redraws all of itself
  standInForClaudeCode(on)
  const mainScreen = { columns: 80, rows: 24, isFullscreen: false }
  const fullscreen = { columns: 80, rows: 24, isFullscreen: true }
  const list = (count: number) => ({ stdout: `${Array.from({ length: count }, (_, n) => `- item ${n}`).join('\n')}\n`, stderr: '', interrupted: false, isImage: false })
  const rows = [
    await $.ui.mount({ ...commandRow('call-48', 'cat list.md'), viewport: mainScreen }),
    await $.ui.mount({ ...commandRow('call-49', 'cat list.md'), viewport: mainScreen }),
    await $.ui.mount({ ...commandRow('call-50', 'cat list.md'), viewport: fullscreen }),
  ]
  const tall = await $.ui.mount({ ...outputBlock('call-48', list(40), true), viewport: mainScreen })
  const short = await $.ui.mount({ ...outputBlock('call-49', list(5), true), viewport: mainScreen })
  const tallInFullscreen = await $.ui.mount({ ...outputBlock('call-50', list(40), true), viewport: fullscreen })
  // 12 lines of 60 wide characters: 12 rows by character count, 24 by the cells a terminal gives them
  rows.push(await $.ui.mount({ ...commandRow('call-51', 'cat 議事録.md'), viewport: mainScreen }))
  const wide = { stdout: `${Array.from({ length: 12 }, () => '議'.repeat(60)).join('\n')}\n`, stderr: '', interrupted: false, isImage: false }
  const tallInWideCharacters = await $.ui.mount({ ...outputBlock('call-51', wide, true), viewport: mainScreen })
  // the same with emoji from the transport block (🚀), which a terminal also draws two cells wide
  rows.push(await $.ui.mount({ ...commandRow('call-53', 'cat launches.md'), viewport: mainScreen }))
  const rockets = { stdout: `${Array.from({ length: 12 }, () => '🚀'.repeat(60)).join('\n')}\n`, stderr: '', interrupted: false, isImage: false }
  const tallInEmoji = await $.ui.mount({ ...outputBlock('call-53', rockets, true), viewport: mainScreen })

  // Act: every block is drawn again with its colours back, and the tall one also in a fullscreen view of the session
  for (const block of [tall, short, tallInFullscreen, tallInWideCharacters, tallInEmoji]) await block.redraw()
  const tallInAnotherView = await $.ui.mount({ ...outputBlock('call-48', list(40), true), requestId: 'call-48-fullscreen', viewport: fullscreen })
  await tallInAnotherView.redraw()

  // Assert: only the tall blocks on the main screen, wide characters counted as two cells, stay as Claude Code drew them
  expect((await tall.findAll({ type: 'Text' })).map(t => t.text)).toEqual([CLAUDE_CODE_DRAWS])
  expect((await tallInWideCharacters.findAll({ type: 'Text' })).map(t => t.text)).toEqual([CLAUDE_CODE_DRAWS])
  expect((await tallInEmoji.findAll({ type: 'Text' })).map(t => t.text)).toEqual([CLAUDE_CODE_DRAWS])
  expect((await short.findAll({ type: 'Text' })).map(t => t.text)).toContain('- item 0')
  expect((await tallInFullscreen.findAll({ type: 'Text' })).map(t => t.text)).toContain('- item 0')
  expect((await tallInAnotherView.findAll({ type: 'Text' })).map(t => t.text)).toContain('- item 0')
  for (const handle of [tall, short, tallInFullscreen, tallInWideCharacters, tallInEmoji, tallInAnotherView, ...rows]) await handle.unmount()
})

test('a subagent\'s Bash call returns at once, with no colours made for rows this transcript does not draw as it ends', async ($, on) => {
  // Arrange: a worker and a wait that record being asked
  const workerInputs: string[] = []
  const waits: number[] = []
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{CLAUDE_CODE_DRAWS}</Text>
  })
  on('process.run', (_, e) => {
    workerInputs.push(String(e.init?.stdin ?? ''))
    const lines = [[{ t: '# Notes', fg: '#ff0000', b: false, i: false, u: false }]]

    return { value: { exitCode: 0, stdout: JSON.stringify({ editor: 'test', theme: 'test', lines }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('clock.sleep', (_, e) => {
    waits.push(e.ms)

    return { value: undefined }
  })
  on('tool.call', () => ({ result: { stdout: '# Notes\n', stderr: '', interrupted: false, isImage: false } }))

  // Act
  const done = await $.tool.call({ tool: 'Bash', command: 'cat notes.md', tool_use_id: 'call-45', agentId: 'agent-research' } as never)

  // Assert: the result came back with no worker started and no wait
  expect((done as { result?: { stdout?: string } }).result?.stdout).toBe('# Notes\n')
  expect(workerInputs).toEqual([])
  expect(waits).toEqual([])
})

test('more distinct command rows than the colour cache holds, drawn again while every worker is busy, have each command coloured once', { timeoutMs: 60_000 }, async ($, on) => {
  // Arrange: a worker held until released, so the commands of 205 rows wait in line together
  const started: string[] = []
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => (release = resolve))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{CLAUDE_CODE_DRAWS}</Text>
  })
  on('process.run', async (_, e) => {
    const asked = JSON.parse(String(e.init?.stdin ?? '{}')) as Record<string, unknown>
    started.push(String(asked.command ?? ''))
    await held
    const lines = [[{ t: String(asked.command ?? ''), fg: '#ff0000', b: false, i: false, u: false }]]

    return { value: { exitCode: 0, stdout: JSON.stringify({ editor: 'test', theme: 'test', lines }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const rows: Array<{ redraw: () => Promise<void>; unmount: () => Promise<void> }> = []
  for (let n = 0; n < 205; n++) rows.push(await $.ui.mount(commandRow(`call-many-${n}`, `cat many-${n}.md`)))

  // Act: every row is drawn again while the workers are held, then they are let go
  for (const row of rows) await row.redraw()
  release()
  await new Promise(resolve => setTimeout(() => resolve(undefined), 1000))

  // Assert: 205 commands, each coloured once
  expect(started.length).toBe(205)
  expect(new Set(started).size).toBe(205)
  for (const row of rows) await row.unmount()
})

test('an Output block drawn in two versions sends each to a worker once while 200 other blocks are coloured', { timeoutMs: 120_000 }, async ($, on) => {
  // Arrange: the two versions' workers are held; every other block is answered at once
  const started: string[] = []
  const held: Array<() => void> = []
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{CLAUDE_CODE_DRAWS}</Text>
  })
  on('process.run', async (_, e) => {
    const asked = JSON.parse(String(e.init?.stdin ?? '{}')) as Record<string, unknown>
    const text = String(asked.output ?? asked.command ?? '')
    started.push(text)
    if (text.startsWith('# Version')) await new Promise<void>(resolve => held.push(resolve))
    const lines = text.split('\n').map(t => (t === '' ? [] : [{ t, fg: '#ff0000', b: false, i: false, u: false }]))

    return { value: { exitCode: 0, stdout: JSON.stringify({ editor: 'test', theme: 'test', lines }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('clock.sleep', () => ({ value: undefined }))
  const handles: Array<{ redraw: () => Promise<void>; unmount: () => Promise<void> }> = []
  handles.push(await $.ui.mount(commandRow('call-54', 'cat version.md')))
  handles.push(await $.ui.mount(outputBlock('call-54', { stdout: '# Version one\n', stderr: '', interrupted: false, isImage: false })))
  const second = await $.ui.mount({ ...outputBlock('call-54', { stdout: '# Version two\n', stderr: '', interrupted: false, isImage: false }), requestId: 'call-54-second' })
  for (let n = 0; n < 200; n++) {
    handles.push(await $.ui.mount(commandRow(`call-other-${n}`, `cat other-${n}.md`)))
    handles.push(await $.ui.mount(outputBlock(`call-other-${n}`, { stdout: `# Other ${n}\n`, stderr: '', interrupted: false, isImage: false })))
  }
  await new Promise(resolve => setTimeout(() => resolve(undefined), 1000))

  // Act: the first version's worker finishes, and the second version, still waiting, is drawn again
  held.shift()?.()
  await new Promise(resolve => setTimeout(() => resolve(undefined), 50))
  await second.redraw()

  // Assert: the second version went to a worker once
  expect(started.filter(text => text === '# Version two')).toEqual(['# Version two'])
  while (held.length > 0) held.shift()?.()
  for (const handle of [second, ...handles]) await handle.unmount()
})

test('a row drawn while every colouring worker is busy is coloured before rows that waited longer', { timeoutMs: 30_000 }, async ($, on) => {
  // Arrange: a worker held until the test lets it go, recording the commands in the order it starts them
  const started: string[] = []
  const held: Array<() => void> = []
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{CLAUDE_CODE_DRAWS}</Text>
  })
  on('process.run', async (_, e) => {
    const asked = JSON.parse(String(e.init?.stdin ?? '{}')) as Record<string, unknown>
    started.push(String(asked.command ?? ''))
    await new Promise<void>(resolve => held.push(resolve))
    const lines = [[{ t: String(asked.command ?? ''), fg: '#ff0000', b: false, i: false, u: false }]]

    return { value: { exitCode: 0, stdout: JSON.stringify({ editor: 'test', theme: 'test', lines }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const rows: Array<{ unmount: () => Promise<void> }> = []

  for (let n = 1; n <= 6; n++) rows.push(await $.ui.mount(commandRow(`call-queue-${n}`, `cat queue-${n}.md`)))

  // Act: with all six rows drawn (four running, two waiting in line), the workers finish one at a time
  while (held.length > 0) {
    held.shift()?.()
    await new Promise(resolve => setTimeout(() => resolve(undefined), 50))
  }

  // Assert: the sixth started before the fifth
  expect(started).toEqual(['cat queue-1.md', 'cat queue-2.md', 'cat queue-3.md', 'cat queue-4.md', 'cat queue-6.md', 'cat queue-5.md'])
  for (const handle of rows) await handle.unmount()
})

test('two drawings of one call with different text (its record before and after a rewrite) settle without starting workers in turn', async ($, on) => {
  // Arrange: the same call drawn twice at once, as recorded and as another mod rewrote it for one view
  const seen = standInForClaudeCode(on)
  const row = await $.ui.mount(commandRow('call-41', 'cat notes.md'))
  const recorded = await $.ui.mount(outputBlock('call-41', { stdout: '# Notes\nAPI_TOKEN=abc123\n', stderr: '', interrupted: false, isImage: false }))
  const rewritten = await $.ui.mount({ ...outputBlock('call-41', { stdout: '# Notes\nAPI_TOKEN=•••\n', stderr: '', interrupted: false, isImage: false }), requestId: 'call-41-rewritten' })
  for (const handle of [recorded, rewritten, recorded, rewritten]) await handle.redraw()
  const workersBefore = seen.workerInputs.length

  // Act: both are drawn again, as every redraw draws them
  for (const handle of [recorded, rewritten, recorded, rewritten]) await handle.redraw()

  // Assert: no further worker, and each drawing shows its own text
  expect(seen.workerInputs.length - workersBefore).toBe(0)
  expect((await recorded.findAll({ type: 'Text' })).map(t => t.text)).toContain('API_TOKEN=abc123')
  expect((await rewritten.findAll({ type: 'Text' })).map(t => t.text)).toContain('API_TOKEN=•••')
  for (const handle of [rewritten, recorded, row]) await handle.unmount()
})

test('many coloured rows drawn together (a resumed session) run at most four colouring workers at once', { timeoutMs: 30_000 }, async ($, on) => {
  // Arrange: a worker that takes a real 50 ms and counts how many run at once; 12 command rows and their blocks ask for
  // 24 colourings
  let running = 0
  let mostAtOnce = 0
  let served = 0
  let allServed: () => void = () => {}
  const everyColouringServed = new Promise<void>(resolve => (allServed = resolve))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{CLAUDE_CODE_DRAWS}</Text>
  })
  on('process.run', async (_, e) => {
    running++
    mostAtOnce = Math.max(mostAtOnce, running)
    await new Promise(resolve => setTimeout(() => resolve(undefined), 50))
    running--
    served++
    if (served === 24) allServed()
    const asked = JSON.parse(String(e.init?.stdin ?? '{}')) as Record<string, unknown>
    const text = String(asked.output ?? asked.command ?? '')
    const lines = text.split('\n').map(t => (t === '' ? [] : [{ t, fg: '#ff0000', b: false, i: false, u: false }]))

    return {
      value: { exitCode: 0, stdout: JSON.stringify({ editor: 'test', theme: 'test', lines }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('clock.sleep', () => ({ value: undefined }))
  const handles: Array<{ redraw: () => Promise<void>; unmount: () => Promise<void>; findAll: (q: { type: string }) => Promise<Array<{ text: string }>> }> = []

  // Act
  for (let n = 0; n < 12; n++) {
    handles.push(await $.ui.mount(commandRow(`call-burst-${n}`, `cat burst-${n}.md`)))
    handles.push(await $.ui.mount(outputBlock(`call-burst-${n}`, { stdout: `# Burst ${n}\n`, stderr: '', interrupted: false, isImage: false })))
  }
  await everyColouringServed
  for (const handle of handles) await handle.redraw()

  // Assert: four at once at most, and every block was coloured in the end
  expect(mostAtOnce).toBe(4)
  for (let n = 0; n < 12; n++) expect((await handles[2 * n + 1]!.findAll({ type: 'Text' })).map(t => t.text)).toContain(`# Burst ${n}`)
  for (const handle of handles) await handle.unmount()
})

// last in this file: its worker never answers and keeps two worker slots for the rest of the run
test('a Bash call whose colours are not back within 1.5 s returns its result then, without waiting for the worker', async ($, on) => {
  // Arrange: the worker never answers; the wait's timer fires at once and records how long it was asked to wait
  const waits: number[] = []
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{CLAUDE_CODE_DRAWS}</Text>
  })
  on('process.run', () => new Promise<never>(() => {}))
  on('clock.sleep', (_, e) => {
    waits.push(e.ms)

    return { value: undefined }
  })
  on('tool.call', () => ({ result: { stdout: '# Notes\n', stderr: '', interrupted: false, isImage: false } }))

  // Act
  const done = await $.tool.call({ tool: 'Bash', command: 'cat notes.md', tool_use_id: 'call-42' } as never)

  // Assert: the call returned its own result, after the 1.5 s wait it promises
  expect((done as { result?: { stdout?: string } }).result?.stdout).toBe('# Notes\n')
  expect(waits).toEqual([1500])
})
