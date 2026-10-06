#!/usr/bin/python3
"""Package-only Linux boundary: exact read roots, one scratch, inherited RPC, no networking."""
import ctypes
import errno
import importlib.util
import json
import os
import platform
import resource
import stat
import sys


class Ruleset(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class PathBeneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


class Filter(ctypes.Structure):
    _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte),
                ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint32)]


class Program(ctypes.Structure):
    _fields_ = [("length", ctypes.c_ushort), ("filter", ctypes.POINTER(Filter))]


def checked(result, operation):
    if result < 0:
        raise OSError(ctypes.get_errno(), operation)
    return result


def restrict_syscalls(libc, machine):
    if machine == "aarch64":
        architecture = 0xC00000B7
        clone_number = 220
        # All socket creation/connection/send/descriptor transfer; process
        # group escape, process-memory/FD stealing and alternate async IO.
        denied = {198, 199, 200, 201, 202, 203, 206, 211, 212, 242, 243,
                  154, 157, 117, 270, 271, 425, 438}
    elif machine == "x86_64":
        architecture = 0xC000003E
        clone_number = 56
        denied = {41, 42, 43, 44, 46, 47, 49, 50, 53, 288, 299, 307,
                  109, 112, 101, 310, 311, 425, 438, 57, 58}
    else:
        raise RuntimeError("Unsupported Linux architecture")
    filters = [Filter(0x20, 0, 0, 4), Filter(0x15, 1, 0, architecture),
               Filter(0x06, 0, 0, 0x80000000), Filter(0x20, 0, 0, 0),
               Filter(0x35, 0, 1, 473), Filter(0x06, 0, 0, 0x00050000 | errno.ENOSYS)]
    for number in sorted(denied):
        filters += [Filter(0x15, 0, 1, number), Filter(0x06, 0, 0, 0x00050000 | errno.EPERM)]
    # No new processes. Runtime threads retain the same process identity.
    # clone3 points to a structure BPF cannot inspect; glibc falls back to clone.
    filters += [Filter(0x15, 0, 1, 435), Filter(0x06, 0, 0, 0x00050000 | errno.ENOSYS),
                Filter(0x15, 0, 5, clone_number), Filter(0x20, 0, 0, 16),
                Filter(0x54, 0, 0, 0x10000), Filter(0x15, 1, 0, 0x10000),
                Filter(0x06, 0, 0, 0x00050000 | errno.EPERM), Filter(0x20, 0, 0, 0)]
    # Do not permit signaling the Canvas host or sibling runs. Self-signals
    # remain available for language-runtime abort handling and worker threads.
    pid = os.getpid()
    signal_calls = ((129, 0), (130, -1), (131, 0), (424, -1)) if machine == "aarch64" else ((62, 0), (200, -1), (234, 0), (424, -1))
    for number, argument in signal_calls:
        if argument == -1:
            filters += [Filter(0x15, 0, 1, number), Filter(0x06, 0, 0, 0x00050000 | errno.EPERM)]
        else:
            filters += [Filter(0x15, 0, 4, number), Filter(0x20, 0, 0, 16 + argument * 8),
                        Filter(0x15, 1, 0, pid), Filter(0x06, 0, 0, 0x00050000 | errno.EPERM),
                        Filter(0x20, 0, 0, 0)]
    filters += [Filter(0x06, 0, 0, 0x7FFF0000)]
    array = (Filter * len(filters))(*filters)
    checked(libc.prctl(22, 2, ctypes.byref(Program(len(filters), array)), 0, 0), "seccomp")


def canonical(value):
    if not isinstance(value, str) or not os.path.isabs(value) or os.path.realpath(value) != value:
        raise RuntimeError("Noncanonical sandbox path")
    info = os.lstat(value)
    if stat.S_ISLNK(info.st_mode) or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) or stat.S_ISCHR(info.st_mode)):
        raise RuntimeError("Invalid sandbox path")
    return value


def confine(policy):
    machine = platform.machine()
    if machine not in ("x86_64", "aarch64"):
        raise RuntimeError("Unsupported Linux architecture")
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    abi = checked(libc.syscall(444, 0, 0, 1), "Landlock version")
    if abi < 3:
        raise RuntimeError("Landlock ABI 3 is required")
    # Load only the existing trusted metadata filter before confinement; it
    # protects chmod/xattr/truncating-open/ioctl surfaces as in the Bash gate.
    spec = importlib.util.spec_from_file_location("canvas_metadata_sandbox", os.path.join(os.path.dirname(__file__), "agent-shell-sandbox.py"))
    metadata = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(metadata)
    read = (1 << 2) | (1 << 3)
    execute = 1
    writes = (1 << 1) | sum(1 << bit for bit in range(4, 15))
    handled = execute | read | writes
    ruleset = checked(libc.syscall(444, ctypes.byref(Ruleset(handled)), ctypes.sizeof(Ruleset), 0), "Landlock ruleset")
    try:
        grants = [(value, read) for value in policy.get("read", [])]
        grants += [(value, read | execute) for value in policy.get("execute", [])]
        if policy.get("scratch"):
            # No device nodes, sockets, FIFOs or executable native files.
            grants += [(policy["scratch"], read | writes & ~((1 << 6) | (1 << 9) | (1 << 10) | (1 << 11)))]
        for value in policy.get("devices", []):
            grants += [(value, (1 << 2) | (1 << 1) | (1 << 14))]
        for value, rights in grants:
            descriptor = os.open(canonical(value), os.O_PATH | os.O_CLOEXEC)
            try:
                if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
                    rights &= ~((1 << 3) | sum(1 << bit for bit in range(4, 14)))
                rule = PathBeneath(rights, descriptor)
                checked(libc.syscall(445, ruleset, 1, ctypes.byref(rule), 0), "Landlock grant")
            finally:
                os.close(descriptor)
        checked(libc.prctl(38, 1, 0, 0, 0), "no_new_privs")
        checked(libc.syscall(446, ruleset, 0), "Landlock enforcement")
    finally:
        os.close(ruleset)
    metadata.restrict_metadata(libc, machine)
    restrict_syscalls(libc, machine)
    return abi


def main():
    if sys.platform != "linux":
        raise RuntimeError("Linux is required")
    if sys.argv[1:] == ["--probe"]:
        abi = confine({})
        print(json.dumps({"abi": abi, "confined": True}))
        return
    if len(sys.argv) < 4:
        raise RuntimeError("Expected sandbox policy and executable")
    policy = json.loads(sys.argv[1])
    for descriptor in (3, 4):
        if not (stat.S_ISFIFO(os.fstat(descriptor).st_mode) or stat.S_ISSOCK(os.fstat(descriptor).st_mode)):
            raise RuntimeError("The inherited tool bridge is unavailable")
    maximum = resource.getrlimit(resource.RLIMIT_NOFILE)[0]
    os.closerange(5, maximum if maximum != resource.RLIM_INFINITY else 1_048_576)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024 * 1024, 32 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (60, 61))
    confine(policy)
    os.execv(sys.argv[2], sys.argv[2:])


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("SKILL_SCRIPT_SANDBOX_UNAVAILABLE", file=sys.stderr)
        sys.exit(126)
