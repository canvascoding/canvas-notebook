import assert from 'node:assert/strict';
import Module from 'node:module';

import { NextRequest } from 'next/server';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

const moduleInternals = Module as typeof Module & { _load: LoadFn };
const originalLoad = moduleInternals._load;
const mailboxChangedMessage = 'The IMAP mailbox changed. Reload the message list before trying again.';
let serviceError: Error & { code?: string; status?: number } = Object.assign(new Error(mailboxChangedMessage), {
  code: 'EMAIL_MAILBOX_CHANGED',
  status: 409,
});

const failWithServiceError = async () => {
  throw serviceError;
};

moduleInternals._load = function loadWithEmailRouteMocks(request, parent, isMain) {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/auth') {
    return { auth: { api: { getSession: async () => ({ user: { id: 'user-1' } }) } } };
  }
  if (request === '@/app/lib/email/ai-route-guard') {
    return { requireEmailAiRouteSession: async () => ({ user: { id: 'user-1' } }) };
  }
  if (request === '@/app/lib/email/ai-request-body') {
    return {
      emailAiRequestBodyErrorStatus: () => undefined,
      readEmailAiJsonObject: async (input: Request) => input.json(),
    };
  }
  if (request === '@/app/lib/email/attachments') {
    return { normalizeEmailAttachmentInputs: () => [] };
  }
  if (request === '@/app/lib/email/errors') {
    return { isEmailMessageNotFoundError: (error: unknown) => (error as { code?: unknown })?.code === 'EMAIL_MESSAGE_NOT_FOUND' };
  }
  if (request === '@/app/lib/email/imap-service') {
    return {
      isImapMailboxChangedError: (error: unknown) => {
        const candidate = error as { code?: unknown; status?: unknown };
        return candidate?.code === 'EMAIL_MAILBOX_CHANGED' && candidate.status === 409;
      },
    };
  }
  if (request === '@/app/lib/email/logging') {
    return { logEmailClientEvent: () => undefined };
  }
  if (request === '@/app/lib/email/service') {
    return {
      archiveEmailMessage: failWithServiceError,
      createEmailAiReplyDraft: failWithServiceError,
      createEmailDerivedDraft: failWithServiceError,
      deleteEmailMessagePermanently: failWithServiceError,
      generateEmailAiReplyBody: failWithServiceError,
      moveEmailMessage: failWithServiceError,
      readEmailMessage: failWithServiceError,
      sendEmailDerivedMessage: failWithServiceError,
      setEmailMessageAnswered: failWithServiceError,
      setEmailMessageRead: failWithServiceError,
      streamEmailAiReplyBody: failWithServiceError,
      summarizeEmailMessage: failWithServiceError,
      trashEmailMessage: failWithServiceError,
    };
  }
  if (request === '@/app/lib/utils/rate-limit') {
    return { rateLimit: () => ({ ok: true }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};

async function expectMailboxChanged(response: Response) {
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    success: false,
    code: 'EMAIL_MAILBOX_CHANGED',
    error: mailboxChangedMessage,
  });
}

async function main() {
  try {
    const { GET: getMessage } = await import('../app/api/email/accounts/[accountId]/messages/[messageId]/route');
    const { POST: postMessageAction } = await import('../app/api/email/accounts/[accountId]/messages/[messageId]/actions/route');
    const { POST: postAiReply } = await import('../app/api/email/accounts/[accountId]/messages/[messageId]/ai-reply/route');
    const { POST: postDraft } = await import('../app/api/email/accounts/[accountId]/messages/[messageId]/draft/route');
    const { POST: postSummary } = await import('../app/api/email/accounts/[accountId]/messages/[messageId]/summary/route');
    const { POST: postMessageOperation } = await import('../app/api/email/accounts/[accountId]/messages/actions/route');

    await expectMailboxChanged(await getMessage(
      new NextRequest('http://localhost/api/email/accounts/account-1/messages/reference-1?folder=INBOX'),
      { params: Promise.resolve({ accountId: 'account-1', messageId: 'reference-1' }) },
    ));

    await expectMailboxChanged(await postMessageAction(
      new NextRequest('http://localhost/api/email/accounts/account-1/messages/reference-1/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark-read', folder: 'INBOX' }),
      }),
      { params: Promise.resolve({ accountId: 'account-1', messageId: 'reference-1' }) },
    ));

    await expectMailboxChanged(await postMessageOperation(
      new NextRequest('http://localhost/api/email/accounts/account-1/messages/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'action', action: 'move', messageId: 'reference-1', folder: 'INBOX', destination: 'Archive' }),
      }),
      { params: Promise.resolve({ accountId: 'account-1' }) },
    ));

    await expectMailboxChanged(await postDraft(
      new NextRequest('http://localhost/api/email/accounts/account-1/messages/reference-1/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'reply', folder: 'INBOX' }),
      }),
      { params: Promise.resolve({ accountId: 'account-1', messageId: 'reference-1' }) },
    ));

    await expectMailboxChanged(await postAiReply(
      new NextRequest('http://localhost/api/email/accounts/account-1/messages/reference-1/ai-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: 'INBOX' }),
      }),
      { params: Promise.resolve({ accountId: 'account-1', messageId: 'reference-1' }) },
    ));

    await expectMailboxChanged(await postSummary(
      new NextRequest('http://localhost/api/email/accounts/account-1/messages/reference-1/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: 'INBOX' }),
      }),
      { params: Promise.resolve({ accountId: 'account-1', messageId: 'reference-1' }) },
    ));

    serviceError = new Error('Generic provider failure');
    const genericResponse = await postMessageAction(
      new NextRequest('http://localhost/api/email/accounts/account-1/messages/reference-1/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'trash', folder: 'INBOX' }),
      }),
      { params: Promise.resolve({ accountId: 'account-1', messageId: 'reference-1' }) },
    );
    assert.equal(genericResponse.status, 500);
    assert.deepEqual(await genericResponse.json(), { success: false, error: 'Generic provider failure' });

    console.log('email-mailbox-changed-route-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
