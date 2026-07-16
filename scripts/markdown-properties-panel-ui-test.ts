import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.join(process.cwd(), 'app', 'components', 'editor', 'MarkdownPropertiesPanel.tsx'),
  'utf8',
);

assert.match(
  source,
  /grid-cols-\[2\.25rem_minmax\(0,1fr\)_auto\]/u,
  'the mobile header must reserve independent columns for icon, title, and controls',
);
assert.match(
  source,
  /line-clamp-2 block break-words/u,
  'long frontmatter titles must wrap instead of competing with the property count',
);
assert.match(
  source,
  /data-testid="markdown-properties-tags"/u,
  'the responsive tag region must remain identifiable for browser coverage',
);
assert.match(
  source,
  /max-h-28 overflow-y-auto overscroll-contain/u,
  'many collapsed tags must not make the document header unbounded',
);
assert.match(
  source,
  /\[overflow-wrap:anywhere\]/u,
  'long tags and metadata values must be allowed to wrap',
);
assert.match(
  source,
  /className="ml-0\.5 flex h-6 w-6 shrink-0/u,
  'tag removal must retain a stable touch target when labels wrap',
);

console.log('markdown properties panel UI tests passed');
