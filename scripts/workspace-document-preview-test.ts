import assert from 'node:assert/strict';

import {
  buildWorkspaceDocumentPreviewTarget,
  createWorkspaceDocumentPreviewContent,
  workspaceDocumentTitleFromPath,
} from '../app/lib/markdown/workspace-document-preview';

const markdown = `---
title: Project plan
tags: [type/plan]
---

# Project plan

Intro paragraph.

## Outcome

The selected outcome links to [[Shared]].

Another outcome paragraph.

## Notes

Unrelated notes.

Remember this exact block. ^decision
`;

assert.equal(workspaceDocumentTitleFromPath('Projects/project-plan.md'), 'project plan');
assert.equal(buildWorkspaceDocumentPreviewTarget({ path: 'Projects/Plan.md', heading: 'Outcome' }), 'Projects/Plan.md#Outcome');
assert.equal(buildWorkspaceDocumentPreviewTarget({ path: 'Projects/Plan.md', blockId: 'decision' }), 'Projects/Plan.md#^decision');

const fullPreview = createWorkspaceDocumentPreviewContent(markdown, { path: 'Projects/Plan.md' });
assert.doesNotMatch(fullPreview.content, /title: Project plan/u, 'frontmatter should not be rendered in the preview');
assert.match(fullPreview.content, /# Project plan/u);

const headingPreview = createWorkspaceDocumentPreviewContent(markdown, {
  path: 'Projects/Plan.md',
  heading: 'Outcome',
});
assert.match(headingPreview.content, /## Outcome/u);
assert.match(headingPreview.content, /selected outcome/u);
assert.doesNotMatch(headingPreview.content, /## Notes/u);

const blockPreview = createWorkspaceDocumentPreviewContent(markdown, {
  path: 'Projects/Plan.md',
  blockId: 'decision',
});
assert.match(blockPreview.content, /Remember this exact block/u);
assert.doesNotMatch(blockPreview.content, /\^decision/u);

const focusOffset = markdown.indexOf('selected outcome');
const focusPreview = createWorkspaceDocumentPreviewContent(markdown, {
  path: 'Projects/Plan.md',
  focusOffset,
});
assert.match(focusPreview.content, /selected outcome/u);
assert.doesNotMatch(focusPreview.content, /Unrelated notes/u);

const longPreview = createWorkspaceDocumentPreviewContent(
  `# Long\n\n${Array.from({ length: 140 }, (_, index) => `Paragraph ${index}`).join('\n')}`,
  { path: 'Long.md' },
);
assert.equal(longPreview.truncated, true);
assert.ok(longPreview.content.length < 12_500);

console.log('workspace document preview test passed');
