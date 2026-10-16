import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SqlConnection } from '../../app/lib/db';
import type { CapabilityPackageDescriptor, CapabilityPackageDraft } from '../../app/lib/capabilities/packages/contracts';
import type { CapabilityPackageDraftValidationReport } from '../../app/lib/capabilities/packages/validation-contracts';

type Packages = typeof import('../../app/lib/capabilities/packages/actions');
type Actor = { userId: string; workspaceId: string };
type RequestFactory = (userId: string | null, method?: string, body?: unknown, url?: string) => Request;
const manifestPath = '.canvas-plugin/plugin.json';
const logoPath = 'assets/logo.svg';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><title>Account brief</title><desc>Source rows become a document ready for review.</desc><rect x="12" y="8" width="40" height="48" rx="4" fill="#17614B"/></svg>';
const skill = (name: string) => `---\nname: ${name}\ndescription: Prepare an account brief from supplied source facts\nmetadata:\n  version: "1.0.0"\n---\nKeep source facts distinct from recommendations.\n`;

/** Actual authenticated routes, SQL, mutable draft files and immutable publication bytes. */
export async function verifyCapabilityPackageCreatorValidation(input: {
  packages: Packages; raw: Pick<SqlConnection, 'get' | 'all' | 'run'>;
  owner: Actor; other: Actor; request: RequestFactory; legacyRef: string;
}) {
  const { packages, raw, owner, other, request, legacyRef } = input;
  const collection = await import('../../app/api/capabilities/packages/drafts/route');
  const fileRoute = await import('../../app/api/capabilities/packages/drafts/[draftRef]/file/route');
  const validateRoute = await import('../../app/api/capabilities/packages/drafts/[draftRef]/validate/route');
  const publishRoute = await import('../../app/api/capabilities/packages/drafts/[draftRef]/publish/route');
  const { creatorPluginManifestTemplate } = await import('../../app/lib/plugins/creator-plugin-manifest');
  const { resolveOwnerScopedPackageVersionPath, readExactPackageInventory } = await import('../../app/lib/capabilities/packages/io');
  const context = (draftRef?: string) => {
    const params: Record<string, string> = draftRef ? {draftRef} : {};
    return {params: Promise.resolve(params)};
  };
  const data = async <T>(response: Response, expected = 200): Promise<T> => {
    assert.equal(response.status, expected, await response.clone().text());
    return (await response.json() as {data: T}).data;
  };
  const manifest = (name: string, version = '1.0.0', rootSkill = false): Record<string, unknown> => ({
    ...structuredClone(creatorPluginManifestTemplate), name, version,
    description: 'Prepare an account brief from independently retained source facts.',
    skills: rootSkill ? '.' : './skills',
    interface: {displayName: 'Account Brief', shortDescription: 'Source facts become a concise account brief.', logo: './assets/logo.svg'},
  });
  const create = async (name: string, actor = owner) => (await data<{draft: CapabilityPackageDraft}>(
    await collection.POST(request(actor.userId, 'POST', {operation: 'create', kind: 'plugin', targetName: name, requestId: randomUUID()}), context()))).draft;
  const write = async (draft: CapabilityPackageDraft, file: string, content: string, actor = owner) =>
    (await data<{draft: CapabilityPackageDraft}>(await fileRoute.PUT(request(actor.userId, 'PUT', {
      expectedDraftRevision: draft.draftRevision, path: file, encoding: 'base64', content: Buffer.from(content).toString('base64'),
    }), context(draft.draftRef)))).draft;
  const remove = async (draft: CapabilityPackageDraft, file: string, actor = owner) =>
    (await data<{draft: CapabilityPackageDraft}>(await fileRoute.DELETE(request(actor.userId, 'DELETE', {
      expectedDraftRevision: draft.draftRevision, path: file,
    }), context(draft.draftRef)))).draft;
  const fill = async (draft: CapabilityPackageDraft, actor = owner, rootSkill = false) => {
    draft = await write(draft, manifestPath, JSON.stringify(manifest(draft.name, '1.0.0', rootSkill)), actor);
    draft = await write(draft, rootSkill ? 'SKILL.md' : 'skills/account-context/SKILL.md', skill(rootSkill ? draft.name : 'account-context'), actor);
    return write(draft, logoPath, svg, actor);
  };
  const validate = async (draft: CapabilityPackageDraft, actor = owner) =>
    (await data<{validation: CapabilityPackageDraftValidationReport}>(await validateRoute.POST(request(actor.userId, 'POST'), context(draft.draftRef)))).validation;
  const head = (descriptor?: CapabilityPackageDescriptor) => ({
    expectedMetadataRevision: descriptor?.resource.metadataRevision ?? 0,
    expectedGrantsRevision: descriptor?.resource.grantsRevision ?? 0,
    expectedPackageRevision: descriptor?.state?.packageRevision ?? 0,
    expectedPublishedRevisionRef: descriptor?.state?.currentPublishedRevisionRef ?? null,
  });
  const publishInput = (draft: CapabilityPackageDraft, descriptor?: CapabilityPackageDescriptor) => ({
    ...head(descriptor), draftRef: draft.draftRef, expectedDraftRevision: draft.draftRevision, requestId: randomUUID(),
  });
  const rowCount = async (table: 'capability_resources' | 'capability_package_versions', resourceRef: string) =>
    Number((await raw.get(`SELECT COUNT(*)::integer AS count FROM ${table} WHERE resource_ref=$1`, [resourceRef]) as {count: number}).count);
  const preserved = async (draft: CapabilityPackageDraft, expectedResources: number, expectedVersions: number) => {
    assert.equal(await rowCount('capability_resources', draft.resourceRef), expectedResources, 'Rejected publication cannot create or replace a resource.');
    assert.equal(await rowCount('capability_package_versions', draft.resourceRef), expectedVersions, 'Rejected publication cannot create an immutable version.');
    assert.equal(Number((await raw.get('SELECT draft_revision FROM capability_package_drafts WHERE draft_ref=$1', [draft.draftRef]) as {draft_revision: number}).draft_revision), draft.draftRevision,
      'Rejected publication preserves the exact editable draft.');
  };
  const rejected = async (draft: CapabilityPackageDraft, code: string, descriptor?: CapabilityPackageDescriptor, actor = owner) => {
    const resources = await rowCount('capability_resources', draft.resourceRef), versions = await rowCount('capability_package_versions', draft.resourceRef);
    const response = await publishRoute.POST(request(actor.userId, 'POST', publishInput(draft, descriptor)), context(draft.draftRef));
    assert.equal(response.status, 400, await response.clone().text());
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const failure = await response.json() as {code: string; validation: CapabilityPackageDraftValidationReport};
    assert.equal(failure.code, 'PACKAGE_INVALID');
    assert.equal(failure.validation.valid, false);
    assert.equal(failure.validation.draftRevision, draft.draftRevision);
    assert(failure.validation.issues.some(issue => issue.code === code), `${code}: ${JSON.stringify(failure.validation.issues)}`);
    for (const issue of failure.validation.issues) {
      assert(issue.code && issue.file && typeof issue.field === 'string' && issue.message && issue.repair, 'A failed publish returns file/field/repair diagnostics.');
    }
    assert(!JSON.stringify(failure.validation).includes('rootPath'), 'Validation reports expose package-relative files only.');
    await preserved(draft, resources, versions);
    return failure.validation;
  };
  const publish = async (draft: CapabilityPackageDraft, descriptor?: CapabilityPackageDescriptor, actor = owner) => {
    const result = await data<Awaited<ReturnType<Packages['publishCapabilityPackageDraftAction']>>>(
      await publishRoute.POST(request(actor.userId, 'POST', publishInput(draft, descriptor)), context(draft.draftRef)));
    const current = await packages.inspectCapabilityPackage(owner, result.state.resourceRef);
    const actualRoot = resolveOwnerScopedPackageVersionPath({...result.published, owner: current.resource.ownership});
    const inventory = await readExactPackageInventory(actualRoot);
    assert.equal(inventory.checksum, result.published.checksum, 'The committed checksum covers actual immutable files.');
    assert.equal(await fs.readFile(path.join(actualRoot, logoPath), 'utf8'), svg, 'Published graphic bytes are independently readable from the real immutable snapshot.');
    return result;
  };
  const edit = async (resourceRef: string, actor = owner) => {
    const descriptor = await packages.inspectCapabilityPackage(actor, resourceRef);
    const draft = await packages.createCapabilityPackageDraftAction(actor, {operation: 'edit', resourceRef, ...head(descriptor)});
    return {draft, descriptor};
  };
  const fork = async (resourceRef: string, targetName: string) => {
    const source = await packages.inspectCapabilityPackage(owner, resourceRef);
    return packages.createCapabilityPackageDraftAction(owner, {operation: 'fork', resourceRef, targetName, ownership: {type: 'organization'},
      expectedSourceMetadataRevision: source.resource.metadataRevision, expectedSourceGrantsRevision: source.resource.grantsRevision,
      expectedSourcePackageRevision: source.state?.packageRevision ?? 0, expectedSourcePublishedRevisionRef: source.state?.currentPublishedRevisionRef ?? null});
  };

  let draft = await create('creator-validation-new');
  await rejected(draft, 'MANIFEST_MISSING');
  draft = await fill(draft);
  const childPath = 'skills/account-context/SKILL.md';
  draft = await write(draft, childPath, skill('account-context').replace('metadata:\n  version: "1.0.0"\n', ''));
  const missingVersion = await rejected(draft, 'SKILL_VERSION_REQUIRED');
  assert(missingVersion.issues.some(issue => issue.code === 'SKILL_VERSION_REQUIRED' && issue.file === childPath && issue.field === 'metadata.version'));
  draft = await write(draft, childPath, skill('account-context').replace('version: "1.0.0"', 'version: "not-a-version"'));
  const malformedVersion = await rejected(draft, 'SKILL_VERSION_REQUIRED');
  assert(malformedVersion.issues.some(issue => issue.code === 'SKILL_VERSION_REQUIRED' && issue.file === childPath));
  draft = await remove(draft, childPath);
  await rejected(draft, 'SKILL_MISSING');
  draft = await write(draft, childPath, skill('account-context'));
  const wrongSchema = manifest(draft.name); delete wrongSchema.schemaVersion;
  draft = await write(draft, manifestPath, JSON.stringify(wrongSchema));
  const schemaFailure = await rejected(draft, 'CREATOR_MANIFEST_SCHEMA');
  assert(schemaFailure.issues.some(issue => issue.field === 'schemaVersion' && issue.file === manifestPath));
  draft = await write(draft, manifestPath, JSON.stringify(manifest(draft.name)));
  draft = await write(draft, logoPath, svg.replace('</svg>', '<script>run()</script></svg>'));
  await rejected(draft, 'CREATOR_SVG_PASSIVE_REQUIRED');
  draft = await write(draft, logoPath, svg);
  const connectedManifest = {...manifest(draft.name), connectors: {mcp: [{name: 'brief-api', configPath: './connectors/brief.json', env: ['BRIEF_API_TOKEN']}]}};
  draft = await write(draft, manifestPath, JSON.stringify(connectedManifest));
  const portableConfig = {transport: 'http', url: 'https://brief.example.test/mcp', headers: {Authorization: '${BRIEF_API_TOKEN}'}};
  draft = await write(draft, 'connectors/brief.json', JSON.stringify({...portableConfig, headers: {Authorization: 'Bearer private-creator-token'}}));
  const privateHeader = await rejected(draft, 'PACKAGE_DECLARATION_NOT_PORTABLE');
  assert(privateHeader.issues.some(issue => issue.file === 'connectors/brief.json'), 'Direct file writes retain exact private-config diagnostics.');
  draft = await write(draft, 'connectors/brief.json', JSON.stringify({...portableConfig, accountId: 'creator-private-account'}));
  await rejected(draft, 'PACKAGE_DECLARATION_NOT_PORTABLE');
  draft = await write(draft, 'connectors/brief.json', JSON.stringify(portableConfig));
  const valid = await validate(draft);
  assert(valid.valid, valid.errors.join(' '));
  assert.equal(valid.manifestSchemaVersion, 1);
  assert.equal(valid.draftRevision, draft.draftRevision);
  assert.equal(valid.files.find(file => file.path === logoPath)?.checksum, createHash('sha256').update(svg).digest('hex'));
  draft = await write(draft, logoPath, svg.replace('<desc>', '<desc>changed ').replace('viewBox="0 0 64 64"', 'viewBox="0 0 0 64"'));
  await rejected(draft, 'CREATOR_SVG_VIEWBOX_INVALID');
  draft = await remove(draft, logoPath);
  await rejected(draft, 'SVG_MISSING');
  draft = await write(draft, logoPath, svg);
  const first = await publish(draft);
  assert.equal(first.published.sourceResourceRef, null);
  assert.equal(await rowCount('capability_package_versions', draft.resourceRef), 1);

  const next = await edit(draft.resourceRef); draft = next.draft;
  const downgrade = manifest(draft.name, '1.1.0'); delete downgrade.schemaVersion;
  draft = await write(draft, manifestPath, JSON.stringify(downgrade));
  await rejected(draft, 'CREATOR_MANIFEST_SCHEMA', next.descriptor);
  draft = await write(draft, manifestPath, JSON.stringify(manifest(draft.name, '1.1.0')));
  draft = await remove(draft, logoPath);
  await rejected(draft, 'SVG_MISSING', next.descriptor);
  draft = await write(draft, logoPath, svg);
  await publish(draft, next.descriptor);
  assert.equal(await rowCount('capability_package_versions', draft.resourceRef), 2);
  const pinned = await packages.readCapabilityPackageFileAction(owner, draft.resourceRef, {revisionRef: first.published.revisionRef, path: logoPath});
  assert.equal(Buffer.from(pinned.file.content, 'base64').toString(), svg, 'The old graphic pin remains exact after the later edit.');

  await raw.run('DELETE FROM capability_package_operations WHERE resource_ref=$1', [draft.resourceRef]);
  const noReceipts = await edit(draft.resourceRef);
  const noReceiptDraft = await write(noReceipts.draft, manifestPath, JSON.stringify({...manifest(draft.name, '1.2.0'), schemaVersion: undefined}));
  await rejected(noReceiptDraft, 'CREATOR_MANIFEST_SCHEMA', noReceipts.descriptor);
  await packages.discardCapabilityPackageDraftAction(owner, noReceiptDraft.draftRef, {expectedDraftRevision: noReceiptDraft.draftRevision});

  let forkDraft = await fork(draft.resourceRef, 'creator-validation-fork');
  forkDraft = await write(forkDraft, manifestPath, JSON.stringify({...manifest(forkDraft.name), schemaVersion: undefined}));
  await rejected(forkDraft, 'CREATOR_MANIFEST_SCHEMA');
  forkDraft = await write(forkDraft, manifestPath, JSON.stringify(manifest(forkDraft.name)));
  await publish(forkDraft);
  const forkEdit = await edit(forkDraft.resourceRef);
  forkDraft = await write(forkEdit.draft, manifestPath, JSON.stringify(manifest(forkDraft.name, '1.1.0')));
  forkDraft = await remove(forkDraft, logoPath);
  await rejected(forkDraft, 'SVG_MISSING', forkEdit.descriptor);
  forkDraft = await write(forkDraft, logoPath, svg);
  await publish(forkDraft, forkEdit.descriptor);
  let descendant = await fork(forkDraft.resourceRef, 'creator-validation-descendant');
  descendant = await write(descendant, manifestPath, JSON.stringify({...manifest(descendant.name), schemaVersion: undefined}));
  await rejected(descendant, 'CREATOR_MANIFEST_SCHEMA');
  descendant = await write(descendant, manifestPath, JSON.stringify(manifest(descendant.name)));
  await publish(descendant);

  let rootSkill = await create('creator-validation-root-skill');
  rootSkill = await fill(rootSkill, owner, true);
  const rootReport = await validate(rootSkill);
  assert(rootReport.valid, rootReport.errors.join(' '));
  await publish(rootSkill);

  const author = {userId: 'creator-validation-author', workspaceId: 'personal-creator-validation-author'};
  await raw.run('INSERT INTO "user" (id,name,email,email_verified,role,banned,created_at,updated_at) VALUES ($1,$1,$2,1,\'user\',0,1000,1000)', [author.userId, `${author.userId}@package-actions.example.test`]);
  await raw.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('org-packages',$1,'admin','active',1,1000,1000)", [author.userId]);
  await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ($1,'org-packages','personal',$2,$1,$2,'active',1000,1000)", [author.workspaceId, author.userId]);
  let authored = await fill(await create('creator-validation-deleted-author', author), author);
  await publish(authored, undefined, author);
  const revoked = await fill(await create('creator-validation-revoked', author), author);
  assert((await validate(revoked, author)).valid);
  await raw.run('UPDATE organization_user_permissions SET can_share_plugins_and_skills=0 WHERE user_id=$1', [author.userId]);
  const revokedResponse = await publishRoute.POST(request(author.userId, 'POST', publishInput(revoked)), context(revoked.draftRef));
  assert.equal(revokedResponse.status, 403, await revokedResponse.clone().text());
  await preserved(revoked, 0, 0);
  assert.equal((await publishRoute.POST(request(other.userId, 'POST', publishInput(revoked)), context(revoked.draftRef))).status, 404,
    'A different actor cannot publish a private draft after its owner loses permission.');
  await raw.run('UPDATE organization_user_permissions SET can_share_plugins_and_skills=1 WHERE user_id=$1', [author.userId]);
  await packages.discardCapabilityPackageDraftAction(author, revoked.draftRef, {expectedDraftRevision: revoked.draftRevision});
  await raw.run('DELETE FROM canvas_workspaces WHERE id=$1 AND owner_user_id=$2', [author.workspaceId, author.userId]);
  await raw.run('DELETE FROM organization_user_permissions WHERE organization_id=$1 AND user_id=$2', ['org-packages', author.userId]);
  await raw.run('DELETE FROM "user" WHERE id=$1', [author.userId]);
  assert.equal((await raw.get('SELECT published_by_user_id FROM capability_package_versions WHERE resource_ref=$1', [authored.resourceRef]) as {published_by_user_id: string | null}).published_by_user_id, null,
    'The real publisher deletion clears its nullable identity.');
  assert.equal(Number((await raw.get('SELECT COUNT(*)::integer AS count FROM capability_package_operations WHERE resource_ref=$1', [authored.resourceRef]) as {count: number}).count), 0,
    'The real actor deletion removes private operation receipts.');
  const survivor = await edit(authored.resourceRef);
  authored = await write(survivor.draft, manifestPath, JSON.stringify({...manifest(authored.name, '1.1.0'), schemaVersion: undefined}));
  await rejected(authored, 'CREATOR_MANIFEST_SCHEMA', survivor.descriptor);

  // Corrupt only this owned fixture's immutable origin rows: descendants must fail closed rather than become legacy.
  const missingOrigin = await edit(descendant.resourceRef);
  const versionColumns = ['revision_ref', 'resource_ref', 'kind', 'name', 'version', 'checksum', 'files', 'total_bytes',
    'published_by_user_id', 'published_at', 'base_revision_ref', 'source_resource_ref', 'source_revision_ref', 'source_checksum', 'source_stamp'];
  const readOriginalVersions = () => raw.all(`SELECT ${versionColumns.join(',')} FROM capability_package_versions WHERE resource_ref=$1 ORDER BY revision_ref`, [draft.resourceRef]);
  const originalVersions = await readOriginalVersions() as Array<Record<string, unknown>>;
  assert.equal(originalVersions.length, 2, 'The corruption fixture saves both exact immutable source versions.');
  let removedOrigin = false;
  try {
    await raw.run('DELETE FROM capability_package_versions WHERE resource_ref=$1', [draft.resourceRef]);
    removedOrigin = true;
    const originValidate = await validateRoute.POST(request(owner.userId, 'POST'), context(missingOrigin.draft.draftRef));
    assert.equal(originValidate.status, 409, await originValidate.clone().text());
    assert.equal((await originValidate.json() as {code: string}).code, 'PACKAGE_SNAPSHOT_UNAVAILABLE');
    const originPublish = await publishRoute.POST(request(owner.userId, 'POST', publishInput(missingOrigin.draft, missingOrigin.descriptor)), context(missingOrigin.draft.draftRef));
    assert.equal(originPublish.status, 409, await originPublish.clone().text());
    await preserved(missingOrigin.draft, 1, 1);
  } finally {
    if (removedOrigin) {
      for (const version of originalVersions) {
        await raw.run(`INSERT INTO capability_package_versions (${versionColumns.join(',')}) VALUES (${versionColumns.map((_, index) => `$${index + 1}`).join(',')})`,
          versionColumns.map(column => version[column]));
      }
      assert.deepEqual(await readOriginalVersions(), originalVersions, 'The negative case restores every exact source row before later registry/publication cases.');
    }
  }

  // Existing complete legacy bytes remain editable/forkable without the new authoring marker or purpose-image fields.
  const legacy = await edit(legacyRef);
  assert((await validate(legacy.draft)).valid, 'Historical packages do not acquire the new Creator manifest/image obligation.');
  await packages.discardCapabilityPackageDraftAction(owner, legacy.draft.draftRef, {expectedDraftRevision: legacy.draft.draftRevision});
  let legacyFork = await fork(legacyRef, 'creator-validation-legacy-fork');
  const legacyManifest = JSON.parse(Buffer.from((await packages.readCapabilityPackageDraftFileAction(owner, legacyFork.draftRef, {path: manifestPath})).file.content, 'base64').toString()) as Record<string, unknown>;
  legacyFork = await write(legacyFork, manifestPath, JSON.stringify({...legacyManifest, name: legacyFork.name}));
  assert((await validate(legacyFork)).valid, 'A historical fork retains its existing format contract.');
  await packages.discardCapabilityPackageDraftAction(owner, legacyFork.draftRef, {expectedDraftRevision: legacyFork.draftRevision});
  console.log('PASS Creator validation actual HTTP/SQL/files: strict new manifests, direct publish rejection, structured repairs, validate/change/delete recheck, repaired immutable bytes, edit/fork ancestry, deleted receipts/publisher, missing-origin fail-closed, root skill, legacy compatibility and revoked actor.');
}
