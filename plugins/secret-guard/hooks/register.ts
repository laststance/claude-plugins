import type { Register } from 'claude-code'

import { MASK, SHELL_TOOLS, UNTOUCHED_DOORS } from './constants'
import { describeFound, findLiteralSecret, maskSecrets, mergeFound } from './mask'

/** A block of a row, as the Messages API spells it: a `type` and that type's own fields. */
type Block = { type: string; [field: string]: unknown }

/** A value that is an object with named fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The command of a shell tool's call; undefined for a call of any other tool. */
function shellCommand(call: { tool: string }): string | undefined {
  if (!SHELL_TOOLS.has(call.tool)) return undefined
  const command = (call as { command?: unknown }).command
  return typeof command === 'string' ? command : undefined
}

/**
 * Why a command was refused, in words the model can act on. It names the kind and never the value.
 *
 * @param plugin - This plugin's name, so the person can tell who refused.
 * @param kind - What the command spells out ("API key").
 * @returns The refusal the model reads in place of the command's result.
 */
function refusal(plugin: string, kind: string): string {
  const article = /^[aeiou]/i.test(kind) ? 'an' : 'a'
  return (
    `${plugin}: this command spells out ${article} ${kind}. A command is shown on screen and stays in the ` +
    'transcript, so read the value inside the command instead (an environment variable, a private file, a ' +
    `password manager such as "$(op read 'op://vault/item/field')") and run it again.`
  )
}

/**
 * What the model is told beside a result that had values masked, so that it neither takes `•••` for
 * the real value nor writes it back.
 *
 * @param plugin - This plugin's name.
 * @param found - What was masked, from {@link maskSecrets}.
 * @returns One paragraph for the model.
 */
function reminder(plugin: string, found: ReadonlyMap<string, number>): string {
  return (
    `${plugin} masked ${describeFound(found)} in this result as ${MASK} before you or the transcript received it. ` +
    `The real value is unchanged where it lives. Never write ${MASK} back as a value; to use the secret, refer to ` +
    'it without printing it (an environment variable, a file, a password manager).'
  )
}

/**
 * Masks the texts of a tool's own result record: what the screen draws and the transcript stores.
 *
 * Why it exists: the conversation's row of a result is masked by the `session.append` hook, but the
 * record a tool returns beside it (a shell's `stdout`, a read file's `content`) is stored and drawn as
 * the tool made it. For the tools whose record is their text, it is masked here.
 *
 * @param tool - The tool's name.
 * @param result - The record the tool returned.
 * @param found - Receives what was masked.
 * @returns The record with its texts masked, or undefined when this tool's record is left alone
 *   or holds nothing to mask.
 */
function maskRecord(tool: string, result: unknown, found: Map<string, number>): unknown {
  if (!isRecord(result)) return undefined
  // A shell's output; an image's bytes are not text
  if (SHELL_TOOLS.has(tool) && result.isImage !== true) {
    const fields: Record<string, string> = {}
    for (const name of ['stdout', 'stderr']) {
      const text = result[name]
      if (typeof text !== 'string') continue
      const masked = maskSecrets(text)
      if (masked.found.size === 0) continue
      mergeFound(found, masked.found)
      fields[name] = masked.text
    }
    return Object.keys(fields).length === 0 ? undefined : { ...result, ...fields }
  }
  // A file read as text
  if (tool === 'Read' && result.type === 'text' && isRecord(result.file) && typeof result.file.content === 'string') {
    const masked = maskSecrets(result.file.content)
    if (masked.found.size === 0) return undefined
    mergeFound(found, masked.found)
    return { ...result, file: { ...result.file, content: masked.text } }
  }
  return undefined
}

/**
 * Masks the text of one block of a row: a text block, or a tool result's text.
 *
 * @param block - A block as the Messages API spells it.
 * @param found - Receives what was masked.
 * @returns The block, or a copy with its text masked.
 */
function maskBlock(block: Block, found: Map<string, number>): Block {
  const maskText = (text: string): string => {
    const masked = maskSecrets(text)
    mergeFound(found, masked.found)
    return masked.text
  }
  if (block.type === 'text' && typeof block.text === 'string') return { ...block, text: maskText(block.text) }
  if (block.type !== 'tool_result') return block
  // A tool result holds its text as one string or as text blocks
  if (typeof block.content === 'string') return { ...block, content: maskText(block.content) }
  if (!Array.isArray(block.content)) return block
  return {
    ...block,
    content: block.content.map((part: unknown) =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? { ...part, text: maskText(part.text) } : part,
    ),
  }
}

