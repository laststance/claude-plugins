# Laststance Claude Code Plugins

Claude Code plugins and mods by [Laststance.io](https://github.com/laststance). This repository is a Claude Code plugin marketplace: each plugin lives in its own folder under [`plugins/`](plugins) and installs on its own.

## Plugins

| Plugin | What it does | Commands |
| --- | --- | --- |
| [desktop-notification](plugins/desktop-notification) | macOS notification when Claude Code needs you; a click brings your terminal forward | (hook) |
| [open-in-editor](plugins/open-in-editor) | Opens the session's project root in your editor of choice (macOS) | `/vscode` `/cursor` `/devin-desktop` `/webstorm` `/phpstorm` `/zed` |
| [serena-activate](plugins/serena-activate) | Briefs Claude on Serena in the system prompt and puts its tools in front, so it is used without being asked | (mod) |

## Install

At the prompt of a Claude Code terminal session:

```text
/plugin install open-in-editor --marketplace laststance/claude-plugins
```

Answer `y` to add the marketplace, then pick a scope (user scope makes it available in every project).

From a shell:

```sh
claude plugin install open-in-editor --marketplace laststance/claude-plugins
```

In the Claude desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `laststance/claude-plugins`, then **Add plugin**.

Replace `open-in-editor` with any plugin name from the table above. Mods need Claude Code **2.1.287** or later.

## Adding a plugin

1. Put the plugin in `plugins/<name>/`, with its manifest at `plugins/<name>/.claude-plugin/plugin.json`.
2. Add an entry to [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json): `{ "name": "<name>", "source": "./plugins/<name>", "description": "..." }`.
3. Run `claude plugin validate plugins/<name>` and, for a mod with tests, `claude plugin test plugins/<name>`.
4. Add a row to the table above.

## License

[MIT](LICENSE)
