#!/usr/bin/env python3
"""Upload-only SH/EX kernel acquisition and anchored terminal/source IO.

fd3 is the parent's actual pinned DATA directory; acquire actions use the
parent's actual lockfile fd4. Never LOCK_UN fd4: the parent retains its flock
through callback/IO/close, including helper crashes. No Auth/native/target grant.
All descendants are fixed names or UUID/hash allowlisted. No recursive fallback.
"""
import datetime
import fcntl
import hashlib
import json
import os
import re
import stat
import sys
import uuid

CONTROL = "canvas-upload-live"
ANCHOR = "canvas-upload-live-anchor.json"
INIT_LOCK = "canvas-upload-live-initialize.lock"
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
READ = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
UUID = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z")
SOURCE_LIMIT = 5 * 1024 * 1024
MANIFEST_LIMIT = 16 * 1024 * 1024
RECORD_LIMIT = 128 * 1024


class Refused(Exception):
    pass


def fail(code):
    raise Refused(code)


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def decode(data):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                fail("UPLOAD_STATE_UNCONFIRMED")
            value[key] = item
        return value
    return json.loads(data, object_pairs_hook=unique)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def identity(info):
    return {"dev": str(info.st_dev), "ino": str(info.st_ino), "uid": info.st_uid, "mode": stat.S_IMODE(info.st_mode)}


def profile(info):
    return {**identity(info), "size": info.st_size, "nlink": info.st_nlink,
            "mtime": str(info.st_mtime_ns), "ctime": str(info.st_ctime_ns)}


def directory(fd, private=True):
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & (0o077 if private else 0o022):
        fail("UPLOAD_STATE_UNCONFIRMED")
    return identity(info)


def open_directory(parent, name, private=True):
    fd = os.open(name, DIRECTORY, dir_fd=parent)
    try:
        directory(fd, private)
        return fd
    except BaseException:
        os.close(fd)
        raise


def named(parent, name, fd):
    if identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != identity(os.fstat(fd)):
        fail("UPLOAD_STATE_UNCONFIRMED")


def regular(info):
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        fail("UPLOAD_STATE_UNCONFIRMED")


