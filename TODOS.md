# TODOS

## syntax-highlight

### Re-check sibling rows on Claude Code upgrades

**What:** After each Claude Code upgrade, compare the fields its Bash result renderer reads (in the bundle) and the `toolUseResult` keys seen in recent transcripts with the mod's sibling-row list (`colourableResult` in `plugins/syntax-highlight/hooks/register.tsx`); add a field Claude Code now draws as a row. Check too that a group's rows still draw their result inline with no `ToolResult`, and that `ToolGroup.calls` still names them (`docs/adr/0003`).

**Why:** A field Claude Code starts drawing (as `bashEditDiff` did) is silently dropped under coloured blocks until the list is updated; no test or error can catch it.

**Context:** syntax-highlight 0.1.1 embeds Claude Code's own drawing of the sibling rows (`docs/adr/0002`). Count the keys of `toolUseResult` records that have `stdout` across the last few days of `~/.claude/projects/**/*.jsonl`. Fields Claude Code does not draw (`staleReadFileStateHint`, `gitOperation`, `timedOutAfterMs`, …) must stay out of the list: embedding for them alone makes Claude Code draw "(No output)".

**Effort:** S
**Priority:** P2
**Depends on:** syntax-highlight 0.1.1

### Colour resumed Output blocks before their first draw

**What:** When a session is resumed, colour the visible Bash results before Claude Code first draws them, so a tall expanded block can be coloured too.

**Why:** Claude Code's main screen cannot rewrite rows it has already drawn. A resumed block taller than the terminal kept rows of its plain first draw above the coloured redraw (seen on 2.1.332, 2026-11-28), so 0.1.1 keeps such an expanded block as Claude Code drew it (`isTooTallToRedraw`): it stays uncoloured. Live calls rarely reach this because the `tool.call` hook waits up to 1.5 s for the colours. Collapsed blocks are short and are coloured.

**Context:** `plugins/syntax-highlight/hooks/register.tsx`: on a cold cache the `ToolResult` hook returns `next(e)` and colours in the background (`OUTPUT_WAIT_MS` applies to live calls only). A fix needs a Mod API event that runs before a resumed transcript is drawn, or a way to read the transcript at `session.start` and warm the cache.

**Effort:** M
**Priority:** P3
**Depends on:** syntax-highlight 0.1.1

### Colour grouped output in fullscreen sessions

**What:** In fullscreen (`tui: fullscreen`), draw a grouped Bash row's output in the main view without doubling it in the ctrl+o transcript.

**Why:** 0.1.3 draws a grouped row's output on the main screen only. In fullscreen the main view groups the calls and the ctrl+o transcript draws the same calls standalone, each with its `ToolResult`, and nothing in a `ToolUse` event tells the two views apart (probed on 2.1.332), so a row that drew its output would show it twice in the transcript. Fullscreen users see the command only and need ctrl+o for the output.

**Context:** `isMainScreen` in `plugins/syntax-highlight/hooks/register.tsx`; `docs/adr/0003`. A fix needs a Mod API signal for the drawing view, or a `ToolResult` hook that draws nothing for a call its row already shows, with the fold state of each view known.

**Effort:** M
**Priority:** P3
**Depends on:** syntax-highlight 0.1.3

### Tell the user once when the colouring worker cannot run

**What:** Show one visible notice (a toast) when the worker fails for a reason that will not go away, such as `node` missing from the PATH.

**Why:** `highlight` writes a worker failure to the debug log only, so with no `node` every row stays uncoloured and nothing on screen says why. Found in the 0.1.3 DX review.

**Context:** `highlight` in `plugins/syntax-highlight/hooks/register.tsx` (`$.ui.log(..., { to: 'debug' })`). Tell a missing program from a single killed worker, so one timeout raises no notice.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Keep a changelog for the plugins

**What:** A `CHANGELOG.md` per plugin (or one for the marketplace) listing what each version changed for the person using it.

**Why:** A version bump in `plugin.json` is the only record of a release. 0.1.3 changed what grouped rows show, and nothing tells an updating user. Found in the 0.1.3 DX review.

**Context:** Versions so far live in PR titles (#2, #4, #5). `/gstack-ship` reports NO_VERSION for this repository because it has no VERSION or CHANGELOG file.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Retry a colouring worker that failed once

**What:** Let a worker that failed or timed out be tried again once before its block is drawn uncoloured for the rest of the session.

**Why:** A failure is cached for the session, so a worker killed once (a busy machine, the 8 s limit) leaves its block uncoloured until Claude Code restarts. Caching stops a worker that fails every time (no `node`) from being retried on every redraw, so a retry needs a bound.

**Context:** `highlight` in `plugins/syntax-highlight/hooks/register.tsx` caches `'failed'`. 0.1.1 runs at most four workers at once, so bursts no longer time them out.

**Effort:** S
**Priority:** P3
**Depends on:** syntax-highlight 0.1.1

## Completed

### Hand back expanded blocks past 100,000 characters

**What:** Before drawing an expanded Output block, total the characters of its drawn text and hand the block to Claude Code past about 95,000, as is done past the node bound.

**Why:** The engine draws only the first 100,000 characters of text in one tree and cuts the rest with no marker. Claude Code's Bash output is 30,000 characters by default, so this needs `BASH_MAX_OUTPUT_LENGTH` raised past 100,000 and an expanded view. Found by the 0.1.1 review (below the floor in its second pass, so not fixed there).

**Context:** `plugins/syntax-highlight/hooks/register.tsx`, the `ToolResult` hook beside `drawnNodes` and `MAX_DRAWN_NODES`; `MAX_OUTPUT_CHARS` (200,000) could come down to match.

**Effort:** S
**Priority:** P3
**Depends on:** syntax-highlight 0.1.1

**Completed:** v0.1.2 (2026-11-28)

### Colour a grouped Bash call's output

**What:** When the `ToolGroup` hook unfolds a group holding a Bash call, draw each row's inline output (`e.props.output` on the `ToolUse` row) and its sibling rows, not only the command.

**Why:** An expanded group draws each call's result inline in its `ToolUse` row, and the mod's command-only `ToolUse` tree leaves it out, so grouped Bash calls show no output. 0.1.0 had the same gap (both hooks are unchanged since); found in the 0.1.1 review.

**Context:** `plugins/syntax-highlight/hooks/register.tsx`, the `ToolGroup` and `ToolUse` hooks. The Mod API: "An expanded group's rows draw it inline; a standalone row's is its own ToolResult" (`ToolUse` `output`).

**Effort:** M
**Priority:** P2
**Depends on:** syntax-highlight 0.1.1

**Completed:** v0.1.3 (2026-11-28)
