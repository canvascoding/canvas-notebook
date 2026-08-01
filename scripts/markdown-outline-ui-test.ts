import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const panelSource = fs.readFileSync(
  path.join(root, 'app', 'components', 'editor', 'MarkdownOutlinePanel.tsx'),
  'utf8',
);
const editorSource = fs.readFileSync(
  path.join(root, 'app', 'components', 'editor', 'MarkdownEditor.tsx'),
  'utf8',
);

assert.match(
  panelSource,
  /data-testid="markdown-outline-toggle"/u,
  'the collapsed outline must expose a stable UI test target',
);
assert.match(
  panelSource,
  /data-testid="markdown-outline-panel"/u,
  'the expanded outline must expose a stable UI test target',
);
assert.match(
  panelSource,
  /aria-pressed=\{pinned\}/u,
  'the pin control must expose its current state to assistive technology',
);
assert.match(
  panelSource,
  /aria-current=\{activeAnchor === heading\.anchor \? 'location' : undefined\}/u,
  'the active heading must be announced as the current location',
);
assert.match(
  panelSource,
  /w-\[min\(18rem,calc\(100vw-1\.5rem\)\)\]/u,
  'the floating outline must remain inside narrow mobile viewports',
);
assert.match(
  editorSource,
  /outlinePinned && 'md:pr-\[17\.5rem\]'/u,
  'pinning the outline must reserve document space instead of covering text',
);
assert.match(
  editorSource,
  /<MarkdownOutlinePanel[\s\S]*?scrollContainerRef=\{scrollContainerRef\}/u,
  'the outline must be connected to the Markdown editor scroll container',
);

console.log('markdown outline UI tests passed');
