import 'server-only';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { openDb } from '@/app/lib/db';
import YAML from 'yaml';
import { isValidCanvasPluginName, isValidCanvasPluginVersion, validateCanvasPluginPackage, type CanvasPluginManifest, type CanvasPluginMcpConnector, type CanvasPluginConnectorManifest } from '@/app/lib/plugins/canvas-plugin-manifest';
import { parsePluginSkillsFromManifest } from '@/app/lib/plugins/canvas-plugin-registry';
import { isValidAgentSkillName, parseSkillFile, validateStandaloneSkillWorkflow, type CanvasSkill } from '@/app/lib/skills/canvas-skill-manifest';
import type { CapabilityResourceActor } from '../resources/contracts';
import type { WorkflowIntegrationCapability } from '../workflow-contracts';
import { CAPABILITY_PACKAGE_LIMITS, CapabilityPackageError, type CapabilityPackageDraftLocation } from './contracts';
import { resolveCapabilityPackageArtifact, validateCompleteCapabilityPackage } from './artifacts';
import { withPublishedPackage } from './actions';
import { getCapabilityPackageDraftRecord, mutateCapabilityPackageDraft } from './store';
import { normalizeCapabilityPackageRelativePath, readExactPackageInventory, resolveCapabilityPackageDraftLocation, withCapturedCapabilityPackageInventory, writeCapabilityPackageDraftBatch, type ExactCapabilityPackageInventory } from './io';
import { capabilityPackageDraftReferenceSchema, capabilityPackageSkillCompositionSchema, capabilityPackageWorkspaceDraftImportSchema, capabilityPackageWorkspaceDraftQuerySchema } from './schemas';
import { readableImportWorkspace, recordCapabilityPackageSourceCaptures, type CapabilityPackageSourceCapture } from './source-captures';
import { assertPortable, assertPortableFiles, assertMcpConfig, parseYaml } from './portable-declarations';

type Entry = {path:string;bytes:Buffer;executable?:boolean};
type PackageCapture = Extract<CapabilityPackageSourceCapture,{source:'package'}>;
type Selection = {source:{resourceRef:string;revisionRef?:string;expectedChecksum:string;childRelativeRoot?:string;expectedParentChecksum?:string};targetName?:string;targetVersion?:string};
type CapturedSkill = {selection:Selection;skill:CanvasSkill;inventory:ExactCapabilityPackageInventory;parentInventory?:ExactCapabilityPackageInventory;
  parentManifest?:CanvasPluginManifest;sourceRoot:string;capture:PackageCapture};
