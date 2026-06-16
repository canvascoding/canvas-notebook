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

  console.log('Email derived draft HTML test passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
