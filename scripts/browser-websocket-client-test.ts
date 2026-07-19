import assert from 'node:assert/strict';

import {
  closeBrowserWebSocket,
  normalizeBrowserWebSocketCloseCode,
} from '../app/lib/pi/browser/client-websocket';

assert.equal(normalizeBrowserWebSocketCloseCode(1000), 1000);
assert.equal(normalizeBrowserWebSocketCloseCode(3000), 3000);
assert.equal(normalizeBrowserWebSocketCloseCode(4999), 4999);
assert.equal(normalizeBrowserWebSocketCloseCode(1002), 3000);
assert.equal(normalizeBrowserWebSocketCloseCode(1011), 3000);
assert.equal(normalizeBrowserWebSocketCloseCode(5000), 3000);
assert.equal(normalizeBrowserWebSocketCloseCode(Number.NaN), 3000);

const closeCalls: Array<{ code?: number; reason?: string }> = [];
closeBrowserWebSocket({
  close(code?: number, reason?: string) {
    closeCalls.push({ code, reason });
  },
}, 1011, 'RESOURCE_UNAVAILABLE');

assert.deepEqual(closeCalls, [{ code: 3000, reason: 'RESOURCE_UNAVAILABLE' }]);

console.log('browser-websocket-client-test: ok');
