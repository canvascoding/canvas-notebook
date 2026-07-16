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
import { getWorkspaceDocumentRelations } from '../app/lib/markdown/workspace-document-relations';
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

const relationIndex = buildWorkspaceLinkIndexFromDocuments([
  {
    path: 'Atlas/Home.md',
    content: '---\ntitle: Home\ntags: [project/atlas]\n---\n\n# Home\n\n[[Plan#Outcome|Roadmap]]\n[[Missing Note]]',
  },
  {
    path: 'Atlas/Plan.md',
    content: '---\ntitle: Plan\ntags: [project/atlas]\n---\n\n# Plan\n\n## Outcome\n\n[[Home]]\n[[Research]]',
  },
  { path: 'Atlas/Research.md', content: '# Research' },
  { path: 'Atlas/Brief.md', content: '---\ntitle: Brief\ntags: [project/atlas]\n---\n\n# Brief' },
  { path: 'Inbox/Source.md', content: '# Source\n\n[[Atlas/Home]]' },
]);
const relations = getWorkspaceDocumentRelations(relationIndex, 'Atlas/Home.md', {
  includeRelated: true,
});
assert.equal(relations.document?.title, 'Home');
assert.deepEqual(relations.outgoing.map((relation) => relation.path), ['Atlas/Plan.md']);
assert.equal(relations.outgoing[0]?.bidirectional, true);
assert.deepEqual(relations.outgoing[0]?.headings, ['Outcome']);
assert.deepEqual(relations.outgoing[0]?.linkAliases, ['Roadmap']);
assert.deepEqual(
  relations.incoming.map((relation) => ({ bidirectional: relation.bidirectional, path: relation.path })),
  [
    { bidirectional: true, path: 'Atlas/Plan.md' },
    { bidirectional: false, path: 'Inbox/Source.md' },
  ],
);
assert.deepEqual(relations.brokenLinks.map((relation) => relation.targetText), ['Missing Note']);
assert.deepEqual(
  relations.related.map((relation) => ({
    path: relation.path,
    sharedTags: relation.sharedTags,
    viaDocuments: relation.viaDocuments,
  })),
  [
    { path: 'Atlas/Research.md', sharedTags: [], viaDocuments: ['Atlas/Plan.md'] },
    { path: 'Atlas/Brief.md', sharedTags: ['project/atlas'], viaDocuments: [] },
  ],
);
assert.equal(getWorkspaceDocumentRelations(relationIndex, 'Unknown.md').document, null);

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
