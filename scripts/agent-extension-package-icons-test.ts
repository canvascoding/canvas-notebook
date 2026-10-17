import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Module from 'node:module';
import { NextRequest } from 'next/server';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

/** Real published Store snapshots, source SQL and authenticated route. Only IO scheduling is controlled. */
async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load;
  let afterImage: (() => Promise<void>) | undefined;
  const wrappers = new WeakMap<object, object>();
  loader._load = (name, parent, isMain) => {
    const actual = originalLoad(name, parent, isMain);
    if (name !== '@/app/lib/capabilities/packages/package-icon-image') return actual;
    const images = actual as typeof import('../app/lib/capabilities/packages/package-icon-image');
    let wrapped = wrappers.get(images);
    if (!wrapped) {
      wrapped = new Proxy(images, { get(target, key, receiver) {
        if (key !== 'readFirstDeclaredCapabilityPackageImage') return Reflect.get(target, key, receiver);
        return async (...args: Parameters<typeof target.readFirstDeclaredCapabilityPackageImage>) => {
          const result = await target.readFirstDeclaredCapabilityPackageImage(...args);
          await afterImage?.();
          return result;
        };
      } });
      wrappers.set(images, wrapped);
    }
    return wrapped;
  };
  try {
    const { owner, alice, sql } = fixture;
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const { GET } = await import('../app/api/agents/extension-options/icon/route');
    const { agentExtensionPackageIcon } = await import('../app/lib/agents/extension-options-icons');
    const svg = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="${fill}"/></svg>`;
    const version = '1.0.0', name = `exact-image-${randomUUID().slice(0, 8)}`;
    const skillText = (skillName: string, selectedVersion = version) =>
      `---\nname: ${skillName}\ndescription: Exact published image fixture\nmetadata:\n  version: "${selectedVersion}"\n---\nExact instructions.\n`;
    const files = (selectedVersion: string) => ({
      '.canvas-plugin/plugin.json': JSON.stringify({ name, version: selectedVersion, description: 'Exact published images', skills: '.',
        interface: { logo: './logo.svg' } }),
      'SKILL.md': skillText('root-image-step', selectedVersion),
      'agents/canvas.yaml': 'interface:\n  icon_small: ./missing.svg\n  icon_large: ./skill.svg\n',
      'logo.svg': svg(selectedVersion === version ? '#aa0000' : '#0000aa'),
      'skill.svg': svg('#00aa00'),
    });
    const grants = [owner.userId, alice.userId].map(targetId => ({ targetType: 'user' as const, targetId,
      canUse: true, canEdit: false, canManage: false }));
    const archive = await fixture.registry.addPackage('application', 'plugin', name, version, files(version), plugins.computeCanvasPluginChecksum);
    const installed = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: name, version, checksum: archive.checksum }, ownership: { type: 'organization' }, grants });
    const pin = { resourceRef: installed.resource.resourceRef, publishedRevisionRef: installed.published.revisionRef, checksum: installed.published.checksum };
    const icon = agentExtensionPackageIcon(pin, ['./logo.svg'], alice.workspaceId);
    assert(icon);
    const rootIcon = agentExtensionPackageIcon(pin, ['./missing.svg', './skill.svg'], alice.workspaceId, '');
    assert(rootIcon);
    assert.equal(new URL(rootIcon.url, 'http://localhost:3001').searchParams.has('childRelativeRoot'), true);
    assert.equal(new URL(rootIcon.url, 'http://localhost:3001').searchParams.get('childRelativeRoot'), '');
    assert.notEqual(rootIcon.sourceKey, icon.sourceKey, 'An explicit root child is distinct from its parent package.');
    assert.notEqual(icon.sourceKey, agentExtensionPackageIcon(pin, ['./logo.svg'], owner.workspaceId)?.sourceKey);
    const request = (url: string, userId: string | null = alice.userId, customHeaders?: Headers) =>
      GET(new NextRequest(new URL(url, 'http://localhost:3001'), { headers: customHeaders ?? (userId ? fixture.headers(userId) : undefined) }));
    const checkHeaders = (response: Response) => {
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(response.headers.get('content-security-policy'), "sandbox; default-src 'none'; style-src 'unsafe-inline'");
    };
    const initial = await request(icon.url);
    assert.equal(initial.status, 200); checkHeaders(initial);
    assert.equal(initial.headers.get('content-type'), 'image/svg+xml');
    assert.equal(await initial.text(), svg('#aa0000'));
    const rootChild = await request(rootIcon.url);
    assert.equal(rootChild.status, 200); assert.equal(await rootChild.text(), svg('#00aa00'));

    const v2 = await fixture.registry.addPackage('application', 'plugin', name, '2.0.0', files('2.0.0'), plugins.computeCanvasPluginChecksum);
    const review = await stores.inspectCapabilityPackageStoreUpdateAction(owner, pin.resourceRef, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: name, version: '2.0.0', checksum: v2.checksum } });
    const updated = await stores.updateCapabilityPackageFromStoreAction(owner, pin.resourceRef, { source: review.source,
      expectedMetadataRevision: review.expectedMetadataRevision, expectedGrantsRevision: review.expectedGrantsRevision,
      expectedPackageRevision: review.expectedPackageRevision, expectedPublishedRevisionRef: review.expectedPublishedRevisionRef,
      expectedLocalChecksum: review.expectedLocalChecksum, replaceLocalChanges: false });
    assert.equal((await packages.inspectCapabilityPackage(owner, pin.resourceRef)).published?.version, '2.0.0');
    const old = await request(icon.url);
    assert.equal(old.status, 200); assert.equal(await old.text(), svg('#aa0000'), 'A held v1 pin never reads current HEAD v2 bytes.');
    const currentPin = { resourceRef: pin.resourceRef, publishedRevisionRef: updated.published.revisionRef, checksum: updated.published.checksum };
    const current = agentExtensionPackageIcon(currentPin, ['./logo.svg'], alice.workspaceId)!;
    assert.notEqual(current.sourceKey, icon.sourceKey);
    assert.equal(await (await request(current.url)).text(), svg('#0000aa'));

    const nestedName = `${name}-nested`;
    const nestedFiles = {
      '.canvas-plugin/plugin.json': JSON.stringify({ name: nestedName, version, description: 'Nested image fixture', skills: './skills' }),
      'skills/nested-image-step/SKILL.md': skillText('nested-image-step'),
      'skills/nested-image-step/agents/canvas.yaml': 'interface:\n  icon_small: ./child.svg\n',
      'skills/nested-image-step/child.svg': svg('#aabbcc'),
    };
    const nestedArchive = await fixture.registry.addPackage('application', 'plugin', nestedName, version, nestedFiles, plugins.computeCanvasPluginChecksum);
    const nested = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: nestedName, version, checksum: nestedArchive.checksum }, ownership: { type: 'organization' }, grants });
    const nestedPin = { resourceRef: nested.resource.resourceRef, publishedRevisionRef: nested.published.revisionRef, checksum: nested.published.checksum };
    const nestedImage = agentExtensionPackageIcon(nestedPin, ['./child.svg'], alice.workspaceId, 'skills/nested-image-step')!;
    assert.equal(await (await request(nestedImage.url)).text(), svg('#aabbcc'));
    const absentParent = new URL(nestedImage.url, 'http://localhost:3001'); absentParent.searchParams.delete('childRelativeRoot');
    const noImage = await request(absentParent.href);
    assert.equal(noImage.status, 204); assert.equal(await noImage.text(), ''); checkHeaders(noImage);
    assert.equal(agentExtensionPackageIcon(nestedPin, [], alice.workspaceId), undefined, 'Undeclared images immediately use initials.');

    const ownName = `${name}-own`;
    const ownArchive = await fixture.registry.addPackage('application', 'skill', ownName, version,
      { 'SKILL.md': skillText(ownName), 'agents/canvas.yaml': 'interface:\n  icon_small: ./own.svg\n', 'own.svg': svg('#123456') }, plugins.computeCanvasPluginChecksum);
    const own = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'skill', registryId: 'store-application',
      entryKey: ownName, version, checksum: ownArchive.checksum }, ownership: { type: 'user' }, grants: [] });
    const ownPin = { resourceRef: own.resource.resourceRef, publishedRevisionRef: own.published.revisionRef, checksum: own.published.checksum };
    const ownIcon = agentExtensionPackageIcon(ownPin, ['./own.svg'], owner.workspaceId, '')!;
    assert.equal(await (await request(ownIcon.url, owner.userId)).text(), svg('#123456'));
    const foreignImage = new URL(ownIcon.url, 'http://localhost:3001'); foreignImage.searchParams.set('workspaceId', alice.workspaceId!);
    assert([403, 404].includes((await request(foreignImage.href)).status));

    for (const [key, value] of [['childRelativeRoot', '../logo.svg'], ['childRelativeRoot', '/private/logo.svg'],
      ['childRelativeRoot', 'skills/not-declared'], ['childRelativeRoot', 'https://private.example/image'],
      ['privatePath', '/private/logo.svg'], ['providerRef', 'hidden']]) {
      const invalid = new URL(icon.url, 'http://localhost:3001'); invalid.searchParams.set(key, value);
      const response = await request(invalid.href);
      assert.equal(response.status, 400); checkHeaders(response);
      assert.doesNotMatch(await response.text(), /\/Users\/|\/private\/|rootPath|INTEGRATIONS_ENV/u);
    }
    const duplicate = `${icon.url}&resourceRef=${encodeURIComponent(pin.resourceRef)}`;
    assert.equal((await request(duplicate)).status, 400);
    const badChecksum = new URL(icon.url, 'http://localhost:3001'); badChecksum.searchParams.set('checksum', '0'.repeat(64));
    assert.equal((await request(badChecksum.href)).status, 409);
    const missingChecksum = new URL(icon.url, 'http://localhost:3001'); missingChecksum.searchParams.delete('checksum');
    assert.equal((await request(missingChecksum.href)).status, 400);
    const mismatch = new URL(icon.url, 'http://localhost:3001'); mismatch.searchParams.set('workspaceId', owner.workspaceId!);
    assert.equal((await request(mismatch.href)).status, 400);
    const unauthenticated = await request(icon.url, null);
    assert.equal(unauthenticated.status, 401); checkHeaders(unauthenticated);

    let revoked = false;
    afterImage = async () => {
      afterImage = undefined; revoked = true;
      await sql.run('UPDATE capability_resource_grants SET can_use=0 WHERE resource_ref=$1 AND target_id=$2', [pin.resourceRef, alice.userId]);
    };
    const deniedAfterImage = await request(icon.url);
    assert(revoked); assert([403, 404].includes(deniedAfterImage.status)); checkHeaders(deniedAfterImage);
    assert.doesNotMatch(await deniedAfterImage.text(), /<svg|aa0000|\/private\/|rootPath/u);
    const denied = await request(icon.url);
    assert([403, 404].includes(denied.status));
    await sql.run('UPDATE capability_resource_grants SET can_use=1 WHERE resource_ref=$1 AND target_id=$2', [pin.resourceRef, alice.userId]);

    const hostileName = `${name}-hostile`;
    const hostileArchive = await fixture.registry.addPackage('application', 'skill', hostileName, version,
      { 'SKILL.md': skillText(hostileName), 'agents/canvas.yaml': 'interface:\n  icon_small: ./active.svg\n',
        'active.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' }, plugins.computeCanvasPluginChecksum);
    const hostile = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'skill', registryId: 'store-application',
      entryKey: hostileName, version, checksum: hostileArchive.checksum }, ownership: { type: 'organization' }, grants });
    const hostilePin = { resourceRef: hostile.resource.resourceRef, publishedRevisionRef: hostile.published.revisionRef, checksum: hostile.published.checksum };
    const passiveOnly = await request(agentExtensionPackageIcon(hostilePin, ['./active.svg'], alice.workspaceId)!.url);
    assert.equal(passiveOnly.status, 204); assert.equal(await passiveOnly.text(), ''); checkHeaders(passiveOnly);
    for (const declaration of ['../secret.svg', '/private/secret.svg', 'file:///private/secret.svg', 'data:image/svg+xml,private', './safe/../secret.svg']) {
      assert.equal(agentExtensionPackageIcon(pin, [declaration], alice.workspaceId), undefined);
    }
    assert.equal(agentExtensionPackageIcon(pin, ['https://images.example/icon.svg?token=private#fragment'], alice.workspaceId)?.url,
      'https://images.example/icon.svg');
    assert.equal(agentExtensionPackageIcon(pin, ['https://user:private@images.example/icon.svg'], alice.workspaceId), undefined);
    const remoteName = `${name}-remote`;
    const remoteArchive = await fixture.registry.addPackage('application', 'skill', remoteName, version,
      { 'SKILL.md': skillText(remoteName), 'agents/canvas.yaml': 'interface:\n  icon_small: https://images.example/icon.svg?token=private#fragment\n' }, plugins.computeCanvasPluginChecksum);
    const remote = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'skill', registryId: 'store-application',
      entryKey: remoteName, version, checksum: remoteArchive.checksum }, ownership: { type: 'organization' }, grants });
    const remotePin = { resourceRef: remote.resource.resourceRef, publishedRevisionRef: remote.published.revisionRef, checksum: remote.published.checksum };
    const remoteQuery = new URLSearchParams({ ...remotePin, workspaceId: alice.workspaceId! });
    const redirect = await request(`/api/agents/extension-options/icon?${remoteQuery}`);
    assert.equal(redirect.status, 307); assert.equal(redirect.headers.get('location'), 'https://images.example/icon.svg');
    assert.equal(await redirect.text(), ''); checkHeaders(redirect);
    await sql.run('UPDATE capability_resource_grants SET can_use=0 WHERE resource_ref=$1 AND target_id=$2', [remotePin.resourceRef, alice.userId]);
    const remoteDenied = await request(`/api/agents/extension-options/icon?${remoteQuery}`);
    assert([403, 404].includes(remoteDenied.status)); assert.equal(remoteDenied.headers.get('location'), null);
    assert.equal(fixture.providerRequests(), 0);
    console.log('PASS exact published package image API: actual Store v1 after HEAD v2, root and nested child and own standalone, source Use before/after image IO, strict auth/workspace/pin/query, passive SVG/traversal and missing-image fallback, no provider/image fetch.');
  } finally {
    afterImage = undefined; loader._load = originalLoad;
    await fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
