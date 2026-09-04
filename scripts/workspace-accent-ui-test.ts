import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const appearanceProviderSource = readFileSync(
  path.join(root, 'app/components/WorkspaceAppearanceProvider.tsx'),
  'utf8',
);

assert.match(appearanceProviderSource, /const activeWorkspace = useWorkspaceStore\(selectActiveWorkspace\)/u);
assert.match(
  appearanceProviderSource,
  /definition\?\.enabled[\s\S]*?applyWorkspaceAppearance[\s\S]*?applyWorkspaceAccent\(root, workspaceId, activeWorkspace\.color/u,
  'The standard Canvas appearance must use the active workspace color without replacing a full brand profile.',
);
assert.match(appearanceProviderSource, /root\.dataset\.workspaceAppearance = 'accent'/u);
assert.match(appearanceProviderSource, /WORKSPACE_ACCENT_CSS_PROPERTIES/u);

console.log('workspace-accent-ui-test: ok');
