# thinking-log

A Claude Code mod that shows Claude's thinking in the normal transcript view, as dim lines right above the answer or tool call it led to. Out of the box Claude Code shows thinking only in the `ctrl+o` transcript view.

```
✻ Comparing the two values first.
  Nine point nine is larger than nine point one one.
⏺ 9.9 is larger.
```

## Install

At the prompt of a Claude Code terminal session:

```text
/plugin install thinking-log --marketplace laststance/claude-plugins
```

From a shell:

```sh
claude plugin install thinking-log --marketplace laststance/claude-plugins
```

## Requirements

- `"showThinkingSummaries": true` in `~/.claude/settings.json`. Without it the API sends no thinking text, and nothing is printed.
- Claude Code 2.1.287 or later.

## How it works

- A `turn.step` hook reads each main-loop model request as it streams and collects the `thinking` chunks of a block.
- When the model moves on (text, a tool call, the stop) or the stream ends, the block is printed with `$.ui.log`: one dim row per non-empty line, the first marked `✻`, a line over 2,000 characters sliced so the terminal does not cut it.
- Subagents' thinking is left out, so the transcript keeps to the main conversation.
- Every chunk passes through unchanged, and the model never sees the logged lines.

## Development

```sh
claude --plugin-dir ./plugins/thinking-log
claude plugin validate ./plugins/thinking-log
claude plugin test ./plugins/thinking-log
```

## License

[MIT](../../LICENSE)
