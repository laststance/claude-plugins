# Colour the stdout, and let Claude Code draw its sibling rows

A Bash result carries more than its stdout: Claude Code draws, under it, the "Shell cwd was reset to …" notice (the only text left in `stderr`, since a command's own stderr is merged into stdout), the diff of files the command changed (`bashEditDiff`), and images it viewed. 0.1.0 handed any block with stderr back to Claude Code, so every command that `cd`s out of the project lost its colours (2,248 of 30,401 results with stdout in five days of transcripts), and it drew coloured blocks without their edit diff (793 in the same five days).

The `ToolResult` hook now draws the coloured stdout itself and, when the result has a sibling row, puts `await next(e)` in its tree with `output.stdout` emptied: Claude Code draws every sibling row its own way, below the coloured text.

## Considered Options

- **Leave any block with a sibling row to Claude Code** (0.1.0, extended to diffs and images). No colour for those blocks: about as many lose colour as the cwd notice fix would gain.
- **Draw the cwd notice ourselves**, copying Claude Code's regex and row, and leave the rest to Claude Code. The mod would carry Claude Code's rendering rules and drift from them.
- **Embed Claude Code's own drawing of the siblings** (chosen). The Mod API keeps what `next(e)` returns when a hook puts it in its tree.

## Consequences

- The layout is Claude Code's own: each sibling row behind its own `⎿`, as Claude Code draws it with no mod (seen on 2.1.330 and 2.1.332, collapsed and expanded). Only the colours differ, with one exception: collapsed, Claude Code adds a "(files that changed while this command ran, …)" line under the first edit diff it draws in a session, and it recognises that diff by object identity. The embedded row reaches Claude Code as a copy of the props, so under a coloured block the line is not drawn. Expanded, Claude Code always draws it, and so it appears there.
- A result whose only extra is a persisted-output note is not embedded: for an emptied stdout with nothing else, Claude Code draws "(No output)". The note (shown only in verbose mode) stays hidden, as in 0.1.0.
- The timeout row Claude Code reads from the call's progress messages comes only with an embed; on its own it stays hidden, as in 0.1.0.
- Which fields count as sibling rows follows Claude Code 2.1.332's Bash renderer. A field Claude Code starts drawing later is dropped under coloured blocks until the list is updated (see TODOS.md).
