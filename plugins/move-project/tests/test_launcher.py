import contextlib
import io
import json
import os
import pty
import shutil
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import launcher


def copy_fixture(source, output, tip):
    output.write_bytes(source.read_bytes())
    return 1


class LauncherTests(unittest.TestCase):
    def setUp(self):
        private = tempfile.TemporaryDirectory()
        self.addCleanup(private.cleanup)
        self.root = Path(private.name).resolve()
        self.destination = self.root / "library B; $(pwd)"
        self.destination.mkdir()
        self.session = str(uuid4())
        self.tip = str(uuid4())
        self.transcript = self.root / f"{self.session}.jsonl"
        self.transcript.write_text('{"text":"The error is café."}\n', encoding="utf-8")
        self.channel = self.new_channel("channel")
        self.enter = contextlib.ExitStack()
        self.addCleanup(self.enter.close)
        self.enter.enter_context(patch.object(launcher, "export_history", copy_fixture))
        self.enter.enter_context(contextlib.redirect_stdout(io.StringIO()))

    def new_channel(self, name):
        channel = self.root / name
        channel.mkdir(mode=0o700)
        (channel / "archive-root").write_text(str(self.root / "archive"))
        (channel / "cli-pid").write_text(str(os.getppid()))
        return channel

    def prepare(self, channel, target):
        launcher.prepare(channel, self.transcript, self.session, self.root, target, self.tip)

    def test_successful_exit_starts_fresh_cli_in_destination_with_original_shell_environment(self):
        # Arrange
        calls = []
        @contextlib.contextmanager
        def foreground_cli(args, cwd, env):
            calls.append((args, cwd, env))
            def wait():
                if len(calls) == 1:
                    self.prepare(Path(env[launcher.CHANNEL_ENV]), self.destination.name)
                    env["A_ONLY_FOR_THIS_CHILD"] = "from-project-settings"
                return 0
            yield SimpleNamespace(pid=os.getppid(), wait=wait)

        with patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(self.root / "config")}):
            with patch.object(launcher.shutil, "which", return_value="/mock/claude"):
                with patch.object(launcher.subprocess, "Popen", side_effect=foreground_cli):
                    # Act
                    status = launcher.launch(["--settings", "/only/A.json"])

        # Assert
        self.assertEqual(status, 0)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][0], ["/mock/claude", "--settings", "/only/A.json"])
        args, cwd, env = calls[1]
        self.assertEqual(cwd, self.destination)
        self.assertEqual(env["PWD"], str(self.destination))
        self.assertEqual(env["OLDPWD"], str(Path.cwd()))
        self.assertEqual(args[:2], ["/mock/claude", "--"])
        self.assertEqual(Path(env[launcher.IMPORT_ENV]).read_text(), '{"text":"The error is café."}\n')
        self.assertNotIn("The error is café.", args[2])
        self.assertIn(env[launcher.IMPORT_ENV], args[2])
        self.assertNotIn(launcher.IMPORT_ENV, calls[0][2])
        self.assertNotIn("/only/A.json", args)
        self.assertNotIn("A_ONLY_FOR_THIS_CHILD", env)
        self.assertNotEqual(env[launcher.CHANNEL_ENV], calls[0][2][launcher.CHANNEL_ENV])

    def test_invalid_destination_or_unreadable_transcript_never_queues_an_exit(self):
        # Arrange / Act / Assert
        with self.assertRaisesRegex(ValueError, "Destination is not a directory"):
            self.prepare(self.channel, "missing")
        self.assertFalse((self.channel / "request.json").exists())
        self.transcript.unlink()
        with self.assertRaises(OSError):
            self.prepare(self.channel, str(self.destination))
        self.assertFalse((self.channel / "request.json").exists())
        self.assertEqual(list((self.root / "archive").iterdir()), [])

    def test_empty_or_invalid_active_tip_cannot_move_an_abandoned_branch(self):
        for tip in [None, "", "stale"]:
            with self.subTest(tip=tip):
                with self.assertRaisesRegex(ValueError, "Cannot identify the active conversation"):
                    launcher.prepare(self.channel, self.transcript, self.session, self.root, str(self.destination), tip)
                self.assertFalse((self.channel / "request.json").exists())

    def test_another_process_inheriting_the_channel_cannot_move_the_owners_terminal(self):
        # Arrange: this process stands in for a nested Claude inheriting the outer CLI's channel.
        env = {**os.environ, launcher.CHANNEL_ENV: str(self.channel)}

        # Act: launch the same helper a mod would, from the wrong real parent PID.
        call = subprocess.run([
            sys.executable, "-IB", launcher.__file__, "prepare", "--channel", str(self.channel),
            "--session", self.session, "--transcript", str(self.transcript), "--cwd", str(self.root),
            "--target", str(self.destination), "--tip", self.tip,
        ], env=env, capture_output=True, text=True, check=False)

        # Assert
        self.assertEqual(call.returncode, 1)
        self.assertIn("does not own the move-project launcher", call.stderr)
        self.assertFalse((self.channel / "request.json").exists())

    def test_two_source_sessions_publish_independent_complete_private_archives(self):
        # Arrange
        other = self.new_channel("another")
        other_id = str(uuid4())
        other_transcript = self.root / f"{other_id}.jsonl"
        other_transcript.write_text("Independent history", encoding="utf-8")

        # Act
        with ThreadPoolExecutor(max_workers=2) as workers:
            first = workers.submit(self.prepare, self.channel, self.destination.name)
            second = workers.submit(launcher.prepare, other, other_transcript, other_id, self.root, str(self.destination), str(uuid4()))
            first.result()
            second.result()

        # Assert
        path = Path(json.loads((self.channel / "request.json").read_text())["history"])
        another_path = Path(json.loads((other / "request.json").read_text())["history"])
        self.assertNotEqual(path, another_path)
        self.assertEqual(path.read_text(), '{"text":"The error is café."}\n')
        self.assertEqual(another_path.read_text(), "Independent history")
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)

    def test_cancel_is_session_specific_and_retries_leave_no_staged_archive(self):
        # Arrange
        self.prepare(self.channel, self.destination.name)
        marker = self.channel / "request.json"
        history = Path(json.loads(marker.read_text())["history"])

        # Act / Assert
        launcher.cancel(self.channel, str(uuid4()))
        with self.assertRaisesRegex(ValueError, "already pending"):
            self.prepare(self.channel, self.destination.name)
        self.assertTrue(marker.is_file())
        self.assertEqual(len(list(history.parent.parent.iterdir())), 1)
        launcher.cancel(self.channel, self.session)
        launcher.cancel(self.channel, self.session)
        self.assertFalse(marker.exists())
        self.assertFalse(history.exists())

    def test_long_history_is_referenced_as_a_complete_file_in_the_destination(self):
        # Arrange
        text = "error: 日本語\n" * 300000
        self.transcript.write_text(text, encoding="utf-8")
        # Act
        self.prepare(self.channel, self.destination.name)
        archive = Path(json.loads((self.channel / "request.json").read_text())["history"])
        prompt = launcher.handoff_prompt(archive)

        # Assert
        self.assertIn(str(archive), prompt)
        self.assertNotIn("error: 日本語", prompt)
        self.assertEqual(archive.read_text(encoding="utf-8"), text)

    @unittest.skipUnless(shutil.which("zsh"), "zsh is not installed")
    def test_zsh_wraps_interactive_sessions_and_preserves_print_and_plugin_commands(self):
        # Arrange
        fake_cli = self.root / "claude"
        fake_cli.write_text(
            '#!/bin/sh\n'
            'if [ -n "$MOVE_PROJECT_CHANNEL" ]; then printf "wrapped"; else printf "direct"; fi\n'
            'printf "|%s" "$@"\nexit 17\n'
        )
        fake_cli.chmod(0o700)
        integration = Path(launcher.__file__).parents[1] / "shell" / "claude.zsh"
        stale_integration = self.root / "removed-plugin" / "shell" / "claude.zsh"
        stale_integration.parent.mkdir(parents=True)
        shutil.copyfile(integration, stale_integration)
        environment = {**os.environ, "PATH": f"{self.root}:{os.environ['PATH']}"}
        environment.pop(launcher.CHANNEL_ENV, None)
        for script, args, expected in [
            (integration, ["question with spaces"], "wrapped|question with spaces"),
            (integration, ["--model", "sonnet", "-p", "run"], "direct|--model|sonnet|-p|run"),
            (integration, ["plugin", "list"], "direct|plugin|list"),
            (stale_integration, ["question after uninstall"], "direct|question after uninstall"),
        ]:
            with self.subTest(args=args):
                # Act
                master, tty = pty.openpty()
                try:
                    call = subprocess.run(
                        ["zsh", "-fc", 'source "$1"; shift; claude "$@"', "zsh", str(script), *args],
                        stdin=tty, stdout=tty, env=environment, timeout=10, check=False,
                    )
                    # Assert
                    self.assertEqual(call.returncode, 17)
                    self.assertEqual(os.read(master, 1024).decode(), expected)
                finally:
                    os.close(tty)
                    os.close(master)


if __name__ == "__main__":
    unittest.main()