def read_file(parent, name, limit):
    fd = os.open(name, READ, dir_fd=parent)
    try:
        before = os.fstat(fd)
        regular(before)
        if before.st_size > limit:
            fail("UPLOAD_STATE_UNCONFIRMED")
        data = bytearray()
        while len(data) <= before.st_size:
            chunk = os.read(fd, min(65536, before.st_size + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if profile(before) != profile(os.fstat(fd)) or profile(before) != profile(os.stat(name, dir_fd=parent, follow_symlinks=False)) or len(data) != before.st_size:
            fail("UPLOAD_STATE_UNCONFIRMED")
        return bytes(data), profile(before)
    finally:
        os.close(fd)


def phase(name):
    print(json.dumps({"stage": name}), flush=True)
    if sys.stdin.readline() != "continue\n":
        fail("UPLOAD_STATE_UNCONFIRMED")


def publish(parent, name, data):
    temporary = "." + name + ".tmp-" + uuid.uuid4().hex
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    created = identity(os.fstat(fd))
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
        os.fsync(fd)
        phase(name + ":file_synced")
        os.link(temporary, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        if identity(os.stat(temporary, dir_fd=parent, follow_symlinks=False)) != created:
            fail("UPLOAD_STATE_UNCONFIRMED")
        os.unlink(temporary, dir_fd=parent)
        os.fsync(parent)
        phase(name + ":published")
    finally:
        os.close(fd)


def barrier(parent, name):
    fd = os.open(name, READ, dir_fd=parent)
    try:
        regular(os.fstat(fd))
        os.fsync(fd)
    finally:
        os.close(fd)


def assert_root(root):
    current = directory(3, False)
    if current["dev"] != root["dev"] or current["ino"] != root["ino"] or identity(os.stat(root["path"], follow_symlinks=False)) != current:
        fail("UPLOAD_STATE_UNCONFIRMED")


def recover_anchor(control, temporary):
    """Finish only this namespace's exact original fsynced anchor, under INIT EX.

    Unknown/ambiguous remnants are retained. A two-link crash is attributable
    only when the original temp and final name are the very same private inode.
    This is namespace recovery, never a current upload or authorization proof.
    """
    if not re.fullmatch(r"\." + re.escape(ANCHOR) + r"\.tmp-[a-f0-9]{32}", temporary):
        fail("UPLOAD_STATE_UNCONFIRMED")
    fd = os.open(temporary, READ, dir_fd=3)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink not in [1, 2] or before.st_uid != os.geteuid() \
                or stat.S_IMODE(before.st_mode) & 0o077 or before.st_size > RECORD_LIMIT:
            fail("UPLOAD_STATE_UNCONFIRMED")
        if profile(before) != profile(os.stat(temporary, dir_fd=3, follow_symlinks=False)):
            fail("UPLOAD_STATE_UNCONFIRMED")
        raw = bytearray()
        while len(raw) <= before.st_size:
            chunk = os.read(fd, min(65536, before.st_size + 1 - len(raw)))
            if not chunk:
                break
            raw.extend(chunk)
        expected = {"version": 1, "root": directory(3, False), "control": directory(control)}
        if len(raw) != before.st_size or bytes(raw) != encode(expected) or encode(decode(raw)) != encode(expected) \
                or profile(before) != profile(os.fstat(fd)) or profile(before) != profile(os.stat(temporary, dir_fd=3, follow_symlinks=False)):
            fail("UPLOAD_STATE_UNCONFIRMED")
        named(3, CONTROL, control)
        os.fsync(fd)
        if before.st_nlink == 1:
            # link is deliberately no-replace; an existing unrelated final is
            # not adopted, overwritten, or deleted.
            os.link(temporary, ANCHOR, src_dir_fd=3, dst_dir_fd=3, follow_symlinks=False)
        final = os.stat(ANCHOR, dir_fd=3, follow_symlinks=False)
        current = os.fstat(fd)
        if current.st_nlink != 2 or profile(final) != profile(current) \
                or profile(os.stat(temporary, dir_fd=3, follow_symlinks=False)) != profile(current) \
                or identity(before) != identity(current) or before.st_size != current.st_size or before.st_mtime_ns != current.st_mtime_ns:
            fail("UPLOAD_STATE_UNCONFIRMED")
        os.lseek(fd, 0, os.SEEK_SET)
        if digest(os.read(fd, RECORD_LIMIT + 1)) != digest(raw) or profile(os.fstat(fd)) != profile(current):
            fail("UPLOAD_STATE_UNCONFIRMED")
        named(3, CONTROL, control)
        os.unlink(temporary, dir_fd=3)
        regular(os.fstat(fd))
        if identity(os.stat(ANCHOR, dir_fd=3, follow_symlinks=False)) != identity(os.fstat(fd)):
            fail("UPLOAD_STATE_UNCONFIRMED")
        os.fsync(fd)
        os.fsync(3)
        return expected
    finally:
        os.close(fd)


def initialize():
    lock = os.open(INIT_LOCK, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=3)
    control = None
    try:
        regular(os.fstat(lock))
        fcntl.flock(lock, fcntl.LOCK_EX)
        named(3, INIT_LOCK, lock)
        remnants = [name for name in os.listdir(3) if name.startswith("." + ANCHOR + ".tmp-")]
        if len(remnants) > 1:
            fail("UPLOAD_STATE_UNCONFIRMED")
        try:
            control = open_directory(3, CONTROL)
        except FileNotFoundError:
            if remnants:
                fail("UPLOAD_STATE_UNCONFIRMED")
            try:
                os.stat(ANCHOR, dir_fd=3, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                fail("UPLOAD_STATE_UNCONFIRMED")
            try:
                os.mkdir(CONTROL, 0o700, dir_fd=3)
            except FileExistsError:
                fail("UPLOAD_STATE_UNCONFIRMED")
            control = open_directory(3, CONTROL)
            anchor = {"version": 1, "root": directory(3, False), "control": directory(control)}
            publish(3, ANCHOR, encode(anchor))
        else:
            if remnants:
                anchor = recover_anchor(control, remnants[0])
            else:
                try:
                    anchor = decode(read_file(3, ANCHOR, RECORD_LIMIT)[0])
                except FileNotFoundError:
                    fail("UPLOAD_STATE_UNCONFIRMED")
        if encode(anchor) != encode({"version": 1, "root": directory(3, False), "control": directory(control)}):
            fail("UPLOAD_STATE_UNCONFIRMED")
        barrier(3, ANCHOR)
        os.fsync(control)
        os.fsync(3)
        named(3, CONTROL, control)
        return {"control": directory(control)}
    finally:
        if control is not None:
            os.close(control)
        os.close(lock)


def open_control():
    fd = open_directory(3, CONTROL)
    try:
        anchor = decode(read_file(3, ANCHOR, RECORD_LIMIT)[0])
        if encode(anchor) != encode({"version": 1, "root": directory(3, False), "control": directory(fd)}):
            fail("UPLOAD_STATE_UNCONFIRMED")
        return fd
    except BaseException:
        os.close(fd)
        raise


def date(value):
    if not isinstance(value, str) or len(value) > 64:
        fail("UPLOAD_STATE_UNCONFIRMED")
    parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        fail("UPLOAD_STATE_UNCONFIRMED")
    return int(parsed.timestamp() * 1000)


def inspect_session(selection, with_source=False):
    uploads = workspace = session = None
    try:
        uploads = open_directory(3, ".uploads", False)
        workspace = open_directory(uploads, "workspace")
        session = open_directory(workspace, selection["sessionId"])
        raw, original = read_file(session, "session.json", MANIFEST_LIMIT)
        value = decode(raw)
        if not isinstance(value, dict) or value.get("id") != selection["sessionId"] or not isinstance(value.get("userId"), str) or not isinstance(value.get("workspaceId"), str):
            fail("UPLOAD_STATE_UNCONFIRMED")
        if selection.get("userId") is not None and (value["userId"] != selection["userId"] or value["workspaceId"] != selection["workspaceId"]):
            fail("UPLOAD_FORBIDDEN")
        date(value.get("createdAt"))
        expires = date(value.get("expiresAt"))
        files = value.get("files")
        if not isinstance(value.get("targetDir"), str) or not isinstance(files, list) or not 1 <= len(files) <= 1000:
            fail("UPLOAD_STATE_UNCONFIRMED")
        immutable = []
        for file in files:
            if not isinstance(file, dict) or not isinstance(file.get("id"), str) or not UUID.fullmatch(file["id"]) \
                    or type(file.get("sourceIndex")) is not int or not 0 <= file["sourceIndex"] < 1000 \
                    or type(file.get("size")) is not int or not 0 <= file["size"] <= 5 * 1024 * 1024 * 1024 \
                    or any(not isinstance(file.get(key), str) for key in ["relativePath", "targetPath"]) \
                    or file.get("mimeType") is not None and not isinstance(file["mimeType"], str):
                fail("UPLOAD_STATE_UNCONFIRMED")
            immutable.append({key: file.get(key) for key in ["id", "sourceIndex", "relativePath", "targetPath", "size", "mimeType"]})
        if len({file["id"] for file in immutable}) != len(files):
            fail("UPLOAD_STATE_UNCONFIRMED")
        birth = {"root": directory(3, False), "directory": directory(session), "manifest": digest(encode({
            "id": value["id"], "userId": value["userId"], "workspaceId": value["workspaceId"], "targetDir": value["targetDir"],
            "createdAt": value["createdAt"], "expiresAt": value["expiresAt"], "files": immutable}))}
        result = {"birth": birth, "birthFingerprint": digest(encode(birth)), "userId": value["userId"], "workspaceId": value["workspaceId"],
                  "expiresAtMs": expires, "files": [file["id"] for file in immutable]}
        if selection.get("fileId") is not None:
            matches = [file for file in files if file["id"] == selection["fileId"]]
            if len(matches) != 1:
                fail("UPLOAD_FILE_NOT_FOUND")
            file = matches[0]
            if with_source:
                if "officeAttempt" in file or file["size"] > SOURCE_LIMIT:
                    fail("UPLOAD_STATE_UNCONFIRMED")
                progress_name = selection["fileId"] + ".part.json"
                try:
                    progress_raw, progress_profile = read_file(session, progress_name, RECORD_LIMIT)
                    progress = decode(progress_raw)
                except FileNotFoundError:
                    progress, progress_profile = file, None
                if progress.get("status") not in (["pending", "uploaded"] if file["size"] == 0 else ["uploaded"]) or type(progress.get("uploadedBytes")) is not int or progress["uploadedBytes"] != file["size"]:
                    fail("UPLOAD_FILE_INCOMPLETE")
                source, source_profile = read_file(session, selection["fileId"] + ".part", SOURCE_LIMIT)
                if len(source) != file["size"]:
                    fail("UPLOAD_STATE_UNCONFIRMED")
                if progress_profile is not None and read_file(session, progress_name, RECORD_LIMIT)[1] != progress_profile:
                    fail("UPLOAD_STATE_UNCONFIRMED")
                result.update({"sourceHash": digest(source), "sourceBytes": len(source), "sourceProfile": source_profile,
                               "targetPath": file["targetPath"]})
        if read_file(session, "session.json", MANIFEST_LIMIT)[1] != original:
            fail("UPLOAD_STATE_UNCONFIRMED")
        named(3, ".uploads", uploads)
        named(uploads, "workspace", workspace)
        named(workspace, selection["sessionId"], session)
        return result
    finally:
        for fd in [session, workspace, uploads]:
            if fd is not None:
                os.close(fd)


def terminal(control, selection):
    try:
        raw, _ = read_file(control, selection["sessionId"] + ".terminal.json", RECORD_LIMIT)
    except FileNotFoundError:
        return None
    value = decode(raw)
    def valid_directory(value):
        return isinstance(value, dict) and set(value) == {"dev", "ino", "uid", "mode"} \
            and all(isinstance(value.get(key), str) and re.fullmatch(r"[0-9]+", value[key]) for key in ["dev", "ino"]) \
            and type(value.get("uid")) is int and value["uid"] == os.geteuid() \
            and type(value.get("mode")) is int and 0 <= value["mode"] <= 0o7777 and not value["mode"] & 0o077
    if not isinstance(value, dict) or set(value) != {"version", "sessionId", "reason", "userId", "workspaceId", "birth", "files"} \
            or type(value["version"]) is not int or value["version"] != 1 or value["sessionId"] != selection["sessionId"] \
            or value["reason"] not in ["cancelled", "expired"] or not isinstance(value["userId"], str) or not isinstance(value["workspaceId"], str) \
            or not isinstance(value["birth"], dict) or set(value["birth"]) != {"root", "directory", "manifest"} \
            or not valid_directory(value["birth"]["directory"]) \
            or encode(value["birth"]["root"]) != encode(directory(3, False)) or not re.fullmatch(r"[a-f0-9]{64}", value["birth"].get("manifest", "")) \
            or not isinstance(value["files"], list) or not 1 <= len(value["files"]) <= 1000 \
            or any(not isinstance(file, str) or not UUID.fullmatch(file) for file in value["files"]) or len(set(value["files"])) != len(value["files"]):
        fail("UPLOAD_STATE_UNCONFIRMED")
    if selection.get("userId") is not None and (value["userId"] != selection["userId"] or value["workspaceId"] != selection["workspaceId"]):
        fail("UPLOAD_STATE_UNCONFIRMED")
    # If staging remains, the historical marker must bind THAT actual birth.
    try:
        current = inspect_session(selection)
        if encode(current["birth"]) != encode(value["birth"]) or current["files"] != value["files"]:
            fail("UPLOAD_STATE_UNCONFIRMED")
    except FileNotFoundError:
        pass
    barrier(control, selection["sessionId"] + ".terminal.json")
    os.fsync(control)
    return value


def remove_session(selection, receipt):
    uploads = workspace = session = None
    try:
        uploads = open_directory(3, ".uploads", False)
        workspace = open_directory(uploads, "workspace")
        try:
            session = open_directory(workspace, selection["sessionId"])
        except FileNotFoundError:
            os.fsync(workspace)
            return
        if encode(directory(session)) != encode(receipt["birth"]["directory"]):
            fail("UPLOAD_STATE_UNCONFIRMED")
        allowed = {"session.json"} | {file + suffix for file in receipt["files"] for suffix in [".part", ".part.json"]}
        names = os.listdir(session)
        # Only declared staging files and actual old atomic-temp forms; never
        # recurse into directories or remove an unfamiliar/alias object.
        for name in names:
            base = re.sub(r"\.tmp-[0-9]+-[0-9]+-[a-f0-9]+$", "", name)
            if base not in allowed:
                fail("UPLOAD_STATE_UNCONFIRMED")
            regular(os.stat(name, dir_fd=session, follow_symlinks=False))
        phase("terminal:before_remove")
        named(3, ".uploads", uploads)
        named(uploads, "workspace", workspace)
        named(workspace, selection["sessionId"], session)
        for name in names:
            regular(os.stat(name, dir_fd=session, follow_symlinks=False))
            os.unlink(name, dir_fd=session)
        os.fsync(session)
        named(workspace, selection["sessionId"], session)
        os.rmdir(selection["sessionId"], dir_fd=workspace)
        os.fsync(workspace)
        os.fsync(uploads)
        os.fsync(3)
        phase("terminal:removed")
    finally:
        for fd in [session, workspace, uploads]:
            if fd is not None:
                os.close(fd)


def main():
    value = decode(sys.stdin.readline(RECORD_LIMIT))
    if not isinstance(value, dict) or set(value) - {"action", "root", "sessionId", "fileId", "userId", "workspaceId", "mode", "reason", "nowMs"}:
        fail("UPLOAD_STATE_UNCONFIRMED")
    root = value.get("root")
    if not isinstance(root, dict) or set(root) != {"path", "dev", "ino"} or not isinstance(root["path"], str) or not os.path.isabs(root["path"]) \
            or not isinstance(value.get("sessionId"), str) or not UUID.fullmatch(value["sessionId"]) \
            or value.get("fileId") is not None and (not isinstance(value["fileId"], str) or not UUID.fullmatch(value["fileId"])):
        fail("UPLOAD_NOT_FOUND")
    assert_root(root)
    action = value.get("action")
    if action == "initialize":
        return initialize()
    control = open_control()
    try:
        if action in ["acquire_session", "acquire_file"]:
            name = "session-" + value["sessionId"] + ".lock" if action == "acquire_session" else "file-" + digest(encode([value["sessionId"], value["fileId"]])) + ".lock"
            regular(os.fstat(4))
            named(control, name, 4)
            if value.get("mode") not in ["shared", "exclusive"] or action == "acquire_file" and value["mode"] != "exclusive":
                fail("UPLOAD_LOCK_ORDER")
            fcntl.flock(4, fcntl.LOCK_SH if value["mode"] == "shared" else fcntl.LOCK_EX)
            named(control, name, 4)
            named(3, CONTROL, control)
            assert_root(root)
            return {"locked": True}
        receipt = terminal(control, value)
        if action in ["inspect", "source"]:
            if receipt:
                fail("UPLOAD_CANCELLED" if receipt["reason"] == "cancelled" else "UPLOAD_EXPIRED")
            current = inspect_session(value, action == "source")
            if current["expiresAtMs"] <= int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000):
                fail("UPLOAD_EXPIRED")
            result = current
        elif action in ["cancel", "expire"]:
            reason = "cancelled" if action == "cancel" else "expired"
            if receipt and receipt["reason"] != reason:
                fail("UPLOAD_STATE_UNCONFIRMED")
            if not receipt:
                current = inspect_session(value)
                now = max(value.get("nowMs", 0), int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000))
                if reason == "expired" and current["expiresAtMs"] > now:
                    return {"skipped": True}
                if reason == "cancelled" and current["expiresAtMs"] <= now:
                    fail("UPLOAD_EXPIRED")
                receipt = {"version": 1, "sessionId": value["sessionId"], "reason": reason,
                           "userId": current["userId"], "workspaceId": current["workspaceId"], "birth": current["birth"], "files": current["files"]}
                publish(control, value["sessionId"] + ".terminal.json", encode(receipt))
            remove_session(value, receipt)
            result = {"terminal": reason}
        else:
            fail("UPLOAD_STATE_UNCONFIRMED")
        named(3, CONTROL, control)
        assert_root(root)
        return result
    finally:
        os.close(control)


try:
    print(json.dumps({"result": main()}, separators=(",", ":")), flush=True)
except FileNotFoundError:
    print(json.dumps({"error": "UPLOAD_NOT_FOUND"}), flush=True)
    sys.exit(1)
except BaseException as error:
    print(json.dumps({"error": str(error) if isinstance(error, Refused) else "UPLOAD_STATE_UNCONFIRMED"}), flush=True)
    sys.exit(1)
