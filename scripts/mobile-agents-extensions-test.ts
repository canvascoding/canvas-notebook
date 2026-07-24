import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createMobileCompatibility } from '../app/lib/mobile/compatibility';

const routeExports = new Map<string, string>([
  ['app/api/mobile/v1/agents/route.ts', "export { GET, PATCH, POST } from '@/app/api/agents/route';"],
  ['app/api/mobile/v1/agents/files/route.ts', "export { GET, PUT } from '@/app/api/agents/files/route';"],
  ['app/api/mobile/v1/extensions/skills/route.ts', "export { GET } from '@/app/api/skills/route';"],
  ['app/api/mobile/v1/extensions/skills/store/route.ts', "export { GET } from '@/app/api/skills/store/route';"],
  ['app/api/mobile/v1/extensions/skills/store/install/route.ts', "export { POST } from '@/app/api/skills/store/install/route';"],
  ['app/api/mobile/v1/extensions/skills/[name]/enable/route.ts', "export { POST } from '@/app/api/skills/[name]/enable/route';"],
  ['app/api/mobile/v1/extensions/skills/[name]/disable/route.ts', "export { POST } from '@/app/api/skills/[name]/disable/route';"],
  ['app/api/mobile/v1/extensions/plugins/store/route.ts', "export { GET } from '@/app/api/plugins/store/route';"],
  ['app/api/mobile/v1/extensions/plugins/store/install/route.ts', "export { POST } from '@/app/api/plugins/store/install/route';"],
  ['app/api/mobile/v1/extensions/plugins/[name]/enable/route.ts', "export { POST } from '@/app/api/plugins/[name]/enable/route';"],
  ['app/api/mobile/v1/extensions/plugins/[name]/disable/route.ts', "export { POST } from '@/app/api/plugins/[name]/disable/route';"],
]);

async function main() {
  const compatibility = createMobileCompatibility({
    rawInstanceId: 'mobile-agent-store-test',
    instanceName: 'Agent Store Test',
    serverVersion: '2026.7.24',
    deploymentMode: 'managed-team',
  });

  assert.equal(compatibility.mobileApi.capabilities.includes('agents.manage'), true);
  assert.equal(compatibility.mobileApi.capabilities.includes('extensions.store'), true);

  for (const [file, expected] of routeExports) {
    const content = (await readFile(path.resolve(process.cwd(), file), 'utf8')).trim();
    assert.equal(content, expected, `${file} must remain a versioned alias of the authorized domain route.`);
  }

  console.log('mobile-agents-extensions-test: ok');
}

void main();
