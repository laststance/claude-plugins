# always-expand

A Claude Code mod that adds `/expand`: a toggle that keeps every collapsed row drawn in full, the way `ctrl+o` shows it. No more `… +27 lines (ctrl+o to expand)` or `Thought for 3s (ctrl+o to expand)`.

```text
⏺ Bash(seq 1 30)            ⏺ Bash(seq 1 30)
  ⎿  1                        ⎿  1
     2           /expand         2
     3          ───────▶         3
     … +27 lines                 …
                                 30
```

## Install

At the prompt of a Claude Code terminal session:

```text
/plugin install always-expand --marketplace laststance/claude-plugins
```

From a shell:

```sh
claude plugin install always-expand --marketplace laststance/claude-plugins
```

Requires Claude Code 2.1.287 or later (tested with 2.1.330).

## Usage

- `/expand` turns always-expanded rows on; `/expand` again folds them back.
- It runs at once, even while Claude is in the middle of a turn, and rows already on screen are redrawn.
- `ctrl+o` keeps working as before.

## How it works

`/expand` flips Claude Code's own **Verbose output** setting (the `verbose` row of `/config`), which draws tool output and thinking in full. Because the setting is Claude Code's, the choice lasts across sessions until you run `/expand` again, and changing it in `/config` does the same thing. Verbose output can show a little more detail than tool output and thinking alone.

When an organization's managed settings fix Verbose output, `/expand` says it could not change it, with the reason.

## Development

```sh
claude --plugin-dir ./plugins/always-expand
claude plugin validate ./plugins/always-expand
claude plugin test ./plugins/always-expand
```

## License

[MIT](../../LICENSE)
