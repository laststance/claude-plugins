import { describe, expect, test } from 'claude-code/testing'

describe('register', () => {
  test('/expand turns always-expanded rows on when Verbose output is off', async ($, on) => {
    // Arrange
    const configWrites: { key: string; value: unknown }[] = []
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('config.list', () => ({
      value: [
        {
          key: 'verbose',
          label: 'Verbose output',
          kind: 'boolean',
          value: false,
          provider: { plugin: 'engine', tier: 'core' },
          isLocked: false,
        },
      ],
    }))
    on('config.set', (_, e) => {
      configWrites.push({ key: e.key, value: e.value })
      return { value: e.value }
    })
    await $.session.start({ cwd: '/Users/me/work/app', surface: 'terminal', isInteractive: true })

    // Act
    const result = await $.command.run({
      command: 'expand',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })

    // Assert
    expect(configWrites).toEqual([{ key: 'verbose', value: true }])
    expect(result.text).toBe('Always expand: on. Tool output and thinking are shown in full, as ctrl+o shows them.')
    expect(result.isTextDisplayOnly).toBe(true)
  })

  test('/expand folds rows again when Verbose output is on', async ($, on) => {
    // Arrange
    const configWrites: { key: string; value: unknown }[] = []
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('config.list', () => ({
      value: [
        {
          key: 'verbose',
          label: 'Verbose output',
          kind: 'boolean',
          value: true,
          provider: { plugin: 'engine', tier: 'core' },
          isLocked: false,
        },
      ],
    }))
    on('config.set', (_, e) => {
      configWrites.push({ key: e.key, value: e.value })
      return { value: e.value }
    })
    await $.session.start({ cwd: '/Users/me/work/app', surface: 'terminal', isInteractive: true })

    // Act
    const result = await $.command.run({
      command: 'expand',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })

    // Assert
    expect(configWrites).toEqual([{ key: 'verbose', value: false }])
    expect(result.text).toBe('Always expand: off. Long output folds again (ctrl+o to expand).')
  })

  test('a refused change says why instead of failing silently', async ($, on) => {
    // Arrange
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('config.list', () => ({
      value: [
        {
          key: 'verbose',
          label: 'Verbose output',
          kind: 'boolean',
          value: false,
          provider: { plugin: 'engine', tier: 'core' },
          isLocked: true,
        },
      ],
    }))
    on('config.set', () => ({ deny: 'set by your organization' }))
    await $.session.start({ cwd: '/Users/me/work/app', surface: 'terminal', isInteractive: true })

    // Act
    const result = await $.command.run({
      command: 'expand',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })

    // Assert
    expect(result.text).toBe('Could not turn always-expand on: set by your organization')
  })

})