function conflict(message:string):never { throw new CapabilityPackageError('PACKAGE_NAMESPACE_CONFLICT',message,409); }
function invalid(message:string):never { throw new CapabilityPackageError('PACKAGE_INVALID',message,400); }
function changed():never { throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED','The selected source changed. Inspect its exact checksum again.',409); }
const object = (value:unknown):Record<string,unknown> => value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
const canonical = (value:unknown):string => JSON.stringify(value,(_key,item:unknown) => {
  if(item && typeof item==='object' && !Array.isArray(item)) return Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b)));
  return item;
});
const localRoot = (value:string):string => { const normalized=path.posix.normalize(value); return normalized==='.'?'':normalizeCapabilityPackageRelativePath(normalized.replace(/^\.\//u,'')); };
const below = (file:string,root:string):boolean => !root || file===root || file.startsWith(`${root}/`);
const relativeFile = (file:string,root:string):string => root ? file.slice(root.length+1) : file;
const draftLocation = (record:Awaited<ReturnType<typeof getCapabilityPackageDraftRecord>>):CapabilityPackageDraftLocation => resolveCapabilityPackageDraftLocation({...record.draft,owner:record.targetOwnership});
const originKey=(source:CapturedSkill):string=>canonical([source.capture.parentStorage?.resourceId??source.capture.storage.resourceId,source.capture.revisionRef,source.capture.parentChecksum??source.capture.checksum]);
function mappedSourcePath(file:string,mappings:ReadonlyMap<string,string>):string {
  const source=[...mappings.keys()].sort((a,b)=>b.length-a.length).find(root=>below(file,root));
  return source===undefined?file:path.posix.join(mappings.get(source)!,relativeFile(file,source));
}

type CaptureBudget={bytes:number;files:number;cache:Map<string,ExactCapabilityPackageInventory>};
function childInventory(parent:ExactCapabilityPackageInventory,root:string):ExactCapabilityPackageInventory {
  const files=parent.files.filter(file=>below(file.path,root)).map(file=>({...file,path:relativeFile(file.path,root),relativePath:relativeFile(file.path,root)}));
  const hash=createHash('sha256');for(const file of files){hash.update(file.path);hash.update('\0');hash.update(file.bytes);hash.update('\0');}
  return {files,directories:parent.directories.filter(dir=>dir!==root&&below(dir,root)).map(dir=>relativeFile(dir,root)),totalBytes:files.reduce((total,file)=>total+file.size,0),checksum:hash.digest('hex')};
}

async function captureSkill(actor:CapabilityResourceActor,selection:Selection,budget:CaptureBudget):Promise<CapturedSkill> {
  const source=await resolveCapabilityPackageArtifact(actor,selection.source.resourceRef);
  const child=source.storage.resourceType==='skill' && source.storage.sourceType==='plugin';
  const parentRef=child ? source.sourceStamp.parentResourceRef : source.storage.resourceType==='plugin' ? source.descriptor.metadata.resourceRef : null;
  if(child && !selection.source.expectedParentChecksum) invalid('A plugin child also requires its exact parent checksum. Inspect the parent or select parent resourceRef plus childRelativeRoot.');
  const parent=parentRef ? await resolveCapabilityPackageArtifact(actor,parentRef) : null;
  const selectedRoot=child ? source.sourceStamp.relativeRoot : selection.source.childRelativeRoot;
  if(parent && selectedRoot==null) invalid('Select one concrete skill root inside the plugin. External seed children must first be materialized in an immutable parent package.');
  if(!parent && selection.source.childRelativeRoot!==undefined) invalid('Only a plugin source selects a child root.');
  const reference=parent?.descriptor.metadata.resourceRef ?? source.descriptor.metadata.resourceRef;
  return withPublishedPackage(actor,reference,selection.source.revisionRef,async location => {
    const key=canonical([reference,'revisionRef' in location?location.revisionRef:null,parent?(child?selection.source.expectedParentChecksum:selection.source.expectedChecksum):selection.source.expectedChecksum]);
    let complete=budget.cache.get(key);
    if(!complete) {
      complete=await readExactPackageInventory(location.rootPath,{maxFiles:CAPABILITY_PACKAGE_LIMITS.maxFiles-budget.files,maxTotalBytes:CAPABILITY_PACKAGE_LIMITS.maxTotalBytes-budget.bytes});
      budget.files+=complete.files.length;budget.bytes+=complete.totalBytes;budget.cache.set(key,complete);
    }
    const parentChecksum=parent ? complete.checksum : undefined;
    if(parent ? complete.checksum!==(child?selection.source.expectedParentChecksum:selection.source.expectedChecksum) : complete.checksum!==selection.source.expectedChecksum) changed();
    assertPortableFiles(new Map(complete.files.map(file=>[file.path,{path:file.path,bytes:file.bytes,executable:file.executable}])));
    return withCapturedCapabilityPackageInventory(complete,async capturedRoot=>{
    let skill:CanvasSkill|null, root='', inventory=complete, manifest:CanvasPluginManifest|undefined;
    if(parent) {
      const validation=await validateCanvasPluginPackage(capturedRoot);
      if(!validation.valid || !validation.manifest || !validation.skillsDir) invalid(validation.errors.join(' ') || 'The selected plugin is invalid.');
      manifest=validation.manifest;
      assertPortableFiles(new Map(complete.files.map(file=>[file.path,{path:file.path,bytes:file.bytes,executable:file.executable}])),manifest.connectors?.mcp,manifest.connectors?.mcpServers);
      const parsed=await parsePluginSkillsFromManifest(manifest,capturedRoot,validation.skillsDir);
      if(parsed.errors.length) invalid(parsed.errors.join(' '));
      root=localRoot(selectedRoot ?? '');
      const matches=parsed.skills.filter(item=>path.relative(capturedRoot,item.directory).split(path.sep).join('/')===root);
      if(matches.length!==1) invalid('The selected root does not identify exactly one declared plugin skill.');
      skill=matches[0]; inventory=childInventory(complete,root);
      if(child && inventory.checksum!==selection.source.expectedChecksum) changed();
    } else {
      skill=await parseSkillFile(path.join(capturedRoot,'SKILL.md'),{validateDirectoryName:false});
      if(!skill) invalid('The selected skill is invalid.');
      await validateStandaloneSkillWorkflow(skill);
    }
    if(!skill.version || !isValidCanvasPluginVersion(skill.version)) invalid('The selected skill needs a valid independent version.');
    const targetName=selection.targetName ?? skill.name;
    if(!isValidAgentSkillName(targetName)) invalid('Choose a valid target skill name.');
    return {selection,skill,inventory,parentInventory:parent?complete:undefined,parentManifest:manifest,sourceRoot:root,
      capture:{source:'package',storage:source.storage,...(child && parent?{parentStorage:parent.storage}:{}),resourceRef:source.descriptor.metadata.resourceRef,
        revisionRef:'revisionRef' in location ? location.revisionRef : null,checksum:child?inventory.checksum:complete.checksum,
        ...(parentChecksum?{parentChecksum}:{}),childRelativeRoot:root,selectedChildChecksum:inventory.checksum,targetRelativeRoot:'',name:skill.name,version:skill.version,
        targetName,targetVersion:skill.version,changes:[],...(skill.license?{skillLicense:skill.license}:{}),
        ...(manifest?{parentName:manifest.name,parentVersion:manifest.version,...(manifest.license?{parentLicense:manifest.license}:{})}:{})}};
    });
  });
}

function addEntry(files:Map<string,Entry>,entry:Entry):void {
  const normalized=normalizeCapabilityPackageRelativePath(entry.path);
  const prior=[...files.keys()].find(key=>key.toLocaleLowerCase('en-US')===normalized.toLocaleLowerCase('en-US'));
  if(prior) {
    const old=files.get(prior)!;
    if(prior!==normalized || !old.bytes.equals(entry.bytes) || Boolean(old.executable)!==Boolean(entry.executable)) conflict(`Package file conflict: ${normalized}. Choose compatible source content before composing.`);
    return;
  }
  files.set(normalized,{...entry,path:normalized});
}

function mergeNamed<T>(existing:readonly T[]|undefined,incoming:readonly T[],identity:(item:T)=>string,label:string):T[] {
  const result=[...(existing??[])];
  for(const item of incoming) {
    const name=identity(item), prior=result.find(value=>identity(value)===name);
    if(prior && canonical(prior)!==canonical(item)) conflict(`${label} conflict: ${name}. Existing declarations are never silently replaced.`);
    if(!prior) result.push(item);
  }
  return result;
}

function mergeCapabilities(existing:readonly WorkflowIntegrationCapability[]|undefined,incoming:readonly WorkflowIntegrationCapability[]):WorkflowIntegrationCapability[] {
  const result=[...(existing??[])];
  for(const capability of incoming) {
    const index=result.findIndex(item=>item.id===capability.id),prior=result[index];
    if(!prior){result.push(capability);continue;}
    const {skillRefs:oldRefs,...old}=prior,{skillRefs:newRefs,...next}=capability;
    if(canonical(old)!==canonical(next)) conflict(`Workflow capability conflict: ${capability.id}. Existing declarations are never silently replaced.`);
    result[index]={...prior,...(oldRefs===undefined||newRefs===undefined?{skillRefs:undefined}:{skillRefs:[...new Set([...oldRefs,...newRefs])].sort()})};
  }
  return result;
}

function derivedVersion(version:string):string {
  const match=/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/u.exec(version);
  return match ? `${match[1]}.${match[2]??'0'}.${Number(match[3]??0)+1}` : `${version}-derived.1`;
}

function setSkillVersion(document:Record<string,unknown>,version:string):void {
  for(const key of ['skill','package','metadata','interface']) {
    const value=object(document[key]); if(typeof value.version==='string') value.version=version;
  }
  if(typeof document.version==='string') document.version=version;
  document.metadata={...object(document.metadata),version};
}

function rewriteLocalLink(value:string,sourceRoot:string,targetRoot:string,available:Map<string,Entry>,mappings:ReadonlyMap<string,string>):string {
  if(!value || value.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/)/iu.test(value)) return value;
  const match=/^([^?#]*)([?#].*)?$/u.exec(value)!;
  const sourcePath=path.posix.normalize(path.posix.join(sourceRoot,match[1]));
  if(sourcePath==='..' || sourcePath.startsWith('../')) invalid('A skill asset reference escapes its authorized source package.');
  const mapped=mappedSourcePath(sourcePath,mappings);
  if(!available.has(mapped) && ![...available.keys()].some(file=>file.startsWith(`${mapped}/`))) conflict(`An asset or local link cannot be resolved inside the captured package: ${value}.`);
  return `${path.posix.relative(targetRoot,mapped)||'.'}${match[2]??''}`;
}

function transformSkill(source:CapturedSkill,targetRoot:string,files:Map<string,Entry>,names:Map<string,string>,mappings:ReadonlyMap<string,string>):{capabilities:WorkflowIntegrationCapability[];mcp:CanvasPluginMcpConnector[];legacyMcpConfigPath?:string;changes:string[]} {
  const changes:string[]=[], caps:WorkflowIntegrationCapability[]=[], mcp:CanvasPluginMcpConnector[]=[];
  const raw=files.get(`${targetRoot}/SKILL.md`)!;
  const match=/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(raw.bytes.toString('utf8'));
  if(!match) invalid('The copied skill frontmatter is invalid.');
  const frontmatter=parseYaml(Buffer.from(match[1]));
  if(source.capture.targetName!==source.skill.name) {frontmatter.name=source.capture.targetName;changes.push('Renamed the copied skill.');}
  const yamlPath=`${targetRoot}/agents/canvas.yaml`, yamlFile=files.get(yamlPath);
  const document=yamlFile?parseYaml(yamlFile.bytes):{};
  const workflow=object(document.workflow);
  const ownConnectors=Array.isArray(workflow.mcpConnectors)?workflow.mcpConnectors as CanvasPluginMcpConnector[]:[];
  for(const connector of ownConnectors) {
    const copied={...connector};
    if(connector.configPath) {
      const local=localRoot(connector.configPath), from=`${targetRoot}/${local}`, target=`connectors/${source.capture.targetName}/${local}`;
      const config=files.get(from); if(!config) invalid('A standalone MCP connector config is missing.');
      assertMcpConfig(config.bytes,connector.name);
      addEntry(files,{...config,path:target}); copied.configPath=`./${target}`;
    }
    mcp.push(copied);
  }
  if(Object.hasOwn(workflow,'mcpConnectors')) {delete workflow.mcpConnectors;changes.push('Moved standalone MCP connector declarations to the parent plugin.');}
  if(Array.isArray(workflow.integrationCapabilities)) {
    for(const value of workflow.integrationCapabilities) {
      const capability=object(value);
      if(Array.isArray(capability.skillRefs)) {
        const previous=capability.skillRefs;
        capability.skillRefs=previous.map(name=>{if(typeof name!=='string' || !names.has(name)) conflict('A child workflow refers to a skill outside this composition batch.');return names.get(name)!;});
        if(canonical(previous)!==canonical(capability.skillRefs)) changes.push('Remapped copied workflow skill references.');
      }
    }
  }
  const iface=object(document.interface);
  for(const key of ['icon_small','iconSmall','icon_large','iconLarge']) if(typeof iface[key]==='string') {
    const prior=iface[key] as string, next=rewriteLocalLink(prior,source.sourceRoot,targetRoot,files,mappings);
    if(prior!==next) {iface[key]=next;changes.push('Adjusted a copied skill image reference.');}
  }
  // Markdown links are structured references; arbitrary script strings are deliberately not rewritten.
  let fence:string|null=null;
  const body=match[2].split(/(?<=\n)/u).map(line=>{
    const marker=/^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if(marker){if(fence===null)fence=marker;else if(marker[0]===fence[0]&&marker.length>=fence.length)fence=null;return line;}
    if(fence)return line;
    return line.split(/(`+[^`]*`+)/gu).map((span,index)=>index%2?span:span.replace(/(!?\[[^\]]*\]\()([^\s)]+)(\))/gu,(_full,start:string,link:string,end:string)=>{
      const next=rewriteLocalLink(link,source.sourceRoot,targetRoot,files,mappings);
      if(next!==link) changes.push('Adjusted a package-local Markdown link.'); return `${start}${next}${end}`;
    })).join('');
  }).join('');
  if(source.parentInventory && source.sourceRoot!==targetRoot
    && source.inventory.files.some(file=>/\.(?:[cm]?[jt]s|py|sh|bash)$/u.test(file.path))) {
    conflict('This layout change could alter relative script paths. Preserve the original layout or adapt the source explicitly.');
  }
  const desired=source.selection.targetVersion ?? (changes.length?derivedVersion(source.capture.version):source.capture.version);
  if(!isValidCanvasPluginVersion(desired) || changes.length && desired===source.capture.version) invalid('A transformed skill needs a distinct valid targetVersion.');
  source.capture.targetVersion=desired; source.capture.changes=changes;
  if(changes.length || desired!==source.capture.version) {
    frontmatter.metadata={...object(frontmatter.metadata),version:desired};setSkillVersion(document,desired);
    files.set(raw.path,{...raw,bytes:Buffer.from(`---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n${body}`)});
    if(yamlFile || ownConnectors.length) files.set(yamlPath,{path:yamlPath,bytes:Buffer.from(YAML.stringify(document))});
  }
  const ownCaps=source.skill.workflow?.integrationCapabilities??[];
  const parentCaps=source.parentManifest?.workflow?.integrationCapabilities??[];
  for(const capability of parentCaps) {
    const relevant=capability.skillRefs===undefined || capability.skillRefs.includes(source.skill.name);
    if(relevant) caps.push({...capability,skillRefs:[source.capture.targetName]});
  }
  const usedMcp=new Set([...ownCaps,...caps].flatMap(cap=>cap.alternatives.filter(alt=>alt.source==='mcp').map(alt=>alt.connector)));
  const parentConnectors=source.parentManifest?.connectors?.mcp??[];
  mcp.push(...parentConnectors.filter(connector=>usedMcp.has(connector.name) || !ownCaps.length && !caps.length).map(connector=>{
    if(!connector.configPath) return connector;
    const original=localRoot(connector.configPath),mapped=mappedSourcePath(original,mappings);
    return {...connector,configPath:`./${mapped}`};
  }));
  // Preserve the existing coarse legacy recommendation. Its synthetic display name
  // "mcp" is not a server identity inside the template, so do not guess one here.
  const legacy=source.parentManifest?.connectors?.mcpServers;
  const legacyMcpConfigPath=legacy?`./${mappedSourcePath(localRoot(legacy),mappings)}`:undefined;
  return {capabilities:caps,mcp,...(legacyMcpConfigPath?{legacyMcpConfigPath}:{}),changes};
}

/** Resolve only identities present in the captured portable template; never guess a server from a display name. */
function canonicalLegacyMcpConnectors(files:Map<string,Entry>,configPath:string):CanvasPluginMcpConnector[] {
  const file=files.get(localRoot(configPath));if(!file)invalid('The legacy MCP template is missing.');
  assertMcpConfig(file.bytes);
  const config=object(JSON.parse(file.bytes.toString('utf8')));
  const names=Object.hasOwn(config,'mcpServers')?Object.keys(object(config.mcpServers)):['mcp'];
  return names.map(name=>({name,configPath,recommended:true}));
}

/** Existing runtime normalizers prefer a modern declaration for the same toolkit over its legacy recommendation. */
function canonicalComposioConnectors(connectors:CanvasPluginConnectorManifest|undefined) {
  const result=[...connectors?.composio??[]];
  for(const toolkit of connectors?.composioToolkits??[]) {
    if(!result.some(connector=>connector.toolkit===toolkit))result.push({toolkit,recommended:true});
  }
  return result;
}

export async function composeCapabilityPackageSkillsAction(actor:CapabilityResourceActor,reference:string,value:unknown) {
  const draftRef=capabilityPackageDraftReferenceSchema.parse(reference), input=capabilityPackageSkillCompositionSchema.parse(structuredClone(value));
  const budget:CaptureBudget={bytes:0,files:0,cache:new Map()};
  const explicitNames=input.skills.flatMap(item=>item.targetName?[item.targetName.toLocaleLowerCase('en-US')]:[]);
  if(new Set(explicitNames).size!==explicitNames.length) conflict('The composition repeats a target skill name.');
  const prepared:CapturedSkill[]=[];
  for(const selection of input.skills) prepared.push(await captureSkill(actor,selection,budget));
  const record=await getCapabilityPackageDraftRecord(actor,draftRef);
  if(record.draft.kind!=='plugin') invalid('Only a plugin draft can bundle skills.');
  const result=await mutateCapabilityPackageDraft(actor,draftRef,input.expectedDraftRevision,async (draft,database)=>{
    const location=draftLocation({...record,draft}), current=await readExactPackageInventory(location.rootPath,{maxFiles:CAPABILITY_PACKAGE_LIMITS.maxFiles-budget.files,maxTotalBytes:CAPABILITY_PACKAGE_LIMITS.maxTotalBytes-budget.bytes});
    const files=new Map<string,Entry>(current.files.map(file=>[file.path,{path:file.path,bytes:file.bytes,executable:file.executable}]));
    assertPortableFiles(files);
    const rawManifest=files.get('.canvas-plugin/plugin.json');
    const declared=Boolean(rawManifest);
    const parsed=declared?await validateCanvasPluginPackage(location.rootPath):null;
    const manifest:CanvasPluginManifest=parsed?.manifest??{name:draft.name,version:'1.0.0',description:`Workflows provided by ${draft.name}.`,skills:'./skills'};
    if(declared && !parsed?.manifest) invalid('Repair the target plugin manifest before composing.');
    const originalDeclaration=rawManifest?object(JSON.parse(rawManifest.bytes.toString('utf8'))):{};
    // The compatibility normalizer deliberately omits newer metadata; composition must not drop a declared contract version.
    const contractVersion=Object.hasOwn(originalDeclaration,'schemaVersion')?{schemaVersion:originalDeclaration.schemaVersion}:{};
    assertPortable(manifest);
    if(manifest.connectors) {
      const connectors=manifest.connectors;
      if(connectors.mcpServers)connectors.mcp=mergeNamed(connectors.mcp,canonicalLegacyMcpConnectors(files,connectors.mcpServers),item=>item.name,'MCP connector');
      connectors.composio=canonicalComposioConnectors(connectors);
      delete connectors.mcpServers;delete connectors.composioToolkits;
    }
    const skillsRoot=localRoot(manifest.skills??'skills');
    if(!skillsRoot) invalid('Composition requires a dedicated plugin skills directory.');
    const occupied=new Set(current.files.filter(file=>file.path.endsWith('/SKILL.md')).map(file=>path.posix.dirname(file.path)));
    const mappingsFor=(source:CapturedSkill)=>new Map(prepared.filter(item=>originKey(item)===originKey(source)).map(item=>[item.sourceRoot,`${skillsRoot}/${item.capture.targetName}`]));
    for(const source of prepared) {
      const targetRoot=`${skillsRoot}/${source.capture.targetName}`;
      if([...occupied].some(root=>root.toLowerCase()===targetRoot.toLowerCase())) conflict(`A bundled skill already occupies ${targetRoot}.`);
      occupied.add(targetRoot);source.capture.targetRelativeRoot=targetRoot;
      for(const file of source.inventory.files) addEntry(files,{path:`${targetRoot}/${file.path}`,bytes:file.bytes,executable:file.executable});
      if(source.parentInventory && source.sourceRoot) {
        const foreignRoots=source.parentInventory.files.filter(file=>file.path==='SKILL.md'||file.path.endsWith('/SKILL.md')).map(file=>path.posix.dirname(file.path)).filter(root=>root!==source.sourceRoot);
        for(const file of source.parentInventory.files) {
          if(file.path==='.canvas-plugin/plugin.json'||[...mappingsFor(source).keys()].some(root=>below(file.path,root))) continue;
          // Preserve helper/assets topology, including shared folders below the skills root.
          // Unselected child instructions and workflow declarations do not become new skills.
          if(foreignRoots.some(root=>file.path===`${root}/SKILL.md`||file.path===`${root}/agents/canvas.yaml`)) continue;
          addEntry(files,{path:file.path,bytes:file.bytes,executable:file.executable});
        }
        const parent=source.parentManifest!;
        if(parent.license||parent.author||parent.source) addEntry(files,{path:`licenses/${source.capture.targetName}/source-plugin.json`,bytes:Buffer.from(`${JSON.stringify({
          name:parent.name,version:parent.version,...(parent.license?{license:parent.license}:{}),...(parent.author?{author:parent.author}:{}),...(parent.source?{source:parent.source}:{})},null,2)}\n`)});
      }
    }
    for(const source of prepared) {
      const origin=prepared.filter(item=>originKey(item)===originKey(source)),names=new Map<string,string>();
      for(const item of origin){if(names.has(item.skill.name)&&names.get(item.skill.name)!==item.capture.targetName) conflict('One source skill has multiple target names; workflow references require an unambiguous selection.');names.set(item.skill.name,item.capture.targetName);}
      const transformed=transformSkill(source,source.capture.targetRelativeRoot,files,names,mappingsFor(source));
      const connectors=manifest.connectors??={};
      connectors.mcp=mergeNamed(connectors.mcp,transformed.mcp,item=>item.name,'MCP connector');
      if(transformed.legacyMcpConfigPath)connectors.mcp=mergeNamed(connectors.mcp,
        canonicalLegacyMcpConnectors(files,transformed.legacyMcpConfigPath),item=>item.name,'MCP connector');
      const allCaps=[...(source.skill.workflow?.integrationCapabilities??[]),...transformed.capabilities];
      const usedComposio=new Set(allCaps.flatMap(cap=>cap.alternatives.filter(alt=>alt.source==='composio').map(alt=>alt.toolkit)));
      connectors.composio=mergeNamed(connectors.composio,canonicalComposioConnectors(source.parentManifest?.connectors).filter(item=>usedComposio.has(item.toolkit)||!allCaps.length),item=>item.toolkit,'Composio connector');
      connectors.email=mergeNamed(connectors.email,source.parentManifest?.connectors?.email??[],item=>item.kind??'mailbox','Email connector');
      if(transformed.capabilities.length) manifest.workflow={version:1,integrationCapabilities:mergeCapabilities(manifest.workflow?.integrationCapabilities,transformed.capabilities)};
    }
    files.set('.canvas-plugin/plugin.json',{path:'.canvas-plugin/plugin.json',bytes:Buffer.from(`${JSON.stringify({...contractVersion,...manifest},null,2)}\n`)});
    assertPortableFiles(files,manifest.connectors?.mcp,manifest.connectors?.mcpServers);
    await writeCapabilityPackageDraftBatch(location,[...files.values()],async root=>{await validateCompleteCapabilityPackage('plugin',root,{name:draft.name});},current.directories);
    await recordCapabilityPackageSourceCaptures(actor,draft,prepared.map(item=>item.capture),database);
  },{sourceCaptures:prepared.map(item=>item.capture)});
  return {draft:result.draft,composition:{skills:prepared.map(item=>({name:item.capture.targetName,version:item.capture.targetVersion,relativeRoot:item.capture.targetRelativeRoot,
    sourceResourceRef:item.capture.resourceRef,sourceRevisionRef:item.capture.revisionRef,selectedChildChecksum:item.capture.selectedChildChecksum,
    ...(item.capture.parentChecksum?{parentChecksum:item.capture.parentChecksum}:{}),changes:item.capture.changes}))}};
}

async function workspaceDraft(actor:CapabilityResourceActor,value:unknown) {
  const input=capabilityPackageWorkspaceDraftQuerySchema.parse(structuredClone(value));
  if(!actor.workspaceId) throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED','An active source workspace is required.',403);
  if(!(input.kind==='skill'?isValidAgentSkillName(input.packageName):isValidCanvasPluginName(input.packageName))) invalid('Choose a valid existing workspace package name.');
  const database=await openDb();
  try {
    await database.run('BEGIN');
    const workspace=await readableImportWorkspace(actor,actor.workspaceId,database);
    let root=workspace.rootPath;
    for(const part of [`.canvas-${input.kind}-drafts`,input.workspaceDraftId,input.packageName]) {
      root=path.join(root,part);const stat=await fs.lstat(root).catch(error=>{
        if((error as NodeJS.ErrnoException).code==='ENOENT') throw new CapabilityPackageError('PACKAGE_NOT_FOUND','The managed workspace draft was not found.',404);
        throw error;
      });
      if(!stat.isDirectory()||stat.isSymbolicLink()) invalid('The managed workspace draft must contain only real directories.');
    }
    const inventory=await readExactPackageInventory(root);
    const files=new Map<string,Entry>(inventory.files.map(file=>[file.path,{path:file.path,bytes:file.bytes,executable:file.executable}]));
    assertPortableFiles(files);
    const validated=await withCapturedCapabilityPackageInventory(inventory,async capturedRoot=>{
      const result=await validateCompleteCapabilityPackage(input.kind,capturedRoot,{name:input.packageName});
      const connectors=input.kind==='plugin'?result.manifest?.connectors?.mcp:result.skill?.workflow?.mcpConnectors;
      assertPortableFiles(files,connectors?.map(connector=>({...connector,env:connector.env?[...connector.env]:undefined})),result.manifest?.connectors?.mcpServers);
      return result;
    });
    if(validated.checksum!==inventory.checksum) changed();
    await database.run('COMMIT');
    return {input,inventory,validated,workspaceId:workspace.workspaceId};
  } catch(error) {await database.run('ROLLBACK');throw error;} finally {await database.close();}
}

export async function inspectCapabilityPackageWorkspaceDraftAction(actor:CapabilityResourceActor,value:unknown) {
  const source=await workspaceDraft(actor,value);
  return {source:{kind:source.input.kind,name:source.validated.name,version:source.validated.version,checksum:source.inventory.checksum,
    fileCount:source.inventory.files.length,totalBytes:source.inventory.totalBytes}};
}

export async function importCapabilityPackageWorkspaceDraftAction(actor:CapabilityResourceActor,reference:string,value:unknown) {
  const draftRef=capabilityPackageDraftReferenceSchema.parse(reference),input=capabilityPackageWorkspaceDraftImportSchema.parse(structuredClone(value));
  const source=await workspaceDraft(actor,input.source);
  if(source.inventory.checksum!==input.expectedChecksum) changed();
  const record=await getCapabilityPackageDraftRecord(actor,draftRef);
  if(record.draft.kind!==source.input.kind) invalid('The source and target package kinds must match.');
  const capture:CapabilityPackageSourceCapture={source:'workspace',workspaceId:source.workspaceId,kind:source.input.kind,workspaceDraftId:source.input.workspaceDraftId,
    packageName:source.input.packageName,checksum:source.inventory.checksum,version:source.validated.version,targetName:record.draft.name,
    targetVersion:source.validated.version,targetRelativeRoot:'',changes:[]};
  const result=await mutateCapabilityPackageDraft(actor,draftRef,input.expectedDraftRevision,async(draft,database)=>{
    const location=draftLocation({...record,draft}),current=await readExactPackageInventory(location.rootPath);
    if(current.files.length) conflict('Import requires an empty target draft so existing work cannot be overwritten.');
    const files:Entry[]=source.inventory.files.map(file=>({path:file.path,bytes:file.bytes,executable:file.executable}));
    if(source.validated.name!==draft.name) {
      const version=derivedVersion(source.validated.version);capture.targetVersion=version;
      if(draft.kind==='plugin') { const manifest=files.find(file=>file.path==='.canvas-plugin/plugin.json')!;
        manifest.bytes=Buffer.from(`${JSON.stringify({...JSON.parse(manifest.bytes.toString('utf8')),name:draft.name,version},null,2)}\n`);
      } else {const skill=files.find(file=>file.path==='SKILL.md')!;const match=/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(skill.bytes.toString('utf8'));
        if(!match) invalid('The imported skill frontmatter is invalid.');
        const frontmatter=parseYaml(Buffer.from(match[1]));
        frontmatter.name=draft.name;frontmatter.metadata={...object(frontmatter.metadata),version};
        skill.bytes=Buffer.from(`---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n${match[2]}`);
        const canvas=files.find(file=>file.path==='agents/canvas.yaml');
        if(canvas){const document=parseYaml(canvas.bytes);setSkillVersion(document,version);
          const workflow=object(document.workflow);
          if(Array.isArray(workflow.integrationCapabilities)) for(const value of workflow.integrationCapabilities) {
            const capability=object(value);if(Array.isArray(capability.skillRefs)) capability.skillRefs=capability.skillRefs.map(name=>name===source.validated.name?draft.name:name);
          }
          canvas.bytes=Buffer.from(YAML.stringify(document));}
      }
      capture.changes.push('Renamed the imported package for its separately managed target.');
    }
    await writeCapabilityPackageDraftBatch(location,files,async root=>{await validateCompleteCapabilityPackage(draft.kind,root,{name:draft.name});},source.inventory.directories);
    await recordCapabilityPackageSourceCaptures(actor,draft,[capture],database);
  },{sourceCaptures:[capture]});
  return {draft:result.draft,imported:{kind:source.input.kind,name:capture.targetName,version:capture.targetVersion,sourceName:source.validated.name,
    sourceVersion:source.validated.version,checksum:source.inventory.checksum,changes:capture.changes}};
}
