# secret-guard

A Claude Code mod that keeps secrets out of the conversation. It refuses a shell command that has a key or token written into it, and it masks keys, tokens and passwords in what tools return, before Claude reads them and before they are written to the transcript.

```
⏺ Bash(env | grep -i key)
  ⎿  OPENAI_API_KEY=sk-proj-•••
     AWS_ACCESS_KEY_ID=AKIA•••

⏺ secret-guard: masked 1 API key and 1 AWS access key id in the output of Bash
```

## Why

A secret that reaches the conversation cannot be taken back: it is in the model's context, on the screen and in the transcript file. It usually gets there by accident, in the output of an ordinary command: `env`, `cat .env`, `curl -v`, a process list that shows a server's start-up arguments. Hooks that check a command before it runs never see that output.

## What it does

**Before a shell command runs.** A `Bash` or `PowerShell` command that spells out a secret is refused, and Claude is told to read the value inside the command instead:

```
⏺ Bash(curl -H "Authorization: Bearer 9f3a…" https://api.example.com/me)
  ⎿  secret-guard: this command spells out a bearer token. A command is shown on screen and stays in
     the transcript, so read the value inside the command instead (an environment variable, a private
     file, a password manager such as "$(op read 'op://vault/item/field')") and run it again.
```

A reference is not a secret, so these run: `$TOKEN`, `${API_KEY}`, `"$(op read …)"`. So do a search for the shape of a key (`grep 'sk-[A-Za-z0-9]{20,}'`) and a throwaway local password (`PGPASSWORD=app123 psql …`).

**After a tool ran.** Secrets in the result are replaced with `•••`, with the prefix or the name that tells what the value was left in front (`sk-ant-•••`, `?signature=•••`, `SESSION_SECRET=•••`):

- in a shell's output and in a file read as text, in the tool's own record: what the screen draws, what the transcript stores and what Claude reads;
- in every other row the conversation keeps (any tool's result, MCP tools included, an attachment, a hook's context, a compaction's summary), as Claude reads it and as the transcript stores it.

Claude is told that values were masked and that `•••` must not be written back as a value. You get one dim line in the transcript naming the kind and the count, never the value.

What you type in your own prompt is left as it is: a key you write there is one you mean Claude to have.

## What it recognizes

| Kind | Examples of the shape | Refuses a command |
| --- | --- | --- |
| API key by its prefix | OpenAI and Anthropic `sk-…`, GitHub `ghp_…` `github_pat_…`, GitLab `glpat-…`, Slack `xoxb-…`, Stripe `sk_live_…` `whsec_…`, Google `AIza…` `ya29.…`, npm, Hugging Face, Groq, Replicate, Linear, Notion, Supabase, Sentry, Figma, PostHog, Shopify, SendGrid, Resend, Tavily, xAI, Perplexity, DigitalOcean, 1Password service accounts | yes |
| Private key | `-----BEGIN … PRIVATE KEY-----` to its end | yes |
| Bearer token, basic credentials | `Authorization: Bearer …`, `Authorization: Basic …` | yes |
| JSON Web Token | `eyJ….eyJ….…` | yes |
| Token in a link | `?signature=…`, `&access_token=…`, and a service's own name such as `?exampleApiKey=…` | yes |
| Webhook address | Slack and Discord incoming webhooks | yes |
| AWS access key id | `AKIA…`, `ASIA…` | no |
| Password in a connection string | `postgres://user:password@host` | no |
| Secret in an environment variable | `NAME=value` where the name ends in `TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, … | no |
| Secret in a JSON value | `"apiKey": "value"`, `"client_secret": "value"` | no |

The last three go by a name, so they also ask that the value look made by a machine (twelve characters or more, with a letter and a digit; eight for a connection string). `POSTGRES_PASSWORD=postgres` stays readable.

## Install

At the prompt of a Claude Code terminal session:

```text
/plugin install secret-guard --marketplace laststance/claude-plugins
```

Answer `y` to add the marketplace, then pick a scope (user scope covers every project).

From a shell:

```sh
claude plugin install secret-guard --marketplace laststance/claude-plugins
```

## Requirements

- Claude Code 2.1.330 or later.

Nothing else: the mod runs inside Claude Code, on every platform it runs on.

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `blockCommands` | `true` | Refuse a shell command that spells out a secret. |
| `maskOutput` | `true` | Mask secrets in what tools return. |
| `notify` | `true` | Print a line in the transcript when something was masked. |

Change them in `/config`, or in settings:

```json
{ "pluginConfigs": { "secret-guard": { "options": { "blockCommands": false } } } }
```

## Limits

This is a guardrail against accidents, not a security boundary.

- It goes by shape. A secret with no prefix, under no telling name, is not recognized: a bare 32-character token printed on a line of its own passes.
- A tool's own record (what the screen draws in full, what the transcript stores beside the row) is masked for shell output and for files read as text. For other tools, MCP tools included, the row Claude reads and the transcript keeps is masked, but the tool's record is stored as the tool made it.
- An error's text is masked by answering in the tool's place, so a failed command that printed a secret shows as refused by `secret-guard`, with the masked error.
- Images and files read as anything but text are not looked at.
- Claude sees `•••` where a value was. To use a secret it has to refer to it (an environment variable, a file), which is the point; turn `maskOutput` off for a session where Claude has to see the values.
- A file that holds key-shaped text on purpose (the fixtures of a scanner's tests) is read masked too, and a shell command that carries such text is refused. The file on disk is never changed, but Claude can then edit those lines only by text it cannot see. Build such fixtures from pieces at run time, as [`tests/mask.test.ts`](tests/mask.test.ts) does, or turn the option off while working on them.
- Rows already in a conversation when the mod is installed are not changed.

## How it works

- A `tool.call` hook checks a shell command against the shapes that are certainly a secret and answers `{ deny }` before the command runs. After any tool ran, it masks the texts of a shell's or a read file's record and answers with that record, which the engine then stores and hands to Claude; a failed call's error text is masked the same way.
- A `session.append` hook masks the text of every row before it is stored, except the rows that hold what you typed.
- A hook that fails is passed by, as Claude Code does for any hook: a guard that breaks does not stop your commands. Run `claude --debug` to see whether one was.

## Development

```sh
claude --plugin-dir ./plugins/secret-guard
claude plugin validate ./plugins/secret-guard
claude plugin test ./plugins/secret-guard
```

The shapes are in [`hooks/constants.ts`](hooks/constants.ts), one rule each, with a test for what it masks and what it leaves alone in [`tests/mask.test.ts`](tests/mask.test.ts).

## License

[MIT](../../LICENSE)
