import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const editorSource = fs.readFileSync(
  path.join(root, 'app', 'components', 'editor', 'MarkdownEditor.tsx'),
  'utf8',
);
const mentionSource = fs.readFileSync(
  path.join(root, 'app', 'components', 'editor', 'MarkdownMentionSuggestions.tsx'),
  'utf8',
);
const routeSource = fs.readFileSync(
  path.join(root, 'app', 'api', 'workspaces', '[id]', 'mention-candidates', 'route.ts'),
  'utf8',
);

assert.match(editorSource, /data-testid="markdown-emoji-dialog"/u);
assert.match(editorSource, /id: 'emoji'[\s\S]*?openEmojiDialog/u);
assert.match(editorSource, /id: 'mention'[\s\S]*?insertContent\('@'\)/u);
assert.match(editorSource, /createMarkdownMentionSuggestions\(\{ labels: mentionLabels, workspaceId \}\)/u);
assert.match(mentionSource, /data-testid="markdown-mention-menu"/u);
assert.match(mentionSource, /type: 'markdownMention'[\s\S]*?userId: props\.userId/u);
assert.match(
  routeSource,
  /auth\.api\.getSession[\s\S]*?WORKSPACE_CONTEXT_MISMATCH[\s\S]*?listMobileWorkspaceMembers/u,
  'mention candidates must require authentication, selected workspace context, and readable membership',
);
assert.doesNotMatch(
  routeSource,
  /candidates[\s\S]*?canWrite|candidates[\s\S]*?canManage/u,
  'the suggestion response should expose identity labels without workspace permissions',
);

console.log('markdown-emoji-mention-ui-test: ok');
