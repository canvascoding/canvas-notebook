import assert from 'node:assert/strict';

import {
  createObsidianSyntaxMask,
  getObsidianWikiDisplayLabel,
  hasObsidianRichEditorUnsupportedSyntax,
  parseObsidianBlockIds,
  parseObsidianCallouts,
  parseObsidianWikiLinks,
  parseObsidianWikiTarget,
} from '../app/lib/markdown/obsidian-flavored-markdown';
import {
  composeCanvasMarkdownDocument,
  normalizeCanvasTags,
  parseCanvasMarkdownDocument,
  parseObsidianFrontmatter,
  splitCanvasMarkdownForRichEditor,
  stripCanvasMarkdownFrontmatterForPresentation,
  updateCanvasMarkdownProperties,
} from '../app/lib/markdown/obsidian-metadata';
import {
  buildObsidianWikiLinkTarget,
  findObsidianWikiCompletionContext,
  getCanvasNotebookMarkdownLinkTarget,
  getObsidianWikiCompletionInsertPath,
  getWorkspaceMarkdownLinkTarget,
  getWorkspaceMarkdownNavigationTarget,
  resolveObsidianWikiLink,
} from '../app/lib/markdown/obsidian-link-resolver';

const markdown = `---
title: Market notes
aliases:
  - Example
tags: [research, "market analysis"]
---

# Intro

See [[research/Market Analysis#Results|the results]] and ![[assets/chart.png|640]].

Inline code \`[[ignored-inline]]\` stays literal.

%% [[ignored-comment]] %%

\`\`\`md
[[ignored-fence]]
\`\`\`

> [!warning]- Important
> Review the assumptions.

Reusable paragraph ^assumptions
`;

const links = parseObsidianWikiLinks(markdown);
assert.equal(links.length, 2);
assert.deepEqual(
  {
    alias: links[0].alias,
    blockId: links[0].blockId,
    embed: links[0].embed,
    heading: links[0].heading,
    path: links[0].path,
  },
  {
    alias: 'the results',
    blockId: null,
    embed: false,
    heading: 'Results',
    path: 'research/Market Analysis',
  },
);
assert.equal(links[1].embed, true);
assert.equal(links[1].path, 'assets/chart.png');
assert.equal(links[1].alias, '640');
assert.deepEqual(
  parseObsidianWikiLinks(String.raw`\[[Literal]] and \![[Embed]] and [[Real]]`).map((link) => link.target),
  ['Real'],
);

const frontmatter = parseObsidianFrontmatter(markdown);
assert.ok(frontmatter);
assert.equal(frontmatter.title, 'Market notes');
assert.deepEqual(frontmatter.aliases, ['Example']);
assert.deepEqual(frontmatter.tags, ['research', 'market analysis']);
assert.equal(markdown.slice(frontmatter.end).trimStart().startsWith('# Intro'), true);
assert.equal(parseObsidianFrontmatter('# No frontmatter'), null);
assert.deepEqual(parseObsidianFrontmatter('---\n: invalid: yaml\n---\n')?.data, {});

const parsedDocument = parseCanvasMarkdownDocument(markdown);
assert.equal(parsedDocument.error, null);
assert.equal(parsedDocument.hasFrontmatter, true);
assert.equal(
  composeCanvasMarkdownDocument(parsedDocument.frontmatterPrefix, parsedDocument.body),
  markdown,
);
const richDocument = splitCanvasMarkdownForRichEditor(markdown);
assert.equal(richDocument.body.startsWith('# Intro'), true);
assert.equal(composeCanvasMarkdownDocument(richDocument.prefix, richDocument.body), markdown);
assert.equal(
  stripCanvasMarkdownFrontmatterForPresentation(markdown).trimStart().startsWith('# Intro'),
  true,
);
assert.equal(
  stripCanvasMarkdownFrontmatterForPresentation('---\n: invalid: yaml\n---\nVisible body'),
  'Visible body',
);
assert.equal(
  stripCanvasMarkdownFrontmatterForPresentation('---\ntitle: Not closed\nVisible body'),
  '---\ntitle: Not closed\nVisible body',
);

