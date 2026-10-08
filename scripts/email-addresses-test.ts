import assert from 'node:assert/strict';
import { emailReplyRecipients, formatEmailAddresses, parseEmailAddresses } from '../app/lib/email/addresses';

const header = '"Müller, Anna" <Anna@example.test>, Bob <bob@example.test>';
assert.deepEqual(parseEmailAddresses(header), [
  { address: 'anna@example.test', name: 'Müller, Anna' },
  { address: 'bob@example.test', name: 'Bob' },
]);
assert.deepEqual(parseEmailAddresses(formatEmailAddresses(parseEmailAddresses(header))), parseEmailAddresses(header));
assert.deepEqual(parseEmailAddresses({ emailAddress: { address: 'A@example.test', name: 'Anna' } }), [{ address: 'a@example.test', name: 'Anna' }]);
assert.deepEqual(parseEmailAddresses('invented person'), []);
assert.deepEqual(parseEmailAddresses('Anna <anna@example.test> (team, sales), bob@example.test (Bob)'), [
  { address: 'anna@example.test', name: 'Anna' }, { address: 'bob@example.test', name: 'Bob' },
]);
assert.deepEqual(parseEmailAddresses('a@example.test\r\nBcc: hidden@example.test'), []);
const message = { from: 'Robot <no-reply@example.test>', replyTo: header, to: ['ME@example.test', 'bob@example.test'], cc: ['bob@example.test', 'cc@example.test', 'me@example.test'] };
assert.deepEqual(emailReplyRecipients(message, 'reply', ['me@example.test']), { to: ['anna@example.test', 'bob@example.test'], cc: [] });
assert.deepEqual(emailReplyRecipients(message, 'reply-all', ['me@example.test']), { to: ['anna@example.test', 'bob@example.test'], cc: ['cc@example.test'] });
assert.deepEqual(emailReplyRecipients({ from: 'me@example.test', to: 'Anna <anna@example.test>' }, 'reply', ['me@example.test']), { to: ['anna@example.test'], cc: [] });
assert.deepEqual(emailReplyRecipients({ from: 'anna@example.test', replyTo: 'me@example.test', to: 'me@example.test, other@example.test' }, 'reply', ['me@example.test']), { to: ['anna@example.test'], cc: [] });
assert.deepEqual(emailReplyRecipients(message, 'forward', []), { to: [], cc: [] });
console.log('Email address and reply-recipient tests passed.');
