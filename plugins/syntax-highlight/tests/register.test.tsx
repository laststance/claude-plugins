import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Plugin } from 'claude-code/testing'

// the test kit runs on a runtime with timers; Claude Code's types leave them out, as a mod has none of its own
declare function setTimeout(callback: () => void, ms: number): unknown

const PLUGIN = 'syntax-highlight'
// the tool the mod registers for Claude to show a snippet, as Claude Code names it
const SHOW_CODE = 'mcp__syntax-highlight__show_code'
const CLAUDE_CODE_DRAWS = 'claude code draws this row'
const CWD_NOTICE = '\nShell cwd was reset to /Users/me/project'
const MEMORY_COMMAND = 'cd /Users/me/.claude/projects/app/memory; cat deploy-lock.md'
const MEMORY_STDOUT = '---\nname: deploy-lock\nmetadata:\n  type: feedback\n---\n\n**Why:** the lock check reads the runner log first.\n'

/**
 * What the engine stand-in saw: each result Claude Code was asked to draw, the worker's inputs, the redraws asked, and
 * for each group Claude Code was asked to draw, whether it reached it unfolded into rows.
 */
type Seen = { drawnByClaudeCode: Record<string, unknown>[]; workerInputs: Record<string, unknown>[]; invalidations: number; unfolded: boolean[] }

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
  const seen: Seen = { drawnByClaudeCode: [], workerInputs: [], invalidations: 0, unfolded: [] }
  on('ui.render', ($, e) => {
    if (e.component === 'ToolResult') seen.drawnByClaudeCode.push(e.props.output as Record<string, unknown>)
    if (e.component === 'ToolGroup') seen.unfolded.push(e.props.isExpanded)
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
  const lastMarkdownRow = texts.findIndex(text => text.includes('**Why:**'))
  expect(lastMarkdownRow).toBeGreaterThan(-1)
  expect(texts.indexOf(CLAUDE_CODE_DRAWS)).toBeGreaterThan(lastMarkdownRow)
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
  // collapsed, as a block is first drawn: expanded, a line this long is more than one drawing shows, and Claude Code
  // draws the block (the 100,000-character test)
  const block = await $.ui.mount(outputBlock('call-26', (done as { result?: Record<string, unknown> }).result ?? {}, false))
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
  const done = await $.tool.call({ tool: 'Bash', command: MEMORY_COMMAND, tool_use_id: 'call-40' } as never)

  // Assert: the failure comes back as Claude Code gave it; the command is coloured on its way in, the error's text never is
  expect(done).toEqual({ result: { stdout: MEMORY_STDOUT, stderr: '', interrupted: false, isImage: false }, isError: true })
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

test('an expanded block with more text than one drawing shows (100,000 characters), and a cwd notice, is drawn by Claude Code whole, its stdout kept', async ($, on) => {
  // Arrange: 100 lines of 1,000 characters, few nodes but past the 100,000 characters the engine draws in one tree
  const seen = standInForClaudeCode(on)
  const row = await $.ui.mount(commandRow('call-55', 'cd /tmp/data; cat data.md'))
  const stdout = `${Array.from({ length: 100 }, (_, n) => `${String(n).padStart(4, '0')} ${'x'.repeat(995)}`).join('\n')}\n`
  const output = { stdout, stderr: CWD_NOTICE, interrupted: false, isImage: false }

  // Act
  const block = await $.ui.mount(outputBlock('call-55', output, true))
  await block.redraw()

  // Assert: Claude Code draws the record as it is, so no end of it is cut
  expect((await block.findAll({ type: 'Text' })).map(t => t.text)).toEqual([CLAUDE_CODE_DRAWS])
  expect(seen.drawnByClaudeCode.at(-1)).toEqual(output)
  for (const handle of [block, row]) await handle.unmount()
})

test('an expanded block whose empty rows bring its text past what one drawing shows, with a cwd notice, is drawn by Claude Code whole', async ($, on) => {
  // Arrange: three lines of 31,666 characters (94,998 in all) and 4,996 empty lines, each drawn as one space
  const seen = standInForClaudeCode(on)
  const row = await $.ui.mount(commandRow('call-57', 'cd /tmp/data; cat sparse.md'))
  const stdout = `${['a', 'b', 'c'].map(letter => letter.repeat(31_666)).join('\n')}${'\n'.repeat(4_997)}z\n`
  const output = { stdout, stderr: CWD_NOTICE, interrupted: false, isImage: false }

  // Act
  const block = await $.ui.mount(outputBlock('call-57', output, true))
  await block.redraw()

  // Assert: Claude Code draws the record as it is, so no end of it is cut
  expect((await block.findAll({ type: 'Text' })).map(t => t.text)).toEqual([CLAUDE_CODE_DRAWS])
  expect(seen.drawnByClaudeCode.at(-1)).toEqual(output)
  for (const handle of [block, row]) await handle.unmount()
})

test('a show_code panel whose colours 200 newer commands pushed out of the cache is coloured again when drawn', { timeoutMs: 60_000 }, async ($, on) => {
  // Arrange: a worker answering at once, and a count of the redraws asked as each colouring is kept
  const asked: string[] = []
  let kept = 0
  let wanted = 0
  let onKept: () => void = () => {}
  const colouringsKept = (count: number) =>
    new Promise<void>(resolve => {
      wanted = count
      onKept = resolve
      if (kept >= wanted) resolve()
    })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{CLAUDE_CODE_DRAWS}</Text>
  })
  on('process.run', (_, e) => {
    const input = JSON.parse(String(e.init?.stdin ?? '{}')) as Record<string, unknown>
    const text = String(input.code ?? input.command ?? '')
    asked.push(text)
    const lines = [[{ t: text, fg: '#ff0000', b: false, i: false, u: false }]]

    return { value: { exitCode: 0, stdout: JSON.stringify({ editor: 'test', theme: 'test', lines }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.invalidate', (_, e, next) => {
    kept++
    if (kept >= wanted) onKept()

    return next(e)
  })
  const snippet = {
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'call-56',
    props: { tool_use_id: 'call-56', tool: SHOW_CODE, input: { code: 'const deploy = 1', language: 'ts' }, isRunning: false, isErrored: false, isInterrupted: false, isExpanded: true },
  } as const
  const panel = await $.ui.mount(snippet)
  await colouringsKept(1)
  await panel.redraw()
  const rows: Array<{ unmount: () => Promise<void> }> = []
  for (let n = 0; n < 200; n++) rows.push(await $.ui.mount(commandRow(`call-push-${n}`, `cat push-${n}.md`)))
  await colouringsKept(201)

  // Act: the panel is drawn again, and once more when its colours are back
  await panel.redraw()
  await colouringsKept(202)
  await panel.redraw()

  // Assert: the snippet went to a worker again, and the panel is the mod's
  expect(asked.filter(text => text === 'const deploy = 1')).toHaveLength(2)
  expect((await panel.findAll({ type: 'Text' })).map(t => t.text)).not.toContain(CLAUDE_CODE_DRAWS)
  for (const handle of [panel, ...rows]) await handle.unmount()
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

test('an expanded block that fits the main screen only without its stderr rows stays as Claude Code drew it once its colours are back', async ($, on) => {
  // Arrange: 14 lines and the prompt's 8 rows fit a 24-row main screen; three rows of stderr under them do not, one does
  standInForClaudeCode(on)
  const mainScreen = { columns: 80, rows: 24, isFullscreen: false }
  const stdout = `${Array.from({ length: 14 }, (_, n) => `- item ${n}`).join('\n')}\n`
  const rows = [
    await $.ui.mount({ ...commandRow('call-57', 'cd /tmp/site && cat list.md'), viewport: mainScreen }),
    await $.ui.mount({ ...commandRow('call-58', 'cd /tmp/site && cat list.md'), viewport: mainScreen }),
  ]
  const threeRowsOfStderr = { stdout, stderr: 'warning: one\nwarning: two\nShell cwd was reset to /Users/me/project', interrupted: false, isImage: false }
  const oneRowOfStderr = { stdout, stderr: CWD_NOTICE, interrupted: false, isImage: false }
  const pastTheScreen = await $.ui.mount({ ...outputBlock('call-57', threeRowsOfStderr, true), viewport: mainScreen })
  const withinTheScreen = await $.ui.mount({ ...outputBlock('call-58', oneRowOfStderr, true), viewport: mainScreen })

  // Act: both are drawn again with their colours back
  for (const block of [pastTheScreen, withinTheScreen]) await block.redraw()

  // Assert: the first stays whole as Claude Code drew it; the second is coloured above Claude Code's notice
  expect((await pastTheScreen.findAll({ type: 'Text' })).map(t => t.text)).toEqual([CLAUDE_CODE_DRAWS])
  const texts = (await withinTheScreen.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('- item 0')
  expect(texts.filter(text => text === CLAUDE_CODE_DRAWS)).toHaveLength(1)
  for (const handle of [pastTheScreen, withinTheScreen, ...rows]) await handle.unmount()
})

test('an expanded block with an edit diff or images under it that Claude Code drew first on the main screen stays as drawn once its colours are back', async ($, on) => {
  // Arrange: one line of stdout over sibling rows whose height only Claude Code knows, and the same in fullscreen,
  // which redraws all of itself
  standInForClaudeCode(on)
  const mainScreen = { columns: 80, rows: 24, isFullscreen: false }
  const fullscreen = { columns: 80, rows: 24, isFullscreen: true }
  const withEditDiff = { stdout: '# Notes\n', stderr: '', interrupted: false, isImage: false, bashEditDiff: { files: [{ filePath: '/repo/notes.md', hunks: [] }] } }
  const withImage = { stdout: '# Notes\n', stderr: '', interrupted: false, isImage: false, viewedImagePaths: ['/repo/shot.png'] }
  const rows = [
    await $.ui.mount({ ...commandRow('call-59', 'cat notes.md'), viewport: mainScreen }),
    await $.ui.mount({ ...commandRow('call-60', 'cat notes.md'), viewport: mainScreen }),
    await $.ui.mount({ ...commandRow('call-61', 'cat notes.md'), viewport: fullscreen }),
  ]
  const editDiffOnMainScreen = await $.ui.mount({ ...outputBlock('call-59', withEditDiff, true), viewport: mainScreen })
  const imageOnMainScreen = await $.ui.mount({ ...outputBlock('call-60', withImage, true), viewport: mainScreen })
  const editDiffInFullscreen = await $.ui.mount({ ...outputBlock('call-61', withEditDiff, true), viewport: fullscreen })

  // Act: each is drawn again with its colours back
  for (const block of [editDiffOnMainScreen, imageOnMainScreen, editDiffInFullscreen]) await block.redraw()

  // Assert
  expect((await editDiffOnMainScreen.findAll({ type: 'Text' })).map(t => t.text)).toEqual([CLAUDE_CODE_DRAWS])
  expect((await imageOnMainScreen.findAll({ type: 'Text' })).map(t => t.text)).toEqual([CLAUDE_CODE_DRAWS])
  expect((await editDiffInFullscreen.findAll({ type: 'Text' })).map(t => t.text)).toContain('# Notes')
  for (const handle of [editDiffOnMainScreen, imageOnMainScreen, editDiffInFullscreen, ...rows]) await handle.unmount()
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
  let finished = 0
  let allFinished: () => void = () => {}
  const everyColouringFinished = new Promise<void>(resolve => (allFinished = resolve))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{CLAUDE_CODE_DRAWS}</Text>
  })
  on('process.run', async (_, e) => {
    const asked = JSON.parse(String(e.init?.stdin ?? '{}')) as Record<string, unknown>
    started.push(String(asked.command ?? ''))
    await held
    if (++finished === 205) allFinished()
    const lines = [[{ t: String(asked.command ?? ''), fg: '#ff0000', b: false, i: false, u: false }]]

    return { value: { exitCode: 0, stdout: JSON.stringify({ editor: 'test', theme: 'test', lines }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const rows: Array<{ redraw: () => Promise<void>; unmount: () => Promise<void> }> = []
  for (let n = 0; n < 205; n++) rows.push(await $.ui.mount(commandRow(`call-many-${n}`, `cat many-${n}.md`)))

  // Act: every row is drawn again while the workers are held, then they are let go
  for (const row of rows) await row.redraw()
  release()
  await everyColouringFinished

  // Assert: 205 commands, each coloured once
  expect(started.length).toBe(205)
  expect(new Set(started).size).toBe(205)
  for (const row of rows) await row.unmount()
})

test('an Output block drawn in two versions sends each to a worker once while 200 other blocks are coloured', { timeoutMs: 120_000 }, async ($, on) => {
  // Arrange: the two versions' workers are held and every other colouring is answered at once. The mod asks for a
  // redraw once for each colouring it has kept, so counting those tells the test how many are done
  const started: string[] = []
  const held: Array<() => void> = []
  let kept = 0
  let wanted = Infinity
  let onKept: () => void = () => {}
  const colouringsKept = (count: number) =>
    new Promise<void>(resolve => {
      wanted = count
      onKept = resolve
      if (kept >= wanted) resolve()
    })
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
  on('ui.invalidate', (_, e, next) => {
    kept++
    if (kept >= wanted) onKept()

    return next(e)
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
  // this call's command and the 200 other calls (a command and a block each) make 401 colourings kept
  await colouringsKept(401)

  // Act: the first version's worker finishes and the mod keeps its colours; the second version, still waiting, is
  // drawn again
  held.shift()?.()
  await colouringsKept(402)
  await second.redraw()

  // Assert: the second version went to a worker once
  expect(started.filter(text => text === '# Version two')).toEqual(['# Version two'])
  while (held.length > 0) held.shift()?.()
  for (const handle of [second, ...handles]) await handle.unmount()
})

test('a row drawn while every colouring worker is busy is coloured before rows that waited longer', { timeoutMs: 30_000 }, async ($, on) => {
  // Arrange: a worker held until the test lets it go, recording the commands in the order it starts them and telling
  // the test when the next one starts
  const started: string[] = []
  const held: Array<() => void> = []
  let onStart: () => void = () => {}
  const nextWorkerStarts = () => new Promise<void>(resolve => (onStart = resolve))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{CLAUDE_CODE_DRAWS}</Text>
  })
  on('process.run', async (_, e) => {
    const asked = JSON.parse(String(e.init?.stdin ?? '{}')) as Record<string, unknown>
    started.push(String(asked.command ?? ''))
    onStart()
    await new Promise<void>(resolve => held.push(resolve))
    const lines = [[{ t: String(asked.command ?? ''), fg: '#ff0000', b: false, i: false, u: false }]]

    return { value: { exitCode: 0, stdout: JSON.stringify({ editor: 'test', theme: 'test', lines }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const rows: Array<{ unmount: () => Promise<void> }> = []

  for (let n = 1; n <= 6; n++) rows.push(await $.ui.mount(commandRow(`call-queue-${n}`, `cat queue-${n}.md`)))

  // Act: with all six rows drawn (four running, two waiting in line), one worker finishes, then another
  const firstFromLine = nextWorkerStarts()
  held.shift()?.()
  await firstFromLine
  const secondFromLine = nextWorkerStarts()
  held.shift()?.()
  await secondFromLine
  while (held.length > 0) held.shift()?.()

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
  // Arrange: a worker that counts how many run at once; 12 command rows and their blocks ask for 24 colourings. The
  // first workers are held until four run together (however long a row takes to mount), and each worker then stays a
  // real 50 ms more, in which a fifth would start if nothing held it back. Two seconds end the hold for a pool that
  // never reaches four, which the count then shows
  let running = 0
  let mostAtOnce = 0
  let served = 0
  let allServed: () => void = () => {}
  const everyColouringServed = new Promise<void>(resolve => (allServed = resolve))
  let fourRun: () => void = () => {}
  const fourRunTogether = new Promise<void>(resolve => (fourRun = resolve))
  setTimeout(() => fourRun(), 2000)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{CLAUDE_CODE_DRAWS}</Text>
  })
  on('process.run', async (_, e) => {
    running++
    mostAtOnce = Math.max(mostAtOnce, running)
    if (running === 4) fourRun()
    await fourRunTogether
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

test('a Bash call whose colours are not back within 1.5 s returns its result then, without waiting for the worker', async ($, on) => {
  // Arrange: the workers are held until the test lets them go; the wait's timer fires at once and records how long it
  // was asked to wait. The mod asks for a redraw once for each colouring it has kept
  const waits: number[] = []
  const held: Array<() => void> = []
  let kept = 0
  let wanted = Infinity
  let onKept: () => void = () => {}
  const colouringsKept = (count: number) =>
    new Promise<void>(resolve => {
      wanted = count
      onKept = resolve
      if (kept >= wanted) resolve()
    })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{CLAUDE_CODE_DRAWS}</Text>
  })
  on('process.run', async () => {
    await new Promise<void>(resolve => held.push(resolve))

    return { value: { exitCode: 0, stdout: JSON.stringify({ editor: 'test', theme: 'test', lines: [] }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.invalidate', (_, e, next) => {
    kept++
    if (kept >= wanted) onKept()

    return next(e)
  })
  on('clock.sleep', (_, e) => {
    waits.push(e.ms)

    return { value: undefined }
  })
  on('tool.call', () => ({ result: { stdout: '# Notes\n', stderr: '', interrupted: false, isImage: false } }))

  try {
    // Act
    const done = await $.tool.call({ tool: 'Bash', command: 'cat notes.md', tool_use_id: 'call-42' } as never)

    // Assert: the call returned its own result after the 1.5 s wait it promises, with both its workers (the command's
    // and the block's) still running
    expect((done as { result?: { stdout?: string } }).result?.stdout).toBe('# Notes\n')
    expect(waits).toEqual([1500])
    expect(held).toHaveLength(2)
  } finally {
    // the workers answer and their colours are kept, so no worker slot stays taken for the tests after this one
    const running = held.length
    while (held.length > 0) held.shift()?.()
    await colouringsKept(running)
  }
})

// ---- grouped rows: a Bash call drawn as a row of a ToolGroup draws its own result (0.1.3) ----

// the terminal's main screen, the one place grouped rows draw their output
const MAIN_SCREEN = { columns: 80, rows: 40, isFullscreen: false } as const
// the stand-in worker colours every line red; drawn at the output's strength (0.75) and the command's (0.55)
const OUTPUT_RED = '#e62626'
const COMMAND_RED = '#d14545'

/** A Bash result with only a stdout. */
const stdoutOf = (stdout: string) => ({ stdout, stderr: '', interrupted: false, isImage: false })

/** A run of Bash calls as Claude Code asks a ToolGroup hook to draw it: collapsed, or expanded by ctrl+o or verbose. */
const group = (requestId: string, ids: string[], isExpanded: boolean, viewport: { columns: number; rows: number; isFullscreen: boolean } = MAIN_SCREEN) =>
  ({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolGroup',
    requestId,
    viewport,
    props: {
      calls: ids.map(id => ({ tool_use_id: id, tool: 'Bash', input: { command: 'cat notes.md' }, isRunning: false, isErrored: false, isInterrupted: false })),
      isActive: false,
      isExpanded,
    },
  }) as const

/** A Bash call's row as a group's row is drawn: expanded, with its result in `output` once it has one. */
const rowWithResult = (id: string, command: string, output: Record<string, unknown> | undefined, viewport: { columns: number; rows: number; isFullscreen: boolean } = MAIN_SCREEN, state: { isRunning?: boolean; isErrored?: boolean } = {}) =>
  ({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolUse',
    requestId: id,
    viewport,
    props: { tool_use_id: id, tool: 'Bash', input: { command }, isRunning: state.isRunning ?? false, isErrored: state.isErrored ?? false, isInterrupted: false, isExpanded: true, output },
  }) as const

/** How long the mod waits for redraw requests to go quiet before a call may ask for more than twenty again. */
const QUIET_MS = 2000

/**
 * Stands in for Claude Code as {@link standInForClaudeCode} does, but holds the mod's quiet wait until the test ends it:
 * with every wait over at once, a burst of redraw requests would never reach its bound.
 *
 * @param on - The test's `on`.
 * @returns the redraws asked so far, and `endQuietWait`, which lets the held wait finish
 * @example
 * const quiet = standInHoldingTheQuietWait(on)
 * // ...25 fold changes: quiet.invalidations() → 20
 * await quiet.endQuietWait() // the next fold change asks again
 */
const standInHoldingTheQuietWait = (on: On) => {
  let invalidations = 0
  const held: Array<() => void> = []
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{CLAUDE_CODE_DRAWS}</Text>
  })
  on('process.run', (_, e) => {
    const asked = JSON.parse(String(e.init?.stdin ?? '{}')) as Record<string, unknown>
    const lines = String(asked.output ?? asked.command ?? '').split('\n').map(t => (t === '' ? [] : [{ t, fg: '#ff0000', b: false, i: false, u: false }]))

    return { value: { exitCode: 0, stdout: JSON.stringify({ editor: 'test', theme: 'test', lines }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.invalidate', (_, e, next) => {
    invalidations++

    return next(e)
  })
  on('clock.sleep', async (_, e) => {
    if (e.ms === QUIET_MS) await new Promise<void>(resolve => held.push(resolve))

    return { value: undefined }
  })

  return {
    invalidations: () => invalidations,
    endQuietWait: async () => {
      // every request waits on its own: let each wait go, then give the mod a moment to act on the last one
      while (held.length > 0) held.shift()?.()
      await new Promise<void>(resolve => setTimeout(() => resolve(), 20))
    },
  }
}

/** Every Text of a drawing, as its shown text and its colour. */
const textsOf = async (drawing: { findAll: (query: { type: string }) => Promise<Array<{ text: string; props: Record<string, unknown> }>> }) =>
  (await drawing.findAll({ type: 'Text' })).map(found => ({ text: found.text, color: found.props.color }))

// Value: protects=a grouped Bash call's output is on screen and coloured; fails_when=the row holds no output text, the output token has no colour, or the group is not unfolded; why_new=no test mounted a group; seam=none; no_claim=grammar choice (the stand-in colours every line red) and Claude Code's own unfolding (the kit mounts the row)
test('a Bash call in a group shows its output under its command, coloured, with the group unfolded into rows', async ($, on) => {
  // Arrange
  const seen = standInForClaudeCode(on)
  const collapsed = await $.ui.mount(group('group-ac1', ['grouped-ac1'], false))

  // Act
  const row = await $.ui.mount(rowWithResult('grouped-ac1', 'cat release.md', stdoutOf('# Release\nalpha one\n')))
  await row.redraw()
  await row.redraw()

  // Assert
  const texts = await textsOf(row)
  expect(seen.unfolded.at(-1)).toBe(true)
  expect(texts).toContainEqual({ text: 'cat release.md', color: COMMAND_RED })
  expect(texts).toContainEqual({ text: '# Release', color: OUTPUT_RED })
  expect(texts).toContainEqual({ text: 'alpha one', color: OUTPUT_RED })
  expect(texts.map(t => t.text)).not.toContain(CLAUDE_CODE_DRAWS)
  for (const handle of [row, collapsed]) await handle.unmount()
})

// Value: protects=output of a group this mod unfolded folds like a collapsed result; fails_when=every line is dumped or the hint count is wrong; why_new=grouped rows untested; seam=none; no_claim=wrapping at widths other than 80 columns
test('a long output in a group the mod unfolded shows three rows and how many more ctrl+o shows', async ($, on) => {
  // Arrange
  standInForClaudeCode(on)
  const collapsed = await $.ui.mount(group('group-fold', ['grouped-fold'], false))
  const tenLines = `${Array.from({ length: 10 }, (_, n) => `line ${n}`).join('\n')}\n`

  // Act
  const row = await $.ui.mount(rowWithResult('grouped-fold', 'cat ten.txt', stdoutOf(tenLines)))
  await row.redraw()
  await row.redraw()

  // Assert
  const texts = (await textsOf(row)).map(t => t.text)
  expect(texts).toContain('line 2')
  expect(texts).not.toContain('line 3')
  expect(texts).toContain('… +7 lines (ctrl+o to expand)')
  for (const handle of [row, collapsed]) await handle.unmount()
})

// Value: protects=ctrl+o and verbose show every line of a grouped call; fails_when=a group Claude Code expanded still folds; why_new=grouped rows untested; seam=none; no_claim=the real ctrl+o redraw (live check)
test('the same output in a group Claude Code expanded (ctrl+o, verbose) shows every line', async ($, on) => {
  // Arrange
  standInForClaudeCode(on)
  const expanded = await $.ui.mount(group('group-full', ['grouped-full'], true))
  const tenLines = `${Array.from({ length: 10 }, (_, n) => `line ${n}`).join('\n')}\n`

  // Act
  const row = await $.ui.mount(rowWithResult('grouped-full', 'cat ten.txt', stdoutOf(tenLines)))
  await row.redraw()
  await row.redraw()

  // Assert
  const texts = (await textsOf(row)).map(t => t.text)
  expect(texts).toContain('line 9')
  expect(texts.some(text => text.includes('ctrl+o to expand'))).toBe(false)
  for (const handle of [row, expanded]) await handle.unmount()
})

// Value: protects=no part of a result is lost for grouped rows the mod cannot draw whole; fails_when=the mod draws its own tree for a cwd notice, an empty stdout or an error; why_new=grouped rows untested; seam=none; no_claim=what Claude Code draws for them (the stand-in draws one Text)
test('a grouped call with a cwd notice, with no output, or that failed is drawn whole by Claude Code', async ($, on) => {
  // Arrange
  standInForClaudeCode(on)
  const collapsed = await $.ui.mount(group('group-ac3', ['grouped-notice', 'grouped-empty', 'grouped-failed'], false))

  // Act
  const withNotice = await $.ui.mount(rowWithResult('grouped-notice', 'cd /tmp/site && cat a.md', { ...stdoutOf('# A\n'), stderr: CWD_NOTICE }))
  const withNoOutput = await $.ui.mount(rowWithResult('grouped-empty', 'grep -n zeta a.md', { ...stdoutOf(''), returnCodeInterpretation: 'No matches found' }))
  const failed = await $.ui.mount(rowWithResult('grouped-failed', 'cat missing.md', 'cat: missing.md: No such file or directory' as never, MAIN_SCREEN, { isErrored: true }))
  for (const handle of [withNotice, withNoOutput, failed]) await handle.redraw()

  // Assert
  expect((await textsOf(withNotice)).map(t => t.text)).toEqual([CLAUDE_CODE_DRAWS])
  expect((await textsOf(withNoOutput)).map(t => t.text)).toEqual([CLAUDE_CODE_DRAWS])
  expect((await textsOf(failed)).map(t => t.text)).toEqual([CLAUDE_CODE_DRAWS])
  for (const handle of [failed, withNoOutput, withNotice, collapsed]) await handle.unmount()
})

// Value: protects=a standalone row never shows its output in the command row (its ToolResult shows it); fails_when=a ToolUse row outside any group holds output rows; why_new=the inline path is new; seam=none; no_claim=none beyond protects
test('a standalone Bash row drawn expanded with its result holds only the command', async ($, on) => {
  // Arrange: no group names this call
  standInForClaudeCode(on)

  // Act
  const row = await $.ui.mount(rowWithResult('standalone-ac4', 'cat solo.md', stdoutOf('# Solo\nbody\n')))
  await row.redraw()
  await row.redraw()

  // Assert
  const texts = (await textsOf(row)).map(t => t.text)
  expect(texts).toContain('cat solo.md')
  expect(texts).not.toContain('# Solo')
  expect(texts).not.toContain('body')
  await row.unmount()
})

// Value: protects=the fullscreen transcript, which draws grouped calls standalone, never shows an output twice; fails_when=output rows are drawn with isFullscreen true; why_new=the inline path is new; seam=none; no_claim=fullscreen main-view outputs stay hidden (a known limit); other surfaces not mounted
test('in fullscreen a grouped Bash row holds only the command, as in 0.1.2', async ($, on) => {
  // Arrange
  standInForClaudeCode(on)
  const fullscreen = { columns: 80, rows: 40, isFullscreen: true }
  const collapsed = await $.ui.mount(group('group-ac5', ['grouped-ac5'], false, fullscreen))

  // Act
  const row = await $.ui.mount(rowWithResult('grouped-ac5', 'cat wide.md', stdoutOf('# Wide\nbody\n'), fullscreen))
  await row.redraw()
  await row.redraw()

  // Assert
  const texts = (await textsOf(row)).map(t => t.text)
  expect(texts).toContain('cat wide.md')
  expect(texts).not.toContain('# Wide')
  for (const handle of [row, collapsed]) await handle.unmount()
})

// Value: protects=a grouped call's output is visible before its colours arrive, and coloured after; fails_when=the row is empty or Claude Code's while colours are pending, or stays plain after; why_new=grouped rows untested; seam=none; no_claim=timing of a real worker
test('a grouped row drawn before its colours are back shows command and output plain, then coloured', async ($, on) => {
  // Arrange: every worker is held until the test lets it go
  const held: Array<() => void> = []
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{CLAUDE_CODE_DRAWS}</Text>
  })
  on('process.run', async (_, e) => {
    const asked = JSON.parse(String(e.init?.stdin ?? '{}')) as Record<string, unknown>
    await new Promise<void>(resolve => held.push(resolve))
    const lines = String(asked.output ?? asked.command ?? '').split('\n').map(t => (t === '' ? [] : [{ t, fg: '#ff0000', b: false, i: false, u: false }]))

    return { value: { exitCode: 0, stdout: JSON.stringify({ editor: 'test', theme: 'test', lines }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('clock.sleep', () => ({ value: undefined }))
  const collapsed = await $.ui.mount(group('group-ac6', ['grouped-ac6'], false))
  const row = await $.ui.mount(rowWithResult('grouped-ac6', 'cat pending.md', stdoutOf('# Pending\n')))
  const whilePending = await textsOf(row)

  // Act: both workers answer
  while (held.length > 0) held.shift()?.()
  await row.redraw()
  await row.redraw()

  // Assert: both texts are drawn while pending, neither in a colour (the row's own Text holds no colour either way)
  expect(whilePending.map(t => t.text)).toContain('cat pending.md')
  expect(whilePending.map(t => t.text)).toContain('# Pending')
  expect(whilePending).not.toContainEqual({ text: 'cat pending.md', color: COMMAND_RED })
  expect(whilePending).not.toContainEqual({ text: '# Pending', color: OUTPUT_RED })
  expect(await textsOf(row)).toContainEqual({ text: '# Pending', color: OUTPUT_RED })
  for (const handle of [row, collapsed]) await handle.unmount()
})

// Value: protects=ctrl+o toggles redraw grouped rows, a burst of them is bounded, and a later toggle works again; fails_when=a fold flip asks for no redraw, one call asks for more than 20 in a burst, or the bound outlives the burst; why_new=the redraw request is new; seam=none; no_claim=that the screen shows the redraw (live check); the 2 s quiet wait is held by the test, not timed
test('folding or unfolding a group asks for one redraw of its rows, for no more than twenty in a burst, and again once the burst is over', async ($, on) => {
  // Arrange: a grouped row drawn and coloured
  const quiet = standInHoldingTheQuietWait(on)
  const asGroup = group('group-ac7', ['grouped-ac7'], false)
  const collapsed = await $.ui.mount(asGroup)
  const row = await $.ui.mount(rowWithResult('grouped-ac7', 'cat toggled.md', stdoutOf('# Toggled\n')))
  await row.redraw()
  await row.redraw()
  const before = quiet.invalidations()

  // Act: ctrl+o once, then 24 more times with no pause; then, after a quiet spell, once more
  await collapsed.redraw({ ...asGroup.props, isExpanded: true })
  await row.redraw()
  const afterOne = quiet.invalidations()
  for (let n = 0; n < 24; n++) {
    await collapsed.redraw({ ...asGroup.props, isExpanded: n % 2 === 1 })
    await row.redraw()
  }
  const afterBurst = quiet.invalidations()
  await quiet.endQuietWait()
  await collapsed.redraw({ ...asGroup.props, isExpanded: false })
  await row.redraw()
  const afterQuiet = quiet.invalidations()

  // Assert
  expect(afterOne - before).toBe(1)
  expect(afterBurst - before).toBe(20)
  expect(afterQuiet - afterBurst).toBe(1)
  await quiet.endQuietWait()
  for (const handle of [row, collapsed]) await handle.unmount()
})

// Value: protects=a call that leaves its group shows its output once; fails_when=the command row still draws the output after a ToolResult was drawn for the call; why_new=the standalone test uses a call no group ever named; seam=none; no_claim=whether Claude Code ever regroups a call (the kit raises the events)
test('a grouped call later drawn standalone shows its output once, in its own result block', async ($, on) => {
  // Arrange: a grouped row drawn with its output
  standInForClaudeCode(on)
  const collapsed = await $.ui.mount(group('group-o2', ['regrouped-o2'], false))
  const output = stdoutOf('# Moved\n')
  const row = await $.ui.mount(rowWithResult('regrouped-o2', 'cat moved.md', output))
  await row.redraw()
  await row.redraw()
  const whileGrouped = (await textsOf(row)).map(t => t.text)

  // Act: the group is gone and Claude Code draws the call's result on its own, as it does for a standalone row
  await collapsed.unmount()
  const block = await $.ui.mount({ ...outputBlock('regrouped-o2', output), viewport: MAIN_SCREEN })
  await block.redraw()
  await row.redraw()

  // Assert
  expect(whileGrouped).toContain('# Moved')
  expect((await textsOf(row)).map(t => t.text)).not.toContain('# Moved')
  expect((await textsOf(block)).map(t => t.text)).toContain('# Moved')
  for (const handle of [block, row]) await handle.unmount()
})

// Value: protects=two views that undo each other's record of a call cannot redraw without end; fails_when=alternating group and result events keep asking for redraws; why_new=the fold test covers flips of one group only; seam=none; no_claim=that Claude Code ever raises both for one call
test('a call drawn in turn as a grouped row and as a standalone result stops asking for redraws', async ($, on) => {
  // Arrange: the quiet wait is held, so every round belongs to one burst
  const quiet = standInHoldingTheQuietWait(on)
  const collapsed = await $.ui.mount(group('group-e2', ['flapping-e2'], false))
  const output = stdoutOf('# Flap\n')
  const row = await $.ui.mount(rowWithResult('flapping-e2', 'cat flap.md', output))
  await row.redraw()
  await row.redraw()
  const block = await $.ui.mount({ ...outputBlock('flapping-e2', output), viewport: MAIN_SCREEN })
  const before = quiet.invalidations()

  // Act: 15 rounds of the row, the group and the result each drawn again, then 3 more
  const round = async () => {
    for (const handle of [row, collapsed, row, block]) await handle.redraw()
  }
  for (let n = 0; n < 15; n++) await round()
  const afterFifteen = quiet.invalidations()
  for (let n = 0; n < 3; n++) await round()

  // Assert: the first rounds asked, within the bound of 20 for one call, and the last three asked for nothing
  expect(afterFifteen - before).toBeGreaterThan(0)
  expect(afterFifteen - before).toBeLessThanOrEqual(20)
  expect(quiet.invalidations() - afterFifteen).toBe(0)
  await quiet.endQuietWait()
  for (const handle of [block, row, collapsed]) await handle.unmount()
})

// Value: protects=a tall grouped row first drawn plain keeps that styling only in the view it was drawn in, and always shows the current text; fails_when=the row is restyled while too tall to redraw, a rewritten stdout shows the old text, or the fold is lost after ctrl+o is closed; why_new=the existing freeze tests cover ToolResult blocks; seam=none; no_claim=what a real screen keeps in its scrollback
test('a grouped row taller than the main screen, drawn before its colours, stays plain while expanded, shows a rewritten output, and folds again when the group is collapsed', async ($, on) => {
  // Arrange: workers held; a 40-line result in a group Claude Code expanded, on a 24-row main screen
  const held: Array<() => void> = []
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{CLAUDE_CODE_DRAWS}</Text>
  })
  on('process.run', async (_, e) => {
    const asked = JSON.parse(String(e.init?.stdin ?? '{}')) as Record<string, unknown>
    await new Promise<void>(resolve => held.push(resolve))
    const lines = String(asked.output ?? asked.command ?? '').split('\n').map(t => (t === '' ? [] : [{ t, fg: '#ff0000', b: false, i: false, u: false }]))

    return { value: { exitCode: 0, stdout: JSON.stringify({ editor: 'test', theme: 'test', lines }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('clock.sleep', () => ({ value: undefined }))
  const shortScreen = { columns: 80, rows: 24, isFullscreen: false }
  const asGroup = group('group-o3', ['tall-o3'], true, shortScreen)
  const expanded = await $.ui.mount(asGroup)
  const list = (first: string) => stdoutOf(`${[first, ...Array.from({ length: 39 }, (_, n) => `- item ${n}`)].join('\n')}\n`)
  const asRow = rowWithResult('tall-o3', 'cat tall.md', list('TOKEN=abc123'), shortScreen)
  const row = await $.ui.mount(asRow)

  // Act: the colours come back; another mod rewrites the record; then ctrl+o is closed
  while (held.length > 0) held.shift()?.()
  await row.redraw()
  await row.redraw()
  const onceColoursAreBack = await textsOf(row)
  await row.redraw({ ...asRow.props, output: list('TOKEN=•••') })
  while (held.length > 0) held.shift()?.()
  await row.redraw({ ...asRow.props, output: list('TOKEN=•••') })
  const afterRewrite = (await textsOf(row)).map(t => t.text)
  await expanded.redraw({ ...asGroup.props, isExpanded: false })
  await row.redraw({ ...asRow.props, output: list('TOKEN=•••') })
  const afterCollapse = (await textsOf(row)).map(t => t.text)

  // Assert
  expect(onceColoursAreBack.map(t => t.text)).toContain('- item 38')
  expect(onceColoursAreBack).not.toContainEqual({ text: 'TOKEN=abc123', color: OUTPUT_RED })
  expect(onceColoursAreBack).not.toContainEqual({ text: '- item 38', color: OUTPUT_RED })
  expect(afterRewrite).toContain('TOKEN=•••')
  expect(afterRewrite).not.toContain('TOKEN=abc123')
  expect(afterCollapse).toContain('… +37 lines (ctrl+o to expand)')
  expect(afterCollapse).not.toContain('- item 38')
  for (const handle of [row, expanded]) await handle.unmount()
})

// Value: protects=the collapsedLines option applies to rows of a group the mod unfolded, running or done; fails_when=a long grouped command is drawn in full, or changes height when its result arrives; why_new=no test mounted a grouped row; seam=none; no_claim=the wrapped width of one long line
test('a long command in a group the mod unfolded shows three lines while it runs and after, with its output under it', async ($, on) => {
  // Arrange
  standInForClaudeCode(on)
  const collapsed = await $.ui.mount(group('group-r1', ['long-r1'], false))
  const command = 'ls -l \\\n  notes.md \\\n  data.json \\\n  long.md \\\n  LAST-ARGUMENT.md'
  const asRunning = rowWithResult('long-r1', command, undefined, MAIN_SCREEN, { isRunning: true })

  // Act
  const row = await $.ui.mount(asRunning)
  await row.redraw()
  const whileRunning = (await textsOf(row)).map(t => t.text)
  await row.redraw({ ...asRunning.props, isRunning: false, output: stdoutOf('notes.md\n') })
  await row.redraw({ ...asRunning.props, isRunning: false, output: stdoutOf('notes.md\n') })
  const whenDone = (await textsOf(row)).map(t => t.text)

  // Assert
  for (const texts of [whileRunning, whenDone]) {
    expect(texts).toContain('  data.json \\')
    expect(texts).not.toContain('  LAST-ARGUMENT.md')
    expect(texts).toContain('      … +2 lines) (ctrl+o to expand)')
  }
  expect(whenDone).toContain('notes.md')
  for (const handle of [row, collapsed]) await handle.unmount()
})

// Value: protects=a grouped row too large for one tree is drawn whole by Claude Code, its output kept; fails_when=the size check ignores what the command rows draw around their text and the engine cuts the row's end; why_new=the existing size tests cover ToolResult blocks; seam=none; no_claim=the engine's real bounds (the kit does not enforce the character cut)
test('a grouped row whose command lines alone pass what one drawing holds is drawn whole by Claude Code', async ($, on) => {
  // Arrange: 1,400 command lines take 11 nodes each as a grouped row draws them, past the 15,000 the mod allows
  standInForClaudeCode(on)
  const expanded = await $.ui.mount(group('group-e1', ['huge-e1'], true))
  const command = Array.from({ length: 1400 }, (_, n) => `echo ${n} \\`).join('\n')

  // Act
  const row = await $.ui.mount(rowWithResult('huge-e1', `${command}\necho end`, stdoutOf('end\n')))
  await row.redraw()
  await row.redraw()

  // Assert
  expect((await textsOf(row)).map(t => t.text)).toEqual([CLAUDE_CODE_DRAWS])
  for (const handle of [row, expanded]) await handle.unmount()
})

// Value: protects=a row drawn before its group is known (verbose mode draws a resumed group's rows first) gains its output; fails_when=the group event asks for no redraw, or the redrawn row still holds only the command; why_new=the other tests mount the group first; seam=none; no_claim=the order Claude Code raises the events in (live probe)
test('a row drawn before the group that names it shows only its command, then its output once the group is drawn', async ($, on) => {
  // Arrange: the row is drawn first, as verbose mode draws a resumed session
  const seen = standInForClaudeCode(on)
  const row = await $.ui.mount(rowWithResult('early-o5', 'cat early.md', stdoutOf('# Early\n')))
  await row.redraw()
  await row.redraw()
  const beforeGroup = (await textsOf(row)).map(t => t.text)
  const invalidationsBefore = seen.invalidations

  // Act
  const expanded = await $.ui.mount(group('group-o5', ['early-o5'], true))
  const afterGroupAlone = (await textsOf(row)).map(t => t.text)
  await row.redraw()
  await row.redraw()

  // Assert: the group's drawing alone had the row drawn again with its output, before the test redrew it
  expect(beforeGroup).not.toContain('# Early')
  expect(afterGroupAlone).toContain('# Early')
  expect(seen.invalidations - invalidationsBefore).toBeGreaterThan(0)
  expect(await textsOf(row)).toContainEqual({ text: '# Early', color: OUTPUT_RED })
  for (const handle of [row, expanded]) await handle.unmount()
})

// Value: protects=a folded grouped output of four rows shows all four and one of five hides two (Claude Code never hides a single row); fails_when=a lone hidden row is replaced by a '+1 line' hint or the hint count is off; why_new=the fold tests use ten lines only; seam=none; no_claim=wrapped lines (each line is short)
test('a grouped output of four lines shows all four with no hint, and one of five shows three with +2 lines', async ($, on) => {
  // Arrange
  standInForClaudeCode(on)
  const collapsed = await $.ui.mount(group('group-b1', ['four-b1', 'five-b1'], false))
  const linesOf = (count: number) => `${Array.from({ length: count }, (_, n) => `row ${n}`).join('\n')}\n`

  // Act
  const four = await $.ui.mount(rowWithResult('four-b1', 'cat four.txt', stdoutOf(linesOf(4))))
  const five = await $.ui.mount(rowWithResult('five-b1', 'cat five.txt', stdoutOf(linesOf(5))))
  for (const handle of [four, five]) {
    await handle.redraw()
    await handle.redraw()
  }

  // Assert
  const fourTexts = (await textsOf(four)).map(t => t.text)
  const fiveTexts = (await textsOf(five)).map(t => t.text)
  expect(fourTexts).toContain('row 3')
  expect(fourTexts.some(text => text.includes('ctrl+o to expand'))).toBe(false)
  expect(fiveTexts).toContain('row 2')
  expect(fiveTexts).not.toContain('row 3')
  expect(fiveTexts).toContain('… +2 lines (ctrl+o to expand)')
  for (const handle of [five, four, collapsed]) await handle.unmount()
})

// Value: protects=an interrupted grouped call or one with a blank command is drawn whole by Claude Code; fails_when=the mod draws its own row for an interrupt or an empty command; why_new=the fallback test covers notice, no output and error only; seam=none; no_claim=what Claude Code draws for them (the stand-in draws one Text)
test('a grouped call that was interrupted, or whose command is blank, is drawn whole by Claude Code', async ($, on) => {
  // Arrange
  standInForClaudeCode(on)
  const collapsed = await $.ui.mount(group('group-b2', ['stopped-b2', 'blank-b2'], false))
  const stopped = rowWithResult('stopped-b2', 'sleep 600', undefined)

  // Act
  const interrupted = await $.ui.mount({ ...stopped, props: { ...stopped.props, isInterrupted: true } })
  const blank = await $.ui.mount(rowWithResult('blank-b2', '  \n ', stdoutOf('# Blank\n')))
  for (const handle of [interrupted, blank]) await handle.redraw()

  // Assert
  expect((await textsOf(interrupted)).map(t => t.text)).toEqual([CLAUDE_CODE_DRAWS])
  expect((await textsOf(blank)).map(t => t.text)).toEqual([CLAUDE_CODE_DRAWS])
  for (const handle of [blank, interrupted, collapsed]) await handle.unmount()
})

// Value: protects=a grouped call's output keeps every line past the colouring cap in a full view; fails_when=lines past 2,000 are dropped or the row falls back to Claude Code; why_new=the cap is only tested for standalone result blocks; seam=none; no_claim=colours of a tall row (kept plain by design, see the tall-row test) and the engine's real node bound
test('a grouped output of 2,001 lines in a group Claude Code expanded shows its first and its last line', async ($, on) => {
  // Arrange: one line past the colouring cap
  standInForClaudeCode(on)
  const expanded = await $.ui.mount(group('group-b3', ['capped-b3'], true))
  const stdout = `${Array.from({ length: 2001 }, (_, n) => `n${n}`).join('\n')}\n`

  // Act
  const row = await $.ui.mount(rowWithResult('capped-b3', 'seq 2001', stdoutOf(stdout)))
  await row.redraw()
  await row.redraw()

  // Assert
  const texts = (await textsOf(row)).map(t => t.text)
  expect(texts).not.toContain(CLAUDE_CODE_DRAWS)
  expect(texts).toContain('n0')
  expect(texts).toContain('n2000')
  for (const handle of [row, expanded]) await handle.unmount()
})

// Value: protects=a running grouped call draws its dot as running and a finished one as done; fails_when=the dot colour ignores isRunning; why_new=the long-command test checks lines, not the dot; seam=none; no_claim=the theme colour values (the kit resolves names)
test('a grouped row shows an inactive dot while its command runs and a success dot once it is done', async ($, on) => {
  // Arrange
  standInForClaudeCode(on)
  const collapsed = await $.ui.mount(group('group-b4', ['dot-b4'], false))
  const asRunning = rowWithResult('dot-b4', 'sleep 2', undefined, MAIN_SCREEN, { isRunning: true })
  const row = await $.ui.mount(asRunning)
  await row.redraw()
  const whileRunning = await textsOf(row)

  // Act
  await row.redraw({ ...asRunning.props, isRunning: false, output: stdoutOf('done\n') })
  await row.redraw({ ...asRunning.props, isRunning: false, output: stdoutOf('done\n') })
  const whenDone = await textsOf(row)

  // Assert
  expect(whileRunning).toContainEqual({ text: '⏺ ', color: 'inactive' })
  expect(whenDone).toContainEqual({ text: '⏺ ', color: 'success' })
  for (const handle of [row, collapsed]) await handle.unmount()
})

// Value: protects=tall grouped rows kept plain do not send their commands to workers again once the colour cache pushed them out; fails_when=a redraw of more such rows than the cache holds starts a worker, whose answer redraws and starts the next; why_new=the existing cache tests draw standalone rows; seam=none; no_claim=real worker timing and the real cache pressure of a long session
test('more tall grouped rows kept plain than the colour cache holds start no further workers when drawn again', { timeoutMs: 120_000 }, async ($, on) => {
  // Arrange: 205 grouped rows, each with its own command and a 40-line result, drawn on a 24-row main screen while every
  // worker is held, so each row is kept plain; then the workers answer (205 commands and 205 results)
  const commandsSent: string[] = []
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => (release = resolve))
  let finished = 0
  let allFinished: () => void = () => {}
  const everyFirstColouringFinished = new Promise<void>(resolve => (allFinished = resolve))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{CLAUDE_CODE_DRAWS}</Text>
  })
  on('process.run', async (_, e) => {
    const asked = JSON.parse(String(e.init?.stdin ?? '{}')) as Record<string, unknown>
    if (asked.output === undefined) commandsSent.push(String(asked.command ?? ''))
    await held
    if (++finished === 410) allFinished()
    const lines = String(asked.output ?? asked.command ?? '').split('\n').map(t => (t === '' ? [] : [{ t, fg: '#ff0000', b: false, i: false, u: false }]))

    return { value: { exitCode: 0, stdout: JSON.stringify({ editor: 'test', theme: 'test', lines }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('clock.sleep', () => ({ value: undefined }))
  const shortScreen = { columns: 80, rows: 24, isFullscreen: false }
  const ids = Array.from({ length: 205 }, (_, n) => `kept-plain-${n}`)
  const expanded = await $.ui.mount(group('group-kept-plain', ids, true, shortScreen))
  const fortyLines = stdoutOf(`${Array.from({ length: 40 }, (_, n) => `- item ${n}`).join('\n')}\n`)
  const rows: Array<{ redraw: () => Promise<void>; unmount: () => Promise<void> }> = []
  for (const [n, id] of ids.entries()) rows.push(await $.ui.mount(rowWithResult(id, `cat tall-${n}.md`, fortyLines, shortScreen)))
  release()
  await everyFirstColouringFinished
  // drawn twice more: a command pushed out of the cache before its row saw its colours is coloured once more, and settles
  for (const row of rows) await row.redraw()
  for (const row of rows) await row.redraw()
  const sentBefore = commandsSent.length

  // Act: every row is drawn again, as a resize or a scroll back draws it
  for (const row of rows) await row.redraw()

  // Assert
  expect(commandsSent.length - sentBefore).toBe(0)
  for (const handle of [...rows, expanded]) await handle.unmount()
})

// Value: protects=a folded grouped row whose one long output line wraps to four rows is measured by the rows it shows; fails_when=the height check counts the line as one row and restyles a row the main screen cannot redraw whole; why_new=the tall-row test uses an unfolded group; seam=none; no_claim=what a real screen keeps in its scrollback
test('a folded grouped row that only fits the main screen when its wrapped output is counted as one line stays plain once its colours are back', async ($, on) => {
  // Arrange: workers held; a mod-unfolded group on a 15-row main screen; one 275-character line, four rows at 70 cells:
  // 8 prompt rows, 3 for the blank line and hints, 1 command row and 4 output rows pass the 15 rows of the screen
  const held: Array<() => void> = []
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{CLAUDE_CODE_DRAWS}</Text>
  })
  on('process.run', async (_, e) => {
    const asked = JSON.parse(String(e.init?.stdin ?? '{}')) as Record<string, unknown>
    await new Promise<void>(resolve => held.push(resolve))
    const lines = String(asked.output ?? asked.command ?? '').split('\n').map(t => (t === '' ? [] : [{ t, fg: '#ff0000', b: false, i: false, u: false }]))

    return { value: { exitCode: 0, stdout: JSON.stringify({ editor: 'test', theme: 'test', lines }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('clock.sleep', () => ({ value: undefined }))
  const tinyScreen = { columns: 80, rows: 15, isFullscreen: false }
  const collapsed = await $.ui.mount(group('group-wrapped', ['wrapped-1'], false, tinyScreen))
  const row = await $.ui.mount(rowWithResult('wrapped-1', 'cat wide.txt', stdoutOf(`${'x'.repeat(275)}\n`), tinyScreen))

  // Act: both workers answer and the row is drawn again
  while (held.length > 0) held.shift()?.()
  await row.redraw()
  await row.redraw()

  // Assert: the first of the four wrapped rows is drawn, and not in the worker's colour
  const texts = await textsOf(row)
  expect(texts.map(t => t.text)).toContain('x'.repeat(70))
  expect(texts).not.toContainEqual({ text: 'x'.repeat(70), color: OUTPUT_RED })
  for (const handle of [row, collapsed]) await handle.unmount()
})
