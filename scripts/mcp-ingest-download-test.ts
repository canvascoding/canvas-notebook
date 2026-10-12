import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import {
  DIRECT_MCP_INGEST_DOWNLOAD_TIMEOUT_MS,
  DirectMcpIngestDownloadError,
  downloadDirectMcpFile,
} from '../app/lib/mcp/server/ingest-download';
import { DIRECT_MCP_INGEST_MAX_BINARY_BYTES } from '../app/lib/mcp/server/ingest-validation';

type FixtureResponse = {
  status?: number;
  headers?: http.IncomingHttpHeaders;
  chunks?: Buffer[];
  stallBody?: boolean;
  error?: Error;
};

function hasCode(code: string) {
  return (error: unknown) => error instanceof DirectMcpIngestDownloadError && error.code === code;
}

async function withNetwork<T>(
  responseForPath: (path: string) => FixtureResponse,
  run: (state: { requests: http.RequestOptions[]; lookups: string[] }) => Promise<T>,
  options: { privateDns?: boolean; mixedDns?: boolean; stallDns?: boolean } = {},
): Promise<T> {
  const originalLookup = dns.lookup;
  const originalHttpsRequest = https.request;
  const originalHttpRequest = http.request;
  const state = { requests: [] as http.RequestOptions[], lookups: [] as string[] };
  dns.lookup = (async (hostname: string) => {
    state.lookups.push(hostname);
    if (options.stallDns) return new Promise(() => undefined);
    if (options.privateDns) return [{ address: '127.0.0.1', family: 4 }];
    if (options.mixedDns) return [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }];
    return [{ address: '93.184.216.34', family: 4 }];
  }) as unknown as typeof dns.lookup;
  http.request = (() => { throw new Error('HTTP transport must never be called.'); }) as unknown as typeof http.request;
  https.request = ((requestOptions: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    state.requests.push(requestOptions);
    assert.equal(requestOptions.protocol, 'https:');
    assert.equal(requestOptions.hostname, '93.184.216.34', 'the socket targets the validated public IP');
    assert.equal((requestOptions.headers as Record<string, string>).authorization, undefined);
    assert.equal((requestOptions.headers as Record<string, string>).cookie, undefined);
    assert.ok(requestOptions.signal);
    const fixture = responseForPath(String(requestOptions.path));
    const request = new EventEmitter() as http.ClientRequest;
    request.setTimeout = (milliseconds: number) => {
      assert.equal(milliseconds, DIRECT_MCP_INGEST_DOWNLOAD_TIMEOUT_MS);
      return request;
    };
    request.end = (() => {
      if (fixture.error) {
        queueMicrotask(() => request.emit('error', fixture.error));
        return request;
      }
      const response = (fixture.stallBody ? new Readable({ read() {} }) : Readable.from(fixture.chunks ?? [])) as http.IncomingMessage;
      response.statusCode = fixture.status ?? 200;
      response.statusMessage = response.statusCode === 200 ? 'OK' : 'Fixture status';
      response.headers = fixture.headers ?? {};
      callback(response);
      return request;
    }) as typeof request.end;
    return request;
  }) as typeof https.request;
  try {
    return await run(state);
  } finally {
    dns.lookup = originalLookup;
    https.request = originalHttpsRequest;
    http.request = originalHttpRequest;
  }
}

test('host references require HTTPS without credentials before any DNS or request', async () => {
  await withNetwork(() => ({}), async state => {
    for (const download_url of ['http://public.fixture.test/file?secret=hidden', 'https://user:password@public.fixture.test/file', 'file:///etc/passwd']) {
      await assert.rejects(downloadDirectMcpFile({ download_url, file_id: 'file-1' }), hasCode('unsafe_download_url'));
    }
    await assert.rejects(downloadDirectMcpFile({ download_url: 'https://public.fixture.test/file', file_id: '' }), hasCode('invalid_file_reference'));
    assert.equal(state.lookups.length, 0);
    assert.equal(state.requests.length, 0);
  });
});

test('private addresses and mixed public/private DNS results cannot dispatch a request', async () => {
  await withNetwork(() => ({}), async state => {
    for (const host of ['127.0.0.1', '2130706433', '10.0.0.1', '169.254.169.254', '[::1]', '[::ffff:127.0.0.1]', 'localhost']) {
      await assert.rejects(downloadDirectMcpFile({ download_url: `https://${host}/file?token=hidden`, file_id: 'file-1' }), hasCode('download_failed'));
    }
    assert.equal(state.requests.length, 0);
  });
  for (const options of [{ privateDns: true }, { mixedDns: true }]) {
    await withNetwork(() => ({}), async state => {
      await assert.rejects(downloadDirectMcpFile({ download_url: 'https://public.fixture.test/file', file_id: 'file-1' }), hasCode('download_failed'));
      assert.equal(state.requests.length, 0);
    }, options);
  }
});

test('each redirect enforces HTTPS, credentials and public addresses before dispatch', async () => {
  for (const location of ['http://public.fixture.test/end?token=hidden', 'https://user:secret@public.fixture.test/end', 'https://127.0.0.1/secret']) {
    await withNetwork(() => ({ status: 302, headers: { location } }), async state => {
      await assert.rejects(downloadDirectMcpFile({ download_url: 'https://public.fixture.test/start', file_id: 'file-1' }));
      assert.equal(state.requests.length, 1, 'an unsafe redirect cannot dispatch a second request');
    });
  }
});

