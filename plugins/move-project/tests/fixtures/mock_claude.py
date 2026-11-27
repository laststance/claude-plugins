"""Respond to real Claude Code clients over loopback, without a model or API key."""

import json
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FIRST_TURN = "Reproduce the parser failure in fixture A."
RAW_ERROR = "ParserError E047: an empty value has no offset."
A_REPLY = "The parser failure occurs before an offset is assigned."
B_RULE = "Project rule sentinel LIBRARY_B_52AF."
A_RULE = "Project rule sentinel APPLICATION_A_16FB."
COMPACT_REPLY = "Summary-only marker COMPACTION_F8D2."
COMMAND = "sh ./repro.sh"
B_FOLLOW_UP = "Check that the destination still accepts keyboard input."
B_FOLLOW_REPLY = "Keyboard follow-up received in B."


def content_blocks(messages):
    """Yield structured model messages so historical text cannot trigger a tool reply."""
    for message in messages:
        content = message.get("content")
        if isinstance(content, list):
            yield from content


class MockMessages(ThreadingHTTPServer):
    """Serve the Messages API while recording only this test's candidate B requests."""

    def __init__(self):
        super().__init__(("127.0.0.1", 0), MessagesHandler)
        self.compacting = False
        self.diagnostic = ""
        self.b_requests = []

    def response(self, request):
        blocks = list(content_blocks(request.get("messages", [])))
        text = json.dumps(request.get("messages", []), ensure_ascii=False)
        in_b = B_RULE in text
        if in_b:
            self.b_requests.append(request)
        # Compaction deliberately omits the underlying error to distinguish raw recovery.
        if self.compacting:
            return {"type": "text", "text": "<summary>" + COMPACT_REPLY + "</summary>"}
        if in_b and B_FOLLOW_UP in text:
            return {"type": "text", "text": B_FOLLOW_REPLY}
        if not in_b and FIRST_TURN not in text:
            return {"type": "text", "text": "Fixture response."}
        tool_id = "toolu_smoke_b" if in_b else "toolu_smoke_a"
        if not any(block.get("tool_use_id") == tool_id for block in blocks):
            return {"type": "tool_use", "id": tool_id, "name": "Bash",
                    "input": {"command": COMMAND, "description": "Run the local parser fixture"}}
        return {"type": "text", "text": "Permission check complete." if in_b else A_REPLY + self.diagnostic}


class MessagesHandler(BaseHTTPRequestHandler):
    """Encode the message selected by the fixture as a Messages API response."""

    def log_message(self, *args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        block = self.server.response(request)
        is_tool = block["type"] == "tool_use"
        reason = "tool_use" if is_tool else "end_turn"
        message = {
            "id": "msg_" + uuid.uuid4().hex, "type": "message", "role": "assistant",
            "model": request.get("model", "mock"), "content": [],
            "stop_reason": None, "stop_sequence": None,
            "usage": {"input_tokens": 1000, "output_tokens": 100},
        }
        if request.get("stream"):
            # Claude's stream decoder accumulates block deltas before emitting tool calls.
            start = {**block, "input": {}} if is_tool else {"type": "text", "text": ""}
            delta = ({"type": "input_json_delta", "partial_json": json.dumps(block["input"])}
                     if is_tool else {"type": "text_delta", "text": block["text"]})
            events = [
                ("message_start", {"message": message}),
                ("content_block_start", {"index": 0, "content_block": start}),
                ("content_block_delta", {"index": 0, "delta": delta}),
                ("content_block_stop", {"index": 0}),
                ("message_delta", {"delta": {"stop_reason": reason, "stop_sequence": None},
                                   "usage": {"output_tokens": 100}}),
                ("message_stop", {}),
            ]
            body = "".join(
                f"event: {event}\ndata: {json.dumps({'type': event, **payload})}\n\n"
                for event, payload in events
            ).encode()
            mime = "text/event-stream"
        else:
            body = json.dumps({**message, "content": [block], "stop_reason": reason}).encode()
            mime = "application/json"
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
