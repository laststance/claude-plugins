# A grouped row draws its own output

Claude Code folds a run of read-like calls (reads, searches, `ls`, `cat`, `grep`) into one count line, a `ToolGroup`. The mod unfolds any group holding a Bash call so each command is drawn highlighted. A group's rows draw their result inline, inside the `ToolUse` row, and Claude Code raises no `ToolResult` for them; the mod's `ToolUse` hook drew only the command, so from 0.1.0 to 0.1.2 a grouped Bash call showed no output at all, with the mod on, in every view.

From 0.1.3 the `ToolUse` hook draws a grouped row as its command with its Output block under it, in the layout the `ToolResult` hook draws for a standalone row.

## What tells a grouped row from a standalone one

Nothing in the row's own event. Read from Claude Code 2.1.332 with a probe mod that logged every `ToolGroup`, `ToolUse` and `ToolResult` render event: in an expanded view (ctrl+o, verbose, a group a hook unfolded) a grouped row and a standalone row carry the same `ToolUse` props (`isExpanded: true`, `output` set). Only the `calls` of a `ToolGroup` event name a group's rows, so the `ToolGroup` hook records each Bash call it is asked to draw, and the `ToolUse` hook draws the output only for a recorded call. A `ToolResult` raised for a recorded call means the call is drawn standalone after all, and removes the record.

## Considered Options

- **Hand every grouped row to Claude Code** (`next(e)`). The output shows, but the command is no longer highlighted, which is why the mod unfolds groups in the first place, and Claude Code draws an unfolded row's output in full, never folded.
- **Draw the output in the `ToolGroup` hook.** A group also holds calls this mod does not draw (Read, Grep), and `next(e)` answers one opaque node for the whole group, so single rows cannot be taken from it.
- **Draw the output in the `ToolUse` hook, for calls a `ToolGroup` event named** (chosen).

## Consequences

- **Main screen only.** In fullscreen (`tui: fullscreen`) the ctrl+o transcript draws no group: the same calls are standalone rows there, each with its `ToolResult`, while the main view groups them, and no event says which view is drawing. A row that drew its output would show it twice in the transcript. So in fullscreen, and on surfaces other than the terminal, a grouped row is drawn as before, command only; ctrl+o shows the outputs. See TODOS.md.
- **The fold follows the group.** A group Claude Code drew collapsed (the mod unfolded it) folds each row as a collapsed standalone row folds: the command to `collapsedLines`, the output to three rows, with the same hints. A group Claude Code expanded (ctrl+o, verbose) draws both in full. Claude Code reuses a row's last drawing when its props are unchanged, and a grouped row's props do not change with ctrl+o, so the `ToolGroup` hook asks for a redraw when a recorded call's group folds or unfolds. Leaving ctrl+o, the rows are drawn once more in full before the group's event reaches the hook and they fold again (seen on 2.1.332).
- **Rows are sometimes drawn before their group is known.** Verbose mode draws a resumed group's rows first and the group after. Such a row is first drawn with its command only, and drawn again with its output when the group names it. Live calls are named by their group while they still run.
- **Redraws are bounded.** Requests are gathered for 50 ms into one, and one call asks at most 20 times in a burst, so two views that undid each other's record could not redraw without end. A burst ends once two seconds pass with no request: ctrl+o pressed by a person, seconds apart, is never refused. Within a burst past the bound, a row may keep a stale fold until another redraw reaches it.
- **Rows the mod cannot draw whole are Claude Code's.** Sibling rows (the cwd notice, an edit diff, images) can only be drawn by Claude Code, and for a grouped row only together with the command. So a grouped call with sibling rows, with no stdout ("(No output)", an exit code's explanation), that failed or was interrupted, that holds a character a drawn Text refuses, or whose row passes the bounds of one tree is handed to Claude Code whole: nothing of the result is lost, and its command is not highlighted.
- **Hidden as under a standalone block:** the persisted-output note (verbose only) and the timeout row are not drawn under a grouped row the mod draws (`docs/adr/0002`).
- **A part without colours is drawn plain, not handed back.** While the command's or the output's colours are not back (or failed), the row is still the mod's, with the rows it will have once coloured: handing it to Claude Code would draw the output in full and change the row's height when the colours arrive. A row first drawn that way and too tall for the main screen to redraw keeps its plain styling in that fold state; its text is always read from the record being drawn, so a record another mod rewrote is never shown from an earlier drawing.
- **The order of events is Claude Code's.** A release that stops naming a call in `ToolGroup.calls`, or raises a `ToolResult` for grouped rows, changes this; a row no group names is drawn as before 0.1.3, command only.