test('public HTTPS redirect imports exact original bytes without Canvas credentials', async () => {
  const content = Buffer.from('\uFEFF---\r\ntitle: Original\r\n---\r\n# Original\r\n');
  await withNetwork(requestPath => requestPath.startsWith('/start')
    ? { status: 302, headers: { location: 'https://other.fixture.test/end?token=second' } }
    : { headers: { 'content-type': 'text/markdown; charset=utf-8' }, chunks: [content.subarray(0, 13), content.subarray(13)] }, async state => {
    const result = await downloadDirectMcpFile({ download_url: 'https://public.fixture.test/start?token=first', file_id: 'file-1' });
    assert.deepEqual(result.content, content);
    assert.equal(result.mimeType, 'text/markdown; charset=utf-8');
    assert.equal(state.requests.length, 2);
    assert.deepEqual(state.lookups, ['public.fixture.test', 'other.fixture.test']);
    assert.equal((state.requests[0].headers as Record<string, string>).host, 'public.fixture.test');
    assert.equal((state.requests[1].headers as Record<string, string>).host, 'other.fixture.test');
  });
});

test('advertised and streaming oversized files both stop at the 25 MiB boundary', async () => {
  await withNetwork(() => ({ headers: { 'content-length': String(DIRECT_MCP_INGEST_MAX_BINARY_BYTES + 1) } }), async () => {
    await assert.rejects(downloadDirectMcpFile({ download_url: 'https://public.fixture.test/file', file_id: 'file-1' }), hasCode('download_too_large'));
  });
  await withNetwork(() => ({ chunks: [Buffer.alloc(DIRECT_MCP_INGEST_MAX_BINARY_BYTES), Buffer.from([1])] }), async () => {
    await assert.rejects(downloadDirectMcpFile({ download_url: 'https://public.fixture.test/file', file_id: 'file-1' }), hasCode('download_too_large'));
  });
});

test('cancellation before dispatch, during DNS and during body reads returns safe errors', async () => {
  await withNetwork(() => ({}), async state => {
    const cancellation = new AbortController();
    cancellation.abort(new Error('Secret https://private.test/?token=hidden'));
    await assert.rejects(downloadDirectMcpFile({ download_url: 'https://public.fixture.test/file', file_id: 'file-1' }, cancellation.signal), hasCode('download_cancelled'));
    assert.equal(state.requests.length, 0);
  });
  await withNetwork(() => ({}), async state => {
    const cancellation = new AbortController();
    const download = downloadDirectMcpFile({ download_url: 'https://public.fixture.test/file', file_id: 'file-1' }, cancellation.signal);
    cancellation.abort(new Error('DNS cancellation includes a secret token=hidden'));
    await assert.rejects(download, hasCode('download_cancelled'));
    assert.equal(state.requests.length, 0);
  }, { stallDns: true });
  await withNetwork(() => ({ stallBody: true }), async state => {
    const cancellation = new AbortController();
    const download = downloadDirectMcpFile({ download_url: 'https://public.fixture.test/file', file_id: 'file-1' }, cancellation.signal);
    const timer = setTimeout(() => cancellation.abort(new Error('hidden secret')), 10);
    try {
      await assert.rejects(download, hasCode('download_cancelled'));
      assert.equal(state.requests.length, 1);
    } finally { clearTimeout(timer); }
  });
});

test('redirect loops, partial responses and network failures never expose URL tokens', async () => {
  await withNetwork(() => ({ status: 302, headers: { location: '/again?token=hidden' } }), async state => {
    await assert.rejects(downloadDirectMcpFile({ download_url: 'https://public.fixture.test/start?token=hidden', file_id: 'file-1' }), hasCode('download_failed'));
    assert.equal(state.requests.length, 4);
  });
  await withNetwork(() => ({ status: 206, headers: { 'content-range': 'bytes 0-1/50' }, chunks: [Buffer.from('AB')] }), async () => {
    await assert.rejects(downloadDirectMcpFile({ download_url: 'https://public.fixture.test/file', file_id: 'file-1' }), hasCode('download_failed'));
  });
  await withNetwork(() => ({ headers: { 'content-encoding': 'gzip', 'content-type': 'text/markdown' }, chunks: [Buffer.from([0x1f, 0x8b, 0x08])] }), async () => {
    await assert.rejects(downloadDirectMcpFile({ download_url: 'https://public.fixture.test/file', file_id: 'file-1' }), hasCode('download_failed'));
  });
  await withNetwork(() => ({ error: new Error('TLS failure at https://public.fixture.test/?token=hidden') }), async () => {
    await assert.rejects(downloadDirectMcpFile({ download_url: 'https://public.fixture.test/file?token=hidden', file_id: 'file-1' }), error => {
      assert.ok(error instanceof DirectMcpIngestDownloadError);
      assert.equal(error.code, 'download_failed');
      assert.doesNotMatch(error.message, /https?:|token=|hidden|public\.fixture/u);
      assert.equal(error.cause, undefined);
      return true;
    });
  });
});
