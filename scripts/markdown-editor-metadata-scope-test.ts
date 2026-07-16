import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const markdownEditorSource = fs.readFileSync(
  path.join(root, 'app', 'components', 'editor', 'MarkdownEditor.tsx'),
  'utf8',
);
const notebookEditorSource = fs.readFileSync(
  path.join(root, 'app', 'components', 'editor', 'FileEditor.tsx'),
  'utf8',
);

assert.match(
  markdownEditorSource,
  /showNotebookMetadata\?: boolean/u,
  'metadata visibility must be an explicit editor capability',
);
assert.match(
  markdownEditorSource,
  /showNotebookMetadata = false/u,
  'shared Markdown editors must hide notebook metadata by default',
);
assert.match(
  markdownEditorSource,
  /\{showNotebookMetadata \? \(\s*<MarkdownPropertiesPanel/u,
  'the rich editor properties panel must be guarded by the notebook capability',
);
assert.match(
  markdownEditorSource,
  /\{showNotebookMetadata && !parsedDocument\.error \? \(\s*<MarkdownPropertiesPanel/u,
  'the read-only source fallback must use the same metadata scope',
);
assert.match(
  notebookEditorSource,
  /<MarkdownEditor[\s\S]*?showNotebookMetadata[\s\S]*?\/>/u,
  'the Notebook file editor must opt into document metadata',
);

const nonNotebookEditorFiles = [
  'app/apps/automations/components/AutomationsClient.tsx',
  'app/components/public-sharing/PublicFilePreview.tsx',
  'app/components/settings/AgentHeartbeatCard.tsx',
  'app/components/settings/AgentManagedFilesCard.tsx',
  'app/components/settings/SkillsPanel.tsx',
  'app/components/skills/SkillDetailDialog.tsx',
];

for (const relativePath of nonNotebookEditorFiles) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  assert.doesNotMatch(
    source,
    /showNotebookMetadata/u,
    `${relativePath} must not opt into Notebook-specific metadata UI`,
  );
}

console.log('markdown editor metadata scope tests passed');
