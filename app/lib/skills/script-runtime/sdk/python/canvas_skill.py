"""Canvas tool bridge over two inherited descriptors; no HTTP, tokens or implicit permissions."""
import json
import os
import struct

_MAX_FRAME = 64 * 1024
_arguments = None
_next_id = 1
_closed = False


class CanvasSkillToolError(RuntimeError):
    def __init__(self, message, code=None, outcome=None):
        super().__init__(message)
        self.code = code
        self.outcome = outcome


def _read(fd, size):
    result = bytearray()
    while len(result) < size:
        chunk = os.read(fd, size - len(result))
        if not chunk:
            raise CanvasSkillToolError("The Canvas script bridge is closed.")
        result.extend(chunk)
    return bytes(result)


def _frame(fd):
    size = struct.unpack("!I", _read(fd, 4))[0]
    if size < 1 or size > _MAX_FRAME:
        raise CanvasSkillToolError("The Canvas script bridge frame is invalid.")
    return json.loads(_read(fd, size).decode("utf-8"))


def arguments():
    global _arguments
    if _arguments is None:
        _arguments = _frame(0)
        if not isinstance(_arguments, dict):
            raise CanvasSkillToolError("Canvas script arguments must be an object.")
    return _arguments


def _request(action, alias, **extra):
    global _next_id, _closed
    if _closed or not isinstance(alias, str) or not alias or len(alias) > 128:
        raise CanvasSkillToolError("The Canvas script bridge is closed or the alias is invalid.")
    request_id = _next_id
    _next_id += 1
    payload = json.dumps(dict(version=1, id=request_id, action=action, alias=alias, **extra),
                         separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(payload) > _MAX_FRAME:
        raise CanvasSkillToolError("The Canvas script bridge request exceeds its limit.")
    frame = struct.pack("!I", len(payload)) + payload
    offset = 0
    while offset < len(frame):
        offset += os.write(3, frame[offset:])
    response = _frame(4)
    if not isinstance(response, dict) or response.get("version") != 1 or response.get("id") != request_id or not isinstance(response.get("ok"), bool):
        _closed = True
        raise CanvasSkillToolError("The Canvas script bridge response is invalid.")
    error = response.get("error") or {}
    if response.get("terminate") is True or error.get("outcome") == "unknown":
        _closed = True
    if not response["ok"]:
        raise CanvasSkillToolError(error.get("message", "The Canvas tool call failed."), error.get("code"), error.get("outcome"))
    return response.get("data")


def describe(alias):
    return _request("describe", alias)


def call(alias, arguments=None):
    description = describe(alias)
    if not isinstance(description, dict) or not isinstance(description.get("schemaHandle"), str):
        raise CanvasSkillToolError("The Canvas tool schema handle is unavailable.")
    return _request("call", alias, schemaHandle=description["schemaHandle"], arguments={} if arguments is None else arguments)
