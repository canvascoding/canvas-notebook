import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  emailMessageContentRevision,
  emailMessageListScopeKey,
} from '../app/lib/email/reader-refresh';
import {
  EmailMessageNotFoundError,
  EmailProviderRequestError,
  isEmailMessageNotFoundError,
  isEmailProviderNotFoundError,
} from '../app/lib/email/errors';

const baselineMessage = {
  id: 'message-1',
  folder: 'INBOX',
  from: 'sender@example.com',
  to: ['reader@example.com'],
  subject: 'Quarterly review',
  date: '2026-08-26T08:00:00.000Z',
  body: 'Initial content',
  bodyHtml: '<p>Initial content</p>',
  attachments: [{ filename: 'review.pdf', contentType: 'application/pdf', size: 42 }],
};

const readStateOnlyUpdate = {
  ...baselineMessage,
  // Read state is intentionally excluded so marking a message read does not reset the reader.
  isRead: true,
};
const unchangedRevision = emailMessageContentRevision(readStateOnlyUpdate);
assert.equal(unchangedRevision, emailMessageContentRevision(baselineMessage));
assert.notEqual(
  unchangedRevision,
  emailMessageContentRevision({ ...baselineMessage, body: 'Updated content' }),
  'visible message-content changes must require an explicit reader update',
);

const baselineScope = emailMessageListScopeKey({
  accountId: 'account-a',
  filter: 'all',
  folder: 'INBOX',
  page: 0,
  query: '',
});
assert.notEqual(baselineScope, emailMessageListScopeKey({
  accountId: 'account-b', filter: 'all', folder: 'INBOX', page: 0, query: '',
}));
assert.notEqual(baselineScope, emailMessageListScopeKey({
  accountId: 'account-a', filter: 'unread', folder: 'INBOX', page: 0, query: '',
}));
assert.notEqual(baselineScope, emailMessageListScopeKey({
  accountId: 'account-a', filter: 'all', folder: 'Archive', page: 0, query: '',
}));
assert.notEqual(baselineScope, emailMessageListScopeKey({
  accountId: 'account-a', filter: 'all', folder: 'INBOX', page: 1, query: '',
}));
assert.notEqual(baselineScope, emailMessageListScopeKey({
  accountId: 'account-a', filter: 'all', folder: 'INBOX', page: 0, query: 'review',
}));

assert.equal(isEmailMessageNotFoundError(new EmailMessageNotFoundError()), true);
assert.equal(isEmailProviderNotFoundError(new EmailProviderRequestError('Missing', 404)), true);
assert.equal(isEmailProviderNotFoundError(new EmailProviderRequestError('Forbidden', 403)), false);

const emailClientSource = fs.readFileSync(
  path.join(process.cwd(), 'app', 'apps', 'email', 'components', 'EmailClient.tsx'),
  'utf8',
);
const notebookShellSource = fs.readFileSync(
  path.join(process.cwd(), 'app', 'components', 'DashboardShell.tsx'),
  'utf8',
);
const reviewCenterSource = fs.readFileSync(
  path.join(process.cwd(), 'app', 'apps', 'email', 'components', 'EmailReviewCenter.tsx'),
  'utf8',
);
const workspaceLayoutSource = fs.readFileSync(
  path.join(process.cwd(), 'app', 'apps', 'email', 'components', 'EmailWorkspaceLayout.tsx'),
  'utf8',
);
const messageReaderSource = fs.readFileSync(
  path.join(process.cwd(), 'app', 'apps', 'email', 'components', 'EmailMessageReader.tsx'),
  'utf8',
);
const composeDialogSource = fs.readFileSync(
  path.join(process.cwd(), 'app', 'apps', 'email', 'components', 'EmailComposeDialog.tsx'),
  'utf8',
);
const messageRouteSource = fs.readFileSync(
  path.join(process.cwd(), 'app', 'api', 'email', 'accounts', '[accountId]', 'messages', '[messageId]', 'route.ts'),
  'utf8',
);
const errorSource = fs.readFileSync(
  path.join(process.cwd(), 'app', 'lib', 'email', 'errors.ts'),
  'utf8',
);

