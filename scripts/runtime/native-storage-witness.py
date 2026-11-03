#!/usr/bin/env python3
"""Inspect native storage on Linux without modifying or authorizing it."""

import argparse
import ctypes
import hashlib
import json
import os
import re
import secrets
import stat
import sys


MARKERS = (
    "canvas-markdown-create-births-anchor.json",
    "canvas-markdown-upload-attempts-anchor.json",
    "canvas-upload-live-anchor.json",
)
MAX_HANDLE_BYTES = 128
MAX_MARKER_BYTES = 4096
AT_EMPTY_PATH = 0x1000
BINDING = "canvas-native-storage-binding.json"


class FileHandle(ctypes.Structure):
    _fields_ = [
        ("size", ctypes.c_uint),
        ("kind", ctypes.c_int),
        ("data", ctypes.c_ubyte * MAX_HANDLE_BYTES),
    ]


def profile(info):
    return {
        "device": str(info.st_dev),
        "inode": str(info.st_ino),
        "owner": info.st_uid,
        "mode": stat.S_IMODE(info.st_mode),
    }


def marker_profile(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_mode,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def witness(fd):
    libc = ctypes.CDLL(None, use_errno=True)
    name_to_handle = libc.name_to_handle_at
    name_to_handle.argtypes = [
        ctypes.c_int, ctypes.c_char_p, ctypes.POINTER(FileHandle),
        ctypes.POINTER(ctypes.c_int), ctypes.c_int,
    ]
    name_to_handle.restype = ctypes.c_int
    handle = FileHandle()
    handle.size = MAX_HANDLE_BYTES
    mount = ctypes.c_int()
    if name_to_handle(fd, b"", ctypes.byref(handle), ctypes.byref(mount), AT_EMPTY_PATH) != 0:
        raise OSError(ctypes.get_errno(), "Native file handle unavailable")
    fsid = os.fstatvfs(fd).f_fsid
    if not fsid or handle.kind <= 0 or not 0 < handle.size <= MAX_HANDLE_BYTES:
        raise ValueError("Missing filesystem identity")
    return {
        "fileSystemId": f"{fsid:x}",
        "handleType": handle.kind,
        "handleSha256": hashlib.sha256(bytes(handle.data[:handle.size])).hexdigest(),
    }


def marker_witness(root_fd, name, root_info):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root_fd)
    except FileNotFoundError:
        return None
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
                or before.st_uid != root_info.st_uid or before.st_dev != root_info.st_dev
                or stat.S_IMODE(before.st_mode) != 0o600 or not 0 < before.st_size <= MAX_MARKER_BYTES):
            raise ValueError("Unexpected marker profile")
        with os.fdopen(os.dup(fd), "rb") as reader:
            content = reader.read(MAX_MARKER_BYTES + 1)
        value = json.loads(content)
        identity = value.get("data" if name == MARKERS[0] else "root") if isinstance(value, dict) else None
        root_matches = identity == {
            "dev": str(root_info.st_dev), "ino": str(root_info.st_ino),
            "uid": root_info.st_uid, "mode": stat.S_IMODE(root_info.st_mode),
        }
        result = {
            "profile": profile(before),
            "object": witness(fd),
            "contentSha256": hashlib.sha256(content).hexdigest(),
            "rootMatches": root_matches,
        }
        if (len(content) != before.st_size or marker_profile(before) != marker_profile(os.fstat(fd))
                or marker_profile(before) != marker_profile(os.stat(name, dir_fd=root_fd, follow_symlinks=False))):
            raise ValueError("Marker changed during observation")
        return result
    finally:
        os.close(fd)


def inspect(root, initialize=False, verify=False):
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        root_witness = witness(fd)
        markers = {name: marker_witness(fd, name, before) for name in MARKERS}
        observed = {"version": 1, "root": profile(before), "object": root_witness, "markers": markers}
        if verify:
            observed["binding"] = verify_binding(fd, before, root_witness)
        if (profile(before) != profile(os.fstat(fd)) or witness(fd) != root_witness
                or profile(before) != profile(os.stat(root, follow_symlinks=False))):
            raise ValueError("Root changed during observation")
        if initialize:
            initialize_binding(fd, before, observed)
        return observed
    finally:
        os.close(fd)


