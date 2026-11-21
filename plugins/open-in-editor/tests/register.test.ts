import { describe, expect, test } from 'claude-code/testing'

describe('register', () => {
  test('the typeahead offers a command for each of the six editors', async ($, on) => {
    // Arrange
    const registeredNames: string[] = []
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('command.register', (_, e) => {
      registeredNames.push(e.name)
      return { value: { command: e.name } }
    })

    // Act
    await $.session.start({ cwd: '/Users/me/work/app', surface: 'terminal', isInteractive: true })

    // Assert
    expect(registeredNames).toEqual(['vscode', 'cursor', 'devin-desktop', 'webstorm', 'phpstorm', 'zed'])
  })

  test('/zed opens the project root in Zed and keeps the line out of the model requests', async ($, on) => {
    // Arrange
    const launchedArgv: (readonly string[])[] = []
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('session.root', () => ({ value: '/Users/me/work/app' }))
    on('process.run', (_, e) => {
      launchedArgv.push(e.argv)
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    await $.session.start({ cwd: '/Users/me/work/app', surface: 'terminal', isInteractive: true })

    // Act
    const result = await $.command.run({
      command: 'zed',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })

    // Assert
    expect(launchedArgv).toEqual([['open', '-a', 'Zed', '/Users/me/work/app']])
    expect(result.text).toBe('Opened /Users/me/work/app in Zed')
    expect(result.isTextDisplayOnly).toBe(true)
  })

  test('each command launches its own macOS app, Devin Desktop as Devin.app', async ($, on) => {
    // Arrange
    const launchedArgv: (readonly string[])[] = []
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('session.root', () => ({ value: '/Users/me/work/app' }))
    on('process.run', (_, e) => {
      launchedArgv.push(e.argv)
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    await $.session.start({ cwd: '/Users/me/work/app', surface: 'terminal', isInteractive: true })

    // Act
    for (const command of ['vscode', 'cursor', 'devin-desktop', 'webstorm', 'phpstorm', 'zed']) {
      await $.command.run({
        command,
        args: '',
        origin: { kind: 'composer' },
        presentation: { isFullscreen: false, columns: 120 },
      })
    }

    // Assert
    expect(launchedArgv).toEqual([
      ['open', '-a', 'Visual Studio Code', '/Users/me/work/app'],
      ['open', '-a', 'Cursor', '/Users/me/work/app'],
      ['open', '-a', 'Devin', '/Users/me/work/app'],
      ['open', '-a', 'WebStorm', '/Users/me/work/app'],
      ['open', '-a', 'PhpStorm', '/Users/me/work/app'],
      ['open', '-a', 'Zed', '/Users/me/work/app'],
    ])
  })

  test('an editor that is not installed shows a toast with the reason', async ($, on) => {
    // Arrange
    const toastTexts: string[] = []
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('session.root', () => ({ value: '/Users/me/work/app' }))
    on('process.run', () => ({
      value: {
        exitCode: 1,
        stdout: '',
        stderr: "Unable to find application named 'PhpStorm'\n",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }))
    on('ui.toast', (_, e) => {
      toastTexts.push(e.text)
      return { value: undefined }
    })
    await $.session.start({ cwd: '/Users/me/work/app', surface: 'terminal', isInteractive: true })

    // Act
    const result = await $.command.run({
      command: 'phpstorm',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })

    // Assert
    expect(toastTexts).toEqual([
      "Could not open /Users/me/work/app in PhpStorm: Unable to find application named 'PhpStorm'",
    ])
    expect(result.text).toBe(
      "Could not open /Users/me/work/app in PhpStorm: Unable to find application named 'PhpStorm'",
    )
  })

  test('a launch that cannot start shows a toast instead of failing silently', async ($, on) => {
    // Arrange
    const toastTexts: string[] = []
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('session.root', () => ({ value: '/Users/me/work/app' }))
    // A refusal rejects the mod's $.process.run, as a launch that never starts does
    on('process.run', () => ({ deny: 'open timed out after 15000 ms' }))
    on('ui.toast', (_, e) => {
      toastTexts.push(e.text)
      return { value: undefined }
    })
    await $.session.start({ cwd: '/Users/me/work/app', surface: 'terminal', isInteractive: true })

    // Act
    const result = await $.command.run({
      command: 'cursor',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })

    // Assert
    expect(toastTexts).toEqual(['Could not open /Users/me/work/app in Cursor: open-in-editor: $.process.run: open timed out after 15000 ms'])
    expect(result.text).toBe('Could not open /Users/me/work/app in Cursor: open-in-editor: $.process.run: open timed out after 15000 ms')
  })
})
