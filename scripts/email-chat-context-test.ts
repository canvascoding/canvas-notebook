import assert from 'node:assert/strict';

import {
  buildEmailPageChatContext,
  resolveEmailShellRequestContext,
} from '../app/apps/email/context/email-route-chat-context';
import { EMAIL_SYSTEM_PROMPT_BLOCK } from '../app/lib/agents/email-prompt-block';

const noSelectedMessageContext = buildEmailPageChatContext({
  account: null,
  activeFolder: 'INBOX',
  activeFolderName: 'Inbox',
  filter: 'all',
});

assert.equal(noSelectedMessageContext.currentPage, '/emails');
assert.deepEqual(noSelectedMessageContext.emailContext, {
  accountEmail: undefined,
  accountId: undefined,
  filter: 'all',
  folder: 'INBOX',
  folderName: 'Inbox',
  query: undefined,
  selectedMessageDate: null,
  selectedMessageFolder: 'INBOX',
  selectedMessageFrom: null,
  selectedMessageId: undefined,
  selectedMessageIsRead: null,
  selectedMessageSubject: null,
});

const loadingSelectedMessageContext = buildEmailPageChatContext({
  account: { id: 'account-2', emailAddress: 'second@example.test' },
  activeFolder: 'Archive',
  activeFolderName: 'Archive',
  filter: 'unread',
  selectedMessageId: 'loading-message',
  submittedQuery: 'renewal',
});

assert.deepEqual(loadingSelectedMessageContext.emailContext, {
  accountEmail: 'second@example.test',
  accountId: 'account-2',
  filter: 'unread',
  folder: 'Archive',
  folderName: 'Archive',
  query: 'renewal',
  selectedMessageDate: null,
  selectedMessageFolder: 'Archive',
  selectedMessageFrom: null,
  selectedMessageId: 'loading-message',
  selectedMessageIsRead: null,
  selectedMessageSubject: null,
});

const selectedMessageWithBody = {
  id: 'message-with-body',
  folder: 'Sent',
  from: 'client@example.test',
  subject: 'Contract',
  date: '2026-06-26T11:00:00.000Z',
  isRead: true,
  body: 'This body must not be injected into chat context.',
  bodyHtml: '<p>This body must not be injected into chat context.</p>',
};
const selectedMessageContext = buildEmailPageChatContext({
  account: { id: 'account-3', emailAddress: 'third@example.test' },
  activeFolder: 'INBOX',
  activeFolderName: 'Inbox',
  filter: 'all',
  selectedMessage: selectedMessageWithBody,
});

assert.deepEqual(selectedMessageContext.emailContext, {
  accountEmail: 'third@example.test',
  accountId: 'account-3',
  filter: 'all',
  folder: 'INBOX',
  folderName: 'Inbox',
  query: undefined,
  selectedMessageDate: '2026-06-26T11:00:00.000Z',
  selectedMessageFolder: 'Sent',
  selectedMessageFrom: 'client@example.test',
  selectedMessageId: 'message-with-body',
  selectedMessageIsRead: true,
  selectedMessageSubject: 'Contract',
});
assert.doesNotMatch(JSON.stringify(selectedMessageContext), /This body must not be injected/);

const accountSwitchContext = buildEmailPageChatContext({
  account: { id: 'account-4', emailAddress: 'fourth@example.test' },
  activeFolder: 'Projects',
  activeFolderName: 'Projects',
  filter: 'unread',
  selectedMessageId: null,
  submittedQuery: '',
});
assert.equal(accountSwitchContext.emailContext?.accountId, 'account-4');
assert.equal(accountSwitchContext.emailContext?.selectedMessageId, undefined);
assert.equal(accountSwitchContext.emailContext?.query, undefined);
assert.equal(accountSwitchContext.emailContext?.selectedMessageFolder, 'Projects');

const staleContext = buildEmailPageChatContext({
  account: { id: 'old-account', emailAddress: 'old@example.test' },
  activeFolder: 'INBOX',
  activeFolderName: 'Inbox',
  filter: 'all',
  pathname: '/emails',
  selectedMessageId: 'old-message',
});
assert.deepEqual(resolveEmailShellRequestContext(staleContext, '/settings'), { currentPage: '/settings' });
assert.equal(resolveEmailShellRequestContext(staleContext, '/emails'), staleContext);
assert.deepEqual(resolveEmailShellRequestContext(null, null), { currentPage: '/emails' });
assert.match(EMAIL_SYSTEM_PROMPT_BLOCK, /Do not assume the visible message body is available in context/);
assert.match(EMAIL_SYSTEM_PROMPT_BLOCK, /Use email_read when the user asks you to reason about the actual email body/);
assert.match(EMAIL_SYSTEM_PROMPT_BLOCK, /call email_list_accounts and pass the matching accountId explicitly/);
assert.match(EMAIL_SYSTEM_PROMPT_BLOCK, /multiple accounts are connected and the target account is unclear/);

console.log('Email chat context test passed');
