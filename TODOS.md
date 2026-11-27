# TODOS

## syntax-highlight

### Re-check sibling rows on Claude Code upgrades

**What:** After each Claude Code upgrade, compare the fields its Bash result renderer reads (in the bundle) and the `toolUseResult` keys seen in recent transcripts with the mod's sibling-row list (`colourableResult` in `plugins/syntax-highlight/hooks/register.tsx`); add a field Claude Code now draws as a row.

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

### Colour a grouped Bash call's output

**What:** When the `ToolGroup` hook unfolds a group holding a Bash call, draw each row's inline output (`e.props.output` on the `ToolUse` row) and its sibling rows, not only the command.

**Why:** An expanded group draws each call's result inline in its `ToolUse` row, and the mod's command-only `ToolUse` tree leaves it out, so grouped Bash calls show no output. 0.1.0 had the same gap (both hooks are unchanged since); found in the 0.1.1 review.

**Context:** `plugins/syntax-highlight/hooks/register.tsx`, the `ToolGroup` and `ToolUse` hooks. The Mod API: "An expanded group's rows draw it inline; a standalone row's is its own ToolResult" (`ToolUse` `output`).

**Effort:** M
**Priority:** P2
**Depends on:** syntax-highlight 0.1.1

### Retry a colouring worker that failed once

**What:** Let a worker that failed or timed out be tried again once before its block is drawn uncoloured for the rest of the session.

**Why:** A failure is cached for the session, so a worker killed once (a busy machine, the 8 s limit) leaves its block uncoloured until Claude Code restarts. Caching stops a worker that fails every time (no `node`) from being retried on every redraw, so a retry needs a bound.

**Context:** `highlight` in `plugins/syntax-highlight/hooks/register.tsx` caches `'failed'`. 0.1.1 runs at most four workers at once, so bursts no longer time them out.

**Effort:** S
**Priority:** P3
**Depends on:** syntax-highlight 0.1.1

### Hand back expanded blocks past 100,000 characters

**What:** Before drawing an expanded Output block, total the characters of its drawn text and hand the block to Claude Code past about 95,000, as is done past the node bound.

**Why:** The engine draws only the first 100,000 characters of text in one tree and cuts the rest with no marker. Claude Code's Bash output is 30,000 characters by default, so this needs `BASH_MAX_OUTPUT_LENGTH` raised past 100,000 and an expanded view. Found by the 0.1.1 review (below the floor in its second pass, so not fixed there).

**Context:** `plugins/syntax-highlight/hooks/register.tsx`, the `ToolResult` hook beside `drawnNodes` and `MAX_DRAWN_NODES`; `MAX_OUTPUT_CHARS` (200,000) could come down to match.

**Effort:** S
**Priority:** P3
**Depends on:** syntax-highlight 0.1.1
