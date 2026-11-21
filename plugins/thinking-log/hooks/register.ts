import type { Register } from 'claude-code'

/** The terminal draws only this many characters of one `$.ui.log` line. */
const LOG_LIMIT = 2000

/** Marks the first line of each thinking block, like Claude Code's own "✻ Thinking". */
const MARK = '✻ '

/** Chunk kinds that mean the model has moved past its thinking block. */
const AFTER_THINKING = new Set(['text', 'tool', 'input', 'stop'])

/**
 * Turns one finished thinking block into transcript lines.
 *
 * `$.ui.log` draws a single row and the terminal cuts it at {@link LOG_LIMIT}
 * characters, so every non-empty line of the block becomes its own row and
 * a longer line is sliced. Called by the `turn.step` hook in {@link register}
 * whenever a thinking block ends.
 *
 * @param text - The whole thinking block as it streamed in.
 * @returns Rows to log in order, the first marked with {@link MARK}; empty
 *   when the block holds no visible text (thinking summaries turned off).
 *
 * @example
 * ```ts
 * toLogLines('Comparing the two.\n\nNine point nine wins.')
 * // ['✻ Comparing the two.', 'Nine point nine wins.']
 * ```
 */
const toLogLines = (text: string): string[] => {
  const rows: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    // Blank lines between paragraphs would only add empty dim rows
    if (!trimmed) continue
    const first = rows.length === 0 ? MARK + trimmed : trimmed
    // Slice a line the terminal would otherwise cut off
    for (let start = 0; start < first.length; start += LOG_LIMIT) {
      rows.push(first.slice(start, start + LOG_LIMIT))
    }
  }
  return rows
}

/**
 * Registers the hook that mirrors Claude's thinking into the transcript.
 *
 * Claude Code only shows thinking in the Ctrl+O transcript view. This hook
 * reads each main-loop model request as it streams, collects the `thinking`
 * chunks of a block, and prints the block with `$.ui.log` as soon as the
 * model moves on (text, a tool call, the stop) or the stream ends, so the
 * reasoning appears in the normal view right above what it led to. The
 * engine loads it from `hooks/hooks.json`; every chunk and the step's result
 * pass through unchanged, and the model never sees the logged lines.
 *
 * Needs `"showThinkingSummaries": true` in settings: without it the API
 * omits the thinking text and nothing is printed.
 */
export const register: Register = (on) => {
  on('turn.step', async function* ($, e, next) {
    // Subagents run their own loops; keep the transcript to the main one
    if (e.agentId !== undefined) return yield* next(e)

    const stream = next(e)
    let block = ''
    let blockIndex = -1

    const flush = () => {
      for (const row of toLogLines(block)) $.ui.log(row)
      block = ''
    }

    try {
      for await (const chunk of stream) {
        if (chunk.kind === 'thinking') {
          // A new thinking block starts: print the previous one first
          if (chunk.index !== blockIndex) flush()
          blockIndex = chunk.index
          block += chunk.text
        } else if (AFTER_THINKING.has(chunk.kind)) {
          flush()
        }
        yield chunk
      }
      return await stream.result
    } finally {
      // Covers the stream ending, an interrupt, and an error alike
      flush()
    }
  })
}
