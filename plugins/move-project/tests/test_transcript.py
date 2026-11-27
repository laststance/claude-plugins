"""Regression fixtures for the Claude Code conversation journal reader."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from transcript import export_history


def entry(uid, parent, role, content, **fields):
    return {"uuid": uid, "parentUuid": parent, "type": role,
            "message": {"role": role, "content": content}, **fields}


class TranscriptTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.journal = Path(directory.name) / "session.jsonl"
        self.output = Path(directory.name) / "history.jsonl"

    def run_export(self, rows, tip=None):
        self.journal.write_text("".join(json.dumps(row) + "\n" for row in rows))
        count = export_history(self.journal, self.output, tip)
        records = [json.loads(line) for line in self.output.read_text().splitlines()]
        self.assertEqual(count, len(records))
        return records

    def test_conversation_quotes_and_tool_errors_survive_while_injected_rules_are_excluded(self):
        # Arrange
        call = {"type": "tool_use", "id": "call-1", "name": "Bash",
                "input": {"command": "printf '%s' '\n'"}, "caller": {"type": "direct"}}
        result = {"type": "tool_result", "tool_use_id": "call-1", "is_error": True,
                  "content": "E_FAIL\n<system-reminder>literal output</system-reminder>"}
        rows = [
            {"type": "api-request", "content": "machine instructions"},
            entry("1", None, "user", "I quoted <system-reminder>A</system-reminder> 🐚"),
            {"uuid": "2", "parentUuid": "1", "type": "attachment", "attachment": {"type": "hook_context", "content": "A hook"}},
            entry("3", "2", "user", "A-only instructions", isMeta=True),
            entry("4", "3", "assistant", [{"type": "thinking", "thinking": "internal"}, call]),
            entry("5", "4", "user", [result], toolUseResult={"source": "internal"}),
            entry("6", "5", "assistant", [{"type": "text", "text": "Failed.\nNext line."}]),
        ]
        # Act
        history = self.run_export(rows)
        # Assert
        self.assertEqual(history, [
            {"role": "user", "content": "I quoted <system-reminder>A</system-reminder> 🐚"},
            {"role": "assistant", "content": [{
                "type": "tool_use", "id": "call-1", "name": "Bash",
                "input": {"command": "printf '%s' '\n'"}, "caller": {"type": "direct"},
            }]},
            {"role": "user", "content": [{
                "type": "tool_result", "tool_use_id": "call-1", "is_error": True,
                "content": "E_FAIL\n<system-reminder>literal output</system-reminder>",
            }]},
            {"role": "assistant", "content": [{"type": "text", "text": "Failed.\nNext line."}]},
        ])

    def test_compact_preserves_originals_once_and_drops_replaced_branches_and_summaries(self):
        # Arrange
        rows = [
            entry("1", None, "user", "Repro"),
            entry("2", "1", "assistant", "Wrong branch"),
            entry("3", "1", "assistant", "Actual branch"),
            {"uuid": "4", "parentUuid": None, "logicalParentUuid": "3", "type": "system", "subtype": "compact_boundary",
             "compactMetadata": {"preservedSegment": {"headUuid": "3", "tailUuid": "3", "anchorUuid": "5"}}},
            entry("5", "4", "user", "Generated summary", isCompactSummary=True),
            entry("3", "5", "assistant", "Actual branch"),
            entry("6", "3", "user", "After compaction"),
            {"uuid": "7", "parentUuid": None, "logicalParentUuid": "6", "type": "system", "subtype": "compact_boundary"},
            entry("8", "7", "user", "Another generated summary", isCompactSummary=True),
            entry("9", "8", "assistant", "Fixed"),
            entry("10", "9", "assistant", "Agent side session", isSidechain=True),
        ]
        # Act
        history = self.run_export(rows)
        # Assert
        self.assertEqual([record["content"] for record in history], ["Repro", "Actual branch", "After compaction", "Fixed"])

    def test_live_tip_excludes_later_abandoned_messages_even_before_a_replacement_turn(self):
        # Arrange
        rows = [entry("1", None, "user", "Keep"), entry("2", "1", "assistant", "Undone")]
        # Act
        history = self.run_export(rows, tip="1")
        # Assert
        self.assertEqual(history, [{"role": "user", "content": "Keep"}])

    def test_local_command_and_hook_envelopes_are_removed_but_literal_user_markup_is_preserved(self):
        # Value: protects=Mixed harness envelopes export only their recorded tool results;
        # fails_when=the exporter discards the result or leaks adjacent project instructions;
        # why_new=the previous fixture only supplied machine-authored strings;
        # seam=none; no_claim=the transcript fixture uses the known envelope format.
        # Arrange: the CLI's /compact marker and stdout are user rows with the caveat's prompt ID.
        rows = [
            entry("1", None, "user", "<local-command-caveat>harness</local-command-caveat>",
                  promptId="compact-id", isMeta=True, rowSource="harness"),
            entry("2", "1", "user", "<command-name>/compact</command-name>", promptId="compact-id", rowSource="local"),
            entry("3", "2", "user", "<local-command-stdout>Compacted</local-command-stdout>", promptId="compact-id"),
            entry("4", "3", "user", "<local-command-stdout>quoted value</local-command-stdout>",
                  promptId="user-id", rowSource="local", promptSource="sdk"),
            entry("5", "4", "user", "hook instruction", rowSource="harness"),
            entry("6", "5", "user", "injected by project plugin", origin={"kind": "plugin", "name": "project-rule"}),
            entry("7", "6", "user", [
                {"type": "text", "text": "A-only hook instruction"},
                {"type": "tool_result", "tool_use_id": "read-A", "content": "recorded file result"},
            ], rowSource="harness"),
        ]
        # Act
        history = self.run_export(rows)
        # Assert
        self.assertEqual(history, [
            {"role": "user", "content": "<local-command-stdout>quoted value</local-command-stdout>"},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "read-A", "content": "recorded file result"},
            ]},
        ])

    def test_incomplete_journal_refuses_to_export_a_plausible_but_truncated_history(self):
        # Value: protects=An incomplete JSON line blocks transfer of the earlier valid turns;
        # fails_when=the reader silently skips a partially written final record;
        # why_new=missing ancestry tests use valid JSON and cannot detect skipped lines;
        # seam=none; no_claim=the fixture simulates the observed bytes during a write.
        # Arrange
        first = json.dumps(entry("1", None, "user", "Already persisted"))
        self.journal.write_text(first + '\n{"uuid":', encoding="utf-8")

        # Act
        with self.assertRaisesRegex(ValueError, "Invalid transcript JSON at line 2"):
            export_history(self.journal, self.output, tip="1")

        # Assert
        self.assertFalse(self.output.exists())

    def test_parallel_call_arguments_and_results_stay_in_order_across_sibling_parents(self):
        # Arrange
        call_a = [{"type": "tool_use", "id": "tool-a", "name": "Read", "input": {"file_path": "a"}}]
        call_b = [{"type": "tool_use", "id": "tool-b", "name": "Read", "input": {"file_path": "b"}}]
        result_a = [{"type": "tool_result", "tool_use_id": "tool-a", "content": "A file"}]
        result_b = [{"type": "tool_result", "tool_use_id": "tool-b", "content": "B file"}]
        rows = [
            entry("1", None, "user", "Read both"),
            entry("2", "1", "assistant", call_a),
            entry("3", "2", "assistant", call_b),
            entry("4", "3", "user", result_b),
            entry("5", "2", "user", result_a),
            entry("6", "5", "assistant", "Done"),
        ]
        rows[1]["message"]["id"] = rows[2]["message"]["id"] = "msg_response"
        # Act
        history = self.run_export(rows)
        # Assert
        self.assertEqual([record["content"] for record in history], [
            "Read both",
            [{"type": "tool_use", "id": "tool-a", "name": "Read", "input": {"file_path": "a"}}],
            [{"type": "tool_use", "id": "tool-b", "name": "Read", "input": {"file_path": "b"}}],
            [{"type": "tool_result", "tool_use_id": "tool-b", "content": "B file"}],
            [{"type": "tool_result", "tool_use_id": "tool-a", "content": "A file"}],
            "Done",
        ])

    def test_missing_history_refuses_to_present_a_partial_conversation(self):
        # Arrange
        broken_chains = [
            [entry("1", "absent", "assistant", "Missing parent")],
            [entry("1", "1", "assistant", "Circular link")],
            [{"uuid": "1", "parentUuid": None, "type": "system", "subtype": "compact_boundary"},
             entry("2", "1", "user", "Only a summary", isCompactSummary=True)],
        ]
        # Act and Assert
        for chain in broken_chains:
            with self.subTest(chain=chain), self.assertRaises(ValueError):
                self.run_export(chain)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
