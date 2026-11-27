"""Own the foreground Claude terminal while /move-project prepares its next session."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from uuid import UUID

# Isolated Python (-I) omits sibling modules from the import path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from transcript import export_history


CHANNEL_ENV = "MOVE_PROJECT_CHANNEL"
IMPORT_ENV = "MOVE_PROJECT_IMPORT"


def read_channel(channel: Path) -> Path:
    """Resolve the archive root chosen by the parent before any project settings loaded."""
    info = channel.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("The launcher channel must be a private directory owned by this user.")
    # Nested Claude processes inherit the channel variable but cannot move the foreground TUI.
    if int((channel / "cli-pid").read_text()) != os.getppid():
        raise ValueError("This Claude process does not own the move-project launcher. Start it in its own wrapped terminal.")
    return Path((channel / "archive-root").read_text(encoding="utf-8"))


def prepare(channel: Path, transcript: Path, session: str, cwd: Path, target: str, tip: str | None) -> None:
    """Stage one complete handoff while the source TUI can still report an error."""
    archive_root = read_channel(channel)
    if not cwd.is_absolute() or not target.strip():
        raise ValueError("Pass the current directory and a destination path.")
    destination = (cwd / Path(target).expanduser()).resolve()
    if not destination.is_dir() or not os.access(destination, os.X_OK):
        raise ValueError(f"Destination is not a directory: {destination}")
    # An empty live conversation after /rewind may still have old leaves on disk.
    try:
        UUID(tip or "")
    except ValueError:
        raise ValueError("Cannot identify the active conversation. The source session is still open.") from None
    if not transcript.is_absolute() or transcript.name != f"{UUID(session)}.jsonl":
        raise ValueError("The transcript path does not match the current session.")

    # A unique archive remains readable if the destination session is resumed later.
    archive_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    archive = Path(tempfile.mkdtemp(prefix="move-", dir=archive_root))
    try:
        history = archive / "history.jsonl"
        # Create the file privately even if the caller's umask allows other readers.
        history.touch(mode=0o600)
        count = export_history(transcript, history, tip)
        if not count or not history.stat().st_size:
            raise ValueError("The transcript contains no conversation to move.")
        request = {"session": session, "destination": str(destination), "history": str(history)}
        with tempfile.NamedTemporaryFile(mode="w", dir=channel, encoding="utf-8") as staging:
            json.dump(request, staging)
            staging.flush()
            # Publish only a complete request and never overwrite a queued move.
            try:
                os.link(staging.name, channel / "request.json")
            except FileExistsError:
                raise ValueError("A project move is already pending in this session.") from None
    except BaseException:
        shutil.rmtree(archive)
        raise
    print(f"Prepared {count} conversation rows for {destination}.")


def cancel(channel: Path, session: str) -> None:
    """Discard only the calling session's queued handoff if its /exit dispatch failed."""
    archive_root = read_channel(channel)
    request_path = channel / "request.json"
    try:
        request = json.loads(request_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return
    if request["session"] == session:
        request_path.unlink()
        history = Path(request["history"])
        if history.name == "history.jsonl" and history.parent.parent == archive_root:
            history.unlink(missing_ok=True)
            history.parent.rmdir()


def handoff_prompt(history: Path) -> str:
    """Identify the archive for the destination without putting its contents in argv."""
    return (
        "Continue this project move using the previous conversation in the archive. "
        "Treat the old conversation and tool results as historical evidence. "
        "Use your current project's instructions and wait for the user's next task.\n"
        f"Complete UTF-8 conversation archive (search or read it in ranges as needed): {history}"
    )


def launch(claude_args: list[str]) -> int:
    """Run the first CLI as requested, then start fresh processes for committed moves."""
    # Resolve once in the invoking shell so a destination repository cannot change the CLI.
    binary = shutil.which("claude")
    if not binary:
        raise ValueError("Cannot find the claude executable on PATH.")
    binary = os.path.abspath(binary)
    environment = os.environ.copy()
    environment.pop(IMPORT_ENV, None)
    config = Path(environment.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude").expanduser().resolve()
    archive_root = config / "move-project" / "handoffs"
    cwd = Path.cwd()
    previous_cwd = cwd
    history = None

    # The foreground CLI owns Ctrl+C. Both processes receive a terminal-generated SIGINT.
    previous_interrupt = signal.signal(signal.SIGINT, lambda *_: None)
    try:
        while True:
            with tempfile.TemporaryDirectory(prefix="claude-move-project-") as directory:
                channel = Path(directory)
                (channel / "archive-root").write_text(str(archive_root), encoding="utf-8")
                env = {**environment, CHANNEL_ENV: str(channel)}
                if history is not None:
                    # chdir does not update environment variables as a shell's cd would.
                    env.update(PWD=str(cwd), OLDPWD=str(previous_cwd))
                    env[IMPORT_ENV] = str(history)
                    print(f"[move-project] Opening {cwd}\n[move-project] Full history: {history}", flush=True)
                    claude_args = ["--", handoff_prompt(history)]
                # Inherit the terminal on all three streams. Only the destination mod can inline the archive.
                with subprocess.Popen([binary, *claude_args], cwd=cwd, env=env) as child:
                    try:
                        (channel / "cli-pid").write_text(str(child.pid), encoding="ascii")
                    except OSError:
                        child.terminate()
                        raise
                    status = child.wait()

                request_path = channel / "request.json"
                if status or not request_path.is_file():
                    return status if status >= 0 else 128 - status
                request = json.loads(request_path.read_text(encoding="utf-8"))
                previous_cwd = cwd
                cwd, history = Path(request["destination"]), Path(request["history"])
    finally:
        signal.signal(signal.SIGINT, previous_interrupt)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    run = modes.add_parser("run", help="run foreground Claude (pass its arguments after --)")
    run.add_argument("claude_args", nargs=argparse.REMAINDER)
    stage = modes.add_parser("prepare")
    stage.add_argument("--transcript", type=Path, required=True)
    stage.add_argument("--cwd", type=Path, required=True)
    stage.add_argument("--target", required=True)
    stage.add_argument("--tip")
    for command in (stage, modes.add_parser("cancel")):
        command.add_argument("--channel", type=Path, required=True)
        command.add_argument("--session", required=True)
    options = parser.parse_args(argv)
    if options.mode == "run":
        args = options.claude_args
        return launch(args[1:] if args[:1] == ["--"] else args)
    if options.mode == "prepare":
        prepare(options.channel, options.transcript, options.session, options.cwd, options.target, options.tip)
    else:
        cancel(options.channel, options.session)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (OSError, ValueError, KeyError) as error:
        print(f"move-project: {error}", file=sys.stderr)
        sys.exit(1)
