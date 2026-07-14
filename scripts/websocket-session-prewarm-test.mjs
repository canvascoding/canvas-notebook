import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../server/websocket-server.ts', import.meta.url), 'utf8');
const subscribeCase = source.indexOf("case 'subscribe_session'");
const ownershipCheck = source.indexOf('userOwnsSession(message.sessionId, userId)', subscribeCase);
const subscribeConnection = source.indexOf('subscribeConnectionToSession(connection, message.sessionId)', ownershipCheck);
const prewarm = source.indexOf('prewarmSessionRuntime(message.sessionId, userId)', subscribeConnection);
const acknowledgement = source.indexOf("type: 'subscribe_result'", prewarm);

assert.notEqual(subscribeCase, -1, 'subscribe handler must exist');
assert.notEqual(ownershipCheck, -1, 'subscribe handler must authorize the session');
assert.notEqual(subscribeConnection, -1, 'subscribe handler must register the connection');
assert.notEqual(prewarm, -1, 'subscribe handler must start session runtime prewarming');
assert.notEqual(acknowledgement, -1, 'subscribe handler must acknowledge the session');
assert.ok(
  subscribeCase < ownershipCheck
    && ownershipCheck < subscribeConnection
    && subscribeConnection < prewarm
    && prewarm < acknowledgement,
  'session prewarming must start only after authorization and subscription, before acknowledgement',
);

console.log('websocket-session-prewarm-test: ok');
