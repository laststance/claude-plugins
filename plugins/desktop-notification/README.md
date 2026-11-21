# desktop-notification

A Claude Code plugin that sends a macOS desktop notification whenever Claude Code needs you: waiting for your input, or asking permission to use a tool. Clicking the notification brings your terminal to the front. macOS only.

## Install

At the prompt of a Claude Code terminal session:

```text
/plugin install desktop-notification --marketplace laststance/claude-plugins
```

From a shell:

```sh
claude plugin install desktop-notification --marketplace laststance/claude-plugins
```

If your `settings.json` already has a `Notification` hook that does the same, remove it, or you get two notifications.

## Requirements

- `jq` (`brew install jq`)
- [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) (`brew install terminal-notifier`), recommended: without it the notification comes from `osascript`, and a click opens Script Editor instead of your terminal.

## Which app a click brings forward

In order, the first that is set wins:

1. `CLAUDE_NOTIFICATION_ACTIVATE_BUNDLE`: a bundle id you set, such as `com.mitchellh.ghostty`.
2. The app macOS launched your shell from (`__CFBundleIdentifier`). This is right inside tmux, herdr and other multiplexers too.
3. A guess from `TERM_PROGRAM` (Terminal, iTerm2, WezTerm, Warp, Hyper, Ghostty, kitty, VS Code, Zed).
4. `CLAUDE_NOTIFICATION_FALLBACK_BUNDLE`, else Terminal.

## Settings

Set these in your shell, or in the `env` block of `~/.claude/settings.json`:

| Variable | Default | Effect |
| --- | --- | --- |
| `CLAUDE_NOTIFICATION_SOUND` | `Ping` | The sound name (any in `/System/Library/Sounds`) |
| `CLAUDE_NOTIFICATION_ACTIVATE_BUNDLE` | | The app a click brings forward, by bundle id |
| `CLAUDE_NOTIFICATION_TERMINAL_APP` | `$TERM_PROGRAM` | Overrides the terminal name used for the guess |
| `CLAUDE_NOTIFICATION_FALLBACK_BUNDLE` | `com.apple.Terminal` | The app for a terminal it does not know |

Each notification is logged to `desktop-notification.log` in the plugin's data folder (`$CLAUDE_PLUGIN_DATA`).

## License

[MIT](../../LICENSE)
