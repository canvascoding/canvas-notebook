import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CAPABILITY_PACKAGE_ICON_MAX_BYTES, readDeclaredCapabilityPackageImage, readFirstDeclaredCapabilityPackageImage } from '../app/lib/capabilities/packages/package-icon-image';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-package-icon-test-'));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="blue"/></svg>';
  try {
    await fs.mkdir(path.join(root, 'assets'));await fs.writeFile(path.join(root, 'assets', 'icon.svg'), svg);
    const actual = await readDeclaredCapabilityPackageImage(root, './assets/icon.svg');
    assert(actual);assert.equal(actual.contentType, 'image/svg+xml');assert.equal(actual.bytes.toString(), svg);
    for (const declaration of ['../icon.svg', '/private/icon.svg', 'file:///private/icon.svg', 'data:image/svg+xml,private',
      '//external.example/icon.svg', 'assets\\icon.svg', 'assets/../icon.svg', 'assets//icon.svg', 'assets/icon.svg\0', 'assets/icon.json']) {
      assert.equal(await readDeclaredCapabilityPackageImage(root, declaration), null, declaration);
    }
    await fs.writeFile(path.join(root, 'assets', 'private.png'), 'PRIVATE_CONFIG_OR_CREDENTIAL_BYTES');
    assert.equal(await readDeclaredCapabilityPackageImage(root, './assets/private.png'), null, 'A raster extension cannot expose non-image source bytes');
    const passiveOnly = [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject>private</foreignObject></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://private.example/image"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://private.example/style";</style></svg>',
      '<!DOCTYPE svg [<!ENTITY private SYSTEM "file:///etc/passwd">]><svg>&private;</svg>',
    ];
    for (const value of passiveOnly) {
      await fs.writeFile(path.join(root, 'assets', 'unsafe.svg'), value);
      assert.equal(await readDeclaredCapabilityPackageImage(root, './assets/unsafe.svg'), null, 'SVG active content/external source must be rejected');
    }
    await fs.writeFile(path.join(root, 'assets', 'oversized.png'), Buffer.alloc(CAPABILITY_PACKAGE_ICON_MAX_BYTES + 1));
    assert.equal(await readDeclaredCapabilityPackageImage(root, './assets/oversized.png'), null, 'Image allocation is bounded');
    await fs.symlink(path.join(root, 'assets', 'icon.svg'), path.join(root, 'linked.svg'));
    await assert.rejects(readDeclaredCapabilityPackageImage(root, './linked.svg'), {code: 'PACKAGE_PATH_INVALID'});
    await fs.symlink(path.join(root, 'assets'), path.join(root, 'linked-assets'));
    await assert.rejects(readDeclaredCapabilityPackageImage(root, './linked-assets/icon.svg'), {code: 'PACKAGE_PATH_INVALID'});
    const fallback = await readFirstDeclaredCapabilityPackageImage(root, ['./assets/missing.svg', './assets/private.png', './assets/icon.svg']);
    assert(fallback && 'bytes' in fallback);assert.equal(fallback.bytes.toString(), svg);
    assert.deepEqual(await readFirstDeclaredCapabilityPackageImage(root, ['https://images.example/icon.svg?token=private#secret']), {url: 'https://images.example/icon.svg'});
    assert.equal(await readFirstDeclaredCapabilityPackageImage(root, ['https://user:private@images.example/icon.svg', 'http://images.example/icon.svg']), null);
    console.log('PASS bounded declared package icons: local signatures, fallback candidates, passive SVG, traversal/symlink denial and sanitized no-fetch HTTPS.');
  } finally { await fs.rm(root, {recursive: true, force: true}); }
}
main().catch(error => {console.error(error);process.exitCode = 1;});
