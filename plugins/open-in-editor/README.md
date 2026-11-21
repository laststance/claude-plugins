# open-in-editor

A Claude Code mod that opens the session's project root in the editor you name, with one slash command per editor. macOS only.

| Command | Opens the project in |
| --- | --- |
| `/vscode` | Visual Studio Code |
| `/cursor` | Cursor |
| `/devin-desktop` | Devin Desktop (`Devin.app`) |
| `/webstorm` | WebStorm |
| `/phpstorm` | PhpStorm |
| `/zed` | Zed |

## Install

At the prompt of a Claude Code terminal session:

```text
/plugin install open-in-editor --marketplace laststance/claude-plugins
```

From a shell:

```sh
claude plugin install open-in-editor --marketplace laststance/claude-plugins
```

Requires Claude Code 2.1.287 or later (tested with 2.1.330).

## How it works

- Each command runs `open -a "<App>" <project root>`, so the editor's own CLI (`code`, `cursor`, `zed`, ...) does **not** need to be on your `PATH`. The app is found wherever macOS finds it, `/Applications` and `~/Applications` (JetBrains Toolbox) included.
- The project root is the folder the session started in, or where `/cd` or a worktree move took it.
- The commands run at once even while Claude is in the middle of a turn.
- The output line (`Opened /path in Zed`) is for you only and is never sent to the model.
- When the app is not installed or fails to launch, a toast shows the reason, such as `Unable to find application named 'PhpStorm'`.

## Development

```sh
claude --plugin-dir ./plugins/open-in-editor   # load from source
claude plugin validate ./plugins/open-in-editor
claude plugin test ./plugins/open-in-editor
```

To add an editor, add an entry to `EDITORS` in [`hooks/constants.ts`](hooks/constants.ts): the command name, the label, and the macOS app name as `open -a` expects it.

## License

[MIT](../../LICENSE)
