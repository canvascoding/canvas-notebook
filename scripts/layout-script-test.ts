import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const layoutFiles = [
  'app/[locale]/layout.tsx',
  'app/(public)/layout.tsx',
];

for (const layoutFile of layoutFiles) {
  const source = readFileSync(layoutFile, 'utf8');

  assert.match(source, /import Script from 'next\/script';/u, `${layoutFile} must use Next.js Script`);
  assert.match(
    source,
    /<Script\s+[\s\S]*?id="excalidraw-asset-path"[\s\S]*?strategy="beforeInteractive"[\s\S]*?window\.EXCALIDRAW_ASSET_PATH="\/excalidraw\/"/u,
    `${layoutFile} must initialize the Excalidraw asset path before hydration`,
  );
  assert.doesNotMatch(
    source,
    /<script\s+[\s\S]*?EXCALIDRAW_ASSET_PATH/u,
    `${layoutFile} must not render a native script tag for the Excalidraw asset path`,
  );
}

const localeLayout = readFileSync('app/[locale]/layout.tsx', 'utf8');
assert.match(
  localeLayout,
  /<Script id="theme-init" src="\/theme-init\.js" strategy="beforeInteractive" \/>/u,
  'the theme initializer must use Next.js Script before hydration',
);
assert.doesNotMatch(
  localeLayout,
  /<script src="\/theme-init\.js"/u,
  'the theme initializer must not render a native script tag',
);

console.log('layout-script-test: ok');