const updatedProperties = updateCanvasMarkdownProperties(`---
# This comment must survive
title: Old title
custom:
  nested: true
tags: [Research, "Market Analysis"]
---

# Body
`, {
  aliases: ['Plan', 'Plan', ' Roadmap '],
  tags: ['#Research', 'Market Analysis', 'status/Draft'],
  title: 'New title',
});
assert.equal(updatedProperties.error, null);
assert.equal(updatedProperties.changed, true);
assert.match(updatedProperties.markdown, /# This comment must survive/);
assert.match(updatedProperties.markdown, /nested: true/);
assert.match(updatedProperties.markdown, /title: New title/);
assert.deepEqual(parseObsidianFrontmatter(updatedProperties.markdown)?.tags, [
  'research',
  'market-analysis',
  'status/draft',
]);
assert.deepEqual(parseObsidianFrontmatter(updatedProperties.markdown)?.aliases, ['Plan', 'Roadmap']);
assert.match(updatedProperties.markdown, /\n# Body\n$/);

const createdProperties = updateCanvasMarkdownProperties('# Untagged document\n', {
  tags: ['type/Note', ' topic/Project Plan '],
  title: 'Untagged document',
});
assert.equal(createdProperties.error, null);
assert.match(createdProperties.markdown, /^---\ntitle: Untagged document\ntags:\n  - type\/note\n  - topic\/project-plan\n---\n\n# Untagged document/);
assert.deepEqual(normalizeCanvasTags(['#Topic/AI', 'topic/ai', 'Market Analysis']), [
  'topic/ai',
  'market-analysis',
]);

const invalidProperties = updateCanvasMarkdownProperties('---\n: invalid: yaml\n---\nBody', {
  tags: ['research'],
});
assert.equal(invalidProperties.changed, false);
assert.ok(invalidProperties.error);
assert.equal(invalidProperties.markdown, '---\n: invalid: yaml\n---\nBody');

const malformedDocument = parseCanvasMarkdownDocument('---\ntitle: Missing close\nBody');
assert.equal(malformedDocument.hasFrontmatter, true);
assert.ok(malformedDocument.error);

const bomDocument = updateCanvasMarkdownProperties('\uFEFF# Body', { title: 'BOM' });
assert.equal(bomDocument.markdown.charCodeAt(0), 0xfeff);

const selfHeading = parseObsidianWikiTarget('#Local heading|jump');
assert.ok(selfHeading);
assert.equal(selfHeading.path, '');
assert.equal(selfHeading.heading, 'Local heading');
assert.equal(getObsidianWikiDisplayLabel(selfHeading), 'jump');

const blockTarget = parseObsidianWikiTarget('Notes#^decision-1');
assert.equal(blockTarget?.blockId, 'decision-1');
assert.equal(blockTarget?.heading, null);

const callouts = parseObsidianCallouts(markdown);
assert.deepEqual(callouts.map(({ fold, title, type }) => ({ fold, title, type })), [
  { fold: '-', title: 'Important', type: 'warning' },
]);

const blockIds = parseObsidianBlockIds(markdown);
assert.deepEqual(blockIds.map(({ id }) => id), ['assumptions']);

const mask = createObsidianSyntaxMask(markdown);
assert.equal(mask.length, markdown.length);
assert.doesNotMatch(mask, /ignored-inline|ignored-comment|ignored-fence/);
assert.match(mask, /research\/Market Analysis/);

assert.equal(hasObsidianRichEditorUnsupportedSyntax('Normal **GFM** with `$code` and $E=mc^2$.'), false);
assert.equal(hasObsidianRichEditorUnsupportedSyntax('A `code` span and\n\n```ts\nconst x = 1\n```'), false);
assert.equal(hasObsidianRichEditorUnsupportedSyntax('See [[Note]].'), false);
assert.equal(hasObsidianRichEditorUnsupportedSyntax('Use ==highlight==.'), false);
assert.equal(hasObsidianRichEditorUnsupportedSyntax('Claim.^[Inline note]'), false);
assert.equal(hasObsidianRichEditorUnsupportedSyntax('Visible %% hidden %% text.'), true);
assert.equal(hasObsidianRichEditorUnsupportedSyntax('Paragraph ^block-id'), true);
assert.equal(hasObsidianRichEditorUnsupportedSyntax('> [!note] Callout'), false);
assert.equal(hasObsidianRichEditorUnsupportedSyntax('[^1]: Footnote'), false);
assert.equal(hasObsidianRichEditorUnsupportedSyntax('---\ntitle: Test\n---\n'), true);

const workspaceFiles = [
  { extension: 'md', path: 'projects/Plan.md', type: 'file' as const },
  { extension: 'markdown', path: 'archive/Plan.markdown', type: 'file' as const },
  { extension: 'md', path: 'projects/Decision.md', type: 'file' as const },
  { extension: 'png', path: 'projects/Plan.png', type: 'file' as const },
];
const explicitResolution = resolveObsidianWikiLink(
  'projects/Decision#Outcome|decision',
  workspaceFiles,
  'projects/Overview.md',
);
assert.equal(explicitResolution?.status, 'resolved');
assert.equal(explicitResolution?.path, 'projects/Decision.md');
assert.equal(explicitResolution?.heading, 'Outcome');

const localResolution = resolveObsidianWikiLink('Decision', workspaceFiles, 'projects/Overview.md');
assert.equal(localResolution?.path, 'projects/Decision.md');
assert.equal(resolveObsidianWikiLink('Plan', workspaceFiles)?.status, 'ambiguous');
assert.equal(resolveObsidianWikiLink('#Intro', workspaceFiles, 'projects/Overview.md')?.path, 'projects/Overview.md');
assert.equal(resolveObsidianWikiLink('Missing', workspaceFiles)?.status, 'missing');

const completionSource = 'See [[proj';
assert.deepEqual(findObsidianWikiCompletionContext(completionSource, completionSource.length), {
  embed: false,
  fragmentQuery: null,
  from: 6,
  kind: 'document',
  pathQuery: 'proj',
  query: 'proj',
  to: completionSource.length,
});
assert.equal(findObsidianWikiCompletionContext('`[[ignored`', 11), null);
assert.deepEqual(findObsidianWikiCompletionContext('[[Plan#Heading', 14), {
  embed: false,
  fragmentQuery: 'Heading',
  from: 2,
  kind: 'heading',
  pathQuery: 'Plan',
  query: 'Plan#Heading',
  to: 14,
});
assert.equal(findObsidianWikiCompletionContext('[[Plan#^block', 14)?.kind, 'block');
assert.equal(findObsidianWikiCompletionContext('[[Plan|Alias', 12), null);
assert.equal(getObsidianWikiCompletionInsertPath('./projects/Plan.md'), 'projects/Plan');
assert.equal(
  buildObsidianWikiLinkTarget('projects/Plan.md#Outcome', 'the plan'),
  'projects/Plan#Outcome|the plan',
);
assert.equal(
  buildObsidianWikiLinkTarget('![[projects/Plan#^decision|old label]]', 'new | label'),
  String.raw`projects/Plan#^decision|new \| label`,
);
assert.equal(buildObsidianWikiLinkTarget('#Local heading'), '#Local heading');
assert.equal(buildObsidianWikiLinkTarget(''), null);
assert.equal(getWorkspaceMarkdownLinkTarget('../Shared.md#Reference', 'projects/Overview.md'), '../Shared.md#Reference');
assert.equal(getWorkspaceMarkdownLinkTarget('#Local heading', 'projects/Overview.md'), '#Local heading');
assert.equal(getWorkspaceMarkdownLinkTarget('https://example.com/Plan.md', 'projects/Overview.md'), null);
assert.equal(getWorkspaceMarkdownLinkTarget('../assets/plan.pdf', 'projects/Overview.md'), null);
assert.equal(
  getCanvasNotebookMarkdownLinkTarget('/de/notebook?path=projects%2FPlan.md#Outcome'),
  'projects/Plan.md#Outcome',
);
assert.equal(
  getCanvasNotebookMarkdownLinkTarget('https://canvas.example/en/notebook?path=projects%2FPlan.md'),
  'projects/Plan.md',
);
assert.equal(getCanvasNotebookMarkdownLinkTarget('https://example.com/projects/Plan.md'), null);
assert.equal(
  getWorkspaceMarkdownNavigationTarget('../Shared.md#Reference', 'projects/Overview.md'),
  '../Shared.md#Reference',
);

console.log('obsidian-flavored-markdown-test: ok');
