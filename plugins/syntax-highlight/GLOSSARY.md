# syntax-highlight

Colours what a Claude Code session shows for a shell call: the command Claude runs and the text it prints back.

## Screen

**Command row**:
The `Bash(...)` line of a session transcript, showing the command Claude ran.
_Avoid_: tool row, command line, ToolUse

**Output block**:
The text shown under a Command row (after `⎿`): what the command printed.
_Avoid_: tool result, output, ToolResult

## What gets coloured

**Language**:
A file or data language that has a grammar of its own, such as Markdown, JSON, YAML or diff. When an Output block holds one, the whole block is that Language.
_Avoid_: format, file type, syntax

**Output shape**:
The fixed layout one command prints a line in, such as an `ls -l` entry, a `grep -n` hit (`path:line:`) or a `plutil -p` pair (`"key" => "value"`). It is recognised line by line, so one Output block can hold several.
_Avoid_: format, output format, pattern

**Strong form**:
The rows of an Output shape that nothing but its command prints, such as an `ls -l` mode string or a `path:12:` hit. Inside a Language block only a strong form takes the shape; the looser rows (a line ending in `:`, a bare `12:`) stay in the Language.
_Avoid_: strict pattern, exact match
