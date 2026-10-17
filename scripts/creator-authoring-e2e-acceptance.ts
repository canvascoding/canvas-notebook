import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { z } from 'zod';
import YAML from 'yaml';
import { extensionPackagePinSchema } from '../app/lib/capabilities/extensions/contracts';
import type { CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import type { CapabilityPackageDescriptor, CapabilityPackageFileRead, CapabilityPackageOperationStatus, CapabilityPackageTreeEntry } from '../app/lib/capabilities/packages/contracts';
import type { AgentExtensionPackageVersion } from '../app/lib/agents/extension-options-contracts';
import type { ChatExtensionOptionsResponse, ChatExtensionOptionsPreview } from '../app/lib/chat/extension-options-contracts';
import { deriveChatBodySelection, parseChatBody } from '../app/lib/chat/chat-body-contracts';
import { parseFrontmatter } from '../app/lib/skills/canvas-skill-manifest';
import { creatorPluginManifestSchema, validateCreatorPluginManifest } from '../app/lib/plugins/creator-plugin-manifest';
import { validateCreatorPluginSvg } from '../app/lib/capabilities/packages/creator-plugin-svg';

/** Read-only HTTP acceptance for an already created package. This is not a substitute for a natural Creator run or browser/provider evidence.
 * Run: tsx --conditions react-server scripts/creator-authoring-e2e-acceptance.ts --evidence /private/path/evidence.json
 * The JSON contains identities/expectations only; actor cookies are read from its named environment variables and never printed.
 */
const relativePath = z.string().min(1).max(1024).refine(value => !/[\\\p{Cc}\p{Cf}]/u.test(value) && !value.startsWith('/')
  && !/^[a-z][a-z0-9+.-]*:/iu.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..'));
const id = z.string().min(1).max(256).refine(value => value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value));
const checksum = extensionPackagePinSchema.shape.checksum;
const actor = z.object({ userId: id, workspaceId: id, agentId: id, cookieEnv: z.string().regex(/^[A-Z][A-Z0-9_]{1,100}$/u) }).strict();
const evidenceSchema = z.object({
  schemaVersion: z.literal(1),
  baseUrl: z.string().url().refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol)
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; }),
  pin: extensionPackagePinSchema,
  draftRef: z.string().regex(/^canvas-package-draft:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u),
  owner: actor,
  deniedContexts: z.array(z.object({ label: id, actor, expectation: z.enum(['read_denied', 'read_without_use']) }).strict()).max(16).default([]),
  expected: z.object({ name: id, version: id, organizationId: id,
    currentPublishedRevisionRef: extensionPackagePinSchema.shape.publishedRevisionRef.optional(),
    skills: z.array(z.object({ name: id, relativeRoot: relativePath, version: id }).strict()).min(2).max(64),
    mcpConnectors: z.array(id).min(1).max(32), composioToolkits: z.array(id).min(1).max(32),
    requiredFiles: z.array(z.object({ path: relativePath, checksum }).strict()).min(1).max(128),
  }).strict(),
}).strict();
type Evidence = z.infer<typeof evidenceSchema>;
type Actor = Evidence['owner'];
type Reply = { status: number; data?: unknown; code?: string };
let lastResponse: { route: string; status: number } | undefined;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
class AcceptanceCheckError extends Error {}
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new AcceptanceCheckError(message); }

