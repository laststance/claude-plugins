import type { Register } from 'claude-code'

/**
 * Registers the user-initiated project move and hands the active conversation to the terminal launcher.
 * Claude Code calls this entry point when it loads the mod.
 *
 * @example
 * // In the Claude Code prompt:
 * // /move-project ../library-b
 */
export const register: Register = on => {
  let imported = false
  on('session.start', async ($, event, next) => {
    await $.command.register({
      name: 'move-project',
      argumentHint: '<directory>',
      description: 'Open another project in this terminal with the conversation and tool history',
    })
    return next(event)
  })

  on('prompt.submit', async ($, event, next) => {
    // Bind the import to the launcher's prompt and its exact archive, once per destination.
    if (imported || !event.text.startsWith('Continue this project move using the previous conversation in the archive.')) {
      return next(event)
    }
    const archive = await $.env.get('MOVE_PROJECT_IMPORT').catch(() => undefined)
    if (!archive?.endsWith('/history.jsonl') || !event.text.endsWith(`: ${archive}`)) return next(event)
    imported = true

    let reason: string
    try {
      const { size } = await $.fs.stat(archive)
      if (size > 4 * 1024 * 1024) {
        // A single Mod file read is limited to 4 MiB.
        reason = 'The full archive exceeds the inline transfer limit.'
      } else {
        const { context } = await $.session.usage({ breakdown: 'summary' })
        const free = context.breakdown?.categories.find(category => category.kind === 'free')?.tokens
        // Allow up to one token per UTF-8 byte, plus space for the opening prompt.
        if (free !== undefined && size + 1024 <= free) {
          const history = await $.fs.read(archive)
          return next({ ...event, text: `${event.text}\n\nPrevious project history:\n${history}` })
        }
        reason = 'The archive exceeds the estimated space available for inline history.'
      }
    } catch {
      reason = 'The archive could not be loaded inline.'
    }
    $.ui.toast(`${reason} Search or read the complete archive at ${archive}`)
    return next({
      ...event,
      text: `${reason}\n${event.text}`,
    })
  })

  on('command.run', { command: 'move-project' }, async ($, event) => {
    const display = (text: string) => ({ text, isTextDisplayOnly: true as const })
    // Treat the entire argument as a path. Optional matching quotes allow shell-style examples.
    const target = event.args.trim().replace(/^(["'])([\s\S]*)\1$/, '$2')
    if (!target) return display('Usage: /move-project <directory>')

    const channel = await $.env.get('MOVE_PROJECT_CHANNEL')
    if (!channel) {
      const script = `${$.plugin.root}/shell/claude.zsh`.replace(/'/g, "'\\''")
      return display(`This session has no move-project launcher. In zsh, run:\nsource '${script}'\nThen start claude again. See the plugin README for permanent setup.`)
    }

    try {
      const { transcriptPath } = await $.session.info()
      if (!transcriptPath) return display('This session has no saved transcript to transfer.')

      const session = await $.session.id()
      const cwd = await $.session.cwd()
      const latest = await $.session.messages({ last: 1 })
      // A rewind can leave other branches later in the journal. Anchor to the live conversation.
      if (!Array.isArray(latest)) return display('Could not identify the active conversation. The session is still open.')
      const tip = latest.at(-1)?.uuid
      const launcher = `${$.plugin.root}/scripts/launcher.py`
      const result = await $.process.run([
        'python3', '-IB', launcher, 'prepare', '--channel', channel, '--transcript', transcriptPath,
        '--session', session, '--cwd', cwd, `--target=${target}`, ...(tip ? ['--tip', tip] : []),
      ])
      if (result.exitCode !== 0) return display(result.stderr.trim() || 'Could not prepare the move. This session is still open.')

      // /exit must run after this command releases the session's command queue.
      $.clock.after(0, async () => {
        try {
          await $.command.run({ command: 'exit', args: '' })
        } catch (error) {
          await $.process.run(['python3', '-IB', launcher, 'cancel', '--channel', channel, '--session', session])
          $.ui.toast(`Could not exit for the move: ${String(error)}`)
        }
      })
      return display(result.stdout.trim() || 'Project move prepared.')
    } catch (error) {
      return display(`Could not prepare the project move: ${String(error)}`)
    }
  })
}
