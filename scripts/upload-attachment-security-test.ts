import assert from 'node:assert/strict';

import { getUploadResponsePolicy } from '@/app/lib/files/upload-response-policy';

for (const activeFileName of [
  'page.html',
  'page.htm',
  'page.xhtml',
  'drawing.svg',
  'payload.js',
  'payload.mjs',
  'payload.cjs',
  'document.xml',
]) {
  const policy = getUploadResponsePolicy(activeFileName);
  assert.equal(policy.forceDownload, true, `${activeFileName} must be forced to download.`);
  assert.equal(policy.contentType, 'application/octet-stream');
  assert.match(policy.contentDisposition || '', /^attachment;/u);
}

assert.deepEqual(getUploadResponsePolicy('photo.png'), {
  contentType: 'image/png',
  contentDisposition: null,
  forceDownload: false,
});
assert.deepEqual(getUploadResponsePolicy('document.pdf'), {
  contentType: 'application/pdf',
  contentDisposition: null,
  forceDownload: false,
});
assert.deepEqual(getUploadResponsePolicy('recording.mp4'), {
  contentType: 'video/mp4',
  contentDisposition: null,
  forceDownload: false,
});

const encodedName = getUploadResponsePolicy('unsafe_name---123.html').contentDisposition;
assert.match(encodedName || '', /filename="unsafe_name---123\.html"/u);
assert.doesNotMatch(encodedName || '', /[\r\n]/u);

console.log('upload-attachment-security-test: ok');