/** What a row is, in the words of the notice: "the result of Bash", "an attachment". */
function describeRow(door: string, origin: unknown): string {
  if (door === 'tool-result' || door === 'tool-message') {
    const tool = isRecord(origin) && typeof origin.tool === 'string' ? origin.tool : 'a tool'
    return `the result of ${tool}`
  }
  const words: Record<string, string> = {
    response: "Claude's reply",
    attachment: 'an attachment',
    delivery: 'a delivered message',
    'hook-context': "a hook's context",
    compaction: 'the compaction summary',
    command: "a command's output",
    note: "a plugin's note",
  }
  return words[door] ?? 'a row of the conversation'
}

/**
 * Registers the hooks that keep secrets out of the conversation; the engine calls it at load and on every reload.
 *
 * - `tool.call`, before a shell command runs: a command that spells out a key or token is refused,
 *   and the model is told to read the value inside the command instead (the `blockCommands` option).
 * - `tool.call`, after a tool ran: secrets in a shell's output and in a file read as text are masked
 *   in the tool's own record, which the screen draws and the transcript stores (the `maskOutput` option).
 * - `session.append`: secrets are masked in every row the conversation keeps (any tool's result, an
 *   attachment, a hook's context, a compaction's summary), except what the person typed.
 *
 * A hook that fails is passed by, as the engine does for any hook: a guard that breaks must not stop
 * every command.
 *
 * @param on - Adds a hook beneath the engine's behaviour.
 * @param options - The `userConfig` values: `blockCommands`, `maskOutput` and `notify`, each on unless set to false.
 * @returns Nothing; the hooks it adds are the mod.
 * @example
 * // The model runs `env` and the shell prints OPENAI_API_KEY=sk-proj-…
 * // => Claude and the transcript get OPENAI_API_KEY=sk-proj-•••, and a dim line says "masked 1 API key in the output of Bash"
 */
export const register: Register = (on, options) => {
  const isBlockingCommands = options.blockCommands !== false
  const isMaskingOutput = options.maskOutput !== false
  const isNotifying = options.notify !== false

  on('tool.call', async ($, e, next) => {
    // A secret written into a command would be on screen and in the transcript before anything could mask it
    if (isBlockingCommands) {
      const command = shellCommand(e)
      const kind = command === undefined ? undefined : findLiteralSecret(command)
      if (kind !== undefined) return { deny: refusal($.plugin.name, kind) }
    }

    const ran = await next(e)
    if (!isMaskingOutput || ran.deny !== undefined) return ran

    const found = new Map<string, number>()
    // A failed call has no record, only the error's text: the model reads the masked text as that error
    if (ran.isError === true) {
      const error = typeof ran.text === 'string' ? ran.text : typeof ran.result === 'string' ? ran.result : undefined
      const masked = error === undefined ? undefined : maskSecrets(error)
      if (masked === undefined || masked.found.size === 0) return ran
      if (isNotifying) $.ui.log(`masked ${describeFound(masked.found)} in the error output of ${e.tool}`)
      return { deny: `${masked.text}\n\n${reminder($.plugin.name, masked.found)}` }
    }

    const record = maskRecord(e.tool, ran.result, found)
    // Nothing to mask: the engine's own answer goes on untouched
    if (record === undefined) return ran
    if (isNotifying) $.ui.log(`masked ${describeFound(found)} in the output of ${e.tool}`)
    // An answer of our own, without the engine's `ref`: the engine builds the result from this record
    return { result: record, context: [...(ran.context ?? []), reminder($.plugin.name, found)] } as typeof ran
  })

  if (!isMaskingOutput) return

  on('session.append', async ($, e, next) => {
    // What the person typed is theirs to share
    if (UNTOUCHED_DOORS.has(e.door)) return next(e)

    const found = new Map<string, number>()
    const content = e.message.content.map(block => maskBlock(block, found))
    if (found.size === 0) return next(e)

    if (isNotifying) $.ui.log(`masked ${describeFound(found)} in ${describeRow(e.door, e.origin)}`)
    // A row the model reads as input also says what happened to it; the model's own words are not added to
    const note: Block[] = e.message.role === 'user' ? [{ type: 'text', text: reminder($.plugin.name, found) }] : []
    return next({ ...e, message: { ...e.message, content: [...content, ...note] } })
  })
}
