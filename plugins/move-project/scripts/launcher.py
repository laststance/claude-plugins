"""Own the foreground Claude terminal while /move-project prepares its next session."""

from __future__ import annotations

import argparse
import json
import os
import select
import shutil
import signal
import socket
import stat
import struct
import sys
import tempfile
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from subprocess import DEVNULL, PIPE, Popen, run
from uuid import UUID

# Isolated Python (-I) omits sibling modules from the import path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from transcript import export_history


CHANNEL_ENV = "MOVE_PROJECT_CHANNEL"
IMPORT_ENV = "MOVE_PROJECT_IMPORT"


def check_channel(channel: Path) -> None:
    """Require the launcher's per-session private directory before using its socket."""
    info = channel.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("The launcher channel must be a private directory owned by this user.")


def peer_parent(connection: socket.socket) -> int:
    """Get the connecting process's real parent from the OS, independently of its message."""
    if sys.platform == "darwin":
        # Darwin's sys/un.h defines SOL_LOCAL=0 and LOCAL_PEERPID=2 (also on Python 3.9).
        pid = connection.getsockopt(0, 2)
        parent = run(["/bin/ps", "-p", str(pid), "-o", "ppid="], stdin=DEVNULL,
                     stdout=PIPE, stderr=DEVNULL, check=False)
        if parent.returncode == 0 and parent.stdout.strip().isdigit():
            return int(parent.stdout)
    elif sys.platform.startswith("linux") and hasattr(socket, "SO_PEERCRED"):
        credentials = struct.Struct("3i")
        pid, uid, _gid = credentials.unpack(
            connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, credentials.size)
        )
        if uid == os.getuid():
            for line in Path(f"/proc/{pid}/status").read_text(encoding="ascii", errors="replace").splitlines():
                if line.startswith("PPid:"):
                    return int(line.split()[1])
    else:
        raise ValueError("This platform cannot verify move-project helper processes. Use macOS or Linux.")
    raise ValueError("Cannot verify the move-project helper process.")


def read_message(connection: socket.socket) -> dict:
    """Read one bounded JSON line so the launcher never waits for a client to disconnect."""
    with connection.makefile("rb") as stream:
        line = stream.readline(128 * 1024)
    if not line.endswith(b"\n"):
        raise ValueError("Incomplete or oversized move-project message.")
    message = json.loads(line)
    if not isinstance(message, dict):
        raise ValueError("Invalid move-project message.")
    return message


def send_message(connection: socket.socket, message: dict) -> None:
    """Send a complete request or reply to the other end of the local handoff channel."""
    connection.sendall(json.dumps(message).encode("ascii") + b"\n")


def call_launcher(channel: Path, message: dict) -> str:
    """Ask the foreground launcher to stage or cancel a move before the Mod dispatches /exit."""
    check_channel(channel)
    with socket.socket(socket.AF_UNIX) as client:
        client.connect(str(channel / "control"))
        send_message(client, message)
        response = read_message(client)
        if message["action"] == "prepare" and "result" in response:
            # A helper lost before it sees approval must not leave a move queued for a later /exit.
            send_message(client, {"received": True})
    if "error" in response:
        raise ValueError(response["error"])
    return response["result"]


def prepare(channel: Path, transcript: Path, session: str, cwd: Path, target: str, tip: str | None) -> None:
    """Pass the Mod's current conversation and destination to its foreground launcher."""
    print(call_launcher(channel, {"action": "prepare", "transcript": str(transcript), "session": session,
                                  "cwd": str(cwd), "target": target, "tip": tip}))


def cancel(channel: Path, session: str) -> None:
    """Withdraw the calling session's pending handoff when its /exit dispatch fails."""
    call_launcher(channel, {"action": "cancel", "session": session})


@dataclass
class Handoff:
    """Remember the exact destination and private archive the launcher approved."""
    session: str
    destination: Path
    history: Path
    destination_info: os.stat_result
    history_info: os.stat_result

    def check_history(self, archive_root: Path) -> None:
        """Keep the imported file inside the original archive store and reject replacements."""
        history = self.history
        if (history.name != "history.jsonl" or history.parent.parent != archive_root
                or history.resolve(strict=True) != history):
            raise ValueError("The move-project archive is outside its original location.")
        check_channel(history.parent)
        info = history.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077
                or info.st_nlink != 1 or not os.path.samestat(info, self.history_info)
                or info.st_ctime_ns != self.history_info.st_ctime_ns or info.st_size != self.history_info.st_size):
            raise ValueError("The move-project archive changed after it was prepared.")

    def check_destination(self) -> None:
        """Recheck the original directory after the source exits, before starting the destination."""
        destination = self.destination
        if (destination.resolve(strict=True) != destination or not destination.is_dir()
                or not os.access(destination, os.X_OK) or not os.path.samestat(destination.stat(), self.destination_info)):
            raise ValueError("The move-project destination changed after it was prepared.")


