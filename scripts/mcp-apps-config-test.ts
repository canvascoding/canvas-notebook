import assert from 'node:assert/strict';

import { isMcpAppFrameHost, isMcpAppsEnabled, mcpAppOrigins } from '../app/lib/mcp/apps-config';

const production = { BASE_URL: 'https://app.example.com' };

assert.deepEqual(mcpAppOrigins(production), {
  appOrigin: 'https://app.example.com',
  frameOrigin: 'https://app.example.com',
});
assert.deepEqual(mcpAppOrigins({ BASE_URL: 'https://192.0.2.1' }), {
  appOrigin: 'https://192.0.2.1',
  frameOrigin: 'https://192.0.2.1',
});
assert.deepEqual(mcpAppOrigins({
  ...production,
  CANVAS_HTML_PREVIEW_ORIGIN: 'https://widgets.example.net',
}), {
  appOrigin: 'https://app.example.com',
  frameOrigin: 'https://widgets.example.net',
});

assert.equal(isMcpAppsEnabled(production), true);
assert.equal(isMcpAppsEnabled({ ...production, CANVAS_MCP_APPS_ENABLED: 'true' }), true);
assert.equal(isMcpAppsEnabled({ ...production, CANVAS_MCP_APPS_ENABLED: ' FALSE ' }), false);
assert.equal(isMcpAppsEnabled({
  ...production,
  CANVAS_HTML_PREVIEW_ORIGIN: 'https://app.example.com',
}), false);

assert.equal(isMcpAppFrameHost('app.example.com', production), true);
assert.equal(isMcpAppFrameHost('app.example.com:443', production), true);
assert.equal(isMcpAppFrameHost('app.example.com.evil.test', production), false);
assert.equal(isMcpAppFrameHost('widgets.example.net', {
  ...production,
  CANVAS_HTML_PREVIEW_ORIGIN: 'https://widgets.example.net',
}), true);

console.log('mcp-apps-config-test: ok');
