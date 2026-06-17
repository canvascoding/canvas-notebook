import assert from 'node:assert/strict';

import { htmlToPlainText, plainTextToEmailHtml } from '../app/lib/email/html-conversion';

assert.equal(
  plainTextToEmailHtml('Hello Frank\nHow are you?\n\nBest,\nCanvas'),
  '<p>Hello Frank<br>How are you?</p><p>Best,<br>Canvas</p>',
);

assert.equal(plainTextToEmailHtml(''), '');
assert.equal(htmlToPlainText('<p>Hello <strong>Frank</strong></p><ul><li>One</li><li>Two</li></ul>'), 'Hello Frank\n\n- One\n- Two');
assert.equal(htmlToPlainText('<p>Fish &amp; Chips&nbsp;&lt;3</p>'), 'Fish & Chips <3');
assert.equal(
  htmlToPlainText('<table><tr><th>Name</th><th>Qty</th></tr><tr><td>Canvas</td><td>2</td></tr></table>'),
  'Name\tQty\nCanvas\t2',
);

console.log('Email HTML conversion test passed.');
