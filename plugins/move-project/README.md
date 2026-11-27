# Move Project

Found a library bug while working on its consumer? Run `/move-project ../library-b` in Claude Code. A fresh session opens in the library in the same terminal, with the conversation, tool calls, and tool results from the consumer. The library supplies the new session's project instructions, hooks, permissions, and environment.

Requires the Claude Code terminal CLI (tested with 2.1.332), Python 3.9 or later, and a terminal on macOS or Linux. The bundled shell integration uses zsh.

## Install

In Claude Code, install the plugin at **User scope** so it loads in both projects.

```text
/plugin install move-project --marketplace laststance/claude-plugins
```

To enable the launcher for your usual `claude` command, add the following to `~/.zshrc`. It resolves the installed plugin's directory, including after an update.

```zsh
move_project_root=$(command claude plugin list --json | python3 -Ic '
import json, sys
print(next((p["installPath"] for p in json.load(sys.stdin)
            if p["id"] == "move-project@laststance" and p["scope"] == "user" and p["enabled"]), ""))')
if [[ -n "$move_project_root" && -r "$move_project_root/shell/claude.zsh" ]]; then
  source "$move_project_root/shell/claude.zsh"
fi
unset move_project_root
```

Open a new terminal or run `source ~/.zshrc`, then start `claude` in the consumer. The launcher needs to own the terminal from the start. If you invoke the command in an already-running plain Claude session, the plugin prints the exact one-time `source` command for your installation and leaves that session open.

## Move

```text
/move-project ../library-b
```

An absolute path also works. For a name containing spaces, type `/move-project ../Library B`. The destination is resolved against Claude's current working directory. A missing directory or unreadable conversation leaves the original session open.

Once the archive is ready, the plugin exits the source session. The launcher starts Claude in the destination using the parent shell environment. Options you passed on the original command line, such as `--settings`, apply only to the source session. If you set `CLAUDE_CONFIG_DIR` and want the same user configuration across projects, use an absolute path. Claude resolves a relative value from each project's directory. The launcher stores every handoff under the configuration directory it resolved at startup. The normal trust dialog applies to an unfamiliar repository. The source session stays available through `claude --resume` in its original project.

### What the destination receives

At move time the plugin reads Claude Code's existing transcript. It follows the active conversation through rewinds and compaction to recover the original user and assistant messages and the recorded tool calls, arguments, results, and errors. It omits abandoned branches, compaction summaries, internal requests, and automatically injected project instructions. A quotation in a message or tool result remains part of that message. A tool that originally recorded a preview or a file reference carries that recorded result.

The destination receives the past conversation as labeled history in its opening prompt. This starts a normal model turn with the destination's tool permissions. The prompt asks Claude to wait for your next task. The plugin retains a complete UTF-8 JSONL archive, with one role and content record per line, under `${CLAUDE_CONFIG_DIR:-~/.claude}/move-project/handoffs/`. The terminal prints its exact path. The private archive directory has mode `0700` and the file has mode `0600`. Archives remain available to resumed sessions until you delete them. If you move again after a file-only handoff, the next archive contains the earlier file's path. Keep that earlier archive to access its full history.

The launcher passes a short prompt with the archive path. After the destination project has loaded, its plugin includes the full text in the first model request when it fits. It budgets one token per UTF-8 byte plus 1,024 tokens for the handoff and can read up to 4 MiB inline. For larger archives, or when the destination plugin is disabled or cannot measure free context, Claude receives the archive path for search and range reads. Ordinary file permissions in the destination apply. The handoff itself makes no model call for summarization.

### Bypass or disable

Use `command claude` to bypass the launcher for one session. To disable the integration, remove the setup block from `~/.zshrc` and open a new terminal. To re-enable it, restore the block and start a new terminal. Non-interactive and management commands such as `claude -p` and `claude plugin list` continue to use the underlying executable.

## Verify a checkout

From the repository root, run the mod tests, archive and launcher tests, and the end-to-end terminal tests.

```sh
claude plugin validate ./plugins/move-project
claude plugin test ./plugins/move-project
python3 -B -m unittest discover -s plugins/move-project/tests -p 'test_*.py'
python3 -B plugins/move-project/tests/tui_smoke.py
```

The terminal tests start the installed Claude Code CLI against a loopback mock API with temporary Git repositories and a disposable configuration directory.
