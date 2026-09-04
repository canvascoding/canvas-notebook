import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { workspaceBrandDesignHref } from '../app/lib/workspaces/brand-navigation';

const root = process.cwd();
const readSource = (relativePath: string) => readFileSync(path.join(root, relativePath), 'utf8');
const createDialogSource = readSource('app/components/settings/CreateWorkspaceDialog.tsx');
const editDialogSource = readSource('app/components/settings/EditWorkspaceDialog.tsx');
const brandPanelSource = readSource('app/components/settings/BrandSettingsPanel.tsx');
const german = JSON.parse(readSource('messages/de.json')) as Record<string, unknown>;
const english = JSON.parse(readSource('messages/en.json')) as Record<string, unknown>;

assert.equal(
  workspaceBrandDesignHref('workspace / 1'),
  '/settings?tab=brand-design&scope=workspace&workspaceId=workspace+%2F+1',
);
assert.match(createDialogSource, /setCreatedWorkspace\(workspace\)/u);
assert.doesNotMatch(createDialogSource, /workspace\.type === 'team'[\s\S]*?setCreatedWorkspace/u);
assert.match(createDialogSource, /href=\{workspaceBrandDesignHref\(createdWorkspace\.id\)\}/u);
assert.match(createDialogSource, /<WorkspaceIdentityMark workspace=\{createdWorkspace\}/u);
assert.match(editDialogSource, /data-workspace-submit-intent="brand-design"/u);
assert.match(editDialogSource, /router\.push\(workspaceBrandDesignHref\(workspace\.id\)\)/u);
assert.match(brandPanelSource, /const requestedWorkspaceId = searchParams\.get\('workspaceId'\)/u);
assert.match(
  brandPanelSource,
  /useState<string \| null>\(\(\) => requestedWorkspaceId\)/u,
);

for (const messages of [german, english]) {
  const settings = messages.settings as Record<string, unknown>;
  const settingsBrandDesign = settings.brandDesign as Record<string, unknown>;
  const appearance = settingsBrandDesign.appearance as Record<string, unknown>;
  const workspacePanel = settings.workspacePanel as Record<string, unknown>;
  const management = workspacePanel.management as Record<string, unknown>;
  const brandDesign = management.brandDesign as Record<string, unknown>;
  const fields = management.fields as Record<string, unknown>;
  const colorPicker = management.colorPicker as Record<string, unknown>;
  assert.equal(typeof brandDesign.open, 'string');
  assert.equal(typeof brandDesign.saveAndOpen, 'string');
  assert.match(String(fields.color), /accent|Akzent/iu);
  assert.match(String(colorPicker.hint), /accent|Akzent/iu);
  assert.match(String(appearance.off), /accent|Akzent/iu);
}

console.log('workspace-brand-workflow-ui-test: ok');
