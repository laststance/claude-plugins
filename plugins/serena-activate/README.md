# serena-activate

A Claude Code mod that makes [Serena](https://github.com/oraios/serena) ready in every session **without Claude having to do anything**.

## Why

Serena's own SessionStart hook (`serena-hooks activate`) only *asks* Claude to call `activate_project` and to read the instructions manual. Claude often skips that, and with the recommended Claude Code setup (`--context claude-code --project-from-cwd`) there is no `activate_project` tool at all: the server already activated the project when it started. Claude never learns that Serena is ready, and falls back to `Read` and `Grep`.

## What it does

- **Briefs Claude in the system prompt.** At session start it finds the project Serena activated (the nearest directory with `.serena/project.yml` or `.git`, the same rule as `--project-from-cwd`), reads Serena's instructions manual with `serena print-system-prompt`, and adds both as the system prompt's last section. Nothing depends on Claude calling a tool, and the section survives `/clear` and compaction.
- **Puts Serena's tools in front.** Serena's tools are moved out from behind ToolSearch, so Claude can call them without loading them first (turn this off with the `loadTools` option).
- **Shows it worked.** A toast reads `Serena ✓ <project>` once per session; if the manual cannot be read, the toast says why and Claude is told to call `initial_instructions` instead.

Outside a project, or in a session without a Serena MCP server, it adds nothing.

## Requirements

- Serena configured as an MCP server named `serena`, ideally as Serena's `serena setup claude-code` does:
  `serena start-mcp-server --context claude-code --project-from-cwd`.
  Without `--project-from-cwd`, the briefing tells Claude to call `activate_project` with the project root first.
- The `serena` CLI on your `PATH` or at `~/.local/bin/serena` (where `uv tool install serena-agent` puts it).
- Claude Code 2.1.287 or later (tested with 2.1.330).

## Install

At the prompt of a Claude Code terminal session:

```text
/plugin install serena-activate --marketplace laststance/claude-plugins
```

From a shell:

```sh
claude plugin install serena-activate --marketplace laststance/claude-plugins
```

If your `settings.json` runs `serena-hooks activate` at SessionStart, remove that hook: its request to call `activate_project` contradicts the briefing.

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `loadTools` | `true` | Keep Serena's tools in the prompt's tool list instead of behind ToolSearch. Turn off to save the tokens their schemas take; the briefing then tells Claude to load them with ToolSearch. |

Change it in `/config`, or in settings:

```json
{ "pluginConfigs": { "serena-activate": { "options": { "loadTools": false } } } }
```

## Cost

The manual is the same text Serena's `initial_instructions` tool returns (roughly 2,000 to 5,000 tokens, depending on the project's memories), added once per session after the prompt cache boundary.

## Development

```sh
claude --plugin-dir ./plugins/serena-activate
claude plugin validate ./plugins/serena-activate
claude plugin test ./plugins/serena-activate
```

## License

[MIT](../../LICENSE)
