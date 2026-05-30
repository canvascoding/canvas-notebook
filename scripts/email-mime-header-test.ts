import assert from 'node:assert/strict';
import Module from 'node:module';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') {
    return {};
  }
  return originalLoad(request, parent, isMain);
};

function decodeMimeHeaderValue(value: string) {
  return value
    .replace(/\r\n[ \t]+/gu, ' ')
    .split(/\s+/u)
    .map((part) => {
      const match = /^=\?UTF-8\?B\?(.+)\?=$/u.exec(part);
      return match ? Buffer.from(match[1], 'base64').toString('utf8') : part;
    })
    .join('');
}

async function main() {
  const { encodeMimeHeaderValue } = await import('../app/lib/email/local-service');

  const subject = '🖌️ Canvas Notebook v2026.5.29.1 — Release Update & Automation Run';
  const encoded = encodeMimeHeaderValue(subject);

  assert.match(encoded, /^=\?UTF-8\?B\?/u);
  assert.doesNotMatch(encoded, /[^\x00-\x7f]/u);
  assert.equal(decodeMimeHeaderValue(encoded), subject);

  for (const encodedWord of encoded.split('\r\n ')) {
    assert.ok(encodedWord.length <= 75, `Encoded word is too long: ${encodedWord.length}`);
  }

  assert.equal(encodeMimeHeaderValue('Canvas Notebook release'), 'Canvas Notebook release');
  assert.equal(
    encodeMimeHeaderValue('Release\r\nBcc: hidden@example.test'),
    'Release Bcc: hidden@example.test',
  );

  console.log('Email MIME header encoding test passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
