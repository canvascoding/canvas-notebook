#!/usr/bin/env python3
"""Private inactive upload snapshot IO on a Node-owned, pinned DATA fd3.

Every child lookup is allowlisted and relative to an open directory descriptor.
The Node caller retains the actual per-file kernel fence until this child closes.
No Auth/native/target authority, native commits, broad deletes or traversal exist.
Snapshots and tombstones survive ordinary upload-session cancellation/expiry;
their existence never proves a live upload or permission to consume its bytes.
"""
import base64
import datetime
import hashlib
import json
import os
import re
import stat
import sys
import uuid

LIMIT = 5 * 1024 * 1024
RECORD_LIMIT = 64 * 1024
STORE = "canvas-markdown-upload-attempts"
ANCHOR = "canvas-markdown-upload-attempts-anchor.json"
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
READ = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
SELECTION_KEYS = {"uploadSessionId", "fileId", "workspaceId", "targetPath", "actorUserId", "actorSessionId", "requestId", "operationId"}


class Refused(Exception):
    pass


def fail(code):
    raise Refused("MARKDOWN_UPLOAD_ATTEMPT_" + code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def decode(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                fail("RECORD_CHANGED")
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=unique)


def identity(info):
    return {"dev": str(info.st_dev), "ino": str(info.st_ino), "uid": info.st_uid, "mode": stat.S_IMODE(info.st_mode)}


def profile(info):
    return {**identity(info), "size": info.st_size, "nlink": info.st_nlink,
            "mtimeNs": str(info.st_mtime_ns), "ctimeNs": str(info.st_ctime_ns)}


def private_directory(fd, private=True):
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & (0o077 if private else 0o022):
        fail("UNSAFE_NAMESPACE")
    return identity(info)


def open_directory(parent, name, private=True):
    fd = os.open(name, DIRECTORY, dir_fd=parent)
    try:
        private_directory(fd, private)
        return fd
    except BaseException:
        os.close(fd)
        raise


def named_directory(parent, name, fd):
    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if not stat.S_ISDIR(info.st_mode) or identity(info) != identity(os.fstat(fd)):
        fail("NAMESPACE_CHANGED")


def read_file(parent, name, limit):
    fd = os.open(name, READ, dir_fd=parent)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != os.geteuid() or stat.S_IMODE(before.st_mode) & 0o077:
            fail("UNSAFE_SOURCE")
        if before.st_size > limit:
            fail("SOURCE_TOO_LARGE")
        data = bytearray()
        while len(data) <= before.st_size:
            part = os.read(fd, min(65536, before.st_size + 1 - len(data)))
            if not part:
                break
            data.extend(part)
        after = os.fstat(fd)
        named = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if profile(before) != profile(after) or profile(after) != profile(named) or len(data) != before.st_size:
            fail("SOURCE_CHANGED")
        return bytes(data), profile(after)
    finally:
        os.close(fd)


def phase(name):
    sys.stdout.write(json.dumps({"stage": name}) + "\n")
    sys.stdout.flush()
    if sys.stdin.readline() != "continue\n":
        fail("IO_UNCONFIRMED")


def publish(parent, name, data):
    """No-replace publication; a crash in link/unlink remains partial recovery."""
    temporary = "." + name + ".tmp-" + uuid.uuid4().hex
    fd = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    created = identity(os.fstat(fd))
    try:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.fsync(fd)
        phase(name + ":file_synced")
        os.link(temporary, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        if identity(os.stat(temporary, dir_fd=parent, follow_symlinks=False)) != created:
            fail("NAMESPACE_CHANGED")
        os.unlink(temporary, dir_fd=parent)
        os.fsync(parent)
        phase(name + ":published")
    finally:
        os.close(fd)
        # A partial or unconfirmed object remains retained; no recursive or
        # unverified compensation removes an unfamiliar temporary/foreign file.


def barrier(parent, name):
    fd = os.open(name, READ, dir_fd=parent)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def validate_selection(value):
    if not isinstance(value, dict) or set(value) != SELECTION_KEYS or any(not isinstance(x, str) for x in value.values()):
        fail("INVALID_INPUT")
    for name in ["uploadSessionId", "fileId"]:
        if not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", value[name]):
            fail("INVALID_INPUT")
    for name in SELECTION_KEYS - {"uploadSessionId", "fileId", "targetPath"}:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", value[name]):
            fail("INVALID_INPUT")
    target = value["targetPath"]
    if len(target) > 4096 or re.search(r"[\\\x00-\x1f\x7f]", target) or any(x in ["", ".", ".."] for x in target.split("/")) or not re.search(r"\.(md|markdown)$", target, re.I):
        fail("INVALID_INPUT")


def origin(selection):
    """Point-in-time historical staging evidence only, never an Auth grant."""
    uploads = workspace = session = None
    try:
        uploads = open_directory(3, ".uploads", False)
        workspace = open_directory(uploads, "workspace")
        session = open_directory(workspace, selection["uploadSessionId"])
        raw, manifest_profile = read_file(session, "session.json", 2 * 1024 * 1024)
        manifest = decode(raw)
        if manifest.get("id") != selection["uploadSessionId"] or manifest.get("userId") != selection["actorUserId"] or manifest.get("workspaceId") != selection["workspaceId"]:
            fail("UPLOAD_CHANGED")
        files = manifest.get("files")
        if not isinstance(files, list) or len(files) > 1000:
            fail("UPLOAD_CHANGED")
        candidates = [file for file in files if isinstance(file, dict) and file.get("id") == selection["fileId"]]
        if len(candidates) != 1:
            fail("UPLOAD_CHANGED")
        file = candidates[0]
        if file.get("targetPath") != selection["targetPath"] or "officeAttempt" in file:
            fail("UPLOAD_CHANGED")
        # Copy only the service's scalar manifest forms. Nullable/absent MIME
        # hints remain harmless optional metadata; arbitrary objects (including
        # credentials accidentally placed there) never enter the private record.
        def canonical(value):
            return isinstance(value, str) and 0 < len(value) <= 4096 and not re.search(r"[\\\x00-\x1f\x7f]", value) and not any(x in ["", ".", ".."] for x in value.split("/"))
        target_dir, relative = manifest.get("targetDir"), file.get("relativePath")
        if not canonical(relative) or not (target_dir == "." or canonical(target_dir)) \
                or (relative if target_dir == "." else target_dir + "/" + relative) != selection["targetPath"] \
                or file.get("mimeType") is not None and (not isinstance(file["mimeType"], str) or re.search(r"[\x00-\x1f\x7f]", file["mimeType"])):
            fail("UPLOAD_CHANGED")
        for name in ["createdAt", "expiresAt"]:
            date = manifest.get(name)
            if not isinstance(date, str) or len(date) > 64:
                fail("UPLOAD_CHANGED")
            try:
                parsed = datetime.datetime.fromisoformat(date.replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    fail("UPLOAD_CHANGED")
            except ValueError:
                fail("UPLOAD_CHANGED")
        size = file.get("size")
        if type(size) is not int or not 0 <= size <= LIMIT or type(file.get("sourceIndex")) is not int or not 0 <= file["sourceIndex"] < 1000:
            fail("SOURCE_TOO_LARGE")
        progress_name = selection["fileId"] + ".part.json"
        try:
            progress_raw, progress_profile = read_file(session, progress_name, RECORD_LIMIT)
            progress = decode(progress_raw)
        except FileNotFoundError:
            progress, progress_profile = file, None
        status = progress.get("status")
        if status == "completed":
            return "completed", None, None
        expires = manifest.get("expiresAt")
        if not isinstance(expires, str):
            fail("UPLOAD_CHANGED")
        expiry = datetime.datetime.fromisoformat(expires.replace("Z", "+00:00"))
        if expiry.tzinfo is None or expiry.timestamp() <= datetime.datetime.now(datetime.timezone.utc).timestamp():
            return "expired", None, None
        if type(progress.get("uploadedBytes")) is not int or progress["uploadedBytes"] != size or status not in (["pending", "uploaded"] if size == 0 else ["uploaded"]):
            fail("UPLOAD_CHANGED")
        selected = {"id": manifest["id"], "userId": manifest["userId"], "workspaceId": manifest["workspaceId"],
                    "targetDir": manifest.get("targetDir"), "createdAt": manifest.get("createdAt"), "expiresAt": expires,
                    "file": {key: file.get(key) for key in ["id", "sourceIndex", "relativePath", "targetPath", "size", "mimeType"]}}
        if len(encode(selected)) > RECORD_LIMIT // 2:
            fail("SOURCE_TOO_LARGE")
        data, source_profile = read_file(session, selection["fileId"] + ".part", LIMIT)
        if len(data) != size:
            fail("SOURCE_CHANGED")
        # Bind exact manifest/progress reads during capture, then only selected
        # immutable fields on future retries: unrelated Office rewrites are not
        # mistaken for this file's publication or authority.
        if read_file(session, "session.json", 2 * 1024 * 1024)[1] != manifest_profile or progress_profile is not None and read_file(session, progress_name, RECORD_LIMIT)[1] != progress_profile:
            fail("UPLOAD_CHANGED")
        named_directory(3, ".uploads", uploads)
        named_directory(uploads, "workspace", workspace)
        named_directory(workspace, selection["uploadSessionId"], session)
        proof = {"selected": selected, "parents": [identity(os.fstat(fd)) for fd in [uploads, workspace, session]], "profile": source_profile, "sha256": digest(data)}
        return "available", proof, data
    except FileNotFoundError:
        return "missing", None, None
    finally:
        for fd in [session, workspace, uploads]:
            if fd is not None:
                os.close(fd)


def assert_root(root):
    info = os.fstat(3)
    if private_directory(3, False)["dev"] != root["dev"] or str(info.st_ino) != root["ino"] or identity(os.stat(root["path"], follow_symlinks=False)) != identity(info):
        fail("NAMESPACE_CHANGED")


def main():
    value = decode(sys.stdin.readline(RECORD_LIMIT))
    if set(value) != {"action", "selection", "key", "root"}:
        fail("INVALID_INPUT")
    action, selection, key, root = value["action"], value["selection"], value["key"], value["root"]
    validate_selection(selection)
    expected = hashlib.sha256(json.dumps([selection["uploadSessionId"], selection["fileId"]], separators=(",", ":")).encode()).hexdigest()
    if key != expected or not re.fullmatch(r"[a-f0-9]{64}", key) or action not in ["initialize", "stage", "inspect", "read", "retain", "abandon"]:
        fail("INVALID_INPUT")
    if not isinstance(root, dict) or set(root) != {"path", "dev", "ino"} or not isinstance(root["path"], str) or not os.path.isabs(root["path"]):
        fail("INVALID_INPUT")
    assert_root(root)
    store = entry = None
    try:
        if action == "initialize":
            try:
                anchor_raw, _ = read_file(3, ANCHOR, RECORD_LIMIT)
                anchor = decode(anchor_raw)
                store = open_directory(3, STORE)
                if encode(anchor) != encode({"version": 1, "root": identity(os.fstat(3)), "store": identity(os.fstat(store))}):
                    fail("NAMESPACE_CHANGED")
            except FileNotFoundError:
                try:
                    os.mkdir(STORE, 0o700, dir_fd=3)
                except FileExistsError:
                    fail("RECOVERY_REQUIRED")
                store = open_directory(3, STORE)
                publish(3, ANCHOR, encode({"version": 1, "root": identity(os.fstat(3)), "store": identity(os.fstat(store))}))
            barrier(3, ANCHOR)
            os.fsync(store)
            os.fsync(3)
            named_directory(3, STORE, store)
            assert_root(root)
            return {"observation": {"state": "staged", "uploadStatus": "missing", "sourceHash": "", "sourceBytes": 0}}
        anchor = decode(read_file(3, ANCHOR, RECORD_LIMIT)[0])
        store = open_directory(3, STORE)
        if encode(anchor) != encode({"version": 1, "root": identity(os.fstat(3)), "store": identity(os.fstat(store))}):
            fail("NAMESPACE_CHANGED")
        try:
            entry = open_directory(store, key)
        except FileNotFoundError:
            if action != "stage":
                fail("RECOVERY_REQUIRED")
            status, original, data = origin(selection)
            if status != "available":
                fail("REFUSED_CONSUMPTION")
            os.mkdir(key, 0o700, dir_fd=store)
            entry = open_directory(store, key)
            publish(entry, "source.bin", data)
            snapshot_data, snapshot_profile = read_file(entry, "source.bin", LIMIT)
            status, final_origin, final_data = origin(selection)
            if status != "available" or final_origin != original or final_data != data or snapshot_data != data:
                fail("SOURCE_CHANGED")
            record = {"version": 1, "selection": selection, "entry": identity(os.fstat(entry)),
                      "origin": original, "snapshot": snapshot_profile, "sourceHash": digest(data), "sourceBytes": len(data)}
            publish(entry, "record.json", encode(record))
        try:
            raw, _ = read_file(entry, "record.json", RECORD_LIMIT)
        except FileNotFoundError:
            fail("RECOVERY_REQUIRED")
        record = decode(raw)
        if not isinstance(record, dict) or set(record) != {"version", "selection", "entry", "origin", "snapshot", "sourceHash", "sourceBytes"} or type(record["version"]) is not int or record["version"] != 1 \
                or type(record["sourceBytes"]) is not int or not 0 <= record["sourceBytes"] <= LIMIT \
                or not isinstance(record["sourceHash"], str) or not re.fullmatch(r"[a-f0-9]{64}", record["sourceHash"]):
            fail("RECORD_CHANGED")
        if encode(record["selection"]) != encode(selection):
            fail("REQUEST_CONFLICT")
        if encode(record["entry"]) != encode(identity(os.fstat(entry))):
            fail("NAMESPACE_CHANGED")
        data, snapshot = read_file(entry, "source.bin", LIMIT)
        if encode(record["snapshot"]) != encode(snapshot) or record["sourceBytes"] != len(data) or record["sourceHash"] != digest(data):
            fail("SOURCE_CHANGED")
        state = "staged"
        for name, marker_state in [("retained.json", "retained"), ("abandoned.json", "abandoned")]:
            try:
                marker = decode(read_file(entry, name, RECORD_LIMIT)[0])
                if encode(marker) != encode({"version": 1, "recordHash": digest(raw), "state": marker_state}) or state != "staged":
                    fail("RECORD_CHANGED")
                state = marker_state
            except FileNotFoundError:
                pass
        if action in ["retain", "abandon"]:
            desired = "retained" if action == "retain" else "abandoned"
            if state != desired:
                if state != "staged":
                    fail("RECOVERY_REQUIRED")
                publish(entry, desired + ".json", encode({"version": 1, "recordHash": digest(raw), "state": desired}))
                state = desired
        try:
            status, current_origin, _ = origin(selection)
            if status == "available" and encode(current_origin) != encode(record["origin"]):
                status = "changed"
        except (Refused, ValueError, OSError):
            status = "changed"
        if action == "read" and (status != "available" or state == "abandoned"):
            fail("REFUSED_CONSUMPTION")
        # Repeat durability after a lost helper answer/directory-fsync failure.
        for name in ["source.bin", "record.json"] + ([] if state == "staged" else [state + ".json"]):
            barrier(entry, name)
        os.fsync(entry)
        os.fsync(store)
        os.fsync(3)
        named_directory(store, key, entry)
        named_directory(3, STORE, store)
        assert_root(root)
        result = {"observation": {"state": state, "uploadStatus": status, "sourceHash": record["sourceHash"], "sourceBytes": record["sourceBytes"]}}
        if action == "read":
            result["bytes"] = base64.b64encode(data).decode("ascii")
        return result
    finally:
        if entry is not None:
            os.close(entry)
        if store is not None:
            os.close(store)


try:
    result = main()
    sys.stdout.write(json.dumps({"result": result}, separators=(",", ":")) + "\n")
    sys.stdout.flush()
except BaseException as error:
    code = str(error) if isinstance(error, Refused) else "MARKDOWN_UPLOAD_ATTEMPT_IO_UNCONFIRMED"
    sys.stdout.write(json.dumps({"error": code}) + "\n")
    sys.stdout.flush()
    sys.exit(1)
