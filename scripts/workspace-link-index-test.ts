import assert from 'node:assert/strict';

import {
  buildWorkspaceLinkIndexFromDocuments,
  extractWorkspaceMarkdownHeadings,
  rewriteWorkspaceWikiLinksForRename,
} from '../app/lib/markdown/workspace-link-index-core';
import {
  getWorkspaceWikiCompletionItems,
  invalidateWorkspaceLinkIndexCache,
  loadWorkspaceLinkIndex,
  resolveWorkspaceLinkFromIndex,
} from '../app/lib/markdown/workspace-link-index-client';
import { selectObsidianEmbedContent } from '../app/lib/markdown/obsidian-embed';

const overview = `---
title: Project overview
tags: [project, active]
---

# Overview

See [[Plan#Outcome|the plan]], [[Decision Alias]], and [the source](../Shared.md#Reference).
Legacy notebook link: [Plan route](https://canvas.example/de/notebook?path=Projects%2FPlan.md#Outcome).
Broken: [[Does Not Exist]].

\`[[ignored-inline]]\`

\`\`\`md
[[ignored-fence]]
\`\`\`
`;

const index = buildWorkspaceLinkIndexFromDocuments([
  { path: 'Projects/Overview.md', content: overview },
  { path: 'Projects/Plan.md', content: '# Plan\n\n## Outcome\n\nDone. ^result' },
  {
    path: 'Projects/Decision.md',
    content: '---\naliases: [Decision Alias]\n---\n\n# Decision',
  },
  { path: 'Shared.md', content: '# Reference\n\nShared material.' },
], new Date('2026-07-14T10:00:00.000Z'));

assert.equal(index.documents.length, 4);
assert.equal(index.documents.find((document) => document.path === 'Projects/Overview.md')?.title, 'Project overview');
assert.deepEqual(
  index.documents.find((document) => document.path === 'Projects/Overview.md')?.tags,
  ['project', 'active'],
);
assert.deepEqual(extractWorkspaceMarkdownHeadings('# ATX\n\nSetext\n------\n\n```md\n# ignored\n```'), [
  { depth: 1, text: 'ATX' },
  { depth: 2, text: 'Setext' },
]);

assert.equal(index.edges.length, 5);
const planEdge = index.edges.find((edge) => edge.targetText.startsWith('Plan#'));
assert.equal(planEdge?.targetPath, 'Projects/Plan.md');
assert.equal(planEdge?.heading, 'Outcome');
assert.equal(planEdge?.alias, 'the plan');
assert.equal(index.edges.find((edge) => edge.targetText === 'Decision Alias')?.targetPath, 'Projects/Decision.md');
assert.equal(index.edges.find((edge) => edge.kind === 'markdown')?.targetPath, 'Shared.md');
assert.equal(
  index.edges.find((edge) => edge.raw.includes('canvas.example'))?.targetPath,
  'Projects/Plan.md',
);
assert.equal(index.brokenLinks.length, 1);
assert.equal(index.brokenLinks[0].targetText, 'Does Not Exist');
assert.equal(index.backlinks['Projects/Plan.md'].length, 2);

const rewritten = rewriteWorkspaceWikiLinksForRename(
  overview,
  index.edges.filter((edge) => edge.sourcePath === 'Projects/Overview.md'),
  'Projects/Plan.md',
  'Projects/Roadmap.md',
);
assert.equal(rewritten.updatedLinks, 1);
assert.match(rewritten.content, /\[\[Projects\/Roadmap#Outcome\|the plan\]\]/);
assert.doesNotMatch(rewritten.content, /\[\[Plan#Outcome/);
assert.match(rewritten.content, /\[\[Decision Alias\]\]/);

const directoryRewrite = rewriteWorkspaceWikiLinksForRename(
  overview,
  index.edges.filter((edge) => edge.sourcePath === 'Projects/Overview.md'),
  'Projects',
  'Archive/Projects',
);
assert.equal(directoryRewrite.updatedLinks, 2);
assert.match(directoryRewrite.content, /\[\[Archive\/Projects\/Plan#Outcome\|the plan\]\]/);
assert.match(directoryRewrite.content, /\[\[Archive\/Projects\/Decision\]\]/);

assert.equal(getWorkspaceWikiCompletionItems(index, {
  fragmentQuery: null,
  kind: 'document',
  pathQuery: 'decision alias',
})[0]?.target, 'Projects/Decision');
assert.deepEqual(getWorkspaceWikiCompletionItems(index, {
  fragmentQuery: 'out',
  kind: 'heading',
  pathQuery: 'Plan',
}, 'Projects/Overview.md').map((item) => item.target), ['Projects/Plan#Outcome']);
assert.deepEqual(getWorkspaceWikiCompletionItems(index, {
  fragmentQuery: '^res',
  kind: 'block',
  pathQuery: 'Plan',
}, 'Projects/Overview.md').map((item) => item.target), ['Projects/Plan#^result']);
assert.equal(
  selectObsidianEmbedContent('# Plan\n\n## Outcome\n\nDone. ^result\n\n## Next\n\nLater.', 'Plan#Outcome'),
  '## Outcome\n\nDone. ^result',
);
assert.equal(
  selectObsidianEmbedContent('# Plan\n\nDecision text ^result\n\nNext paragraph.', 'Plan#^result'),
  'Decision text',
);

async function testWorkspaceLinkIndexClient(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let linkIndexRequests = 0;
  globalThis.fetch = async () => {
    linkIndexRequests += 1;
    return new Response(JSON.stringify({ success: true, index }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });
  };

  try {
    const [firstLoad, concurrentLoad] = await Promise.all([
      loadWorkspaceLinkIndex('workspace-a'),
      loadWorkspaceLinkIndex('workspace-a'),
    ]);
    assert.equal(firstLoad, concurrentLoad);
    assert.equal(linkIndexRequests, 1);
    assert.equal(
      resolveWorkspaceLinkFromIndex('Decision Alias', firstLoad, 'Projects/Overview.md')?.path,
      'Projects/Decision.md',
    );

    invalidateWorkspaceLinkIndexCache('workspace-a');
    await loadWorkspaceLinkIndex('workspace-a');
    assert.equal(linkIndexRequests, 2);
  } finally {
    globalThis.fetch = originalFetch;
    invalidateWorkspaceLinkIndexCache();
  }
}

void testWorkspaceLinkIndexClient().then(() => {
  console.log('workspace-link-index-test: ok');
});
