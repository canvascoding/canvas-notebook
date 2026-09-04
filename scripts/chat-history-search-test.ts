import assert from 'node:assert/strict';

import {
  createSessionSearchSnippet,
  escapeSessionSearchLikeValue,
  extractPersistedMessageText,
  getSessionTitleSearchRank,
} from '../app/lib/chat/session-search-text';

assert.equal(getSessionTitleSearchRank('Quarterly planning', 'quarterly planning'), 0);
assert.equal(getSessionTitleSearchRank('Quarterly planning', 'quarter'), 1);
assert.equal(getSessionTitleSearchRank('Our quarterly planning', 'quarter'), 2);
assert.equal(getSessionTitleSearchRank('Quarterly planning', 'launch'), 3);

assert.equal(escapeSessionSearchLikeValue('50%_done\\today'), '50\\%\\_done\\\\today');

const persistedUserMessage = JSON.stringify({
  role: 'user',
  content: [{ type: 'text', text: 'The blue launch concept won.' }, { type: 'image' }],
  timestamp: 1,
});
assert.equal(extractPersistedMessageText(persistedUserMessage), 'The blue launch concept won.\n[image]');
assert.equal(extractPersistedMessageText('Legacy plain-text message'), 'Legacy plain-text message');

const longText = `${'Earlier context '.repeat(20)}needle phrase${' later context'.repeat(20)}`;
const snippet = createSessionSearchSnippet(longText, 'needle phrase', 120);
assert.match(snippet, /needle phrase/);
assert.ok(snippet.length <= 120);
assert.match(snippet, /^\.\.\./);
assert.match(snippet, /\.\.\.$/);

console.log('chat-history-search-test: ok');
