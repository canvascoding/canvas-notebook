import assert from 'node:assert/strict';

import {
  consumeMobileChatTicket,
  hasPendingMobileChatTicket,
  issueMobileChatTicket,
  mobileChatTicketFromHeaders,
  MOBILE_CHAT_WEBSOCKET_PROTOCOL,
} from '../app/lib/mobile/ws-ticket';

const issued = issueMobileChatTicket({
  userId: 'mobile-user',
  userEmail: 'mobile@example.test',
  userName: 'Mobile User',
  userRole: 'member',
  workspace: {
    workspaceId: 'workspace-1',
    workspaceType: 'team',
    workspaceName: 'Client Work',
    canWrite: true,
    canDelete: false,
    canShare: false,
  },
});
const headers = {
  'sec-websocket-protocol': `${MOBILE_CHAT_WEBSOCKET_PROTOCOL}, ${issued.ticketProtocol}`,
};

assert.equal(issued.ticketProtocol.includes('?'), false);
assert.match(issued.ticketProtocol, /^canvas-ticket\.[A-Za-z0-9_-]{43}$/u);
assert.equal(mobileChatTicketFromHeaders(headers), issued.ticket);
assert.equal(hasPendingMobileChatTicket(headers), true);

const identity = consumeMobileChatTicket(headers);
assert.equal(identity?.userId, 'mobile-user');
assert.equal(identity?.workspace.workspaceId, 'workspace-1');
assert.equal(hasPendingMobileChatTicket(headers), false);
assert.equal(consumeMobileChatTicket(headers), null);

assert.equal(mobileChatTicketFromHeaders({
  'sec-websocket-protocol': `${MOBILE_CHAT_WEBSOCKET_PROTOCOL}, canvas-ticket.not-valid`,
}), null);

console.log('mobile-chat-ticket-test: ok');
