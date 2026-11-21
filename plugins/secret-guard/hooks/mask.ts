import { MAX_SCANNED_CHARS, SECRET_RULES } from './constants'

/** A text with its secrets masked, and what was masked: each kind with how many times. */
export type Masked = {
  text: string
  /** Kind of secret, then how many values of it were masked; empty when the text had none. */
  found: Map<string, number>
}

/**
 * Masks every secret in a text.
 *
 * Why it exists: a tool's result is read by the model and written to the transcript, and a value
 * that reaches either cannot be taken back. Called by the hooks in {@link register} for every text
 * a tool returns and every row the conversation keeps.
 *
 * @param text - What a tool printed, a file's content, a message.
 * @returns The text with each secret replaced by `•••` behind what names it (`sk-ant-•••`,
 *   `?token=•••`), and the kinds that were found. The same text when it holds none.
 *
 * @example
 * maskSecrets('GET /verify?expires=1&signature=0f3a9c…').text // 'GET /verify?expires=1&signature=•••'
 */
export function maskSecrets(text: string): Masked {
  const found = new Map<string, number>()
  // Megabytes of text are a file's bytes: nothing reads them, and scanning them holds the session up
  if (text.length > MAX_SCANNED_CHARS) return { text, found }
  let shown = text
  for (const rule of SECRET_RULES) {
    let hits = 0
    shown = shown.replace(rule.pattern, (...match: unknown[]) => {
      hits += 1
      // `$1`, `$2` stand for the pattern's groups: the prefix or the name that stays readable
      return rule.replacement.replace(/\$(\d)/g, (_, group: string) => String(match[Number(group)] ?? ''))
    })
    if (hits > 0) found.set(rule.kind, (found.get(rule.kind) ?? 0) + hits)
  }
  return { text: shown, found }
}

/**
 * Names the kind of secret a shell command spells out, if it does.
 *
 * Why it exists: a command is shown on screen and stays in the transcript, so a secret belongs in
 * something the command reads (an environment variable, a file, a password manager), never in its
 * text. Only shapes that are certainly a secret count: a reference such as `$TOKEN` or
 * `"$(op read …)"` and a name-based guess such as `PGPASSWORD=app123` let the command run. Called by
 * the `tool.call` hook in {@link register} before a shell command runs.
 *
 * @param command - The command as the model wrote it.
 * @returns The kind of the first secret found ("API key", "bearer token"), or undefined.
 *
 * @example
 * findLiteralSecret('curl -H "Authorization: Bearer $TOKEN" https://api.test/me') // undefined
 */
export function findLiteralSecret(command: string): string | undefined {
  // `search` ignores where a global pattern stopped last time
  return SECRET_RULES.find(rule => rule.isBlocking && command.search(rule.pattern) !== -1)?.kind
}

/**
 * Says what was masked, for a notice: "1 API key", "2 API keys and 1 bearer token".
 *
 * @param found - The kinds from {@link maskSecrets}.
 * @returns The kinds with their counts, in the order they were found; never a value.
 */
export function describeFound(found: ReadonlyMap<string, number>): string {
  const parts = [...found].map(([kind, count]) => `${count} ${count === 1 ? kind : pluralize(kind)}`)
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** The plural of a kind: the noun that leads it takes the `s` ("tokens in a link", "API keys"). */
function pluralize(kind: string): string {
  const [head = kind, ...rest] = kind.split(/ (?=in an? )/)
  return [`${head}s`, ...rest].join(' ')
}

/** How many values a text had masked. */
export function countFound(found: ReadonlyMap<string, number>): number {
  return [...found.values()].reduce((sum, count) => sum + count, 0)
}

/** Adds the counts of one result to a running total. */
export function mergeFound(into: Map<string, number>, found: ReadonlyMap<string, number>): void {
  for (const [kind, count] of found) into.set(kind, (into.get(kind) ?? 0) + count)
}
