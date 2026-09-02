import assert from 'node:assert/strict';

import { getSchema } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';

import {
  createRichMarkdownYDoc,
  replaceRichMarkdownInYDoc,
  richMarkdownSchemaExtensions,
  richMarkdownFromYDoc,
  validateRichMarkdownYDoc,
} from '../app/lib/collaboration/markdown-state';
import { TiptapTransformer, YProsemirror } from '../app/lib/collaboration/server-runtime';
import { selectInitialTextCollaborationRepresentation } from '../app/lib/collaboration/document-state-service';

assert.equal(
  selectInitialTextCollaborationRepresentation('safe.md', '# Safe\n'),
  'tiptap_xml',
  'round-trip-safe Markdown may initialize the collaborative rich-text representation',
);
assert.equal(
  selectInitialTextCollaborationRepresentation('normalizable.md', '1. First\n\n2. Second\n'),
  'plain_text',
  'safe normalization must remain explicit before initializing collaborative rich text',
);
assert.equal(
  selectInitialTextCollaborationRepresentation('source.md', '# Raw HTML\n\n<div>keep exactly</div>\n'),
  'plain_text',
  'lossy Markdown must initialize the exact plain-text representation',
);

const markdown = `# Shared note

Highlighted ==collaborative text== remains rich-editable.

Workspace member @{Ada Lovelace|user-ada} remains identifiable.

Release notes remain linked as [[03_releases/v2026.5.21.3/social-posts.md|v2026.5.21.3]].

> [!warning]+ Review together
> This callout is part of the shared document schema.

Reference from another editor.[^1]

[^1]: Shared footnote definition.

<details>
<summary>Shared context</summary>

The details body survives the Yjs conversion.

</details>`;

const richDocument = createRichMarkdownYDoc(markdown);

try {
  const serialized = richMarkdownFromYDoc(richDocument);
  assert.match(serialized, /==collaborative text==/u);
  assert.match(serialized, /@\{Ada Lovelace\|user-ada\}/u);
  assert.match(serialized, /\[\[03_releases\/v2026\.5\.21\.3\/social-posts\.md\|v2026\.5\.21\.3\]\]/u);
  assert.match(serialized, /^> \[!warning\]\+ Review together$/mu);
  assert.match(serialized, /another editor\.\[\^1\]/u);
  assert.match(serialized, /^\[\^1\]: Shared footnote definition\.$/mu);
  assert.match(serialized, /^<details>\n<summary>Shared context<\/summary>/mu);
  assert.equal(
    validateRichMarkdownYDoc(richDocument).valid,
    true,
    'the shared rich-document schema must validate the new Markdown nodes',
  );

  const replacement = markdown.replace(
    'The details body survives the Yjs conversion.',
    'A collaborator can replace the details body without losing its structure.',
  );
  replaceRichMarkdownInYDoc(richDocument, replacement, { actorType: 'user', actorId: 'test-user' });
  assert.match(
    richMarkdownFromYDoc(richDocument),
    /A collaborator can replace the details body without losing its structure\./u,
  );
} finally {
  richDocument.destroy();
}

const blankTableMarkdown = `|   |   |   |
| --- | --- | --- |
|   |   |   |`;
const blankTableDocument = createRichMarkdownYDoc(blankTableMarkdown);
try {
  const serializedTable = richMarkdownFromYDoc(blankTableDocument);
  assert.doesNotMatch(
    serializedTable,
    /> \[!note\]/u,
    'blank collaborative table cells must not materialize as Note callouts',
  );
  assert.equal(
    validateRichMarkdownYDoc(blankTableDocument).valid,
    true,
    'blank tables must remain valid collaborative Markdown documents',
  );
} finally {
  blankTableDocument.destroy();
}

const schema = getSchema(richMarkdownSchemaExtensions());
assert.ok(schema.nodes.obsidianWikiLink, 'the collaboration schema must preserve workspace wiki links');
assert.equal(
  schema.topNodeType.contentMatch.defaultType?.name,
  'paragraph',
  'the collaboration schema must fill empty containers with paragraphs, not callouts',
);

const terminalCalloutMarkdown = '> [!tip] Tipp\n> Inhalt.\n';
const terminalCalloutDocument = createRichMarkdownYDoc(terminalCalloutMarkdown);
try {
  const json = TiptapTransformer.fromYdoc(terminalCalloutDocument, 'body');
  const proseMirrorDocument = schema.nodeFromJSON(json);
  const trailingParagraph = schema.nodes.paragraph.create({ id: 'terminal-empty-paragraph' });
  const documentWithTrailingParagraph = proseMirrorDocument.copy(
    proseMirrorDocument.content.append(Fragment.from(trailingParagraph)),
  );
  YProsemirror.updateYFragment(
    terminalCalloutDocument,
    terminalCalloutDocument.getXmlFragment('body'),
    documentWithTrailingParagraph,
    { mapping: new Map(), isOMark: new Map() },
  );

  assert.equal(
    richMarkdownFromYDoc(terminalCalloutDocument),
    terminalCalloutMarkdown,
    'a structural trailing editor paragraph must serialize to the preserved single line ending',
  );
  assert.equal(
    validateRichMarkdownYDoc(terminalCalloutDocument).valid,
    true,
    'a callout followed by an empty editor paragraph must remain round-trip stable',
  );
} finally {
  terminalCalloutDocument.destroy();
}

for (const [label, transientNode] of [
  [
    'callout body',
    schema.nodes.canvasCallout.create(
      { calloutType: 'note' },
      schema.nodes.canvasCalloutTitle.create(null, schema.text('Restoring')),
    ),
  ],
  [
    'callout title',
    schema.nodes.canvasCallout.create(
      { calloutType: 'note' },
      schema.nodes.paragraph.create(null, schema.text('Restoring')),
    ),
  ],
  [
    'details content',
    schema.nodes.canvasDetails.create(
      null,
      schema.nodes.canvasDetailsSummary.create(null, schema.text('Restoring')),
    ),
  ],
  [
    'footnote body',
    schema.nodes.markdownFootnoteDefinition.create({ footnoteId: '1' }),
  ],
] as const) {
  const transientDocument = schema.nodes.doc.create(null, transientNode);
  const transientState = EditorState.create({ schema, doc: transientDocument });

  assert.doesNotThrow(
    () => transientState.tr.setNodeMarkup(0, undefined, {
      ...transientNode.attrs,
      id: `restored-${transientNode.type.name}`,
    }),
    `UniqueID must be able to update a rich block while its collaborative ${label} is still restoring`,
  );
}

console.log('markdown-rich-blocks-collaboration-test: ok');
