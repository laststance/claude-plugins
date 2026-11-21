/**
 * The engine keybinding action this mod borrows as its global toggle.
 *
 * Mods cannot declare keybinding actions of their own: a Button's `action`
 * must name one of the engine's. `app:toggleDiffPreSession` is a Global
 * action with no default key, and its engine handler is mounted only while
 * the legacy diff view lists pre-session changes, so binding a key to it in
 * `~/.claude/keybindings.json` (`"ctrl+space"`, and `"ctrl+`"` for terminals
 * that send ctrl+space as a NUL byte) collides with nothing else.
 */
export const TOGGLE_ACTION = 'app:toggleDiffPreSession'

/**
 * How long to let Claude Code paint the emptied render sites before the
 * terminal is cleared, in milliseconds; a clear sent sooner is painted over.
 */
export const PAINT_SETTLE_MS = 250

/**
 * How often the screen is erased again while blacked out, in milliseconds.
 * Claude Code repaints the cells that change (typed text, the status line's
 * figures); this bounds how long such a fragment can stay on screen.
 */
export const RECLEAR_INTERVAL_MS = 400

/**
 * A `printf` format that erases the visible screen and hides the cursor,
 * leaving the cursor where Claude Code put it and the scrollback untouched.
 */
export const CLEAR_SCREEN_FORMAT = '\\033[2J\\033[?25l'

/**
 * A `printf` format that moves the cursor home and erases the screen, sent
 * just before the repaint signal. The classic renderer repaints from where the
 * cursor stands, so starting home keeps the restored screen from drifting down.
 */
export const RESTORE_FORMAT = '\\033[H\\033[2J'