async function verify(evidence: Evidence) {
  const { pin, expected } = evidence;
  const actors = [evidence.owner, ...evidence.deniedContexts.map(context => context.actor)];
  check(new Set(evidence.deniedContexts.map(context => context.label)).size === evidence.deniedContexts.length, 'Denied context labels must be unique.');
  const contextKey = (value: Actor) => JSON.stringify([value.userId,value.workspaceId,value.agentId,value.cookieEnv]);
  const cookies = new Map<string, string>();
  for (const value of actors) {
    const cookie = process.env[value.cookieEnv];
    check(typeof cookie === 'string' && cookie.length > 0 && cookie.length <= 32_768 && !/[\r\n]/u.test(cookie), 'A named actor cookie is missing or invalid.');
    cookies.set(contextKey(value), cookie);
  }
  let requests = 0, staticUnauthenticated401Exemptions = 0;
  const packageRoute = `/api/capabilities/packages/${encodeURIComponent(pin.resourceRef)}`;
  const safeRoutes = new Map([
    [packageRoute, '/api/capabilities/packages/[resourceRef]'],
    [`${packageRoute}/tree`, '/api/capabilities/packages/[resourceRef]/tree'],
    [`${packageRoute}/file`, '/api/capabilities/packages/[resourceRef]/file'],
    [`/api/capabilities/resources/${encodeURIComponent(pin.resourceRef)}`, '/api/capabilities/resources/[resourceRef]'],
    [`/api/capabilities/packages/drafts/${encodeURIComponent(evidence.draftRef)}/status`, '/api/capabilities/packages/drafts/[draftRef]/status'],
    ['/api/capabilities/packages/operations', '/api/capabilities/packages/operations'],
    ['/api/chat/extension-options', '/api/chat/extension-options'],
    ['/api/auth/get-session', '/api/auth/get-session'],
  ]);
  const request = async (path: string, who: Actor | null, body?: unknown): Promise<Reply> => {
    const url = new URL(path, evidence.baseUrl);
    check(url.origin === new URL(evidence.baseUrl).origin && url.pathname.startsWith('/api/'), 'Only same-instance API requests are permitted.');
    // The only POST is the documented metadata/preview endpoint. No session/message creation, setup, mutation or provider route is reachable.
    check(body === undefined || url.pathname === '/api/chat/extension-options', 'The verifier cannot mutate the application.');
    if (who && url.pathname !== '/api/auth/get-session') url.searchParams.set('workspaceId', who.workspaceId);
    const headers = new Headers({ ...(who ? { cookie: cookies.get(contextKey(who))! } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) });
    if (who) headers.set('x-canvas-workspace-id', who.workspaceId);
    const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(120_000) });
    requests += 1;
    lastResponse = { route: safeRoutes.get(url.pathname) ?? '/api/[unrecognized]', status: response.status };
    const text = await response.text();
    check(Buffer.byteLength(text) <= 16 * 1024 * 1024, 'An API response exceeds the acceptance budget.');
    let payload: Record<string, unknown>;
    try { payload = object(JSON.parse(text)); } catch { throw new Error('An API returned an invalid response.'); }
    if (url.pathname === '/api/auth/get-session') return { status: response.status, data: payload };
    if (who === null && url.pathname === packageRoute && response.status === 401) {
      // proxy.ts or resourceRequestActor may reject first, both before the private package response boundary.
      const proxyFailure = payload.success === false && payload.error === 'Unauthorized' && Object.keys(payload).length === 2;
      const routeFailure = payload.success === false && payload.code === 'unauthorized' && payload.error === 'Sign in to manage resources.'
        && Object.keys(payload).length === 3;
      check(proxyFailure || routeFailure, 'The unauthenticated response must contain only its documented static failure.');
      staticUnauthenticated401Exemptions += 1;
    } else check(response.headers.get('cache-control')?.includes('no-store'), 'Private acceptance API responses must not be cached.');
    return { status: response.status, ...(payload.success === true ? { data: payload.data } : {}), ...(typeof payload.code === 'string' ? { code: payload.code } : {}) };
  };
  const success = <T>(reply: Reply, label: string): T => { check(reply.status === 200 && reply.data !== undefined, `${label} did not return current authorized metadata.`); return reply.data as T; };
  const refused = (reply: Reply, statuses: readonly number[], label: string) => check(statuses.includes(reply.status) && reply.data === undefined, `${label} was not refused.`);
  for (const who of actors) {
    const session = success<Record<string, unknown>>(await request('/api/auth/get-session', who), 'Actor session');
    check(object(session.user).id === who.userId, 'An actor cookie does not match its declared user.');
  }
  const owner = evidence.owner;
  const resourcePath = `/api/capabilities/resources/${encodeURIComponent(pin.resourceRef)}`;
  const packagePath = `/api/capabilities/packages/${encodeURIComponent(pin.resourceRef)}`;
  const selected = `revisionRef=${encodeURIComponent(pin.publishedRevisionRef)}`;
  const current = success<{ package: CapabilityPackageDescriptor }>(await request(packagePath, owner), 'Published package').package;
  check(current.resource.resourceRef === pin.resourceRef && current.resource.ownership.type === 'organization'
    && current.resource.ownership.organizationId === expected.organizationId, 'The actual package has another identity or ownership.');
  if (expected.currentPublishedRevisionRef) check(current.state?.currentPublishedRevisionRef === expected.currentPublishedRevisionRef, 'The observed current head differs from the explicitly expected head.');
  refused(await request(packagePath, null), [401], 'Unauthenticated package read');
  const receiptPath = `/api/capabilities/packages/operations?draftRef=${encodeURIComponent(evidence.draftRef)}`;
  const receipt = success<{ operation: CapabilityPackageOperationStatus }>(await request(receiptPath, owner), 'Private publication receipt').operation;
  check(receipt.status === 'published' && receipt.resourceRef === pin.resourceRef && receipt.publishedRevisionRef === pin.publishedRevisionRef
    && receipt.publishedChecksum === pin.checksum, 'The operation receipt does not identify the same exact immutable publication.');
  const draftPath = `/api/capabilities/packages/drafts/${encodeURIComponent(evidence.draftRef)}/status`;
  refused(await request(draftPath, owner), [404], 'Consumed draft status');

  const tree = success<{ files: CapabilityPackageTreeEntry[] }>(await request(`${packagePath}/tree?${selected}`, owner), 'Exact immutable tree').files;
  check(Array.isArray(tree) && tree.length <= 4_000, 'The exact file inventory is unavailable or unbounded.');
  const files = tree.filter((entry): entry is Extract<CapabilityPackageTreeEntry, {type:'file'}> => entry.type === 'file')
    .sort((left,right) => left.path.localeCompare(right.path));
  check(files.length > 0 && files.length <= 2_000 && new Set(files.map(file => file.path)).size === files.length, 'The exact file list is empty, duplicated or unbounded.');
  check(files.every(file => relativePath.safeParse(file.path).success && checksum.safeParse(file.checksum).success && Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 32 * 1024 * 1024), 'An inventory entry is invalid.');
  const totalBytes = files.reduce((sum,file)=>sum+file.size,0); check(totalBytes <= 250 * 1024 * 1024, 'The package exceeds its byte budget.');
  const readFile = async (file: typeof files[number], consume?: (bytes: Buffer)=>void): Promise<void> => {
    const hash = createHash('sha256'); let offset = 0;
    do {
      const reply = success<{ file: CapabilityPackageFileRead }>(await request(`${packagePath}/file?${selected}&path=${encodeURIComponent(file.path)}&offset=${offset}&maxBytes=1048576`, owner), 'Exact immutable file').file;
      check(reply.path === file.path && reply.size === file.size && reply.checksum === file.checksum && reply.offset === offset && reply.encoding === 'base64', 'A file read does not match its selected immutable inventory.');
      check(typeof reply.content === 'string' && reply.content.length <= 1_400_000, 'A file range exceeds its bound.');
      const bytes = Buffer.from(reply.content, 'base64'); check(bytes.byteLength === reply.byteLength && bytes.byteLength <= 1_048_576 && offset + bytes.byteLength <= file.size, 'A file range has inconsistent bytes.');
      check(reply.eof === (offset + bytes.byteLength === file.size) && (reply.eof || bytes.byteLength > 0), 'A file read cannot make progress.');
      hash.update(bytes); consume?.(bytes); offset += bytes.byteLength;
    } while (offset < file.size);
    check(hash.digest('hex') === file.checksum, 'Downloaded bytes do not match their file checksum.');
  };
  const manifestEntry = files.find(file=>file.path==='.canvas-plugin/plugin.json'); check(manifestEntry && manifestEntry.size <= 262_144, 'A bounded Creator manifest is required.');
  const manifestParts:Buffer[]=[];await readFile(manifestEntry,bytes=>manifestParts.push(bytes));
  const rawManifest=Buffer.concat(manifestParts).toString('utf8');check(validateCreatorPluginManifest(rawManifest).valid, 'The actual immutable manifest does not satisfy Creator Plugin V1.');
  const manifest=creatorPluginManifestSchema.parse(JSON.parse(rawManifest));check(manifest.name===expected.name&&manifest.version===expected.version, 'The actual manifest has another name or version.');
  const logo=manifest.interface.logo.replace(/^\.\//u,'');const retained=new Set([logo,...expected.skills.flatMap(skill=>[`${skill.relativeRoot}/SKILL.md`,`${skill.relativeRoot}/agents/canvas.yaml`])]);
  const captured=new Map<string,Buffer>();const packageHash=createHash('sha256');
  for(const file of files){
    packageHash.update(file.path);packageHash.update('\0');const parts:Buffer[]=[];
    if(retained.has(file.path))check(file.size<=2*1024*1024,'Retained proof text/image exceeds its bound.');
    await readFile(file,bytes=>{packageHash.update(bytes);if(retained.has(file.path))parts.push(bytes);});packageHash.update('\0');
    if(retained.has(file.path))captured.set(file.path,Buffer.concat(parts));
  }
  check(packageHash.digest('hex')===pin.checksum,'The independently downloaded complete tree differs from the published package checksum.');
  const logoBytes=captured.get(logo);check(logoBytes&&validateCreatorPluginSvg(logoBytes,logo).length===0,'The published purpose SVG is absent or invalid.');
  for(const required of expected.requiredFiles)check(files.find(file=>file.path===required.path)?.checksum===required.checksum,'An exact required source resource or license notice is absent or changed.');
  for(const skill of expected.skills){
    const bytes=captured.get(`${skill.relativeRoot}/SKILL.md`);check(bytes,'An expected complete child skill is absent.');
    const front=parseFrontmatter(bytes.toString('utf8')).frontmatter;check(front?.name===skill.name&&front.metadata?.version===skill.version,'The copied/new skill has another name or independent version.');
    const ui=captured.get(`${skill.relativeRoot}/agents/canvas.yaml`);if(ui){const declared=object(YAML.parse(ui.toString('utf8'))).skill;if(declared)check(object(declared).version===skill.version,'Skill version carriers disagree.');}
  }
  const target=(who:Actor)=>({kind:'draft_turn' as const,agentId:who.agentId,workspaceId:who.workspaceId});
  const ownerOptions=success<Extract<ChatExtensionOptionsResponse,{operation:'package_version'}>>(await request('/api/chat/extension-options',owner,{operation:'package_version',target:target(owner),...pin}),'Exact owner package options');
  const actual:AgentExtensionPackageVersion=ownerOptions.package;
  check(actual.pin.resourceRef===pin.resourceRef&&actual.pin.publishedRevisionRef===pin.publishedRevisionRef&&actual.pin.checksum===pin.checksum,'Chat metadata silently switched the immutable pin.');
  check(actual.version===expected.version,'Chat metadata has another package version.');
  const capabilities=actual.declarations.flatMap(declaration=>declaration.workflow.integrationCapabilities);
  for(const name of expected.mcpConnectors)check(manifest.connectors?.mcp?.some(connector=>connector.name===name)&&capabilities.some(capability=>capability.required&&capability.alternatives.length>0&&capability.alternatives.every(alternative=>alternative.source==='mcp'&&alternative.connector===name)),'A required exact MCP declaration is missing.');
  for(const slug of expected.composioToolkits)check(manifest.connectors?.composio?.some(connector=>connector.toolkit===slug)&&capabilities.some(capability=>capability.required&&capability.alternatives.length>0&&capability.alternatives.every(alternative=>alternative.source==='composio'&&alternative.toolkit===slug)),'A required exact Composio declaration is missing.');
  const stale={...pin,checksum:(pin.checksum[0]==='a'?'b':'a')+pin.checksum.slice(1)};
  refused(await request('/api/chat/extension-options',owner,{operation:'package_version',target:target(owner),...stale}),[409],'Stale exact package checksum');
  refused(await request('/api/chat/extension-options',owner,{operation:'package_version',target:target(owner),...pin,accountId:'forged'}),[400],'Strict options schema');
  const negativeContexts: Array<{label:string;expectation:string;status:'passed';observedUserId:string;workspaceId:string}> = [];
  for(const deniedContext of evidence.deniedContexts){
    const who=deniedContext.actor;
    if(deniedContext.expectation==='read_denied'){
      refused(await request(resourcePath,who),[403,404],'Declared context resource read');
      refused(await request(`${packagePath}/tree?${selected}`,who),[403,404],'Declared context immutable tree');
      refused(await request(`${packagePath}/file?${selected}&path=${encodeURIComponent('.canvas-plugin/plugin.json')}`,who),[403,404],'Declared context immutable bytes');
      refused(await request(draftPath,who),[403,404],'Declared context draft status');
    }else{
      const metadata=success<{resource:CapabilityResourceDescriptor}>(await request(resourcePath,who),'Readable no-Use resource').resource;
      check(metadata.access.canRead&&!metadata.access.canUse,'The declared no-Use actor must actually have Read and lack Use.');
      const readableOptions=await request('/api/chat/extension-options',who,{operation:'package_version',target:target(who),...pin});
      check([200,403,409].includes(readableOptions.status),'No-Use metadata returned an unexpected failure.');
      const bundleId=randomUUID();const body=parseChatBody({version:1,parts:[{type:'extension_reference',occurrenceId:randomUUID(),bundleId}],bundles:[{id:bundleId,caption:expected.name,
        primary:{selection:{kind:'plugin',package:pin,skillSelection:{kind:'all'}},requirement:'optional',toolCap:null},supporting:[],packageConnections:[]}]});
      const preview=success<{preview:ChatExtensionOptionsPreview}>(await request('/api/chat/extension-options',who,{operation:'preview',target:target(who),body,intakeSelection:deriveChatBodySelection(body)}),'No-Use selection preview').preview;
      check(preview.configurationReadiness==='blocked'&&preview.finalSendValidationRequired&&preview.issues.some(issue=>issue.severity==='error'&&issue.code==='CHAT_EXTENSION_UNAVAILABLE')
        &&!preview.effectiveToolCaps.some(entry=>entry.selection.kind==='plugin'&&entry.selection.package.resourceRef===pin.resourceRef),'Readable metadata admitted a package without Use.');
    }
    // Actor privacy differs from a workspace-only denial; the same actor may legitimately recover their own receipt in another authorized workspace.
    if(who.userId!==owner.userId)refused(await request(receiptPath,who),[403,404],'Another actor/context operation receipt');
    negativeContexts.push({label:deniedContext.label,expectation:deniedContext.expectation,status:'passed',observedUserId:who.userId,workspaceId:who.workspaceId});
  }
  const readDenied=negativeContexts.some(context=>context.expectation==='read_denied'),noUseDenied=negativeContexts.some(context=>context.expectation==='read_without_use');
  return {schemaVersion:1,status:readDenied&&noUseDenied?'passed_for_configured_checks':'partial',pin,requests,files:files.length,totalBytes,
    cachePolicy:{privateResponsesNoStore:true,staticUnauthenticated401Exemptions},
    checks:['exact_org_ownership','owner_receipt_exact_pin','unauthenticated_read_denied','complete_http_inventory_checksum','canonical_manifest','passive_purpose_svg','source_license_bytes','independent_skill_versions','required_mcp_and_composio','exact_chat_pin','stale_checksum_denied','strict_options_schema'],negativeContexts,
    uncovered:[...(!readDenied?['No denied resource/workspace context supplied.']:[]),...(!noUseDenied?['No actual Read-without-Use context supplied; separate P4/P6 native evidence remains required.']:[]),'Foreign-organization membership and execution denial require separate native evidence.'],
    limits:{naturalCreatorRun:'separate evidence required',browserVisual:'separate evidence required',sqlAndFilesystem:'independent evidence required',providerExecution:'not performed',messagesOrMutations:'not performed'}};
}

async function main(){
  if(process.argv.length===3&&process.argv[2]==='--help'){process.stdout.write('Read-only Creator acceptance: --evidence /private/path/evidence.json; provide the cookie environment variables named by that file; owner is required and deniedContexts are explicit optional coverage. No sessions or messages are created; setup, mutations and provider calls are excluded.\n');return;}
  check(process.argv.length===4&&process.argv[2]==='--evidence','Use --evidence with one prepared identity/expectation JSON file.');
  const bytes=await fs.readFile(process.argv[3]);check(bytes.byteLength<=64*1024,'Evidence input exceeds its bound.');const evidence=evidenceSchema.parse(JSON.parse(bytes.toString('utf8')));
  process.stdout.write(JSON.stringify(await verify(evidence),null,2)+'\n');
}
main().catch(error=>{process.stderr.write(JSON.stringify({schemaVersion:1,status:'failed',message:error instanceof AcceptanceCheckError?error.message:'Read-only Creator acceptance failed. Recheck the private evidence input and current API rights; no credentials or response bodies are printed.',...(lastResponse ? {lastResponse} : {})})+'\n');process.exitCode=1;});
