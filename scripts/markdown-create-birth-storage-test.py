#!/usr/bin/env python3
"""Exercise the real private birth-store IO without invoking its stdin RPC."""
import ast
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
