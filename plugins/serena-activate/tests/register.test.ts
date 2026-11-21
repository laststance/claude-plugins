import { describe, expect, test } from 'claude-code/testing'

// What the engine stamps on every prompt.compose besides the tool names each test spells out
const ENGINE_COMPOSE_FIELDS = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['terminal'],
  outputStyle: null,
  traits: [],
} as const

describe('register', () => {
  test('inside a git project the system prompt ends with the Serena briefing and its manual', async ($, on) => {
    // Arrange
    const serenaRuns: (readonly string[])[] = []
    const statusTexts: (string | undefined)[] = []
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('fs.exists', (_, e) => ({ value: e.path === '/Users/me/work/app/.git' }))
    on('env.get', () => ({ value: '/Users/me' }))
    on('process.run', (_, e) => {
      serenaRuns.push(e.argv)
      return {
        value: {
          exitCode: 0,
          stdout: '<serena>\nUse find_symbol.\n</serena>\n',
          stderr: '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    })
    on('ui.status', (_, e) => {
      statusTexts.push(e.text)
      return { value: undefined }
    })
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
    await $.session.start({ cwd: '/Users/me/work/app/src', surface: 'terminal', isInteractive: true })

    // Act
    const composed = await $.prompt.compose({ ...ENGINE_COMPOSE_FIELDS, tools: ['Bash', 'mcp__serena__find_symbol'] })

    // Assert
    expect(composed.sections).toEqual([
      { id: 'intro', text: 'You are Claude Code.', scope: 'shared' },
      {
        id: 'serena-activate:briefing',
        text:
          '# Serena\n\n' +
          "Serena's MCP server activated the project at `/Users/me/work/app` when this session started, from the working directory. Nothing needs activating: there is no `activate_project` step to take.\n" +
          "The Serena Instructions Manual follows, so there is no need to call `initial_instructions`. Use Serena's symbolic tools for code navigation and editing as it describes.\n\n" +
          '<serena>\nUse find_symbol.\n</serena>',
        scope: 'session',
      },
    ])
    expect(serenaRuns).toEqual([
      ['serena', 'print-system-prompt', '--only-instructions', '--context', 'claude-code', '/Users/me/work/app'],
    ])
    expect(statusTexts).toEqual(['Serena ✓ app'])
  })

  test('outside any project the system prompt stays as the engine composed it', async ($, on) => {
    // Arrange
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('fs.exists', () => ({ value: false }))
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
    await $.session.start({ cwd: '/private/tmp', surface: 'terminal', isInteractive: true })

    // Act
    const composed = await $.prompt.compose({ ...ENGINE_COMPOSE_FIELDS, tools: ['Bash', 'mcp__serena__find_symbol'] })

    // Assert
    expect(composed.sections).toEqual([{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }])
  })

  test('without a Serena MCP server the system prompt gets no Serena section', async ($, on) => {
    // Arrange
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('fs.exists', (_, e) => ({ value: e.path === '/Users/me/work/app/.git' }))
    on('env.get', () => ({ value: '/Users/me' }))
    on('process.run', () => ({
      value: { exitCode: 0, stdout: '<serena>manual</serena>', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    on('tool.list', () => ({ value: [{ name: 'Bash', description: 'Runs a command', mcp: false }] }))
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
    await $.session.start({ cwd: '/Users/me/work/app', surface: 'terminal', isInteractive: true })

    // Act
    const composed = await $.prompt.compose({ ...ENGINE_COMPOSE_FIELDS, tools: ['Bash'] })

    // Assert
    expect(composed.sections).toEqual([{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }])
  })

  test('Serena tools behind ToolSearch still get the briefing, found through the session tool list', async ($, on) => {
    // Arrange
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('fs.exists', (_, e) => ({ value: e.path === '/Users/me/work/app/.git' }))
    on('env.get', () => ({ value: '/Users/me' }))
    on('process.run', () => ({
      value: { exitCode: 0, stdout: '<serena>manual</serena>', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    on('tool.list', () => ({
      value: [
        { name: 'Bash', description: 'Runs a command', mcp: false },
        { name: 'mcp__serena__find_symbol', description: 'Finds symbols', mcp: true },
      ],
    }))
    on('ui.status', () => ({ value: undefined }))
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
    await $.session.start({ cwd: '/Users/me/work/app', surface: 'terminal', isInteractive: true })

    // Act
    const composed = await $.prompt.compose({ ...ENGINE_COMPOSE_FIELDS, tools: ['Bash', 'ToolSearch'] })

    // Assert
    expect(composed.sections.map(section => section.id)).toEqual(['intro', 'serena-activate:briefing'])
  })

  test('when Serena CLI is not installed a toast says so and Claude is told to call initial_instructions', async ($, on) => {
    // Arrange
    const serenaRuns: (readonly string[])[] = []
    const toastTexts: string[] = []
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('fs.exists', (_, e) => ({ value: e.path === '/Users/me/work/app/.git' }))
    on('env.get', () => ({ value: '/Users/me' }))
    // A refusal rejects the mod's $.process.run, as a command that cannot start does
    on('process.run', (_, e) => {
      serenaRuns.push(e.argv)
      return { deny: 'command not found' }
    })
    on('ui.toast', (_, e) => {
      toastTexts.push(e.text)
      return { value: undefined }
    })
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
    await $.session.start({ cwd: '/Users/me/work/app', surface: 'terminal', isInteractive: true })

    // Act
    const composed = await $.prompt.compose({ ...ENGINE_COMPOSE_FIELDS, tools: ['mcp__serena__find_symbol'] })

    // Assert
    expect(composed.sections[1]).toEqual({
      id: 'serena-activate:briefing',
      text:
        '# Serena\n\n' +
        "Serena's MCP server activated the project at `/Users/me/work/app` when this session started, from the working directory. Nothing needs activating: there is no `activate_project` step to take.\n" +
        "Serena's manual could not be read (serena was not found on the PATH or in ~/.local/bin): call `mcp__serena__initial_instructions` before using Serena's tools.",
      scope: 'session',
    })
    expect(serenaRuns).toEqual([
      ['serena', 'print-system-prompt', '--only-instructions', '--context', 'claude-code', '/Users/me/work/app'],
      [
        '/Users/me/.local/bin/serena',
        'print-system-prompt',
        '--only-instructions',
        '--context',
        'claude-code',
        '/Users/me/work/app',
      ],
    ])
    expect(toastTexts).toEqual(['serena-activate: serena was not found on the PATH or in ~/.local/bin'])
  })

  test('Serena run without --project-from-cwd: Claude is told to activate the project first', async ($, on) => {
    // Arrange
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('fs.exists', (_, e) => ({ value: e.path === '/Users/me/work/app/.serena/project.yml' }))
    on('env.get', () => ({ value: '/Users/me' }))
    on('process.run', () => ({
      value: { exitCode: 0, stdout: '<serena>manual</serena>', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    on('ui.status', () => ({ value: undefined }))
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
    await $.session.start({ cwd: '/Users/me/work/app', surface: 'terminal', isInteractive: true })

    // Act
    const composed = await $.prompt.compose({ ...ENGINE_COMPOSE_FIELDS, tools: ['mcp__serena__activate_project', 'mcp__serena__find_symbol'] })

    // Assert
    expect(composed.sections[1]?.text).toBe(
      '# Serena\n\n' +
        "Serena's MCP server runs without `--project-from-cwd`, so no project is active yet: call `mcp__serena__activate_project` with `/Users/me/work/app` before any other Serena tool.\n" +
        "The Serena Instructions Manual follows, so there is no need to call `initial_instructions`. Use Serena's symbolic tools for code navigation and editing as it describes.\n\n" +
        '<serena>manual</serena>',
    )
  })

  test('inside a project Serena tools move out from behind ToolSearch', async ($, on) => {
    // Arrange
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('fs.exists', (_, e) => ({ value: e.path === '/Users/me/work/app/.git' }))
    on('env.get', () => ({ value: '/Users/me' }))
    on('process.run', () => ({
      value: { exitCode: 0, stdout: '<serena>manual</serena>', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    on('tool.describe', (_, e) => ({ tool: e.tool, description: e.description, isDeferred: true }))
    await $.session.start({ cwd: '/Users/me/work/app', surface: 'terminal', isInteractive: true })

    // Act
    const described = await $.tool.describe({
      tool: 'mcp__serena__find_symbol',
      description: 'Finds symbols',
      isDeferred: true,
      provider: { plugin: 'mcp:serena', tier: 'user' },
    })

    // Assert
    expect(described.isDeferred).toBe(false)
  })

  test(
    'with loadTools off Serena tools stay behind ToolSearch and Claude is told how to load them',
    { options: { loadTools: false } },
    async ($, on) => {
      // Arrange
      on('session.start', (_, e) => ({ cwd: e.cwd }))
      on('fs.exists', (_, e) => ({ value: e.path === '/Users/me/work/app/.git' }))
      on('env.get', () => ({ value: '/Users/me' }))
      on('process.run', () => ({
        value: { exitCode: 0, stdout: '<serena>manual</serena>', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
      }))
      on('ui.status', () => ({ value: undefined }))
      on('tool.describe', (_, e) => ({ tool: e.tool, description: e.description, isDeferred: true }))
      on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
      await $.session.start({ cwd: '/Users/me/work/app', surface: 'terminal', isInteractive: true })

      // Act
      const described = await $.tool.describe({
        tool: 'mcp__serena__find_symbol',
        description: 'Finds symbols',
        isDeferred: true,
        provider: { plugin: 'mcp:serena', tier: 'user' },
      })
      const composed = await $.prompt.compose({ ...ENGINE_COMPOSE_FIELDS, tools: ['mcp__serena__find_symbol'] })

      // Assert
      expect(described.isDeferred).toBe(true)
      expect(composed.sections[1]?.text).toBe(
        '# Serena\n\n' +
          "Serena's MCP server activated the project at `/Users/me/work/app` when this session started, from the working directory. Nothing needs activating: there is no `activate_project` step to take.\n" +
          "Serena's tools are behind ToolSearch: load the ones you need (for example `select:mcp__serena__find_symbol,mcp__serena__get_symbols_overview`) before code navigation.\n" +
          "The Serena Instructions Manual follows, so there is no need to call `initial_instructions`. Use Serena's symbolic tools for code navigation and editing as it describes.\n\n" +
          '<serena>manual</serena>',
      )
    },
  )
})
