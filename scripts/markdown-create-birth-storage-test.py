#!/usr/bin/env python3
"""Exercise the real private birth-store IO without invoking its stdin RPC."""
import ast
import contextlib
import fcntl
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).parent / 'runtime' / 'markdown-create-birth.py'
namespace = {'__name__': 'birth_storage_test'}
definitions = [node for node in ast.parse(SOURCE.read_text()).body
               if isinstance(node, (ast.Import, ast.ImportFrom, ast.Assign,
                                    ast.AnnAssign, ast.FunctionDef, ast.ClassDef))]
exec(compile(ast.Module(body=definitions, type_ignores=[]), str(SOURCE), 'exec'), namespace)


class BirthStorageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='canvas-owned-birth-storage-')
        self.root = Path(self.temp.name)
        self.fd = os.open(self.root, namespace['DIRECTORY'])

    def tearDown(self):
        os.close(self.fd)
        self.temp.cleanup()

    def claim(self):
        name, fd = namespace['claim_store'](self.fd)
        os.close(fd)
        return name

    @contextlib.contextmanager
    def pinned_workspace(self):
        workspace = self.root / 'workspace'
        workspace.mkdir(mode=0o700, exist_ok=True)
        workspace_fd = os.open(workspace, namespace['DIRECTORY'])
        saved, copies = {}, []
        try:
            for slot in (3, 4):
                try:
                    saved[slot] = fcntl.fcntl(slot, fcntl.F_DUPFD_CLOEXEC, 10)
                except OSError as error:
                    if error.errno != 9:
                        raise
                    saved[slot] = None
            for fd in (self.fd, workspace_fd):
                copies.append(fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 10))
            os.dup2(copies[0], 3)
            os.dup2(copies[1], 4)
            operation = 'manual-create:' + str(namespace['uuid'].uuid4())
            origin = {'workspaceId': 'owned-storage-workspace', 'userId': 'owner', 'sessionId': 'session'}
            source = {'kind': 'manual-empty-v1', 'workspaceId': origin['workspaceId'],
                      'targetPath': 'Document.md', 'actorUserId': origin['userId'],
                      'actorSessionId': origin['sessionId'], 'requestId': operation,
                      'operationId': operation, 'sourceHash': namespace['digest'](b''), 'sourceBytes': 0}
            # Attribution data only; this low-level helper grants no authority.
            yield {'action': 'open', 'key': namespace['digest'](operation.encode()),
                   'intent': {'version': 1, 'targetPath': source['targetPath'], 'origin': origin,
                              'source': source, 'operationId': operation,
                              'dataRoot': namespace['directory'](3), 'workspaceRoot': namespace['directory'](4)}}
        finally:
            for slot, previous in saved.items():
                if previous is None:
                    with contextlib.suppress(OSError):
                        os.close(slot)
                else:
                    os.dup2(previous, slot)
                    os.close(previous)
            for fd in copies:
                os.close(fd)
            os.close(workspace_fd)

    def invoke(self, message, action):
        # Feed the real ACK reader; do not replace any filesystem result.
        with contextlib.redirect_stdout(io.StringIO()), patch.object(namespace['sys'], 'stdin', io.StringIO('continue\n' * 32)):
            return namespace['run']({**message, 'action': action})

    def snapshot(self):
        result = {}
        for entry in [self.root, *sorted(self.root.rglob('*'))]:
            info = entry.lstat()
            result[str(entry.relative_to(self.root))] = (info.st_dev, info.st_ino, info.st_uid, info.st_mode,
                info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
                entry.read_bytes() if entry.is_file() else None)
        return result

    def assert_read_only_verify(self, message, error=None):
        before = self.snapshot()
        # Passthrough spies observe actual syscalls; no positive IO is mocked.
        operations = ['open', 'write', 'mkdir', 'link', 'unlink', 'rename', 'fsync', 'fchmod']
        with contextlib.ExitStack() as stack:
            observed = {name: stack.enter_context(patch.object(os, name, wraps=getattr(os, name))) for name in operations}
            if error:
                with self.assertRaisesRegex(namespace['Refused'], error):
                    self.invoke(message, 'verify')
                value = None
            else:
                value = self.invoke(message, 'verify')
        self.assertEqual(self.snapshot(), before, 'Verification must retain every original byte, inode and directory entry.')
        for name in operations[1:]:
            self.assertEqual(observed[name].call_count, 0, name + ' is not a verification operation')
        forbidden = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
        for call in observed['open'].call_args_list:
            flags = call.args[1] if len(call.args) > 1 else call.kwargs['flags']
            self.assertEqual(flags & forbidden, 0, 'Verification must open only existing read-only descriptors.')
        return value

    def test_verify_missing_namespace_does_not_initialize_it(self):
        with self.pinned_workspace() as message:
            self.assert_read_only_verify(message, 'RECORD_CHANGED')

    def test_verify_existing_intent_uses_only_read_operations(self):
        with self.pinned_workspace() as message:
            original = self.invoke(message, 'open')
            for _ in range(3):
                observed = self.assert_read_only_verify(message)
                self.assertEqual(observed, original)

    def test_verify_missing_claim_does_not_recreate_it(self):
        with self.pinned_workspace() as message:
            self.invoke(message, 'open')
            anchor = namespace['decode']((self.root / namespace['ANCHOR']).read_bytes())
            claim = self.root / anchor['storeName'] / message['key']
            claim.rename(claim.with_name(claim.name + '-retained-evidence'))
            self.assert_read_only_verify(message, 'RECORD_CHANGED')

    def test_verify_missing_lock_keeps_original_store(self):
        with self.pinned_workspace() as message:
            self.invoke(message, 'open')
            (self.root / (namespace['STORE'] + '.lock')).unlink()
            self.assert_read_only_verify(message, 'RECORD_CHANGED')

    def test_verify_missing_anchor_keeps_orphaned_store(self):
        with self.pinned_workspace() as message:
            self.invoke(message, 'open')
            (self.root / namespace['ANCHOR']).unlink()
            self.assert_read_only_verify(message, 'RECORD_CHANGED')

    def test_verify_interrupted_anchor_is_not_settled(self):
        with self.pinned_workspace() as message:
            with patch.object(os, 'unlink', side_effect=InterruptedError('owned initialization boundary')):
                with self.assertRaises(InterruptedError):
                    self.claim()
            self.assertEqual((self.root / namespace['ANCHOR']).stat().st_nlink, 2)
            self.assert_read_only_verify(message, 'RECOVERY_REQUIRED')

    def test_verify_changed_anchor_is_preserved(self):
        with self.pinned_workspace() as message:
            self.invoke(message, 'open')
            anchor = self.root / namespace['ANCHOR']
            value = namespace['decode'](anchor.read_bytes())
            value['data']['ino'] = str(int(value['data']['ino']) + 1)
            anchor.write_bytes(namespace['encode'](value))
            self.assert_read_only_verify(message, 'NAMESPACE_CHANGED')

    def test_verify_unexpected_pending_file_is_preserved(self):
        with self.pinned_workspace() as message:
            self.invoke(message, 'open')
            anchor = namespace['decode']((self.root / namespace['ANCHOR']).read_bytes())
            pending = self.root / anchor['storeName'] / 'anchor.pending'
            pending.write_bytes(b'original foreign pending evidence')
            pending.chmod(0o600)
            self.assert_read_only_verify(message, 'RECORD_CHANGED')

    def test_verify_unpublished_orphan_is_not_adopted(self):
        with self.pinned_workspace() as message:
            orphan = self.root / namespace['STORE']
            orphan.mkdir(mode=0o700)
            (orphan / 'retained-evidence').write_bytes(b'original evidence')
            self.assert_read_only_verify(message, 'RECORD_CHANGED')

    def test_first_initialization_and_reopen_preserve_pointer(self):
        # Do not enumerate, seek, or open '.' before this call: doing so can
        # hide the Linux failure caused by the original directory description.
        name = self.claim()
        anchor = self.root / namespace['ANCHOR']
        original = (anchor.read_bytes(), anchor.stat().st_ino)
        self.assertEqual(anchor.stat().st_nlink, 1)
        self.assertEqual(anchor.stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.root / name / 'anchor.pending').exists())
        for _ in range(32):
            self.assertEqual(self.claim(), name)
            self.assertEqual((anchor.read_bytes(), anchor.stat().st_ino), original)

    def test_exact_interrupted_pending_twin_is_settled(self):
        # Interrupt the real protocol immediately before its exact twin unlink.
        with patch.object(os, 'unlink', side_effect=InterruptedError('owned test boundary')):
            with self.assertRaises(InterruptedError):
                self.claim()
        anchor = self.root / namespace['ANCHOR']
        original = (anchor.read_bytes(), anchor.stat().st_ino)
        self.assertEqual(anchor.stat().st_nlink, 2)
        name = self.claim()
        self.assertEqual((anchor.read_bytes(), anchor.stat().st_ino), original)
        self.assertEqual(anchor.stat().st_nlink, 1)
        self.assertFalse((self.root / name / 'anchor.pending').exists())

    def test_changed_root_binding_is_refused_without_reset(self):
        self.claim()
        anchor = self.root / namespace['ANCHOR']
        value = namespace['decode'](anchor.read_bytes())
        value['data']['ino'] = str(int(value['data']['ino']) + 1)
        anchor.write_bytes(namespace['encode'](value))
        before = (anchor.read_bytes(), anchor.stat().st_ino, sorted(self.root.iterdir()))
        with self.assertRaisesRegex(namespace['Refused'], 'NAMESPACE_CHANGED'):
            self.claim()
        self.assertEqual((anchor.read_bytes(), anchor.stat().st_ino, sorted(self.root.iterdir())), before)

    def test_unpublished_orphan_is_never_adopted(self):
        orphan = self.root / namespace['STORE']
        orphan.mkdir(mode=0o700)
        evidence = orphan / 'retained-evidence'
        evidence.write_bytes(b'original evidence')
        inode = evidence.stat().st_ino
        self.assertNotEqual(self.claim(), orphan.name)
        self.assertEqual(evidence.read_bytes(), b'original evidence')
        self.assertEqual(evidence.stat().st_ino, inode)

    def test_unexpected_pending_file_is_preserved_and_refused(self):
        name = self.claim()
        anchor = self.root / namespace['ANCHOR']
        pending = self.root / name / 'anchor.pending'
        pending.write_bytes(b'foreign pending evidence')
        pending.chmod(0o600)
        before = (anchor.read_bytes(), anchor.stat().st_ino,
                  pending.read_bytes(), pending.stat().st_ino)
        with self.assertRaisesRegex(namespace['Refused'], 'RECORD_CHANGED'):
            self.claim()
        self.assertEqual((anchor.read_bytes(), anchor.stat().st_ino,
                          pending.read_bytes(), pending.stat().st_ino), before)

    def test_enumeration_stays_on_pinned_directory_and_sees_new_names(self):
        entries = namespace['directory_entries']
        (self.root / 'Original.md').touch()
        self.assertEqual(entries(self.fd), ['Original.md'])
        (self.root / 'New.md').touch()
        self.assertEqual(set(entries(self.fd)), {'Original.md', 'New.md'})
        moved = self.root / 'moved'
        original = self.root / 'original'
        original.mkdir()
        (original / 'pinned').touch()
        fd = os.open(original, namespace['DIRECTORY'])
        try:
            original.rename(moved)
            original.mkdir()
            (original / 'replacement').touch()
            self.assertEqual(entries(fd), ['pinned'])
        finally:
            os.close(fd)


if __name__ == '__main__':
    unittest.main()
