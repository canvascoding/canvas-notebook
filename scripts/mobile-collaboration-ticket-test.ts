import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parseCollaborationSessionRequest } from '@/app/lib/collaboration/session-service';
import {
  consumeMobileCollaborationTicket,
  hasMobileCollaborationProtocol,
  issueMobileCollaborationTicket,
  MOBILE_COLLABORATION_WEBSOCKET_PROTOCOL,
} from '@/app/lib/mobile/collaboration-ticket';

const now = Date.parse('2026-08-01T08:00:00.000Z');
const claims = {
  userId: 'user-mobile',
  sessionId: 'session-mobile',
  workspaceId: 'workspace-team',
  organizationId: 'organization-1',
  documentId: 'collab-doc-1',
  path: 'Notes/Shared.md',
  provider: 'yjs' as const,
  representation: 'tiptap_xml' as const,
  permission: 'write' as const,
  lifecycleGeneration: 2,
};
const ticket = issueMobileCollaborationTicket({
  claims,
  user: {
    id: 'user-mobile',
    name: 'Mobile User',
    email: 'mobile@example.test',
    role: 'member',
  },
}, now);

assert.match(ticket.token, /^[A-Za-z0-9_-]{43}$/u);
assert.equal(ticket.claims.expiresAt, now + 30_000);
assert.equal(
  consumeMobileCollaborationTicket(ticket.token, now + 1)?.claims.documentId,
  'collab-doc-1',
);
assert.equal(consumeMobileCollaborationTicket(ticket.token, now + 2), null);

const expired = issueMobileCollaborationTicket({
  claims,
  user: {
    id: 'user-mobile',
    name: 'Mobile User',
    email: null,
    role: 'member',
  },
}, now);
assert.equal(consumeMobileCollaborationTicket(expired.token, now + 30_001), null);

assert.equal(hasMobileCollaborationProtocol({
  'sec-websocket-protocol': `other, ${MOBILE_COLLABORATION_WEBSOCKET_PROTOCOL}`,
}), true);
assert.equal(hasMobileCollaborationProtocol({
  'sec-websocket-protocol': 'other',
}), false);

assert.deepEqual(parseCollaborationSessionRequest({
  path: 'Notes/Shared.md',
  provider: 'yjs',
  representation: 'tiptap_xml',
}), {
  path: 'Notes/Shared.md',
  provider: 'yjs',
  representation: 'tiptap_xml',
});
assert.equal(parseCollaborationSessionRequest({
  path: 'Notes/Shared.pdf',
  provider: 'yjs',
  representation: 'tiptap_xml',
}), null);

const root = process.cwd();
const routeSource = readFileSync(
  path.join(root, 'app/api/mobile/v1/notebook/collaboration/session/route.ts'),
  'utf8',
);
const serverSource = readFileSync(path.join(root, 'server/collaboration-server.ts'), 'utf8');
assert.match(routeSource, /issueMobileCollaborationTicket/u);
assert.match(routeSource, /representation: 'tiptap_xml'/u);
assert.match(serverSource, /consumeMobileCollaborationTicket/u);
assert.match(serverSource, /hasMobileCollaborationProtocol/u);
assert.match(serverSource, /MOBILE_COLLABORATION_WEBSOCKET_PROTOCOL/u);

console.log('mobile-collaboration-ticket-test: ok');
