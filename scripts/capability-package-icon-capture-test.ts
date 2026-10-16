import assert from 'node:assert/strict';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: process.argv.includes('--native') });
  try {
    const { readExactPackageInventory } = await import('../app/lib/capabilities/packages/io');
    const { computeCanvasPluginChecksum } = await import('../app/lib/plugins/canvas-plugin-registry');
    const { capturedCapabilityPackageIconDeclarations, assertCapturedCapabilityPackageChild } = await import('../app/lib/capabilities/packages/package-icon-capture');
    const { readFirstCapturedCapabilityPackageImage } = await import('../app/lib/capabilities/packages/package-icon-image');
    type Artifact = Parameters<typeof capturedCapabilityPackageIconDeclarations>[0];
    const root = path.join(fixture.root, 'capture-package'), childRoot = path.join(root, 'skills', 'actual-child');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" fill="blue"/></svg>';
    await fs.mkdir(path.join(root, '.canvas-plugin'), { recursive: true });
    await fs.mkdir(path.join(childRoot, 'agents'), { recursive: true });
    await fs.mkdir(path.join(root, 'assets'), { recursive: true });
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
    await fs.mkdir(path.join(root, 'z'), { recursive: true });
    await fs.writeFile(path.join(root, '.canvas-plugin', 'plugin.json'), JSON.stringify({ name: 'capture-plugin', version: '1.0.0', skills: './skills', interface: { logo: './assets/logo.svg' } }));
    await fs.writeFile(path.join(root, 'assets', 'logo.svg'), svg);
    await fs.writeFile(path.join(root, 'A.txt'), 'A'); await fs.writeFile(path.join(root, 'ä.txt'), 'umlaut');
    await fs.writeFile(path.join(root, 'z', 'nested.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await fs.writeFile(path.join(root, '.git', 'ignored'), 'ignored');
    await fs.writeFile(path.join(root, 'node_modules', 'ignored'), 'ignored');
    await fs.writeFile(path.join(root, '.DS_Store'), 'ignored');
    await fs.writeFile(path.join(childRoot, 'SKILL.md'), '---\nname: actual-child\ndescription: Actual child\n---\n');
    await fs.writeFile(path.join(childRoot, 'agents', 'canvas.yaml'), 'interface:\n  icon_small: ./missing.svg\n  icon_large: ./image.svg\n');
    await fs.writeFile(path.join(childRoot, 'image.svg'), svg);
    const originalOpen = fs.open, originalMkdir = fs.mkdir;
    let writes = 0;
    fs.open = (async (file, flags, mode) => {
      if (typeof flags === 'number' ? Boolean(flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT)) : /[wa+]/u.test(flags)) writes++;
      return originalOpen(file, flags, mode);
    }) as typeof fs.open;
    fs.mkdir = (async (...args: Parameters<typeof fs.mkdir>) => { writes++; return originalMkdir(...args); }) as typeof fs.mkdir;
    let parentInventory: Awaited<ReturnType<typeof readExactPackageInventory>>, childInventory: Awaited<ReturnType<typeof readExactPackageInventory>>;
    try {
      parentInventory = await readExactPackageInventory(root); childInventory = await readExactPackageInventory(childRoot);
      assert.equal(writes, 0, 'An exact inventory capture never writes, fsyncs or creates a second package tree.');
    } finally { fs.open = originalOpen; fs.mkdir = originalMkdir; }
    assert.equal(parentInventory.checksum, await computeCanvasPluginChecksum(root), 'Canonical captured-buffer hash equals the unchanged independent legacy reader.');
    assert(parentInventory.files.find(file => file.path === 'z/nested.sh')?.executable);
    assert(!parentInventory.files.some(file => /(?:node_modules|\.git|\.DS_Store)/u.test(file.path)));
    await fs.chmod(path.join(root, 'z', 'nested.sh'), 0o600);
    assert.equal((await readExactPackageInventory(root)).checksum, parentInventory.checksum, 'Executable metadata keeps the legacy checksum semantics.');
    const parent = { storage: { resourceType: 'plugin', sourceType: 'standalone', name: 'capture-plugin', resourceId: 'capture-parent' },
      sourceStamp: { version: '1.0.0' }, packageRoot: root } as Artifact;
    const child = { storage: { resourceType: 'skill', sourceType: 'plugin', sourcePluginId: 'capture-parent', name: 'actual-child' },
      sourceStamp: { version: '1.0.0' }, packageRoot: childRoot } as Artifact;
    assertCapturedCapabilityPackageChild(parent, parentInventory, child, childInventory);
    const originalChild = await fs.readFile(path.join(childRoot, 'SKILL.md'));
    await fs.writeFile(path.join(childRoot, 'SKILL.md'), Buffer.concat([originalChild, Buffer.from('\nDifferent bytes between the captures.\n')]));
    const mixedChildInventory = await readExactPackageInventory(childRoot);
    await fs.writeFile(path.join(childRoot, 'SKILL.md'), originalChild);
    assert.throws(() => assertCapturedCapabilityPackageChild(parent, parentInventory, child, mixedChildInventory),
      { code: 'PACKAGE_SOURCE_CHANGED' }, 'An actual Parent-A / Child-B / restored-Parent-A sequence cannot mix captured snapshots.');
    assert.throws(() => assertCapturedCapabilityPackageChild(parent, parentInventory, { ...child, packageRoot: path.join(childRoot, 'undeclared') }, childInventory), { code: 'PACKAGE_NOT_FOUND' });
    assert.throws(() => assertCapturedCapabilityPackageChild(parent, parentInventory, { ...child, storage: { ...child.storage, sourcePluginId: 'foreign' } }, childInventory), { code: 'PACKAGE_NOT_FOUND' });
    const originalManifest = await fs.readFile(path.join(root, '.canvas-plugin', 'plugin.json'));
    await fs.writeFile(path.join(root, '.canvas-plugin', 'plugin.json'), JSON.stringify({ name: 'capture-plugin', version: '1.0.0', skillRefs: ['actual-child'] }));
    const seedParentInventory = await readExactPackageInventory(root);
    await fs.writeFile(path.join(root, '.canvas-plugin', 'plugin.json'), originalManifest);
    const seedChild = { ...child, storage: { ...child.storage, resourceId: 'seed-child-id' } };
    const seedParent: Artifact = { ...parent, bundledReferences: [{ source: { rootPath: childRoot, resourceRef: 'seed-child-id',
      kind: 'skill', name: 'actual-child', owner: { type: 'system' } }, checksum: childInventory.checksum, relativeTargetRoot: 'skills/actual-child' }],
      sourceStamp: { version: '1.0.0', dependencies: [{ resourceId: 'seed-child-id', name: 'actual-child', version: '1.0.0', checksum: childInventory.checksum, relativeRoot: 'skills/actual-child' }] } };
    assertCapturedCapabilityPackageChild(seedParent, seedParentInventory, seedChild, childInventory);
    assert.throws(() => assertCapturedCapabilityPackageChild(seedParent, seedParentInventory, seedChild, mixedChildInventory), { code: 'PACKAGE_SOURCE_CHANGED' },
      'A declared seed is bound to the captured dependency checksum.');
    assert.throws(() => assertCapturedCapabilityPackageChild({ ...seedParent, sourceStamp: { version: '1.0.0' } }, seedParentInventory, seedChild, childInventory),
      { code: 'PACKAGE_SOURCE_CHANGED' }, 'The parent must pin the exact seed dependency.');
    assert.throws(() => assertCapturedCapabilityPackageChild(seedParent, seedParentInventory, { ...seedChild, storage: { ...seedChild.storage, resourceId: 'wrong-seed-id' } }, childInventory),
      { code: 'PACKAGE_SOURCE_CHANGED' }, 'A same-name seed cannot substitute a different resource identity.');
    const parentDeclarations = capturedCapabilityPackageIconDeclarations(parent, parentInventory);
    const childDeclarations = capturedCapabilityPackageIconDeclarations(child, childInventory);
    // A live declaration/image change after capture cannot alter the selected
    // path or bytes, including an ABA swap that disappears before final hashing.
    await fs.writeFile(path.join(root, '.canvas-plugin', 'plugin.json'), '{"name":"capture-plugin","version":"1.0.0","interface":{"logo":"./A.txt"}}');
    await fs.writeFile(path.join(childRoot, 'agents', 'canvas.yaml'), 'interface:\n  icon_small: https://unrelated.example/image.svg\n');
    await fs.writeFile(path.join(root, 'assets', 'logo.svg'), '<svg><script>unsafe()</script></svg>');
    assert.deepEqual(capturedCapabilityPackageIconDeclarations(parent, parentInventory), parentDeclarations);
    assert.deepEqual(capturedCapabilityPackageIconDeclarations(child, childInventory), childDeclarations);
    const image = readFirstCapturedCapabilityPackageImage(parentInventory, parentDeclarations);
    assert(image && 'bytes' in image); assert.equal(image.bytes.toString(), svg);
    const childImage = readFirstCapturedCapabilityPackageImage(childInventory, childDeclarations);
    assert(childImage && 'bytes' in childImage); assert.equal(childImage.bytes.toString(), svg);
    assert.equal(readFirstCapturedCapabilityPackageImage(parentInventory, ['./A.txt', '../assets/logo.svg', './assets/missing.svg']), null);
    assert.deepEqual(readFirstCapturedCapabilityPackageImage(parentInventory, ['https://images.example/icon.svg?token=PRIVATE#secret']), { url: 'https://images.example/icon.svg' });
    const linked = path.join(root, 'hardlinked.txt'); await fs.link(path.join(root, 'A.txt'), linked);
    await assert.rejects(() => readExactPackageInventory(root), { code: 'PACKAGE_PATH_INVALID' }); await fs.unlink(linked);
    const symlink = path.join(root, 'symlink.txt'); await fs.symlink(path.join(root, 'A.txt'), symlink);
    await assert.rejects(() => readExactPackageInventory(root), { code: 'PACKAGE_PATH_INVALID' }); await fs.unlink(symlink);
    console.log('PASS exact in-memory icon capture: unchanged legacy/native sort and executable/ignored checksum semantics, zero filesystem writes, declared parent/child identities, capture-bound manifest/YAML/image against ABA, passive bounded image rules and hardlink/symlink denial.');
  } finally { await fixture.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
