"""Credential storage contracts with in-memory backends, not live OS-store acceptance."""

from __future__ import annotations

import json
import traceback
import types
import unittest
from unittest.mock import patch

from mcp.shared.auth import OAuthClientInformationFull, OAuthToken

from canvas_notebook.credentials import CredentialStorageError, KeyringTokenStorage

ENDPOINT = "https://canvas.example/mcp"
SECRET = "contract-only-token-never-include-in-errors"


class KeyringStorageTests(unittest.IsolatedAsyncioTestCase):
    def backend(self, module="keyring.backends.macOS"):
        records = {}
        calls = []

        def get_password(_self, service, kind):
            calls.append(("get", service, kind))
            return records.get((service, kind))

        def set_password(_self, service, kind, value):
            calls.append(("set", service, kind))
            records[(service, kind)] = value

        def delete_password(_self, service, kind):
            calls.append(("delete", service, kind))
            del records[(service, kind)]

        selected = type("ContractBackend", (), {
            "__module__": module, "get_password": get_password,
            "set_password": set_password, "delete_password": delete_password,
        })()
        return selected, records, calls

    def store(self, backend, endpoint=ENDPOINT, profile="contract"):
        module = types.SimpleNamespace(get_keyring=lambda: backend)
        with patch("canvas_notebook.credentials.importlib.import_module", return_value=module):
            return KeyringTokenStorage(endpoint, profile)

    def token(self, value=SECRET):
        return OAuthToken(access_token=value, token_type="Bearer", scope="knowledge:read")

    def assert_redacted(self, error):
        self.assertIsInstance(error, CredentialStorageError)
        self.assertNotIn(SECRET, str(error))
        self.assertNotIn(SECRET, "".join(traceback.format_exception(error)))

    async def test_unsafe_and_null_backends_are_rejected_without_io(self):
        for module in ("keyring.backends.null", "keyring.backends.fail",
                       "keyrings.alt.file", "application.custom_backend"):
            with self.subTest(module=module):
                backend, records, calls = self.backend(module)
                with self.assertRaises(CredentialStorageError):
                    self.store(backend)
                self.assertEqual(records, {})
                self.assertEqual(calls, [])

    async def test_missing_dependency_or_backend_failure_is_clear_and_redacted(self):
        for failure in (ModuleNotFoundError("keyring"), RuntimeError(SECRET)):
            with self.subTest(kind=type(failure).__name__):
                with patch("canvas_notebook.credentials.importlib.import_module", side_effect=failure):
                    with self.assertRaisesRegex(CredentialStorageError, "keyring extra") as raised:
                        KeyringTokenStorage(ENDPOINT)
                self.assert_redacted(raised.exception)

    async def test_supported_backend_records_are_partitioned_and_clear_retains_registration(self):
        for module in ("keyring.backends.macOS", "keyring.backends.Windows",
                       "keyring.backends.SecretService", "keyring.backends.kwallet"):
            with self.subTest(module=module):
                backend, records, calls = self.backend(module)
                first = self.store(backend)
                other_profile = self.store(backend, profile="other")
                other_endpoint = self.store(backend, endpoint="https://other.example/mcp")
                registration = OAuthClientInformationFull.model_validate({
                    "client_id": "contract-client",
                    "redirect_uris": ["http://127.0.0.1:8765/oauth/callback"],
                    "token_endpoint_auth_method": "none",
                })
                await first.set_tokens(self.token())
                await first.set_client_info(registration)
                self.assertEqual((await first.get_tokens()).access_token, SECRET)
                self.assertIsNone(await other_profile.get_tokens())
                self.assertIsNone(await other_endpoint.get_tokens())
                self.assertEqual(len(records), 2)
                await first.clear_tokens()
                self.assertIsNone(await first.get_tokens())
                self.assertEqual((await first.get_client_info()).client_id, "contract-client")
                self.assertEqual(len(records), 1)
                self.assertTrue(all(SECRET not in str(call) for call in calls))

    async def test_transplanted_or_malformed_records_never_return_credentials(self):
        backend, records, calls = self.backend()
        store = self.store(backend)
        await store.set_tokens(self.token())
        key = next(iter(records))
        original = json.loads(records[key])
        invalid = ["not JSON " + SECRET, json.dumps([SECRET])]
        for field, value in (("version", 2), ("endpoint", "https://other.example/mcp"),
                             ("profile", "other"), ("kind", "client_info"),
                             ("value", {"unexpected": SECRET})):
            invalid.append(json.dumps({**original, field: value}))
        invalid.append(json.dumps({**original, "unexpected": SECRET}))
        for record in invalid:
            with self.subTest(record_kind=type(record).__name__):
                records[key] = record
                with self.assertRaises(CredentialStorageError) as raised:
                    await store.get_tokens()
                self.assert_redacted(raised.exception)
        self.assertEqual(sum(call[0] == "set" for call in calls), 1)

    async def test_oversized_multibyte_records_fail_before_write_and_on_read(self):
        backend, records, calls = self.backend()
        store = self.store(backend)
        oversized = "😀" * 17000
        with self.assertRaises(CredentialStorageError):
            await store.set_tokens(self.token(oversized))
        self.assertEqual(calls, [])
        await store.set_tokens(self.token())
        key = next(iter(records))
        record = json.loads(records[key])
        record["value"]["access_token"] = oversized
        records[key] = json.dumps(record, ensure_ascii=False)
        self.assertLess(len(records[key]), 65536)
        self.assertGreater(len(records[key].encode("utf-8")), 65536)
        with self.assertRaises(CredentialStorageError):
            await store.get_tokens()

    async def test_chainer_uses_secure_backend_and_never_falls_back_after_io_failure(self):
        insecure, insecure_records, insecure_calls = self.backend("keyrings.alt.file")
        secure, secure_records, secure_calls = self.backend()
        chain = type("ContractChainer", (), {"__module__": "keyring.backends.chainer"})()
        chain.backends = [insecure, secure]
        store = self.store(chain)
        await store.set_tokens(self.token())
        self.assertEqual((await store.get_tokens()).access_token, SECRET)
        with patch.object(secure, "set_password", side_effect=RuntimeError(SECRET)):
            with self.assertRaisesRegex(CredentialStorageError, "did not confirm.*write") as raised:
                await store.set_tokens(self.token("replacement"))
        self.assert_redacted(raised.exception)
        self.assertEqual((await store.get_tokens()).access_token, SECRET)
        with patch.object(secure, "delete_password", side_effect=RuntimeError(SECRET)):
            with self.assertRaisesRegex(CredentialStorageError, "did not confirm.*removal") as raised:
                await store.clear_tokens()
        self.assert_redacted(raised.exception)
        self.assertEqual(len(secure_records), 1)
        self.assertTrue(secure_calls)
        self.assertEqual(insecure_records, {})
        self.assertEqual(insecure_calls, [])


if __name__ == "__main__":
    unittest.main()
