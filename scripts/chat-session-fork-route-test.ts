import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const route = readFileSync(
  path.join(root, 'app/api/sessions/[sessionId]/fork/route.ts'),
  'utf8',
);

assert.match(route, /auth\.api\.getSession/u, 'fork route must require an authenticated user');
assert.match(route, /requireAgentAccess/u, 'fork route must enforce agent access');
assert.match(route, /resolveAgentSessionWorkspaceForUser/u, 'fork route must resolve workspace authority');
assert.match(route, /isPiSessionInWorkspace/u, 'fork route must reject cross-workspace sources');
assert.match(route, /withRuntimeSessionOperation/u, 'fork route must serialize against runtime operations');
assert.match(route, /getActiveRuntimeStatusSummaries/u, 'fork route must reject active source runtimes');
assert.match(route, /prepareSessionRuntimeSnapshot/u, 'fork route must validate the pinned runtime selection');
assert.match(route, /ensurePiSessionSystemPromptSnapshot/u, 'fork route must preserve a valid prompt snapshot');
assert.match(route, /forkPiSession/u, 'fork route must delegate persistence to the fork service');
assert.match(route, /action: 'pi_session\.fork'/u, 'fork route must record a dedicated audit event');
assert.match(route, /clientRequestId/u, 'fork route must require an idempotency key');
assert.match(route, /Cache-Control': 'private, no-store'/u, 'fork responses must not be cached');

console.log('[Chat Session Fork Route Test] passed');
