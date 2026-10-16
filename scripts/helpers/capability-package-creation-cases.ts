import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SqlConnection } from '../../app/lib/db';
import type { CapabilityPackageDraft } from '../../app/lib/capabilities/packages/contracts';

type Packages = typeof import('../../app/lib/capabilities/packages/actions');
type Actor = { userId: string; workspaceId: string };
type RequestFactory = (userId: string | null, method?: string, body?: unknown, url?: string) => Request;

/** Real authenticated routes, SQL and package bytes; no mocked creation/publication results. */
export async function verifyCapabilityPackageCreation(input: {
  packages: Packages; raw: Pick<SqlConnection, 'get' | 'all' | 'run'>;
  owner: Actor; other: Actor; request: RequestFactory; native: boolean;
}) {
  const { packages, raw, owner, other, request } = input;
  const collection = await import('../../app/api/capabilities/packages/drafts/route');
  const recovery = await import('../../app/api/capabilities/packages/operations/route');
  const context = (params: Record<string, string> = {}) => ({ params: Promise.resolve(params) });
  const data = async <T>(response: Response, expected = 200): Promise<T> => {
    assert.equal(response.status, expected, await response.clone().text());
    return (await response.json() as { data: T }).data;
  };
  const operation = async (requestId: string, userId = owner.userId) => {
    const response = await recovery.GET(request(userId, 'GET', undefined,
      `http://localhost/api/capabilities/packages/operations?requestId=${requestId}`), context());
    return data<{ operation: { status: string; draftRef: string; draftRevision: number; resourceRef: string; publishedRevisionRef: string | null } }>(response);
  };
  const creation = { operation: 'create', kind: 'plugin', targetName: 'package-created-org', requestId: randomUUID() };
  assert.equal((await collection.POST(request(null, 'POST', creation), context())).status, 401);
  assert.equal((await collection.POST(request(other.userId, 'POST', creation), context())).status, 403);
  await assert.rejects(packages.createCapabilityPackageDraftAction({ ...owner, workspaceId: other.workspaceId }, creation),
    error => (error as { status?: number }).status === 403, 'A caller cannot borrow another user’s private workspace context.');
  for (const injected of [{ ownership: { type: 'user' } }, { organizationId: 'another-org' },
    { resourceRef: 'invented-source' }, { actorUserId: other.userId }]) {
    assert.equal((await collection.POST(request(owner.userId, 'POST', { ...creation, ...injected }), context())).status, 400);
  }
  assert.equal((await collection.POST(request(owner.userId, 'POST', { ...creation, targetName: '../escape' }), context())).status, 400);
  const created = await data<{ draft: CapabilityPackageDraft }>(await collection.POST(request(owner.userId, 'POST', creation), context()));
  let draft = created.draft;
  assert.equal(draft.operation, 'create');
  assert.equal(draft.sourceResourceRef, null, 'A new package must not pretend to derive from a source.');
  assert.equal(draft.baseSourceStamp, null);
  assert.equal((await raw.get('SELECT COUNT(*)::integer AS count FROM capability_resources WHERE resource_ref=$1', [draft.resourceRef]) as { count: number }).count, 0,
    'Creation leaves only an actor-private draft until publication.');
  const read = await packages.readCapabilityPackageDraftAction(owner, draft.draftRef);
  assert.equal(read.target.ownership.type, 'organization');
  assert.equal('organizationId' in read.target.ownership && read.target.ownership.organizationId, 'org-packages');
  await assert.rejects(packages.readCapabilityPackageDraftAction(other, draft.draftRef), error => (error as { status?: number }).status === 404);
  const listed = await packages.listCapabilityPackageOwnedDraftStatusesAction(owner);
  assert(listed.drafts.some(item => item.draftRef === draft.draftRef && item.operation === 'create'));
  const replay = await data<{ draft: CapabilityPackageDraft }>(await collection.POST(request(owner.userId, 'POST', creation), context()));
  assert.equal(replay.draft.draftRef, draft.draftRef, 'Lost create response must recover the same draft.');
  assert.equal((await packages.validateCapabilityPackageDraftAction(owner, draft.draftRef)).validation.valid, false,
    'An empty new plugin is not a publishable package.');
  assert.equal((await collection.POST(request(owner.userId, 'POST', { ...creation, targetName: 'different-package' }), context())).status, 409,
    'Reusing a request key for a different operation must fail.');
  const files: Record<string, string> = {
    '.canvas-plugin/plugin.json': JSON.stringify({ schemaVersion: 1, name: creation.targetName, version: '1.0.0', description: 'Created through the package API',
      skills: 'skills', interface: { displayName: 'Created Context', shortDescription: 'Prepare a document from supplied context', logo: './assets/logo.svg' } }),
    'skills/created-context/SKILL.md': '---\nname: created-context\ndescription: Prepare a document from the supplied context\nmetadata:\n  version: "1.0.0"\n---\nRead references/guidance.md before preparing the document.\n',
    'skills/created-context/references/guidance.md': 'Keep source facts distinguishable from suggestions.\n',
    'assets/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><title>Context document</title><desc>A document prepared from source facts</desc><rect x="56" y="28" width="144" height="200" rx="12" fill="#184E77"/><path d="M80 80h96M80 112h96M80 144h64" stroke="#FFF" stroke-width="12"/></svg>',
  };
  for (const [file, content] of Object.entries(files)) {
    ({ draft } = await packages.writeCapabilityPackageDraftFileAction(owner, draft.draftRef, {
      expectedDraftRevision: draft.draftRevision, path: file, encoding: 'base64', content: Buffer.from(content).toString('base64'),
    }));
  }
  const afterWrites = await data<{ draft: CapabilityPackageDraft }>(await collection.POST(request(owner.userId, 'POST', creation), context()));
  assert.equal(afterWrites.draft.draftRevision, draft.draftRevision, 'Create recovery must not return stale draft revision one.');
  assert.equal((await operation(creation.requestId)).operation.draftRevision, draft.draftRevision);
  assert((await packages.validateCapabilityPackageDraftAction(owner, draft.draftRef)).validation.valid);
  const publishRequest = { draftRef: draft.draftRef, expectedDraftRevision: draft.draftRevision, expectedMetadataRevision: 0,
    expectedGrantsRevision: 0, expectedPackageRevision: 0, expectedPublishedRevisionRef: null, requestId: randomUUID() };
  const published = await packages.publishCapabilityPackageDraftAction(owner, publishRequest);
  assert.equal(published.state.resourceRef, draft.resourceRef);
  assert.equal(published.published.sourceResourceRef, null);
  const recovered = await operation(publishRequest.requestId);
  assert.equal(recovered.operation.status, 'published');
  assert.equal(recovered.operation.publishedRevisionRef, published.published.revisionRef);
  assert.equal((await operation(creation.requestId)).operation.status, 'published', 'The create key remains useful after its draft is consumed.');
  const second = await packages.publishCapabilityPackageDraftAction(owner, publishRequest);
  assert.equal(second.published.revisionRef, published.published.revisionRef, 'Lost publish response must not create a second immutable version.');
  assert.equal((await raw.get('SELECT COUNT(*)::integer AS count FROM capability_package_versions WHERE resource_ref=$1', [draft.resourceRef]) as { count: number }).count, 1);
  assert.equal((await raw.get('SELECT COUNT(*)::integer AS count FROM capability_package_drafts WHERE draft_ref=$1', [draft.draftRef]) as { count: number }).count, 0);
  const descriptor = await packages.inspectCapabilityPackage(owner, draft.resourceRef);
  assert.equal(descriptor.resource.ownership.type, 'organization');
  assert.equal(descriptor.access.canUse, false, 'Org ownership must not implicitly grant tool use.');
  const actual = await packages.readCapabilityPackageFileAction(owner, draft.resourceRef, {
    revisionRef: published.published.revisionRef, path: 'skills/created-context/references/guidance.md',
  });
  assert.equal(Buffer.from(actual.file.content, 'base64').toString(), files['skills/created-context/references/guidance.md']);
  const foreign = await recovery.GET(request(other.userId, 'GET', undefined,
    `http://localhost/api/capabilities/packages/operations?requestId=${publishRequest.requestId}`), context());
  assert.equal(foreign.status, 404, 'Publication recovery remains private to the actual actor.');
  for (const query of ['', 'requestId=invalid', `requestId=${creation.requestId}&requestId=${creation.requestId}`,
    `requestId=${creation.requestId}&draftRef=${draft.draftRef}`, 'rootPath=/tmp']) {
    assert.equal((await recovery.GET(request(owner.userId, 'GET', undefined,
      `http://localhost/api/capabilities/packages/operations?${query}`), context())).status, 400);
  }
  const skillInput = { operation: 'create', kind: 'skill', targetName: 'created-standalone-context', requestId: randomUUID() };
  const skill = await packages.createCapabilityPackageDraftAction(owner, skillInput);
  const skillContent = '---\nname: created-standalone-context\ndescription: Summarize the supplied context\nmetadata:\n  version: "1.0.0"\n---\nPrepare a summary from supplied facts.\n';
  const skillWritten = await packages.writeCapabilityPackageDraftFileAction(owner, skill.draftRef, {
    expectedDraftRevision: skill.draftRevision, path: 'SKILL.md', encoding: 'base64', content: Buffer.from(skillContent).toString('base64'),
  });
  assert((await packages.validateCapabilityPackageDraftAction(owner, skill.draftRef)).validation.valid);
  const skillPublished = await packages.publishCapabilityPackageDraftAction(owner, {
    ...publishRequest, draftRef: skill.draftRef, expectedDraftRevision: skillWritten.draft.draftRevision, requestId: randomUUID(),
  });
  assert.equal(skillPublished.published.kind, 'skill');
  assert.equal(skillPublished.published.sourceResourceRef, null);
  const skillBytes = await packages.readCapabilityPackageFileAction(owner, skill.resourceRef, { path: 'SKILL.md' });
  assert.equal(Buffer.from(skillBytes.file.content, 'base64').toString(), skillContent);
  const discardedInput = { operation: 'create', kind: 'skill', targetName: 'created-discarded-skill', requestId: randomUUID().toUpperCase() };
  const discarded = await packages.createCapabilityPackageDraftAction(owner, discardedInput);
  await packages.discardCapabilityPackageDraftAction(owner, discarded.draftRef, { expectedDraftRevision: discarded.draftRevision });
  assert.equal((await operation(discardedInput.requestId)).operation.status, 'discarded', 'Discard and publish are unambiguous after draft removal.');
  if (input.native) {
    const racedInput = { operation: 'create', kind: 'skill', targetName: 'created-parallel-skill', requestId: randomUUID() };
    const racers = await Promise.all([packages.createCapabilityPackageDraftAction(owner, racedInput), packages.createCapabilityPackageDraftAction(owner, racedInput)]);
    assert.equal(racers[0].draftRef, racers[1].draftRef, 'Concurrent retries must share one private draft.');
    assert.equal((await raw.get('SELECT COUNT(*)::integer AS count FROM capability_package_drafts WHERE name=$1', [racedInput.targetName]) as { count: number }).count, 1);
    const racedWritten = await packages.writeCapabilityPackageDraftFileAction(owner, racers[0].draftRef, {
      expectedDraftRevision: racers[0].draftRevision, path: 'SKILL.md', encoding: 'base64',
      content: Buffer.from(skillContent.replace('created-standalone-context', racedInput.targetName)).toString('base64'),
    });
    const racedPublishRequest = { ...publishRequest, draftRef: racers[0].draftRef,
      expectedDraftRevision: racedWritten.draft.draftRevision, requestId: randomUUID() };
    const publications = await Promise.all([packages.publishCapabilityPackageDraftAction(owner, racedPublishRequest),
      packages.publishCapabilityPackageDraftAction(owner, racedPublishRequest)]);
    assert.equal(publications[0].published.revisionRef, publications[1].published.revisionRef,
      'Overlapping publication retries must recover the committed version rather than fail on a consumed draft.');
    assert.equal((await raw.get('SELECT COUNT(*)::integer AS count FROM capability_package_versions WHERE resource_ref=$1', [racers[0].resourceRef]) as { count: number }).count, 1);
    const conflictKey = randomUUID();
    const conflicts = await Promise.allSettled(['created-race-left', 'created-race-right'].map(targetName =>
      packages.createCapabilityPackageDraftAction(owner, { ...racedInput, targetName, requestId: conflictKey })));
    assert.equal(conflicts.filter(result => result.status === 'fulfilled').length, 1);
    const conflict = conflicts.find(result => result.status === 'rejected');
    assert(conflict?.status === 'rejected');
    assert.equal(conflict.reason.code, 'PACKAGE_REQUEST_CONFLICT');
    console.log('PASS native PostgreSQL overlapping create/publish retries and request-key payload conflict.');
  }
  console.log('PASS organization creation + authenticated HTTP: source-free provenance, actor-private resume, exact files, request-key deduplication, durable publish/discard recovery and independent use rights.');
}
