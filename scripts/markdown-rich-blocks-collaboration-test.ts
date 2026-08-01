import assert from 'node:assert/strict';

import {
  createRichMarkdownYDoc,
  replaceRichMarkdownInYDoc,
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

console.log('markdown-rich-blocks-collaboration-test: ok');
