import assert from 'node:assert/strict';

import { normalizeBrowserAddressInput } from '../app/lib/pi/browser/address';

assert.equal(normalizeBrowserAddressInput(' youtube.com '), 'https://youtube.com');
assert.equal(normalizeBrowserAddressInput('example.com/path?q=canvas'), 'https://example.com/path?q=canvas');
assert.equal(normalizeBrowserAddressInput('//example.com/path'), 'https://example.com/path');
assert.equal(normalizeBrowserAddressInput('http://example.com'), 'http://example.com');
assert.equal(normalizeBrowserAddressInput('https://example.com'), 'https://example.com');
assert.equal(normalizeBrowserAddressInput('about:blank'), 'about:blank');
assert.equal(normalizeBrowserAddressInput('   '), '');

console.log('browser-address-test: ok');
