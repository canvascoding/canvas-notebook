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
import { parseObsidianFrontmatter } from '../app/lib/markdown/obsidian-metadata';
import {
  findObsidianWikiCompletionContext,
  getObsidianWikiCompletionInsertPath,
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

const frontmatter = parseObsidianFrontmatter(markdown);
assert.ok(frontmatter);
assert.equal(frontmatter.title, 'Market notes');
assert.deepEqual(frontmatter.aliases, ['Example']);
assert.deepEqual(frontmatter.tags, ['research', 'market analysis']);
assert.equal(markdown.slice(frontmatter.end).trimStart().startsWith('# Intro'), true);
assert.equal(parseObsidianFrontmatter('# No frontmatter'), null);
assert.deepEqual(parseObsidianFrontmatter('---\n: invalid: yaml\n---\n')?.data, {});

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
assert.equal(hasObsidianRichEditorUnsupportedSyntax('See [[Note]].'), true);
assert.equal(hasObsidianRichEditorUnsupportedSyntax('Use ==highlight==.'), true);
assert.equal(hasObsidianRichEditorUnsupportedSyntax('Visible %% hidden %% text.'), true);
assert.equal(hasObsidianRichEditorUnsupportedSyntax('Paragraph ^block-id'), true);
assert.equal(hasObsidianRichEditorUnsupportedSyntax('> [!note] Callout'), true);
assert.equal(hasObsidianRichEditorUnsupportedSyntax('[^1]: Footnote'), true);
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
  from: 6,
  query: 'proj',
  to: completionSource.length,
});
assert.equal(findObsidianWikiCompletionContext('`[[ignored`', 11), null);
assert.equal(findObsidianWikiCompletionContext('[[Plan#Heading', 14), null);
assert.equal(findObsidianWikiCompletionContext('[[Plan|Alias', 12), null);
assert.equal(getObsidianWikiCompletionInsertPath('./projects/Plan.md'), 'projects/Plan');

console.log('obsidian-flavored-markdown-test: ok');
