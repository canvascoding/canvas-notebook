import 'server-only';

import path from 'node:path';
import YAML from 'yaml';
import type { CanvasPluginMcpConnector } from '@/app/lib/plugins/canvas-plugin-manifest';
import { CapabilityPackageError, isCapabilityPackageError } from './contracts';
import { normalizeCapabilityPackageRelativePath } from './io';
import { projectCapabilityPackageMcpTemplateConfig } from './mcp-template-projection';

export type PortablePackageEntry = {path:string;bytes:Buffer;executable?:boolean};
export class PortablePackageDeclarationError extends CapabilityPackageError {
  constructor(readonly file: string, readonly field: string, message: string) { super('PACKAGE_INVALID', message); }
}
function inFile(file: string, field: string, validate: () => void): void {
  try { validate(); }
  catch (error) {
    if (!isCapabilityPackageError(error) || error.code !== 'PACKAGE_INVALID') throw error;
    throw new PortablePackageDeclarationError(file, field, error.message);
  }
}
function invalid(message:string):never { throw new CapabilityPackageError('PACKAGE_INVALID',message,400); }
const object = (value:unknown):Record<string,unknown> => value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
const canonical = (value:unknown):string => JSON.stringify(value,(_key,item:unknown) => {
  if(item && typeof item==='object' && !Array.isArray(item)) return Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b)));
  return item;
});
const localRoot = (value:string):string => { const normalized=path.posix.normalize(value); return normalized==='.'?'':normalizeCapabilityPackageRelativePath(normalized.replace(/^\.\//u,'')); };

export function assertPortable(value:unknown):void {
  const pending=[{value,depth:0}],seen=new Set<object>();let nodes=0,bytes=0;
  while(pending.length) {
    const item=pending.pop()!;
    if(++nodes>10_000 || item.depth>24 || bytes>1024*1024) invalid('A package declaration exceeds its bounded portable structure.');
    if(typeof item.value==='string') {bytes+=Buffer.byteLength(item.value);continue;}
    // Normalized internal manifests include absent optional properties as undefined.
    // JSON inputs cannot carry undefined; MCP byte validation remains an exact comparison.
    if(item.value===undefined || item.value===null || typeof item.value==='boolean' || typeof item.value==='number'&&Number.isFinite(item.value)) continue;
    if(!item.value || typeof item.value!=='object') invalid('Package declarations require portable JSON values.');
    if(!Array.isArray(item.value)&&![Object.prototype,null].includes(Object.getPrototypeOf(item.value))) invalid('Package declarations require portable JSON objects.');
    if(seen.has(item.value)) invalid('Package declarations must not contain cyclic or aliased structures.');
    seen.add(item.value);
    for(const [key,child] of Object.entries(item.value)) {
      if(pending.length+nodes>=10_000) invalid('A package declaration exceeds its bounded portable structure.');
      bytes+=Buffer.byteLength(key);
      if(/^(?:accountSelectionRef|connectedAccountId|accountId|profileId|connectionId|connectionRef|providerRef|serverDefinitionId|ownerUserId|clientSecret|accessToken|refreshToken)$/iu.test(key)) {
        invalid('Package declarations must not contain private account, connection or credential identities.');
      }
      pending.push({value:child,depth:item.depth+1});
    }
  }
  if(bytes>1024*1024) invalid('A package declaration exceeds its bounded portable structure.');
}

export function parseYaml(bytes:Buffer):Record<string,unknown> {
  if(bytes.length>1024*1024) invalid('A package declaration exceeds its size limit.');
  try {const result=object(YAML.parse(bytes.toString('utf8'),{maxAliasCount:0}));assertPortable(result);return result;}
  catch(error) {if(error instanceof CapabilityPackageError) throw error;invalid('The package YAML declaration is invalid or contains aliases.');}
}

export function assertMcpConfig(bytes:Buffer,connector?:string):void {
  let value:unknown;try{value=JSON.parse(bytes.toString('utf8'));}catch{invalid('An MCP template must be valid JSON.');}
  assertPortable(value);const raw=object(value);
  if(Object.hasOwn(raw,'mcpServers')&&(Object.keys(raw).length!==1 || !raw.mcpServers || typeof raw.mcpServers!=='object'||Array.isArray(raw.mcpServers))) {
    invalid('An MCP server wrapper may contain only its portable mcpServers declarations.');
  }
  const servers=Object.hasOwn(raw,'mcpServers')?Object.entries(object(raw.mcpServers)):[[connector??'template',raw] as const];
  if(!servers.length || connector && Object.hasOwn(raw,'mcpServers') && !Object.hasOwn(object(raw.mcpServers),connector)) invalid('An MCP template does not contain its declared connector.');
  for(const [name,server] of servers) {
    const candidate=object(server),projected=projectCapabilityPackageMcpTemplateConfig(candidate,name);
    if(!Object.keys(candidate).length || projected.redactedFields.length || canonical(candidate)!==canonical(projected.config)) {
      invalid('Every copied MCP configuration must contain only portable supported fields and placeholders.');
    }
  }
}

export function assertPortableFiles(files:ReadonlyMap<string,PortablePackageEntry>,connectors:readonly CanvasPluginMcpConnector[]=[],legacyConfigPath?:string):void {
  for(const file of files.values()) {
    inFile(file.path, '$', () => {
    if(file.path.endsWith('.json')) {
      let document:unknown;try{document=JSON.parse(file.bytes.toString('utf8'));}catch{return;}
      assertPortable(document);if(Object.hasOwn(object(document),'mcpServers')) assertMcpConfig(file.bytes);
    } else if(/\.ya?ml$/u.test(file.path)) parseYaml(file.bytes);
    else if(file.path==='SKILL.md'||file.path.endsWith('/SKILL.md')) {
      const match=/^---\r?\n([\s\S]*?)\r?\n---/u.exec(file.bytes.toString('utf8'));if(match) parseYaml(Buffer.from(match[1]));
    }
    });
  }
  for(const connector of connectors) if(connector.configPath) {
    const relative = localRoot(connector.configPath), file=files.get(relative);
    inFile(relative, 'mcpServers', () => {if(!file) invalid('A copied MCP connector config is missing.');assertMcpConfig(file.bytes,connector.name);});
  }
  if(legacyConfigPath){const relative=localRoot(legacyConfigPath),file=files.get(relative);inFile(relative,'mcpServers',()=>{if(!file)invalid('A copied legacy MCP config is missing.');assertMcpConfig(file.bytes);});}
}
