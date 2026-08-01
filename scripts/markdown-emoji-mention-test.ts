import assert from 'node:assert/strict';

import {
  CANVAS_EMOJI_CATALOG,
  filterCanvasEmoji,
} from '../app/lib/editor/emoji-catalog';
import {
  filterWorkspaceMentionCandidates,
  type WorkspaceMentionCandidate,
} from '../app/lib/editor/workspace-mention-candidates-client';
import {
  getMarkdownDocumentStats,
  markdownTextForStats,
} from '../app/lib/editor/markdown-document-stats';

assert.ok(CANVAS_EMOJI_CATALOG.length >= 40, 'the picker should offer a useful compact emoji set');
assert.deepEqual(filterCanvasEmoji('idea').map((item) => item.emoji), ['💡']);
assert.ok(filterCanvasEmoji('status').some((item) => item.emoji === '🟢'));
assert.equal(filterCanvasEmoji('no-such-emoji').length, 0);

const candidates: WorkspaceMentionCandidate[] = [
  { userId: 'user-ada', label: 'Ada Lovelace', detail: 'ada@example.com' },
  { userId: 'user-grace', label: 'Grace Hopper', detail: 'grace@example.com' },
];
assert.deepEqual(
  filterWorkspaceMentionCandidates(candidates, 'hopper').map((candidate) => candidate.userId),
  ['user-grace'],
);
assert.deepEqual(
  filterWorkspaceMentionCandidates(candidates, 'ada@').map((candidate) => candidate.userId),
  ['user-ada'],
);

const mentionMarkdown = 'Owner: @{Ada Lovelace|user-ada} 🚀';
assert.equal(markdownTextForStats(mentionMarkdown), 'Owner: @Ada Lovelace 🚀');
assert.deepEqual(getMarkdownDocumentStats(mentionMarkdown), {
  characters: 22,
  words: 3,
});

console.log('markdown-emoji-mention-test: ok');
