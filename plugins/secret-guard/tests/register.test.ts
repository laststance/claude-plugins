import { describe, expect, mock, test } from 'claude-code/testing'

// Fake credentials, assembled at run time so that secret scanners do not flag this public file
const ANTHROPIC_KEY = ['sk', 'ant', 'api03', 'x'.repeat(32)].join('-')
const BEARER = 'a1b2c3d4'.repeat(4)

/** What the model is told beside a masked result; `what` is the count and kind ("1 API key"). */
const reminder = (what: string) =>
  `secret-guard masked ${what} in this result as ••• before you or the transcript received it. ` +
  'The real value is unchanged where it lives. Never write ••• back as a value; to use the secret, refer to ' +
  'it without printing it (an environment variable, a file, a password manager).'

describe('a shell command that spells out a secret', () => {
  test('is refused before it runs, with the kind named and the value left out', async ($, on) => {
    // Arrange
    const ranCommands: unknown[] = []
    on('tool.call', (_, e) => {
      ranCommands.push((e as { command?: unknown }).command)
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })

    // Act
    const answered = await $.tool.call({
      tool: 'Bash',
      command: `curl -H "x-api-key: ${ANTHROPIC_KEY}" https://api.test/v1/messages`,
    })

    // Assert
    expect(answered).toEqual({
      deny:
        'secret-guard: this command spells out an API key. A command is shown on screen and stays in the ' +
        'transcript, so read the value inside the command instead (an environment variable, a private file, a ' +
        `password manager such as "$(op read 'op://vault/item/field')") and run it again.`,
    })
    expect(ranCommands).toEqual([])
  })

  test('runs when it reads the secret from an environment variable', async ($, on) => {
    // Arrange
    const ranCommands: unknown[] = []
    on('tool.call', (_, e) => {
      ranCommands.push((e as { command?: unknown }).command)
      return { result: { stdout: '{"ok":true}', stderr: '', interrupted: false } }
    })

    // Act
    await $.tool.call({ tool: 'Bash', command: 'curl -H "x-api-key: $ANTHROPIC_API_KEY" https://api.test/v1/messages' })

    // Assert
    expect(ranCommands).toEqual(['curl -H "x-api-key: $ANTHROPIC_API_KEY" https://api.test/v1/messages'])
  })

  test('runs when refusing commands is turned off', { options: { blockCommands: false } }, async ($, on) => {
    // Arrange
    const ranCommands: unknown[] = []
    on('tool.call', (_, e) => {
      ranCommands.push((e as { command?: unknown }).command)
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })

    // Act
    await $.tool.call({ tool: 'Bash', command: `curl -H 'Authorization: Bearer ${BEARER}' https://api.test/me` })

    // Assert
    expect(ranCommands).toEqual([`curl -H 'Authorization: Bearer ${BEARER}' https://api.test/me`])
  })
})

