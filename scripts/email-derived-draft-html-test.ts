import assert from 'node:assert/strict';
import Module from 'node:module';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  return originalLoad(request, parent, isMain);
};

async function main() {
  const { buildEmailDerivedDraft } = await import('../app/lib/email/message-draft-builder');

  const draft = buildEmailDerivedDraft({
    accountId: 'account-1',
    bodyOverride: 'Thanks!',
    bodyOverrideHtml: '<p>Thanks!</p>',
    is_HTML: true,
    message: {
      body: '',
      bodyHtml: '<p>Original &amp; details</p><script>alert(1)</script>',
      cc: ['Manager <manager@example.test>', 'me@example.test'],
      date: 'Tue, 16 Jun 2026 10:00:00 +0200',
      from: 'Sender <sender@example.test>',
      subject: 'Project update',
      to: ['Me <me@example.test>', 'Other <other@example.test>'],
    },
    mode: 'reply-all',
    ownAddresses: new Set(['me@example.test']),
  });

  assert.equal(draft.is_HTML, true);
  assert.equal(draft.subject, 'Re: Project update');
  assert.deepEqual(draft.to, ['sender@example.test', 'other@example.test']);
  assert.deepEqual(draft.cc, ['manager@example.test']);
  assert.match(draft.body, /^<p>Thanks!<\/p><br><p>On /u);
  assert.match(draft.body, /<blockquote><p>Original &amp; details<\/p><\/blockquote>/u);
  assert.doesNotMatch(draft.body, /<script/iu);
  assert.doesNotMatch(draft.body, /alert\(1\)/u);

  const plainDraft = buildEmailDerivedDraft({
    accountId: 'account-1',
    bodyOverride: 'Plain response',
    message: {
      body: 'Original text',
      from: 'sender@example.test',
      subject: 'Plain thread',
      to: ['me@example.test'],
    },
    mode: 'reply',
    ownAddresses: new Set(['me@example.test']),
  });

  assert.equal(plainDraft.is_HTML, false);
  assert.match(plainDraft.body, /^Plain response\n\nsender@example\.test wrote:/u);

  const replyMessage = {
    from: 'Automated sender <notifications@example.test>',
    replyTo: '"Support, Team" <support@example.test> (Support inbox), backup@example.test (Backup)',
    to: ['ME@EXAMPLE.TEST', 'support@example.test', 'colleague@example.test'],
    cc: ['colleague@example.test', 'manager@example.test', 'backup@example.test', 'me@example.test'],
    subject: 'Reply destination',
    body: 'Original text',
  };
  const replyInput = { accountId: 'account-1', message: replyMessage, ownAddresses: new Set(['Me <ME@EXAMPLE.TEST>']) };
  const directReply = buildEmailDerivedDraft({ ...replyInput, mode: 'reply' });
  assert.deepEqual(directReply.to, ['support@example.test', 'backup@example.test'], 'Reply-To replaces From, including multiple addresses');
  assert.deepEqual(directReply.cc, [], 'ordinary replies do not inherit Cc');

  const replyAll = buildEmailDerivedDraft({ ...replyInput, mode: 'reply-all' });
  assert.deepEqual(replyAll.to, ['support@example.test', 'backup@example.test', 'colleague@example.test']);
  assert.deepEqual(replyAll.cc, ['manager@example.test'], 'own addresses and To/Cc duplicates are removed across fields');

  const fallbackReply = buildEmailDerivedDraft({ ...replyInput, message: { ...replyMessage, replyTo: ['not an address'] }, mode: 'reply' });
  assert.deepEqual(fallbackReply.to, ['notifications@example.test'], 'invalid Reply-To falls back to From');

  const sentReply = buildEmailDerivedDraft({ ...replyInput, message: { ...replyMessage, from: 'Me <me@example.test>', replyTo: undefined }, mode: 'reply' });
  assert.deepEqual(sentReply.to, ['support@example.test', 'colleague@example.test'], 'replying to a sent message addresses its original recipients');
  assert.deepEqual(sentReply.cc, []);

  const forward = buildEmailDerivedDraft({ ...replyInput, mode: 'forward' });
  assert.deepEqual(forward.to, []);
  assert.deepEqual(forward.cc, [], 'forwarding never inherits recipients');

  const overridden = buildEmailDerivedDraft({ ...replyInput, mode: 'reply-all', to: ['Selected <selected@example.test>'], cc: [] });
  assert.deepEqual(overridden.to, ['selected@example.test'], 'explicit human recipient overrides still win');
  assert.deepEqual(overridden.cc, [], 'an explicit empty Cc override removes inherited Cc');

  console.log('Email derived draft: safe HTML, Reply-To, sent replies, deduplicated Reply-All, forwarding and recipient overrides passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
