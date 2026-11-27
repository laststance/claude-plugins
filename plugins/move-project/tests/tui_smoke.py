"""Run with python3 tests/tui_smoke.py on a POSIX host with Claude Code installed."""

import errno
import fcntl
import json
import os
import pty
import re
import select
import shlex
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
import unittest
from pathlib import Path

from fixtures.mock_claude import (
    A_REPLY, A_RULE, B_FOLLOW_REPLY, B_FOLLOW_UP, B_RULE, COMMAND, COMPACT_REPLY,
    FIRST_TURN, RAW_ERROR, MockMessages,
)

PLUGIN = Path(__file__).resolve().parents[1]
AFTER_COMPACT = "Capture the remaining reproduction steps."
ANSI = re.compile(rb"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[78=>])")


class Terminal:
    """Run foreground Claude in its own controlling PTY, including launcher restarts."""

    def __init__(self, argv, directory, env):
        master, slave = pty.openpty()
        self.master = master
        self.output = bytearray()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 160, 0, 0))
        # The fresh interpreter acquires a controlling terminal without forking Python hooks.
        try:
            self.proc = subprocess.Popen(
                [sys.executable, __file__, "--acquire-tty", *map(str, argv)],
                cwd=directory, env=env, stdin=slave, stdout=slave, stderr=slave,
                start_new_session=True,
            )
        finally:
            os.close(slave)

    def send(self, line):
        # A newline in the same input burst can be interpreted as pasted multiline text.
        os.write(self.master, line.encode())
        time.sleep(0.15)
        os.write(self.master, b"\r")

    def until(self, check, description, timeout=25):
        deadline = time.monotonic() + timeout
        while not check() and time.monotonic() < deadline:
            if self.proc.poll() is not None:
                break
            if select.select([self.master], [], [], 0.1)[0]:
                try:
                    data = os.read(self.master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    break
                self.output.extend(data)
                if not data:
                    break
        if not check():
            screen = ANSI.sub(b"", bytes(self.output)).decode(errors="replace")
            raise AssertionError(f"Expected {description}; process={self.proc.poll()}\n{screen[-3500:]}")

    def close(self):
        try:
            if self.proc.poll() is None:
                self.send("/exit")
                # Keep draining terminal output so shutdown can restore the terminal mode.
                deadline = time.monotonic() + 4
                while self.proc.poll() is None and time.monotonic() < deadline:
                    if select.select([self.master], [], [], 0.1)[0]:
                        try:
                            if not os.read(self.master, 65536):
                                break
                        except OSError as error:
                            if error.errno != errno.EIO:
                                raise
                            break
        finally:
            os.close(self.master)
        try:
            self.proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(self.proc.pid, signal.SIGKILL)
            self.proc.wait(timeout=5)


def write_json(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")


def project(directory, model_rule, mark, permission):
    """Create an independent, trusted Git project with unique settings for the probe."""
    directory.mkdir()
    subprocess.run(["git", "init", "-q", str(directory)], check=True)
    (directory / "CLAUDE.md").write_text(model_rule)
    # Execution creates a marker even when the reproduction intentionally fails.
    (directory / "repro.sh").write_text(
        "touch tool-ran\n" + "echo " + shlex.quote(RAW_ERROR) + " >&2\nexit 23\n"
    )
    local = directory / ".claude"
    local.mkdir()
    capture = local / "capture.py"
    capture.write_text(
        "import json, os, sys\nfrom pathlib import Path\n"
        "event = json.load(sys.stdin)\n"
        "result = {k: event.get(k) for k in ('cwd','source','session_id','transcript_path')}\n"
        "result.update(project=os.environ.get('CLAUDE_PROJECT_DIR'), "
        "a=os.environ.get('MOVE_SMOKE_A'), b=os.environ.get('MOVE_SMOKE_B'))\n"
        "path = Path(__file__).with_name('startup.json')\n"
        "temp = path.with_suffix('.tmp')\n"
        "temp.write_text(json.dumps(result))\n"
        "temp.replace(path)\n"
    )
    write_json(local / "settings.json", {
        "env": {"MOVE_SMOKE_" + mark: mark},
        "permissions": {permission: [f"Bash({COMMAND})"]},
        "hooks": {"SessionStart": [{"matcher": "startup", "hooks": [{
            "type": "command", "command": shlex.join([sys.executable, str(capture)]),
        }]}]},
    })


def rows(path):
    """Read already-flushed JSONL rows while Claude is appending to the file."""
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_bytes().splitlines(keepends=True)
            if line.endswith(b"\n") and line.strip()]


def has_text(path, marker):
    return any(marker in json.dumps(row.get("message", {}).get("content", row.get("content", "")), ensure_ascii=False)
               for row in rows(path) if row.get("type") in ("assistant", "user", "system"))


@unittest.skipUnless(shutil.which("claude"), "Claude Code CLI is required")
class MoveProjectTTY(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix="move-project-smoke-")
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name).resolve()
        self.a = self.root / "App A"
        self.b = self.root / "Library B"
        project(self.a, A_RULE, "A", "allow")
        project(self.b, B_RULE, "B", "deny")
        self.config = self.root / "config"
        # A user-scope install loads independently in B, without carrying any A flags.
        self.mod = self.config / "skills" / "move-project"
        shutil.copytree(PLUGIN, self.mod, ignore=shutil.ignore_patterns("types", "tests", "__pycache__"))
        write_json(self.config / ".claude.json", {
            "hasCompletedOnboarding": True, "theme": "dark",
            "projects": {str(d): {"hasTrustDialogAccepted": True} for d in [self.a, self.b]},
            "customApiKeyResponses": {"approved": ["mock"], "rejected": []},
        })
        self.api = MockMessages()
        threading.Thread(target=self.api.serve_forever, daemon=True).start()
        self.addCleanup(self.api.server_close)
        self.addCleanup(self.api.shutdown)
        self.cli = shutil.which("claude")
        self.env = {
            "PATH": os.pathsep.join([str(Path(self.cli).parent), str(Path(sys.executable).parent), os.defpath]),
            "TERM": "xterm-256color", "LANG": "en_US.UTF-8",
            "CLAUDE_CONFIG_DIR": str(self.config), "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "DISABLE_AUTOUPDATER": "1", "DISABLE_INSTALLATION_CHECKS": "1", "PYTHONDONTWRITEBYTECODE": "1",
            "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{self.api.server_port}",
            "ANTHROPIC_API_KEY": "mock",
        }

    def start(self, wrapped):
        argv = [sys.executable, self.mod / "scripts" / "launcher.py", "run", "--"] if wrapped else [self.cli]
        terminal = Terminal([*argv, "--permission-mode", "default"], self.a, self.env)
        self.addCleanup(terminal.close)
        record = self.a / ".claude" / "startup.json"
        terminal.until(record.exists, "A's SessionStart hook")
        source = json.loads(record.read_text())
        return terminal, source, Path(source["transcript_path"])

    def test_move_recovers_original_tool_error_and_runs_in_b_with_its_own_rules(self):
        # Arrange
        # The distinct long diagnostic checks transfer past 32 KiB without accidental duplication.
        diagnostic = "Diagnostic-BEGIN-" + ("0123456789abcdef" * 3000) + "-Diagnostic-END"
        self.api.diagnostic = diagnostic
        terminal, source, journal = self.start(wrapped=True)
        terminal.send(FIRST_TURN)
        terminal.until(lambda: has_text(journal, A_REPLY), "the real Bash result and A's reply")
        self.assertTrue((self.a / "tool-ran").is_file())
        self.assertTrue(has_text(journal, RAW_ERROR))
        self.api.diagnostic = ""
        self.api.compacting = True
        terminal.send("/compact")
        terminal.until(lambda: any(r.get("isCompactSummary") for r in rows(journal)), "the compaction boundary")
        self.assertTrue(has_text(journal, COMPACT_REPLY))
        self.api.compacting = False
        terminal.send(AFTER_COMPACT)
        terminal.until(lambda: has_text(journal, "Fixture response."), "a post-compaction response")

        # Act
        terminal.send("/move-project ../Library B")
        record = self.b / ".claude" / "startup.json"
        terminal.until(lambda: record.exists() and bool(self.api.b_requests), "B's first model request")
        target = json.loads(record.read_text())
        b_journal = Path(target["transcript_path"])
        terminal.until(lambda: has_text(b_journal, "Permission check complete."), "B to complete its permission check")

        # Assert
        self.assertNotEqual(source["session_id"], target["session_id"])
        self.assertEqual((source["source"], source["project"], source["a"], source["b"]),
                         ("startup", str(self.a), "A", None))
        self.assertEqual((target["source"], target["cwd"], target["project"], target["a"], target["b"]),
                         ("startup", str(self.b), str(self.b), None, "B"))
        archive, = (self.config / "move-project" / "handoffs").glob("*/history.jsonl")
        history = rows(archive)
        self.assertEqual([row["role"] for row in history],
                         ["user", "assistant", "user", "assistant", "user", "assistant"])
        self.assertEqual(history[0]["content"], FIRST_TURN)
        self.assertEqual(history[1]["content"][0]["id"], "toolu_smoke_a")
        self.assertEqual(history[1]["content"][0]["input"]["command"], COMMAND)
        self.assertEqual(history[2]["content"][0]["tool_use_id"], "toolu_smoke_a")
        self.assertIn("Exit code 23", history[2]["content"][0]["content"])
        self.assertIn(RAW_ERROR, history[2]["content"][0]["content"])
        self.assertEqual(history[4]["content"], AFTER_COMPACT)
        request = json.dumps(self.api.b_requests[0], ensure_ascii=False)
        self.assertEqual(request.count(diagnostic), 1)
        self.assertEqual(request.count(RAW_ERROR), 1)
        for marker in [FIRST_TURN, RAW_ERROR, A_REPLY, AFTER_COMPACT, B_RULE]:
            self.assertIn(marker, request, marker)
        for marker in [A_RULE, COMPACT_REPLY]:
            self.assertNotIn(marker, request, marker)
        self.assertFalse((self.b / "tool-ran").exists())
        results = [block for row in rows(b_journal) for block in
                   (row.get("message", {}).get("content") or []) if isinstance(block, dict)
                   and block.get("tool_use_id") == "toolu_smoke_b"]
        self.assertEqual(len(results), 1)
        self.assertTrue(results[0].get("is_error"), results)
        terminal.send(B_FOLLOW_UP)
        terminal.until(lambda: has_text(b_journal, B_FOLLOW_REPLY), "a typed follow-up in the destination TUI")

    def test_destination_context_budget_keeps_a_medium_archive_out_of_the_model_request(self):
        # The default target context is smaller than the conservative bound for 1.5 MB.
        self.check_file_only_handoff(character_count=500_000, reason="context")

    def test_a_very_large_history_remains_available_in_the_complete_private_archive(self):
        self.check_file_only_handoff(character_count=1_410_000, reason="large")

    def test_destination_with_plugin_disabled_receives_only_the_archive_path(self):
        # A remains enabled through the user install; only B disables this plugin.
        settings_file = self.b / ".claude" / "settings.json"
        settings = json.loads(settings_file.read_text())
        settings["enabledPlugins"] = {"move-project@skills-dir": False}
        write_json(settings_file, settings)
        # An enabled B in the positive case can inline a diagnostic of this size.
        self.check_file_only_handoff(character_count=16_000, reason="disabled")

    def check_file_only_handoff(self, character_count, reason):
        # Arrange
        # Distinct bookends verify that the file retains every byte when B only receives a pointer.
        diagnostic = "Large-Begin-28CD" + ("あ" * character_count) + "Large-End-F319"
        self.api.diagnostic = diagnostic
        terminal, _, journal = self.start(wrapped=True)
        terminal.send(FIRST_TURN)
        terminal.until(lambda: has_text(journal, "Large-End-F319"), "the full source diagnostic", timeout=60)
        self.api.diagnostic = ""

        # Act
        terminal.send("/move-project ../Library B")
        record = self.b / ".claude" / "startup.json"
        terminal.until(lambda: record.exists() and bool(self.api.b_requests), "B's file-only first request", timeout=60)

        # Assert
        archive, = (self.config / "move-project" / "handoffs").glob("*/history.jsonl")
        if reason == "large":
            self.assertGreater(archive.stat().st_size, 4 * 1024 * 1024)
        else:
            self.assertLess(archive.stat().st_size, 4 * 1024 * 1024)
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
        self.assertTrue(diagnostic in archive.read_text(), "large source diagnostic changed")
        request = json.dumps(self.api.b_requests[0], ensure_ascii=False)
        self.assertTrue(str(archive) in request, "B did not receive the complete archive path")
        self.assertFalse("Large-Begin-28CD" in request, "B received the archive head inline")
        self.assertFalse("Large-End-F319" in request, "B received the archive tail inline")
        if reason == "context":
            self.assertIn("estimated space", request)
        if reason == "disabled":
            self.assertIn("Continue this project move using the previous conversation in the archive.", request)
            self.assertNotIn("estimated space", request)
        self.assertNotIn(A_RULE, request)
        self.assertIn(B_RULE, request)

    def test_an_invalid_destination_leaves_the_source_session_interactive(self):
        # Arrange
        terminal, source, journal = self.start(wrapped=True)
        # Act
        terminal.send("/move-project ../Missing library")
        terminal.until(lambda: has_text(journal, "Destination is not a directory"), "the invalid-path diagnostic")
        terminal.send("Stay in A.")
        # Assert
        terminal.until(lambda: has_text(journal, "Fixture response."), "another working turn in A")
        self.assertEqual(json.loads((self.a / ".claude" / "startup.json").read_text())["session_id"], source["session_id"])
        self.assertFalse((self.b / ".claude" / "startup.json").exists())

    def test_a_bare_claude_session_explains_how_to_enable_moves(self):
        # Arrange
        terminal, _, journal = self.start(wrapped=False)
        # Act
        terminal.send("/move-project ../Library B")
        terminal.until(lambda: has_text(journal, "launcher"), "the launcher setup diagnostic")
        terminal.send("Stay in A.")
        # Assert
        terminal.until(lambda: has_text(journal, "Fixture response."), "another working turn in A")
        self.assertFalse((self.b / ".claude" / "startup.json").exists())


if __name__ == "__main__":
    if sys.argv[1:2] == ["--acquire-tty"]:
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        os.execvp(sys.argv[2], sys.argv[2:])
    unittest.main(verbosity=2)
