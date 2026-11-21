# blackout

Press `ctrl+space` and Claude Code's screen goes blank: every character disappears and only your terminal's own background (its colour, image or blur) shows. Press it again and everything comes back exactly as it was. Claude keeps working the whole time.

## How it works

Most of Claude Code's interface can be emptied from a mod, but the prompt box, the logo and the status line cannot. So when the blackout turns on, blackout:

1. empties every render site it can (transcript, spinner, hint line, footer, other mods' rows and panes);
2. erases the screen by writing `ESC[2J ESC[?25l` straight to the session's terminal (`/dev/tty`);
3. erases it again every 400 ms, because Claude Code repaints any cell that changes (what you type, the status line's figures).

When it turns off, blackout moves the cursor home, erases the screen, and sends Claude Code a `SIGCONT`. Claude Code's renderer answers that signal (the one `fg` sends) by repainting the whole screen. A running process is not affected by `SIGCONT` in any other way.

Works with both renderers (`/tui classic` and `/tui fullscreen`), and inside multiplexers such as herdr or tmux.

## Toggle

- `ctrl+space` (needs the keybinding below), or
- `/blackout`.

The state lasts for the session only; every new session starts visible.

## Keybinding setup

Mods cannot declare keybinding actions of their own, so blackout borrows the engine's `app:toggleDiffPreSession` action, which has no default key. Add this to `~/.claude/keybindings.json`:

```json
{
  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
  "$docs": "https://code.claude.com/docs/en/keybindings",
  "bindings": [
    {
      "context": "Global",
      "bindings": {
        "ctrl+space": "app:toggleDiffPreSession",
        "ctrl+`": "app:toggleDiffPreSession"
      }
    }
  ]
}
```

Terminals that speak the kitty keyboard protocol send `ctrl+space` as itself; the others send a NUL byte, which Claude Code reads as `` ctrl+` ``. Binding both covers either.

On macOS, `ctrl+space` is also the default shortcut for "Select the previous input source". If that shortcut is on, macOS takes the key before the terminal sees it: turn it off in System Settings → Keyboard → Keyboard Shortcuts → Input Sources, or pick another key.

## While the screen is blank

- Dialogs are hidden too: a permission prompt or a question from Claude waits unseen. Turn the blackout off when Claude seems to be waiting.
- Keys still reach Claude Code: what you type goes into the prompt, unseen, and may flash for up to 400 ms.
- Plugin `$.ui.log` lines raised during the blackout go to the debug log instead of the transcript.

Requires Claude Code 2.1.287 or later.