def initialize_binding(root_fd, info, observed):
    if info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise ValueError("The data root must be owned by the runtime user")
    if any(marker is not None and not marker["rootMatches"] for marker in observed["markers"].values()):
        raise ValueError("The existing markers must match the original storage root")
    binding = {key: observed[key] for key in ("version", "root", "object")}
    encoded = (json.dumps(binding, sort_keys=True, separators=(",", ":")) + "\n").encode()
    temporary = "." + BINDING + "." + secrets.token_hex(16)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root_fd)
    try:
        with os.fdopen(fd, "wb") as target:
            target.write(encoded)
            target.flush()
            os.fsync(target.fileno())
        if witness(root_fd) != binding["object"] or profile(os.fstat(root_fd)) != binding["root"]:
            raise ValueError("The data root changed before publication")
        os.link(temporary, BINDING, src_dir_fd=root_fd, dst_dir_fd=root_fd, follow_symlinks=False)
        os.fsync(root_fd)
    finally:
        os.unlink(temporary, dir_fd=root_fd)
        os.fsync(root_fd)


def verify_binding(root_fd, info, root_witness):
    if info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise ValueError("The data root must be owned by the runtime user")
    fd = os.open(BINDING, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root_fd)
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
                or before.st_uid != info.st_uid or before.st_dev != info.st_dev
                or stat.S_IMODE(before.st_mode) != 0o600 or not 0 < before.st_size <= MAX_MARKER_BYTES):
            raise ValueError("Unexpected binding profile")
        with os.fdopen(os.dup(fd), "rb") as reader:
            raw = reader.read(MAX_MARKER_BYTES + 1)
        if (len(raw) != before.st_size or marker_profile(before) != marker_profile(os.fstat(fd))
                or marker_profile(before) != marker_profile(os.stat(BINDING, dir_fd=root_fd, follow_symlinks=False))):
            raise ValueError("Binding changed during observation")
        binding = json.loads(raw)
        if (not isinstance(binding, dict) or set(binding) != {"version", "root", "object"}
                or (json.dumps(binding, sort_keys=True, separators=(",", ":")) + "\n").encode() != raw
                or type(binding["version"]) is not int or binding["version"] != 1
                or binding["object"] != root_witness):
            raise ValueError("The binding does not identify this data root")
        prior = binding["root"]
        current = profile(info)
        if (not isinstance(prior, dict) or set(prior) != set(current)
                or not isinstance(prior["device"], str) or not re.fullmatch(r"0|[1-9][0-9]{0,19}", prior["device"])
                or int(prior["device"]) >= 2**64 or type(prior["owner"]) is not int or type(prior["mode"]) is not int
                or {**prior, "device": current["device"]} != current):
            raise ValueError("The recorded storage profile changed")
        return {"recordedDevice": prior["device"], "currentDevice": current["device"]}
    finally:
        os.close(fd)


def read_device_map(root_fd):
    """Derive a device alias from the already-open root, never from a path."""
    before = os.fstat(root_fd)
    if not stat.S_ISDIR(before.st_mode) or before.st_uid != os.geteuid() or before.st_mode & 0o022:
        raise ValueError("Unexpected storage directory")
    try:
        os.stat(BINDING, dir_fd=root_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    current = witness(root_fd)
    alias = verify_binding(root_fd, before, current)
    if profile(os.fstat(root_fd)) != profile(before) or witness(root_fd) != current:
        raise ValueError("The opened storage directory changed")
    return alias


def storage_device_mapper(root_fd):
    """Select a recorded identity only for objects on the verified device."""
    alias = read_device_map(root_fd)
    if alias is None:
        raise ValueError("Storage binding disappeared")

    def map_device(device):
        if device != alias["currentDevice"]:
            raise ValueError("Object is outside the verified storage device")
        return alias["recordedDevice"]

    return map_device


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--root")
    source.add_argument("--device-map-fd", action="store_true",
                        help="Verify the already-open storage directory on inherited descriptor 3")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--initialize-binding", action="store_true",
                        help="Record the current, verified root once while the service is offline")
    action.add_argument("--verify-binding", action="store_true",
                        help="Compare the recorded root with the current opened directory")
    args = parser.parse_args()
    if sys.platform != "linux":
        parser.error("Linux descriptor file handles are required")
    if args.device_map_fd and (args.initialize_binding or args.verify_binding):
        parser.error("Descriptor verification is a separate read-only operation")
    if args.root is not None and not os.path.isabs(args.root):
        parser.error("An absolute storage root is required")
    try:
        result = read_device_map(3) if args.device_map_fd else inspect(
            args.root, initialize=args.initialize_binding, verify=args.verify_binding)
        print(json.dumps(result, sort_keys=True))
    except (AttributeError, OSError, ValueError):
        print(json.dumps({"code": "NATIVE_STORAGE_WITNESS_UNAVAILABLE"}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
