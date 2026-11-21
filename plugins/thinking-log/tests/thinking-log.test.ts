import { expect, test } from 'claude-code/testing'

test('shows the thinking summary in the transcript before the answer streams', async ($, on) => {
  // Arrange: the engine streams one thinking block in two pieces, then the answer
  const events: string[] = []
  on('ui.log', (_, e) => {
    events.push('log: ' + e.text)
    return { value: undefined }
  })
  on('turn.step', async function* () {
    yield { kind: 'thinking', index: 0, text: 'Comparing 9.11 ' }
    yield { kind: 'thinking', index: 0, text: 'and 9.9.' }
    yield { kind: 'text', index: 1, text: '9.9' }
    return { turnId: 't1', index: 0, answer: '9.9', toolUses: [], stopReason: 'end_turn', usage: null }
  })

  // Act
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  let step = await stream.next()
  // Read chunk by chunk so the generator's return value is kept
  while (!step.done) {
    const chunk = step.value
    events.push(chunk.kind + ': ' + ('text' in chunk ? chunk.text : ''))
    step = await stream.next()
  }

  // Assert
  expect(events).toEqual([
    'thinking: Comparing 9.11 ',
    'thinking: and 9.9.',
    'log: ✻ Comparing 9.11 and 9.9.',
    'text: 9.9',
  ])
  // The step's result reaches the engine unchanged
  expect(step.value).toEqual({ turnId: 't1', index: 0, answer: '9.9', toolUses: [], stopReason: 'end_turn', usage: null })
})

test('shows each paragraph of a long summary as its own uncut line', async ($, on) => {
  // Arrange: two paragraphs, the second longer than the terminal draws in one line
  const logged: string[] = []
  on('ui.log', (_, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  on('turn.step', async function* () {
    yield { kind: 'thinking', index: 0, text: 'Weighing a PR against a push.\n\n' + 'x'.repeat(2500) }
    yield { kind: 'tool', index: 1, id: 'toolu_1', name: 'Bash' }
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: null }
  })

  // Act
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) {
    // Drain the stream as the engine would
  }

  // Assert
  expect(logged).toEqual(['✻ Weighing a PR against a push.', 'x'.repeat(2000), 'x'.repeat(500)])
})

test('shows thinking that ends the step with no answer after it', async ($, on) => {
  // Arrange: the stream stops right after the thinking block
  const logged: string[] = []
  on('ui.log', (_, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  on('turn.step', async function* () {
    yield { kind: 'thinking', index: 0, text: 'Nothing left to do.' }
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })

  // Act
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) {
    // Drain the stream as the engine would
  }

  // Assert
  expect(logged).toEqual(['✻ Nothing left to do.'])
})

test('keeps subagent thinking out of the main transcript', async ($, on) => {
  // Arrange: a subagent's request streams thinking
  const logged: string[] = []
  on('ui.log', (_, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  on('turn.step', async function* () {
    yield { kind: 'thinking', index: 0, text: 'Subagent reasoning.' }
    yield { kind: 'text', index: 1, text: 'done' }
    return { turnId: 't1', index: 0, answer: 'done', toolUses: [], stopReason: 'end_turn', usage: null }
  })

  // Act
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'a1' })
  for await (const _ of stream) {
    // Drain the stream as the engine would
  }

  // Assert
  expect(logged).toEqual([])
})

test('prints nothing when thinking summaries are turned off', async ($, on) => {
  // Arrange: with showThinkingSummaries off the API sends thinking with no text
  const logged: string[] = []
  on('ui.log', (_, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  on('turn.step', async function* () {
    yield { kind: 'thinking', index: 0, text: '' }
    yield { kind: 'text', index: 1, text: 'answer' }
    return { turnId: 't1', index: 0, answer: 'answer', toolUses: [], stopReason: 'end_turn', usage: null }
  })

  // Act
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) {
    // Drain the stream as the engine would
  }

  // Assert
  expect(logged).toEqual([])
})
