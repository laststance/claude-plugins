import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HINT = {
  plugin: 'blackout',
  component: 'PromptHint',
  requestId: 'hint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

const REPLY = {
  plugin: 'blackout',
  component: 'AssistantMessage',
  requestId: 'message-1',
  props: { text: 'secret reply', isFirstOfReply: true },
} as const

const PROCESS_DONE = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
} as const

/**
 * Stands in for the engine beneath the mod: draws every site as one Text,
 * answers the settle wait at once, refuses the periodic erase timer (so a
 * test never loops), and records each command the mod runs.
 *
 * @param on - The test's `on`, whose hooks sit beneath every plugin.
 * @param engineText - What the engine stand-in draws at any site.
 * @returns The argv of every `$.process.run` call, in order.
 *
 * @example
 * const commands = standInForEngine(on, 'engine hint')
 * // after one press: commands[0] → ['sh', '-c', "printf '...' > /dev/tty"]
 */
const standInForEngine = (on: On, engineText: string): string[][] => {
  const commands: string[][] = []
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{engineText}</Text>
  })
  on('clock.sleep', () => ({ value: undefined }))
  on('clock.every', () => ({ deny: 'no periodic erase in tests' }))
  on('process.run', (_, e) => {
    commands.push([...e.argv])

    return { value: PROCESS_DONE }
  })

  return commands
}

test('ctrl+space blacks out an assistant reply and a second press restores it', async ($, on) => {
  // Arrange
  standInForEngine(on, 'engine drew it')
  const hint = await $.ui.mount({ ...HINT, surface: 'terminal' })

  // Act: press the hidden toggle, as the bound key does
  await hint.press({ key: 'blackout-toggle' })
  const blackedOut = await $.ui.mount({ ...REPLY, surface: 'terminal' })

  // Assert: the reply's text is gone
  expect(await blackedOut.find({ type: 'Text' })).toBeUndefined()
  await blackedOut.unmount()

  // Act: press again
  await hint.press({ key: 'blackout-toggle' })
  const restored = await $.ui.mount({ ...REPLY, surface: 'terminal' })

  // Assert: the engine's drawing is back
  expect((await restored.find({ type: 'Text' }))?.text).toBe('engine drew it')
  await restored.unmount()
  await hint.unmount()
})

test('the hidden toggle is bound to the app:toggleDiffPreSession keybinding action', async ($, on) => {
  // Arrange
  standInForEngine(on, 'engine hint')

  // Act
  const hint = await $.ui.mount({ ...HINT, surface: 'terminal' })
  const toggle = await hint.find({ key: 'blackout-toggle' })

  // Assert: ctrl+space reaches the mod only through this action name
  expect(toggle?.props.action).toBe('app:toggleDiffPreSession')
  // Assert: the engine's hint text still shows while not blacked out
  expect((await hint.find({ type: 'Text' }))?.text).toBe('engine hint')
  await hint.unmount()
})

test('the hint line keeps only the invisible toggle while blacked out', async ($, on) => {
  // Arrange
  standInForEngine(on, 'engine hint')
  const hint = await $.ui.mount({ ...HINT, surface: 'terminal' })

  // Act
  await hint.press({ key: 'blackout-toggle' })

  // Assert: no hint text, but the toggle stays mounted so the key can undo it
  expect(await hint.find({ type: 'Text' })).toBeUndefined()
  expect(await hint.find({ key: 'blackout-toggle' })).toBeDefined()
  await hint.unmount()
})

test('blackout erases the real terminal, and turning it off makes Claude Code repaint everything', async ($, on) => {
  // Arrange
  const commands = standInForEngine(on, 'engine hint')
  const hint = await $.ui.mount({ ...HINT, surface: 'terminal' })

  // Act
  await hint.press({ key: 'blackout-toggle' })
  await hint.press({ key: 'blackout-toggle' })
  await hint.unmount()

  // Assert: on → erase the screen and hide the cursor; off → home, erase, SIGCONT
  expect(commands).toEqual([
    ['sh', '-c', "printf '\\033[2J\\033[?25l' > /dev/tty"],
    ['sh', '-c', "printf '\\033[H\\033[2J' > /dev/tty; kill -CONT \"$PPID\""],
  ])
})
