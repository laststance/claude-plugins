import { describe, expect, test } from 'claude-code/testing'

describe('/move-project', () => {
  test('offers a directory argument in the slash command menu', async ($, on) => {
    // Arrange
    const commands: string[] = []
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('command.register', (_, e) => {
      commands.push(e.name + ' ' + e.argumentHint)
      return { value: { command: e.name } }
    })

    // Act
    await $.session.start({ cwd: '/app', isInteractive: true, surface: 'terminal' })

    // Assert
    expect(commands).toEqual(['move-project <directory>'])
  })

  test('explains how to use a move when the session has no launcher', async ($, on) => {
    // Arrange
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('env.get', () => ({ value: undefined }))
    await $.session.start({ cwd: '/app', isInteractive: true, surface: 'terminal' })

    // Act
    const result = await $.command.run({
      command: 'move-project', args: '../lib', origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 100 },
    })

    // Assert
    expect(result.text).toContain('This session has no move-project launcher.')
    expect(result.text).toContain("/shell/claude.zsh'")
    expect(result.isTextDisplayOnly).toBe(true)
  })

  test('shows usage without preparing a move when the destination is missing', async ($, on) => {
    // Arrange
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    await $.session.start({ cwd: '/app', isInteractive: true, surface: 'terminal' })

    // Act
    const result = await $.command.run({
      command: 'move-project', args: '  ', origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 100 },
    })

    // Assert
    expect(result.text).toBe('Usage: /move-project <directory>')
  })
})
