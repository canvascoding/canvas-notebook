#!/usr/bin/python3
"""Linux write confinement for Canvas agent shells, without root or containers.

Landlock ABI >= 3 protects file content and directory entries. Seccomp denies
metadata mutations that Landlock does not yet mediate. Consequently chmod,
chown, xattr and timestamp updates are unavailable even in scratch; ordinary
file creation, writing and atomic renames within scratch remain available.

Contract reference: https://docs.kernel.org/userspace-api/landlock.html
This is deliberately not a general-purpose network or read-access sandbox.
"""

import ctypes
import errno
import os
import platform
import resource
import sys


class Ruleset(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class PathBeneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


class SockFilter(ctypes.Structure):
    _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte),
                ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint32)]


class SockFprog(ctypes.Structure):
    _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(SockFilter))]


def checked(result, operation):
    if result < 0:
        error = ctypes.get_errno()
        raise OSError(error, f"{operation}: {os.strerror(error)}")
    return result


def restrict_metadata(libc, machine):
    # seccomp_data: syscall number at offset 0, audit architecture at offset 4.
    # Reject alternate syscall ABIs rather than letting them bypass the list.
    if machine == "x86_64":
        architecture = 0xC000003E
        ioctl_number = 16
        denied = {
            90, 91, 92, 93, 94,  # chmod/fchmod/chown/fchown/lchown
            132, 235, 261, 268, 280,  # utime/utimes/futimesat/fchmodat/utimensat
            260,  # fchownat
            188, 189, 190, 197, 198, 199,  # set/remove xattr variants
            425,  # io_uring_setup (avoid a second metadata syscall surface)
            452,  # fchmodat2
            463, 466, 469,  # setxattrat/removexattrat/file_setattr
        }
    elif machine == "aarch64":
        architecture = 0xC00000B7
        ioctl_number = 29
        denied = {
            5, 6, 7, 14, 15, 16,  # set/remove xattr variants
            52, 53, 54, 55,  # fchmod/fchmodat/fchownat/fchown
            88,  # utimensat
            425, 452,  # io_uring_setup/fchmodat2
            463, 466, 469,  # setxattrat/removexattrat/file_setattr
        }
    else:
        raise RuntimeError(f"Unsupported Linux sandbox architecture: {machine}")

    # BPF_LD|BPF_W|BPF_ABS, BPF_JMP|BPF_JEQ|BPF_K, BPF_RET|BPF_K.
    filters = [
        SockFilter(0x20, 0, 0, 4),
        SockFilter(0x15, 1, 0, architecture),
        SockFilter(0x06, 0, 0, 0x80000000),  # SECCOMP_RET_KILL_PROCESS
        SockFilter(0x20, 0, 0, 0),
        # The reviewed syscall table ends at 472. Future APIs must not gain
        # unchecked metadata-write access; they return ENOSYS until reviewed.
        # This also rejects the x32 syscall-number bit/range on x86-64.
        SockFilter(0x35, 0, 1, 473),
        SockFilter(0x06, 0, 0, 0x00050000 | errno.ENOSYS),
    ]
    for number in sorted(denied):
        filters.extend([
            SockFilter(0x15, 0, 1, number),
            SockFilter(0x06, 0, 0, 0x00050000 | errno.EPERM),
        ])
    # Some filesystem ioctls can mutate an inode opened read-only. Permit only
    # descriptor/terminal operations required by ordinary non-PTY commands;
    # no filesystem/device-specific mutation ioctls are exposed.
    allowed_ioctls = (0x5401, 0x5413, 0x541B, 0x5421, 0x5450, 0x5451, 0x5452)
    filters.append(SockFilter(0x15, 0, 2 * len(allowed_ioctls) + 2, ioctl_number))
    filters.append(SockFilter(0x20, 0, 0, 24))  # seccomp_data.args[1], low word
    for request in allowed_ioctls:
        filters.extend([
            SockFilter(0x15, 0, 1, request),
            SockFilter(0x06, 0, 0, 0x7FFF0000),
        ])
    filters.append(SockFilter(0x06, 0, 0, 0x00050000 | errno.EPERM))
    filters.append(SockFilter(0x06, 0, 0, 0x7FFF0000))  # SECCOMP_RET_ALLOW
    buffer = (SockFilter * len(filters))(*filters)
    program = SockFprog(len(filters), buffer)
    checked(libc.prctl(22, 2, ctypes.byref(program), 0, 0), "seccomp")


def confine(scratch):
    machine = platform.machine()
    if machine not in ("x86_64", "aarch64"):
        raise RuntimeError(f"Unsupported Linux sandbox architecture: {machine}")
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    # These syscall numbers are shared by the supported x86-64/aarch64 ABIs.
    create_ruleset, add_rule, restrict_self = 444, 445, 446
    abi = checked(libc.syscall(create_ruleset, 0, 0, 1), "Landlock version")
    if abi < 3:
        raise RuntimeError(f"Landlock ABI 3 or newer is required (found {abi})")

    write_file = 1 << 1
    remove_dir, remove_file = 1 << 4, 1 << 5
    make_char, make_dir, make_reg = 1 << 6, 1 << 7, 1 << 8
    make_sock, make_fifo, make_block, make_sym = 1 << 9, 1 << 10, 1 << 11, 1 << 12
    refer, truncate = 1 << 13, 1 << 14
    handled = (write_file | remove_dir | remove_file | make_char | make_dir |
               make_reg | make_sock | make_fifo | make_block | make_sym | refer | truncate)
    # Never permit raw device creation; scratch consists of ordinary files.
    scratch_rights = handled & ~(make_char | make_block)
    attributes = Ruleset(handled)
    ruleset_fd = checked(libc.syscall(create_ruleset, ctypes.byref(attributes),
                                    ctypes.sizeof(attributes), 0), "Landlock ruleset")
    try:
        for target, rights in ((scratch, scratch_rights), ("/dev/null", write_file | truncate)):
            descriptor = os.open(target, os.O_PATH | os.O_CLOEXEC)
            try:
                rule = PathBeneath(rights, descriptor)
                checked(libc.syscall(add_rule, ruleset_fd, 1, ctypes.byref(rule), 0),
                        "Landlock path rule")
            finally:
                os.close(descriptor)
        checked(libc.prctl(38, 1, 0, 0, 0), "no_new_privs")
        checked(libc.syscall(restrict_self, ruleset_fd, 0), "Landlock enforcement")
    finally:
        os.close(ruleset_fd)
    restrict_metadata(libc, machine)


def main():
    if sys.platform != "linux" or len(sys.argv) < 3:
        raise RuntimeError("Expected Linux, a scratch directory and an executable")
    scratch = sys.argv[1]
    if not os.path.isabs(scratch) or os.path.realpath(scratch) != scratch or not os.path.isdir(scratch):
        raise RuntimeError("The scratch directory must be a canonical absolute directory")
    # A pre-opened writable descriptor can bypass path-based confinement.
    # The Node launcher supplies only stdin/stdout/stderr; also close any
    # unexpected descriptors rather than trusting inherited process state.
    maximum = resource.getrlimit(resource.RLIMIT_NOFILE)[0]
    os.closerange(3, maximum if maximum != resource.RLIM_INFINITY else 1_048_576)
    confine(scratch)
    os.execv(sys.argv[2], sys.argv[2:])


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"AGENT_SHELL_SANDBOX_UNAVAILABLE: {error}", file=sys.stderr)
        sys.exit(126)
