import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lYjG7wAAAABJRU5ErkJggg==',
  'base64',
);

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-icons-'));
  process.env.CANVAS_DATA_ROOT = tempRoot;

  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><head><link rel="icon" href="/icon.png"></head><body>ok</body></html>');
      return;
    }
    if (req.url === '/icon.png') {
      res.setHeader('Content-Type', 'image/png');
      res.end(pngBytes);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const baseUrl = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`;

  try {
    const { writeMcpConfigRaw } = await import('../app/lib/mcp/config');
    const { getMcpServerIconMetadata, readMcpServerIconFile } = await import('../app/lib/mcp/icons');

    await writeMcpConfigRaw(JSON.stringify({
      settings: { toolPrefix: 'server', idleTimeout: 10 },
      mcpServers: {
        'Google Calendar': {
          url: `${baseUrl}/mcp`,
          auth: 'none',
        },
      },
    }, null, 2));

    const metadata = await getMcpServerIconMetadata('Google Calendar');
    assert.equal(metadata?.origin, baseUrl);
    assert.equal(metadata?.contentType, 'image/png');
    assert.equal(Boolean(metadata?.fileName), true);

    const icon = await readMcpServerIconFile('Google Calendar');
    assert.equal(icon?.contentType, 'image/png');
    assert.deepEqual(icon?.buffer, pngBytes);

    console.log('mcp-icons-test: ok');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
