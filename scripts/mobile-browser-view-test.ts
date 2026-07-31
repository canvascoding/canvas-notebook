import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  consumeMobileBrowserViewTicket,
  hasPendingMobileBrowserViewTicket,
  issueMobileBrowserViewTicket,
  MOBILE_BROWSER_WEBSOCKET_PROTOCOL,
  mobileBrowserViewTicketFromHeaders,
  type MobileBrowserViewTicketIdentity,
} from '../app/lib/mobile/browser-view-ticket';

const identity: MobileBrowserViewTicketIdentity = {
  userId: 'user-mobile-browser',
  authSessionId: 'auth-session-mobile-browser',
  agentId: 'canvas-agent',
  agentSessionId: 'agent-session-mobile-browser',
  workspaceId: 'workspace-mobile-browser',
  workspaceType: 'personal',
  organizationId: 'organization-mobile-browser',
};
const issuedAt = Date.parse('2026-07-31T12:00:00.000Z');
const issued = issueMobileBrowserViewTicket(identity, issuedAt);
assert.match(issued.ticketProtocol, /^canvas-browser-ticket\.[A-Za-z0-9_-]{43}$/u);
assert.equal(issued.expiresAt, '2026-07-31T12:00:30.000Z');

const headers = {
  'sec-websocket-protocol': `${MOBILE_BROWSER_WEBSOCKET_PROTOCOL}, ${issued.ticketProtocol}`,
};
assert.equal(mobileBrowserViewTicketFromHeaders(headers), issued.ticketProtocol.split('.')[1]);
assert.equal(hasPendingMobileBrowserViewTicket(headers, issuedAt + 1), true);
assert.deepEqual(consumeMobileBrowserViewTicket(headers, issuedAt + 1), identity);
assert.equal(consumeMobileBrowserViewTicket(headers, issuedAt + 2), null, 'Browser tickets must be one-use.');

const wrongProtocolIssued = issueMobileBrowserViewTicket(identity, issuedAt + 3);
const wrongProtocolHeaders = {
  'sec-websocket-protocol': `canvas-chat-v1, ${wrongProtocolIssued.ticketProtocol}`,
};
assert.equal(mobileBrowserViewTicketFromHeaders(wrongProtocolHeaders), null);
assert.equal(consumeMobileBrowserViewTicket(wrongProtocolHeaders, issuedAt + 4), null);

const expiredIssued = issueMobileBrowserViewTicket(identity, issuedAt + 5);
const expiredHeaders = {
  'sec-websocket-protocol': `${MOBILE_BROWSER_WEBSOCKET_PROTOCOL}, ${expiredIssued.ticketProtocol}`,
};
assert.equal(hasPendingMobileBrowserViewTicket(expiredHeaders, issuedAt + 30_006), false);
assert.equal(consumeMobileBrowserViewTicket(expiredHeaders, issuedAt + 30_006), null);

const root = process.cwd();
const routeSource = readFileSync(
  path.join(root, 'app/api/mobile/v1/sessions/[sessionId]/browser-view-ticket/route.ts'),
  'utf8',
);
const browserServerSource = readFileSync(path.join(root, 'server/browser-view-server.ts'), 'utf8');
const bootstrapSource = readFileSync(path.join(root, 'app/lib/mobile/bootstrap.ts'), 'utf8');
const compatibilitySource = readFileSync(path.join(root, 'app/lib/mobile/compatibility.ts'), 'utf8');

assert.match(routeSource, /requireMobileChatSession/u);
assert.match(routeSource, /getStatus\(session\.sessionId, authSession\.user\.id\)/u);
assert.match(routeSource, /runtimeStatus\?\.browser\?\.running/u);
assert.match(routeSource, /issueMobileBrowserViewTicket/u);
assert.match(routeSource, /issueBrowserViewTicket/u);
assert.match(routeSource, /path:\s*'\/ws\/browser'/u);
assert.doesNotMatch(routeSource, /websocketUrl.*\?/u);
assert.match(browserServerSource, /hasPendingMobileBrowserViewTicket/u);
assert.match(browserServerSource, /consumeMobileBrowserViewTicket/u);
assert.match(browserServerSource, /claims\.agentSessionId !== connection\.mobileScope\.agentSessionId/u);
assert.match(browserServerSource, /!isConfiguredTrustedOrigin\(request\.headers\.origin\) && !hasMobileTicket/u);
assert.match(bootstrapSource, /'browser\.live_view'/u);
assert.equal((compatibilitySource.match(/'browser\.live_view'/gu) || []).length, 2);

console.log('mobile-browser-view-test: ok');
