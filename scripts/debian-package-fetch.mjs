import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Transport never selects a version or a digest. Those come from the caller's
// authenticated repository metadata. Integrity failures do not trigger fallback.
export async function fetchVerified({ urls, destination, sha256, size, fetchImpl = globalThis.fetch, timeoutMs = 60_000 }) {
  assert.match(sha256, /^[a-f0-9]{64}$/u);
  assert(Number.isSafeInteger(size) && size > 0 && size <= 512 * 1024 * 1024);
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000);
  const allowed = new Set(['snapshot.debian.org', 'deb.debian.org', 'security.debian.org']);
  for (const value of urls) {
    const url = new URL(value);
    assert(url.protocol === 'https:' && allowed.has(url.hostname) && !url.username && !url.password && !url.port);
  }
  assert(urls.length > 0 && urls.length <= 4);
  const verify = filename => {
    const stat = fs.lstatSync(filename);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Package cache must contain regular files');
    assert.equal(stat.size, size, 'Downloaded size differs from authenticated metadata');
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let count;
      while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
    } finally { fs.closeSync(fd); }
    assert.equal(hash.digest('hex'), sha256, 'Downloaded SHA256 differs from authenticated metadata');
  };
  try { fs.lstatSync(destination); verify(destination); return { cached: true }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(path.dirname(destination), '.canvas-fetch-'));
  const file = path.join(temporary, 'payload');
  const failures = [];
  try {
    for (const url of urls) {
      let response;
      try {
        let current = url;
        const signal = AbortSignal.timeout(timeoutMs);
        for (let redirects = 0; ; redirects++) {
          response = await fetchImpl(current, { signal, redirect: 'manual' });
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          await response.body?.cancel();
          assert(redirects < 3, 'Too many Debian source redirects');
          const next = new URL(response.headers.get('location'), current);
          assert(next.protocol === 'https:' && next.hostname === new URL(url).hostname && !next.username && !next.password && !next.port, 'Redirect must remain on the same official HTTPS source');
          current = next.href;
        }
      }
      catch (error) {
        const transient = error.name === 'TimeoutError' || ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(error.cause?.code);
        if (!transient) throw error;
        failures.push(error); continue;
      }
      try {
        if (response.status === 404 || response.status >= 500) {
          failures.push(new Error(`HTTP ${response.status}: ${url}`)); continue;
        }
        assert.equal(response.status, 200, `Unexpected HTTP status: ${url}`);
        assert(response.body, 'Missing download body');
        const fd = fs.openSync(file, 'wx', 0o644);
        let bytes = 0;
        try {
          for await (const chunk of response.body) {
            bytes += chunk.byteLength;
            assert(bytes <= size, 'Downloaded size exceeds authenticated metadata');
            fs.writeFileSync(fd, chunk);
          }
        } finally { fs.closeSync(fd); }
        verify(file);
        // link is atomic and refuses to replace a concurrent cache entry.
        try { fs.linkSync(file, destination); }
        catch (error) { if (error.code !== 'EEXIST') throw error; verify(destination); }
        return { cached: false, url };
      } finally {
        if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
      }
    }
    throw new AggregateError(failures, 'All authenticated Debian package sources were unavailable');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