assert.match(emailClientSource, /const EMAIL_BACKGROUND_REFRESH_MS = 60_000/u);
assert.match(emailClientSource, /const refreshSelectedMessage = useCallback/u);
assert.match(emailClientSource, /listRequestRef\.current\?\.abort\(\)/u);
assert.match(emailClientSource, /detailRequestRef\.current\?\.abort\(\)/u);
assert.match(emailClientSource, /signal: controller\.signal/u);
assert.match(emailClientSource, /emailMessageListScopeKey\(/u);
assert.match(emailClientSource, /setPendingMessageUpdate\(nextMessage\)/u);
assert.match(emailClientSource, /payload\.code === 'EMAIL_MESSAGE_NOT_FOUND'/u);
assert.match(emailClientSource, /data-presentation=\{embedded \? 'embedded' : 'page'\}/u);
assert.match(emailClientSource, /data-layout-mode=\{layoutMode\}/u);
assert.match(emailClientSource, /<EmailReviewCenter/u);
assert.match(emailClientSource, /<EmailPaneResizeHandle/u);
assert.match(emailClientSource, /import \{ EmailComposeDialog \} from/u);
assert.match(emailClientSource, /import \{ EmailMessageRowActions, EmailMessageViewer \} from/u);
assert.match(emailClientSource, /contextIntent\.toolName === 'email_search_messages'/u);
assert.match(emailClientSource, /contextIntent\.toolName === 'email_read_message'/u);
assert.match(emailClientSource, /contextIntent\.view !== 'review-draft'/u);
assert.match(emailClientSource, /const openOutboxDraftById = useCallback/u);
assert.match(emailClientSource, /key=\{`email-message-viewer:/u);
assert.match(emailClientSource, /onClick=\{\(\) => void loadMessages\(\{ background: true \}\)\}/u);
assert.match(reviewCenterSource, /canvas:email:review-center:v1/u);
assert.match(reviewCenterSource, /aria-controls=\{regionId\} aria-expanded=\{isExpanded\}/u);
assert.match(reviewCenterSource, /\/api\/email\/outbox/u);
assert.match(reviewCenterSource, /\/email\/inbox/u);
assert.match(reviewCenterSource, /\/email\/outbox/u);
assert.match(workspaceLayoutSource, /new ResizeObserver\(update\)/u);
assert.match(workspaceLayoutSource, /if \(width < 600\) return 'mobile'/u);
assert.match(workspaceLayoutSource, /if \(width < 960\) return 'compact'/u);
assert.match(messageReaderSource, /export function EmailMessageBody/u);
assert.match(messageReaderSource, /export function EmailMessageRowActions/u);
assert.match(composeDialogSource, /import \{ EmailMessageBody \} from/u);
assert.match(composeDialogSource, /export function EmailComposeDialog/u);
assert.match(messageReaderSource, /export function EmailMessageViewer/u);
assert.match(messageReaderSource, /DOMPurify\.sanitize/u);
assert.match(messageReaderSource, /sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"/u);

assert.match(notebookShellSource, /role="tabpanel"/u);
assert.match(notebookShellSource, /aria-hidden=\{!active\}/u);
assert.match(notebookShellSource, /inert=\{!active\}/u);
assert.match(notebookShellSource, /<EmailClient contextIntent=\{emailContext\} embedded \/>/u);
assert.match(messageRouteSource, /code: 'EMAIL_MESSAGE_NOT_FOUND'/u);
assert.match(messageRouteSource, /status: 404/u);
assert.match(errorSource, /readonly code = 'EMAIL_MESSAGE_NOT_FOUND'/u);

console.log('email-inbox-reading-flow-test: ok');
