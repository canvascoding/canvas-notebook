import assert from 'node:assert/strict';

import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';

import {
  createRichMarkdownYDoc,
  replaceRichMarkdownInYDoc,
  richMarkdownSchemaExtensions,
  richMarkdownFromYDoc,
  validateRichMarkdownYDoc,
} from '../app/lib/collaboration/markdown-state';

const markdown = `# Shared note

Highlighted ==collaborative text== remains rich-editable.

Workspace member @{Ada Lovelace|user-ada} remains identifiable.

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

const schema = getSchema(richMarkdownSchemaExtensions());

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
