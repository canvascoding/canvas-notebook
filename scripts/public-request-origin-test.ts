import assert from 'node:assert/strict';

import { buildPublicRequestUrl, getPublicRequestOrigin } from '../app/lib/utils/request-origin';

function requestLike(url: string, headers: Record<string, string>) {
  return {
    url,
    headers: new Headers(headers),
  };
}

const proxiedRequest = requestLike('http://0.0.0.0:3000/public/files/token/board.excalidraw', {
  'x-forwarded-host': 'canvas.example.com',
  'x-forwarded-proto': 'https',
  host: '0.0.0.0:3000',
});

assert.equal(getPublicRequestOrigin(proxiedRequest), 'https://canvas.example.com');
assert.equal(
  buildPublicRequestUrl(proxiedRequest, '/public/view/token/board.excalidraw').toString(),
  'https://canvas.example.com/public/view/token/board.excalidraw'
);

const multiProxyRequest = requestLike('http://0.0.0.0:3000/public/files/token/board.excalidraw', {
  'x-forwarded-host': 'canvas.example.com, internal:3000',
  'x-forwarded-proto': 'https, http',
  host: '0.0.0.0:3000',
});

assert.equal(getPublicRequestOrigin(multiProxyRequest), 'https://canvas.example.com');

const localRequest = requestLike('http://localhost:3000/public/files/token/board.excalidraw', {
  host: 'localhost:3000',
});

assert.equal(getPublicRequestOrigin(localRequest), 'http://localhost:3000');

const invalidForwardedHostRequest = requestLike('http://localhost:3000/public/files/token/board.excalidraw', {
  'x-forwarded-host': 'bad host',
  'x-forwarded-proto': 'https',
  host: 'localhost:3000',
});

assert.equal(getPublicRequestOrigin(invalidForwardedHostRequest), 'https://localhost:3000');

console.log('public request origin tests passed');
