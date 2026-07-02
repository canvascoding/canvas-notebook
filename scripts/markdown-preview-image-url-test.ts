import assert from 'node:assert/strict';

import { resolveMarkdownImageUrl } from '../app/lib/markdown/markdown-image-url';

assert.deepEqual(
  resolveMarkdownImageUrl('chart.png', 'reports/q2/summary.md'),
  {
    ok: true,
    src: '/api/media/preview/reports/q2/chart.png',
    workspacePath: 'reports/q2/chart.png',
    rewritten: true,
  },
  'relative image paths should resolve beside the markdown file',
);

assert.deepEqual(
  resolveMarkdownImageUrl('./images/a b.png?raw=1#chart', 'reports/q2/summary.md'),
  {
    ok: true,
    src: '/api/media/preview/reports/q2/images/a%20b.png?raw=1#chart',
    workspacePath: 'reports/q2/images/a b.png',
    rewritten: true,
  },
  'spaces should be encoded once while query and hash are preserved',
);

assert.deepEqual(
  resolveMarkdownImageUrl('./images/a b.png?raw=1#chart', 'reports/q2/summary.md', { workspaceId: 'team workspace' }),
  {
    ok: true,
    src: '/api/media/preview/__workspace/team%20workspace/reports/q2/images/a%20b.png?raw=1#chart',
    workspacePath: 'reports/q2/images/a b.png',
    rewritten: true,
  },
  'workspace-scoped image paths should preserve query and hash',
);

assert.deepEqual(
  resolveMarkdownImageUrl('../shared/logo%20wide.svg', 'reports/q2/summary.md'),
  {
    ok: true,
    src: '/api/media/preview/reports/shared/logo%20wide.svg',
    workspacePath: 'reports/shared/logo wide.svg',
    rewritten: true,
  },
  'parent-directory references should stay inside the workspace and keep SVG preview support',
);

assert.deepEqual(
  resolveMarkdownImageUrl('/brand/logo.png', 'reports/q2/summary.md'),
  {
    ok: true,
    src: '/api/media/preview/brand/logo.png',
    workspacePath: 'brand/logo.png',
    rewritten: true,
  },
  'leading slash image paths should resolve from the workspace root',
);

assert.deepEqual(
  resolveMarkdownImageUrl('/api/media/existing.png', 'reports/q2/summary.md'),
  {
    ok: true,
    src: '/api/media/existing.png',
    rewritten: false,
  },
  'existing app media URLs should not be rewritten',
);

assert.deepEqual(
  resolveMarkdownImageUrl('https://example.com/image.png', 'reports/q2/summary.md'),
  {
    ok: true,
    src: 'https://example.com/image.png',
    rewritten: false,
  },
  'remote image URLs should not be rewritten',
);

assert.deepEqual(
  resolveMarkdownImageUrl('chart.png'),
  {
    ok: true,
    src: 'chart.png',
    rewritten: false,
  },
  'relative image paths without markdown file context should be left untouched',
);

assert.equal(
  resolveMarkdownImageUrl('../../../secret.png', 'reports/q2/summary.md').ok,
  false,
  'too many parent-directory segments should be blocked',
);

assert.equal(
  resolveMarkdownImageUrl('%2e%2e/%2e%2e/%2e%2e/secret.png', 'reports/q2/summary.md').ok,
  false,
  'encoded parent-directory traversal should be blocked',
);

assert.equal(
  resolveMarkdownImageUrl('file:///Users/example/image.png', 'reports/q2/summary.md').ok,
  false,
  'unsupported protocols should be rejected',
);

console.log('Markdown preview image URL test passed');
