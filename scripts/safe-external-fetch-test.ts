import assert from 'node:assert/strict';

import { fetchExternalResourceSafely } from '../app/lib/security/safe-external-fetch';

async function main(): Promise<void> {
  await assert.rejects(
    fetchExternalResourceSafely('http://127.0.0.1'),
    /Blocked private or local network address/u,
  );
  await assert.rejects(
    fetchExternalResourceSafely('http://[::1]'),
    /Blocked private or local network address/u,
  );
  await assert.rejects(
    fetchExternalResourceSafely('http://[::ffff:127.0.0.1]'),
    /Blocked private or local network address/u,
  );
  await assert.rejects(
    fetchExternalResourceSafely('http://localhost'),
    /Localhost URLs are not allowed/u,
  );
  await assert.rejects(
    fetchExternalResourceSafely('http://example.com:8080'),
    /Only standard HTTP\(S\) ports are allowed/u,
  );
  await assert.rejects(
    fetchExternalResourceSafely('file:///etc/passwd'),
    /Only http:\/\/ and https:\/\/ URLs are allowed/u,
  );

  console.log('safe external fetch test passed');
}

main().catch(() => {
  console.error('safe external fetch test failed');
  process.exitCode = 1;
});