class PendingMove:
    """Own the single handoff that the authenticated source helper may stage or cancel."""

    def __init__(self, archive_root: Path):
        self.archive_root = archive_root
        self.handoff: Handoff | None = None

    def discard(self) -> None:
        """Revoke approval first, even if a changed archive cannot be cleaned up safely."""
        handoff, self.handoff = self.handoff, None
        if handoff is not None:
            handoff.check_history(self.archive_root)
            handoff.history.unlink()
            handoff.history.parent.rmdir()

    def handle(self, request: dict) -> str:
        """Apply one authenticated request and acknowledge only a complete archive."""
        session = str(UUID(request["session"]))
        if request["action"] == "cancel":
            if self.handoff is not None and self.handoff.session == session:
                self.discard()
            return ""
        if request["action"] != "prepare":
            raise ValueError("Unknown move-project request.")
        if self.handoff is not None:
            raise ValueError("A project move is already pending in this session.")
        cwd, target = Path(request["cwd"]), request["target"]
        if not cwd.is_absolute() or not target.strip():
            raise ValueError("Pass the current directory and a destination path.")
        destination = (cwd / Path(target).expanduser()).resolve()
        if not destination.is_dir() or not os.access(destination, os.X_OK):
            raise ValueError(f"Destination is not a directory: {destination}")
        destination_info = destination.stat()
        # A rewound conversation can leave old, inactive transcript rows on disk.
        try:
            tip = str(UUID(request["tip"] or ""))
        except ValueError:
            raise ValueError("Cannot identify the active conversation. The source session is still open.") from None
        transcript = Path(request["transcript"])
        if not transcript.is_absolute() or transcript.name != f"{session}.jsonl" or not transcript.is_file():
            raise ValueError("The transcript must be a regular file matching the current session.")

        # Only the launcher determines where private archives are created.
        if self.archive_root.resolve() != self.archive_root:
            raise ValueError("The move-project archive store cannot be redirected.")
        self.archive_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        archive = Path(tempfile.mkdtemp(prefix="move-", dir=self.archive_root))
        history = archive / "history.jsonl"
        try:
            # Keep the output inode pinned throughout export, including if its directory entry changes.
            fd = os.open(history, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            try:
                count = export_history(transcript, Path("/dev/fd") / str(fd), tip)
                info = os.fstat(fd)
            finally:
                os.close(fd)
            if not count or not info.st_size:
                raise ValueError("The transcript contains no conversation to move.")
            handoff = Handoff(session, destination, history, destination_info, info)
            handoff.check_history(self.archive_root)
            self.handoff = handoff
        except BaseException:
            shutil.rmtree(archive)
            raise
        return f"Prepared {count} conversation rows for {destination}."


@contextmanager
def listen(channel: Path):
    """Bind before starting Claude so even its earliest helper can reach the launcher."""
    check_channel(channel)
    with socket.socket(socket.AF_UNIX) as listener:
        listener.bind(str(channel / "control"))
        listener.listen()
        yield listener


def serve_helper(connection: socket.socket, cli_pid: int, pending: PendingMove) -> None:
    """Process one direct helper and roll back a move whose receipt never arrives."""
    connection.settimeout(3)
    if peer_parent(connection) != cli_pid:
        raise ValueError("This Claude process does not own the move-project launcher. "
                         "Start it in its own wrapped terminal.")
    request = read_message(connection)
    result = pending.handle(request)
    try:
        send_message(connection, {"result": result})
        if request["action"] == "prepare" and read_message(connection) != {"received": True}:
            raise ValueError("The move-project helper did not acknowledge the prepared move.")
    except (OSError, ValueError):
        if request["action"] == "prepare":
            pending.discard()
        raise


@contextmanager
def receive_moves(listener: socket.socket, cli_pid: int, archive_root: Path):
    """Serve verified helpers while the main thread waits on the native foreground CLI."""
    pending = PendingMove(archive_root)
    stop, wake = socket.socketpair()
    with stop, wake:
        def serve():
            while True:
                ready, _, _ = select.select([stop, listener], [], [])
                if stop in ready:
                    return
                connection, _ = listener.accept()
                with connection:
                    try:
                        serve_helper(connection, cli_pid, pending)
                    except (OSError, ValueError, KeyError, TypeError, AttributeError, RuntimeError) as error:
                        try:
                            send_message(connection, {"error": str(error)})
                        except OSError:
                            # A disconnected client cannot receive its diagnostic.
                            pass

        thread = threading.Thread(target=serve, name="move-project")
        thread.start()
        try:
            yield pending
        finally:
            wake.sendall(b"\x00")
            thread.join()


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
            # Unix-domain socket names are limited to 104 bytes on macOS.
            with tempfile.TemporaryDirectory(prefix="claude-move-", dir="/tmp") as directory:
                channel = Path(directory)
                env = {**environment, CHANNEL_ENV: str(channel)}
                if history is not None:
                    # chdir does not update environment variables as a shell's cd would.
                    env.update(PWD=str(cwd), OLDPWD=str(previous_cwd))
                    env[IMPORT_ENV] = str(history)
                    print(f"[move-project] Opening {cwd}\n[move-project] Full history: {history}", flush=True)
                    claude_args = ["--", handoff_prompt(history)]
                # Inherit the terminal on all three streams. Only the destination mod can inline the archive.
                with listen(channel) as listener, Popen([binary, *claude_args], cwd=cwd, env=env) as child:
                    with receive_moves(listener, child.pid, archive_root) as pending:
                        status = child.wait()

                handoff = pending.handoff
                if status or handoff is None:
                    return status if status >= 0 else 128 - status
                handoff.check_destination()
                handoff.check_history(archive_root)
                previous_cwd = cwd
                cwd, history = handoff.destination, handoff.history
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
