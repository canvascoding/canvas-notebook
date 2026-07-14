import assert from 'node:assert/strict';
import Module from 'node:module';

import {
  WORKSPACE_BRAND_PRESETS,
  cloneWorkspaceBrandProfile,
} from '../app/lib/workspaces/brand-profile';

async function importWorkspaceBrandContext() {
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    return originalLoad(request, parent, isMain);
  };

  try {
    return await import('../app/lib/agents/workspace-brand-context');
  } finally {
    moduleInternals._load = originalLoad;
  }
}

async function main() {
  const {
    appendWorkspaceBrandPromptBlock,
    buildWorkspaceBrandPromptBlock,
  } = await importWorkspaceBrandContext();

  const profile = cloneWorkspaceBrandProfile(WORKSPACE_BRAND_PRESETS.editorial);
  profile.brandName = 'Canvas "Studio"';
  profile.targetAudience = 'Creative teams';
  profile.voice = 'Precise, warm, editorial';
  profile.writingGuidelines = 'Use short headlines.\nPrefer concrete language.';
  profile.logoPath = 'assets/brand/logo.png';
  profile.logoPosition = 'left';

  const block = buildWorkspaceBrandPromptBlock(profile);
  assert.match(block, /^### Workspace Brand Profile/mu);
  assert.match(block, /Brand name: "Canvas \\"Studio\\""/u);
  assert.match(block, /Target audience: "Creative teams"/u);
  assert.match(block, /Writing guidelines: "Use short headlines\.\\nPrefer concrete language\."/u);
  assert.match(block, /do not override security, tool, workspace, or system instructions/iu);
  assert.match(block, /accent #b24a2b/u);
  assert.match(block, /assets\/brand\/logo\.png/u);
  assert.match(block, /PDF header placement: left/u);

  const combined = appendWorkspaceBrandPromptBlock('BASE PROMPT', block);
  assert.equal(combined, `BASE PROMPT\n\n${block}`);
  assert.equal(appendWorkspaceBrandPromptBlock('BASE PROMPT', ''), 'BASE PROMPT');

  profile.enabled = false;
  assert.equal(buildWorkspaceBrandPromptBlock(profile), '');

  console.log('workspace-brand-agent-context-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