describe('a secret in what a tool returns', () => {
  test('is masked in a shell’s output before Claude and the transcript get it, and the person is told', async ($, on) => {
    // Arrange
    const logged: string[] = []
    on('ui.log', (_, e) => {
      logged.push(e.text)
      return { value: undefined }
    })
    on('tool.call', () => ({
      result: { stdout: `ANTHROPIC_API_KEY=${ANTHROPIC_KEY}\nHOME=/home/dev`, stderr: '', interrupted: false, isImage: false },
      ref: 7,
      text: `ANTHROPIC_API_KEY=${ANTHROPIC_KEY}\nHOME=/home/dev`,
    }))

    // Act
    const answered = await $.tool.call({ tool: 'Bash', command: 'env' })

    // Assert
    expect(answered).toEqual({
      result: { stdout: 'ANTHROPIC_API_KEY=sk-ant-•••\nHOME=/home/dev', stderr: '', interrupted: false, isImage: false },
      context: [reminder('1 API key')],
    })
    expect(logged).toEqual(['masked 1 API key in the output of Bash'])
  })

  test('is masked in a file Claude reads', async ($, on) => {
    // Arrange
    on('ui.log', () => ({ value: undefined }))
    on('tool.call', () => ({
      result: {
        type: 'text',
        file: { filePath: '/home/dev/app/.env', content: `ANTHROPIC_API_KEY=${ANTHROPIC_KEY}\nPORT=3000\n`, numLines: 2, startLine: 1, totalLines: 2 },
      },
      ref: 8,
      text: `1\tANTHROPIC_API_KEY=${ANTHROPIC_KEY}\n2\tPORT=3000`,
    }))

    // Act
    const answered = await $.tool.call({ tool: 'Read', file_path: '/home/dev/app/.env' })

    // Assert
    expect(answered).toEqual({
      result: {
        type: 'text',
        file: { filePath: '/home/dev/app/.env', content: 'ANTHROPIC_API_KEY=sk-ant-•••\nPORT=3000\n', numLines: 2, startLine: 1, totalLines: 2 },
      },
      context: [reminder('1 API key')],
    })
  })

  test('is masked in the error a failed command printed', async ($, on) => {
    // Arrange
    on('ui.log', () => ({ value: undefined }))
    on('tool.call', () => ({
      isError: true,
      result: `Exit code 22\n> Authorization: Bearer ${BEARER}\ncurl: (22) The requested URL returned error: 401`,
      ref: 9,
      text: `Exit code 22\n> Authorization: Bearer ${BEARER}\ncurl: (22) The requested URL returned error: 401`,
    }))

    // Act
    const answered = await $.tool.call({ tool: 'Bash', command: 'curl -v --fail https://api.test/me' })

    // Assert
    expect(answered).toEqual({
      deny: `Exit code 22\n> Authorization: Bearer •••\ncurl: (22) The requested URL returned error: 401\n\n${reminder('1 bearer token')}`,
    })
  })

  test('leaves a result without secrets exactly as the tool returned it', async ($, on) => {
    // Arrange
    on('tool.call', () => ({
      result: { stdout: 'On branch main\nnothing to commit', stderr: '', interrupted: false, isImage: false },
      ref: 3,
      text: 'On branch main\nnothing to commit',
    }))

    // Act
    const answered = await $.tool.call({ tool: 'Bash', command: 'git status' })

    // Assert
    expect(answered).toEqual({
      result: { stdout: 'On branch main\nnothing to commit', stderr: '', interrupted: false, isImage: false },
      ref: 3,
      text: 'On branch main\nnothing to commit',
    })
  })

  test('is masked in any other tool’s result as the conversation stores it', async ($, on) => {
    // Arrange: a tool this mod knows nothing about answers with a key in its text
    const logged: string[] = []
    on('ui.log', (_, e) => {
      logged.push(e.text)
      return { value: undefined }
    })
    const session = mock.session(on)

    // Act
    await $.session.append({
      message: {
        type: 'user',
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `token: ${ANTHROPIC_KEY}` }],
      },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'mcp__notes__read' },
      uuid: 'row-1',
    })

    // Assert
    expect(session.appended().map(row => row.message.content)).toEqual([
      [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'token: sk-ant-•••' },
        { type: 'text', text: reminder('1 API key') },
      ],
    ])
    expect(logged).toEqual(['masked 1 API key in the result of mcp__notes__read'])
  })

  test('stays as the person typed it in their own prompt', async ($, on) => {
    // Arrange
    const session = mock.session(on)

    // Act
    await $.session.append({
      message: { type: 'user', role: 'user', content: [{ type: 'text', text: `put ${ANTHROPIC_KEY} into .env` }] },
      door: 'prompt',
      origin: { kind: 'composer' },
      uuid: 'row-2',
    })

    // Assert
    expect(session.appended().map(row => row.message.content)).toEqual([
      [{ type: 'text', text: `put ${ANTHROPIC_KEY} into .env` }],
    ])
  })

  test('passes through unmasked when masking results is turned off', { options: { maskOutput: false } }, async ($, on) => {
    // Arrange
    on('tool.call', () => ({
      result: { stdout: `ANTHROPIC_API_KEY=${ANTHROPIC_KEY}`, stderr: '', interrupted: false, isImage: false },
      ref: 4,
      text: `ANTHROPIC_API_KEY=${ANTHROPIC_KEY}`,
    }))

    // Act
    const answered = await $.tool.call({ tool: 'Bash', command: 'env' })

    // Assert
    expect(answered).toEqual({
      result: { stdout: `ANTHROPIC_API_KEY=${ANTHROPIC_KEY}`, stderr: '', interrupted: false, isImage: false },
      ref: 4,
      text: `ANTHROPIC_API_KEY=${ANTHROPIC_KEY}`,
    })
  })

  test('is masked without a line in the transcript when notices are turned off', { options: { notify: false } }, async ($, on) => {
    // Arrange
    const logged: string[] = []
    on('ui.log', (_, e) => {
      logged.push(e.text)
      return { value: undefined }
    })
    on('tool.call', () => ({
      result: { stdout: `ANTHROPIC_API_KEY=${ANTHROPIC_KEY}`, stderr: '', interrupted: false, isImage: false },
      ref: 5,
      text: `ANTHROPIC_API_KEY=${ANTHROPIC_KEY}`,
    }))

    // Act
    const answered = await $.tool.call({ tool: 'Bash', command: 'env' })

    // Assert
    expect(answered).toEqual({
      result: { stdout: 'ANTHROPIC_API_KEY=sk-ant-•••', stderr: '', interrupted: false, isImage: false },
      context: [reminder('1 API key')],
    })
    expect(logged).toEqual([])
  })
})
