import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { liveCollaborationRuntimeAvailable } from '@/app/lib/collaboration/runtime-policy';
import { parseCollaborationSessionRequest } from '@/app/lib/collaboration/session-service';
import { RICH_MARKDOWN_SCHEMA_VERSION } from '@/app/lib/collaboration/types';
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
assert.deepEqual(parseCollaborationSessionRequest({
  path: 'Notes/Shared.txt',
  provider: 'yjs',
  representation: 'plain_text',
}), {
  path: 'Notes/Shared.txt',
  provider: 'yjs',
  representation: 'plain_text',
});
assert.deepEqual(parseCollaborationSessionRequest({
  path: 'Notes/Shared.md',
  provider: 'yjs',
  representation: 'auto',
}), {
  path: 'Notes/Shared.md',
  provider: 'yjs',
  representation: 'auto',
});
assert.deepEqual(parseCollaborationSessionRequest({
  path: 'Notes/Shared.txt',
  provider: 'yjs',
  representation: 'auto',
}), {
  path: 'Notes/Shared.txt',
  provider: 'yjs',
  representation: 'auto',
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
const browserRouteSource = readFileSync(
  path.join(root, 'app/api/files/collaboration/session/route.ts'),
  'utf8',
);
const serverSource = readFileSync(path.join(root, 'server/collaboration-server.ts'), 'utf8');
const excalidrawServerSource = readFileSync(
  path.join(root, 'server/excalidraw-collaboration/server.ts'),
  'utf8',
);
const excalidrawAssetsRouteSource = readFileSync(
  path.join(root, 'app/api/files/excalidraw-assets/route.ts'),
  'utf8',
);
const workspaceMembersRouteSource = readFileSync(
  path.join(root, 'app/api/workspaces/[id]/members/route.ts'),
  'utf8',
);
assert.match(routeSource, /issueMobileCollaborationTicket/u);
assert.match(routeSource, /representation:\s*'auto'/u);
assert.doesNotMatch(routeSource, /analyzeMarkdownRichMode/u);
assert.doesNotMatch(routeSource, /workspaceRequiresCollaborationPolicy/u);
assert.doesNotMatch(browserRouteSource, /workspaceRequiresCollaborationPolicy/u);
assert.match(routeSource, /Live collaboration requires Postgres\./u);
assert.match(browserRouteSource, /Live collaboration requires Postgres\./u);
for (const collaborationTransportSource of [
  routeSource,
  browserRouteSource,
  serverSource,
  excalidrawServerSource,
  excalidrawAssetsRouteSource,
]) {
  assert.doesNotMatch(collaborationTransportSource, /requireTeamRuntimeLicense/u);
  assert.doesNotMatch(collaborationTransportSource, /requireRuntimeCapability/u);
}
assert.match(excalidrawAssetsRouteSource, /Excalidraw collaboration requires Postgres\./u);
assert.match(workspaceMembersRouteSource, /requireTeamRuntimeLicense/u);
assert.match(routeSource, /error instanceof CollaborationSessionError && error\.code/u);
assert.match(routeSource, /richTextSchemaVersion: RICH_MARKDOWN_SCHEMA_VERSION/u);
assert.equal(RICH_MARKDOWN_SCHEMA_VERSION, 3);
assert.equal(liveCollaborationRuntimeAvailable('postgres'), true);
assert.equal(liveCollaborationRuntimeAvailable('sqlite'), false);
assert.match(serverSource, /consumeMobileCollaborationTicket/u);
assert.match(serverSource, /hasMobileCollaborationProtocol/u);
assert.match(serverSource, /MOBILE_COLLABORATION_WEBSOCKET_PROTOCOL/u);

console.log('mobile-collaboration-ticket-test: ok');
