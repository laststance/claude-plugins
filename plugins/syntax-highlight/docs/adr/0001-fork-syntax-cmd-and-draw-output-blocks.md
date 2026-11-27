# Fork syntax-cmd, and draw Output blocks ourselves

syntax-highlight is a full fork of [Lucasbk38/claude-syntax-cmd](https://github.com/Lucasbk38/claude-syntax-cmd) v0.2.3 (`a791d1d`), not a companion mod installed beside it. Both would redraw the same Bash rows (`ToolUse`, and the `ToolGroup` it unfolds), and two mods redrawing one row are settled by load order, so colouring Output blocks next to syntax-cmd would break or be broken by it. One mod owns the cache, the theme lookup and every Bash row.

## Considered Options

- **Recolour Claude Code's own Output block.** `ui.render`'s `next(e)` returns an opaque engine node (`{ type: 'engine' }`), so its text cannot be restyled.
- **Put ANSI colours in a rewritten `output.stdout`** and let Claude Code draw it. Claude Code refuses the rewrite: "props.output with a control character (an escape sequence the terminal would …)".
- **Return our own tree** (chosen). We draw the `⎿` indent and Claude Code's fold (3 rows, all 4 when one would be left, `… +N lines (ctrl+o to expand)`), as read from Claude Code 2.1.330. A Claude Code release that changes its fold will look different until this mod follows.

## Consequences

- Output blocks are coloured when expanded too (ctrl+o, `verbose`), against the mod convention of leaving expanded rows to Claude Code. With Verbose output on, that convention would leave every block uncoloured.
- A block with stderr, an error, an interrupt, an image or a background task is left to Claude Code, which draws those parts its own way. (Superseded for stderr, edit diffs and viewed images by [0002](0002-claude-code-draws-sibling-rows.md).)
