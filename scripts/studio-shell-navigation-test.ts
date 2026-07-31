import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { getStudioBackDestination } from '../app/apps/studio/utils/studio-navigation';

assert.deepEqual(getStudioBackDestination('/studio'), { href: '/', label: 'suite' });
assert.deepEqual(getStudioBackDestination('/studio/create'), { href: '/', label: 'suite' });
assert.deepEqual(getStudioBackDestination('/studio/models'), { href: '/', label: 'suite' });
assert.deepEqual(getStudioBackDestination('/studio/presets'), { href: '/', label: 'suite' });
assert.deepEqual(getStudioBackDestination('/studio/bulk'), { href: '/', label: 'suite' });
assert.deepEqual(getStudioBackDestination('/studio/aspect-ratio'), { href: '/', label: 'suite' });
assert.deepEqual(getStudioBackDestination('/studio/models/new'), { href: '/studio/models', label: 'models' });
assert.deepEqual(getStudioBackDestination('/studio/models/model-1'), { href: '/studio/models', label: 'models' });
assert.deepEqual(getStudioBackDestination('/studio/products/product-1'), { href: '/studio/models', label: 'models' });
assert.deepEqual(getStudioBackDestination('/studio/personas/persona-1'), { href: '/studio/models', label: 'models' });
assert.deepEqual(getStudioBackDestination('/studio/presets/new'), { href: '/studio/presets', label: 'presets' });
assert.deepEqual(getStudioBackDestination('/studio/presets/preset-1'), { href: '/studio/presets', label: 'presets' });

const studioShellSource = fs.readFileSync(
  path.join(process.cwd(), 'app', 'components', 'StudioShell.tsx'),
  'utf8',
);
assert.match(studioShellSource, /WorkspaceSwitcher source="studio" variant="compact" \/>/);
assert.doesNotMatch(studioShellSource, /variant="mobile-sheet"/);
assert.doesNotMatch(studioShellSource, /headerBelow=/);

console.log('studio-shell-navigation-test: ok');
