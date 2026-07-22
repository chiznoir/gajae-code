import json

from gjc_sdk.frames import ActionNeeded, GenericFrame, Reply, parse_frame, reply_frame, serialize_frame


def test_reply_serialization_includes_token() -> None:
    raw = json.loads(serialize_frame(reply_frame("action-1", {"choice": "yes"}, "secret")))
    assert raw == {"type": "reply", "id": "action-1", "answer": {"choice": "yes"}, "token": "secret"}


def test_unknown_frame_is_preserved() -> None:
    frame = parse_frame('{"type":"future_frame","newField":{"value":1}}')
    assert isinstance(frame, GenericFrame)
    assert frame.raw == {"type": "future_frame", "newField": {"value": 1}}


def test_reply_round_trip() -> None:
    original = Reply("action-1", ["yes", True], "secret", "retry-1")
    assert parse_frame(serialize_frame(original)) == original


def test_action_needed_round_trip() -> None:
    original = ActionNeeded("action-1", "ask", "session-1", "Proceed?", ["Yes", "No"], "gate-1")
    assert parse_frame(serialize_frame(original)) == original


def test_reply_repr_hides_token() -> None:
    assert "secret-token" not in repr(Reply("action-1", "yes", "secret-token"))
