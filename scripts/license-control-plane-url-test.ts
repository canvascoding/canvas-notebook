import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';

function readEnvironmentFile(fileName: string): Record<string, string> {
  const filePath = path.join(process.cwd(), fileName);
  return existsSync(filePath)
    ? dotenv.parse(readFileSync(filePath, 'utf8'))
    : {};
}

function requireLoopbackUrl(environment: Record<string, string | undefined>, name: string): URL {
  const raw = environment[name]?.trim();
  assert.ok(raw, `${name} must be configured for the local license test`);
  assert.doesNotMatch(raw, /(?:^|\.)api\.canvasnotebook\.app(?::|\/|$)/iu);
  const url = new URL(raw);
  assert.equal(url.protocol, 'http:', `${name} must use local HTTP`);
  assert.ok(
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    `${name} must use a loopback host`,
  );
  return url;
}

const environment = {
  ...readEnvironmentFile('.env.local'),
  ...readEnvironmentFile('.env.development.local'),
  ...process.env,
};

assert.equal(
  environment.CANVAS_LICENSE_RUNTIME_ENVIRONMENT,
  'development',
  'The local license test must run in the development runtime',
);
assert.equal(
  environment.CANVAS_LICENSE_CERT?.trim() || '',
  '',
  'The local license test must use the real claim and refresh flow instead of CANVAS_LICENSE_CERT',
);

const apiUrl = requireLoopbackUrl(environment, 'CANVAS_LICENSE_CONTROL_PLANE_URL');
const webUrl = requireLoopbackUrl(environment, 'CANVAS_LICENSE_CONTROL_PLANE_WEB_URL');
assert.notEqual(apiUrl.origin, webUrl.origin, 'Control Plane API and web origins must be explicit');

console.log('license-control-plane-url-test: ok');
