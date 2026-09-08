import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

import type { StoredEmailAccount } from '../app/lib/email/account-store';
import type { ImapClientLike } from '../app/lib/email/imap-service';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  return originalLoad(request, parent, isMain);
};

let tmpRoot = '';

async function main() {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-imap-message-reference-'));
  process.env.CANVAS_DATA_ROOT = tmpRoot;
  process.env.INTEGRATIONS_ENV_MASTER_KEY = 'imap-message-reference-test-key';

  const { writeEmailAccountSecret } = await import('../app/lib/email/secret-store');
  const {
    archiveImapEmailMessage,
    createImapMessageReference,
    deleteImapEmailMessagePermanently,
    getImapMailboxUidValidity,
    isImapMailboxChangedError,
    listImapEmailMessages,
    moveImapEmailMessage,
    parseImapMessageReference,
    readImapEmailMessage,
    setImapClientFactoryForTests,
    setImapEmailMessageRead,
    trashImapEmailMessage,
  } = await import('../app/lib/email/imap-service');

  const secretRef = 'imap-reference-user/imap-reference-account.json.enc';
  await writeEmailAccountSecret(secretRef, {
    authType: 'smtp_imap',
    smtp: {
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      username: 'reader@example.test',
      password: 'smtp-secret',
    },
    imap: {
      host: 'imap.example.test',
      port: 993,
      secure: true,
      username: 'reader@example.test',
      password: 'imap-secret',
    },
  });

  const now = new Date('2026-09-08T09:00:00.000Z');
  const account = {
    id: 'imap-reference-account',
    userId: 'imap-reference-user',
    provider: 'smtp_imap',
    authType: 'smtp_imap',
    emailAddress: 'reader@example.test',
    displayName: 'IMAP Reader',
    providerAccountId: null,
    status: 'active',
    policyJson: JSON.stringify({ readFrom: ['@example.test'], sendTo: ['@example.test'] }),
    secretRef,
    isPrimary: true,
    accountScope: 'personal',
    organizationId: null,
    connectedByUserId: 'imap-reference-user',
    automationEnabledAt: null,
    workspaceId: null,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
  } as StoredEmailAccount;

  let currentUidValidity = BigInt(7001);
  let connectCalls = 0;
  let fetchOneCalls = 0;
  let flagCalls = 0;
  let moveCalls = 0;
  let deleteCalls = 0;
  const lockedFolders: string[] = [];
  const source = Buffer.from([
    'From: Sender <sender@example.test>',
    'To: reader@example.test',
    'Subject: Stable IMAP identity',
    'Date: Tue, 08 Sep 2026 09:00:00 +0000',
    '',
    'Message body.',
  ].join('\r\n'));
  const fetchedMessage = {
    uid: 41,
    flags: new Set<string>(),
    envelope: {
      subject: 'Stable IMAP identity',
      date: now,
      from: [{ name: 'Sender', address: 'sender@example.test' }],
      to: [{ address: 'reader@example.test' }],
    },
    internalDate: now,
    source,
  };

  setImapClientFactoryForTests(() => {
    const client: ImapClientLike = {
      get mailbox() {
        return { uidValidity: currentUidValidity };
      },
      connect: async () => {
        connectCalls += 1;
      },
      logout: async () => undefined,
      close: () => undefined,
      list: async () => [
        { path: 'Archive', name: 'Archive', flags: new Set(['\\Archive']), specialUse: '\\Archive' },
        { path: 'Trash', name: 'Trash', flags: new Set(['\\Trash']), specialUse: '\\Trash' },
      ] as never,
      getMailboxLock: async (folder) => {
        lockedFolders.push(Array.isArray(folder) ? folder.join('/') : folder);
        return { release: () => undefined };
      },
      search: async () => [41],
      fetch: async function* () {
        yield fetchedMessage as never;
      },
      fetchOne: async () => {
        fetchOneCalls += 1;
        return fetchedMessage as never;
      },
      messageFlagsAdd: async () => {
        flagCalls += 1;
        return true;
      },
      messageFlagsRemove: async () => {
        flagCalls += 1;
        return true;
      },
      messageDelete: async () => {
        deleteCalls += 1;
        return true;
      },
      messageMove: async () => {
        moveCalls += 1;
        return true;
      },
    };
    return client;
  });

  assert.equal(getImapMailboxUidValidity({ mailbox: { uidValidity: BigInt(7001) } }), '7001');
  assert.throws(() => getImapMailboxUidValidity({ mailbox: false }), /UIDVALIDITY is unavailable/u);
  const directlyCreated = createImapMessageReference(' Archive ', '7001', 41);
  assert.deepEqual(parseImapMessageReference(directlyCreated), {
    version: 1,
    folder: 'Archive',
    uidValidity: '7001',
    uid: 41,
  });
  assert.deepEqual(parseImapMessageReference('41', ' Archive '), {
    version: 0,
    folder: 'Archive',
    uidValidity: null,
    uid: 41,
  });
  assert.throws(() => parseImapMessageReference('imap:v1:not+base64url'), /Invalid IMAP message ID/u);

  const listed = await listImapEmailMessages(account, { folder: 'INBOX', limit: 5 });
  assert.equal(listed.uidValidity, '7001');
  assert.equal(listed.messages.length, 1);
  assert.equal(listed.messages[0].uid, '41');
  assert.notEqual(listed.messages[0].id, listed.messages[0].uid);
  assert.deepEqual(parseImapMessageReference(listed.messages[0].id), {
    version: 1,
    folder: 'INBOX',
    uidValidity: '7001',
    uid: 41,
  });

  const reference = listed.messages[0].id;
  const read = await readImapEmailMessage(account, reference);
  assert.equal(read.message.id, reference);
  assert.equal(read.message.uid, '41');
  assert.equal(read.message.uidValidity, '7001');
  assert.equal(lockedFolders.at(-1), 'INBOX');

  const marked = await setImapEmailMessageRead(account, reference, 'inbox', true);
  assert.equal(marked.messageId, reference);
  assert.equal(marked.uid, '41');
  assert.equal(marked.uidValidity, '7001');
  assert.equal(flagCalls, 1);

  const connectsBeforeFolderMismatch = connectCalls;
  await assert.rejects(
    () => readImapEmailMessage(account, reference, 'Archive'),
    /Invalid IMAP message ID/u,
  );
  assert.equal(connectCalls, connectsBeforeFolderMismatch, 'folder mismatch must fail before connecting');

  currentUidValidity = BigInt(7002);
  const providerCallsBeforeStaleReference = {
    fetchOneCalls,
    flagCalls,
    moveCalls,
    deleteCalls,
  };
  const staleOperations = [
    () => readImapEmailMessage(account, reference),
    () => setImapEmailMessageRead(account, reference, undefined, true),
    () => moveImapEmailMessage(account, reference, undefined, 'Archive'),
    () => archiveImapEmailMessage(account, reference),
    () => trashImapEmailMessage(account, reference),
    () => deleteImapEmailMessagePermanently(account, reference),
  ];
  for (const operation of staleOperations) {
    await assert.rejects(operation, (error: unknown) => {
      assert.equal(isImapMailboxChangedError(error), true);
      if (isImapMailboxChangedError(error)) {
        assert.equal(error.code, 'EMAIL_MAILBOX_CHANGED');
        assert.equal(error.status, 409);
        assert.equal(error.folder, 'INBOX');
        assert.equal(error.expectedUidValidity, '7001');
        assert.equal(error.actualUidValidity, '7002');
      }
      return true;
    });
  }
  assert.deepEqual({ fetchOneCalls, flagCalls, moveCalls, deleteCalls }, providerCallsBeforeStaleReference);

  const legacyRead = await readImapEmailMessage(account, '41', 'INBOX');
  assert.equal(legacyRead.message.id, '41');
  assert.equal(legacyRead.message.uidValidity, '7002');
  const legacyMarked = await setImapEmailMessageRead(account, '41', 'INBOX', true);
  assert.equal(legacyMarked.messageId, '41');
  assert.equal(legacyMarked.uid, '41');
  assert.equal(legacyMarked.uidValidity, '7002');
  assert.equal(flagCalls, providerCallsBeforeStaleReference.flagCalls + 1);

  setImapClientFactoryForTests(null);
  await fs.rm(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
  console.log('imap-message-reference-test: ok');
}

main().catch(async (error) => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  console.error(error);
  process.exitCode = 1;
});
