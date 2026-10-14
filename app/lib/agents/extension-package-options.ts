import 'server-only';

import path from 'node:path';
import { z } from 'zod';
import { inspectCapabilityResource } from '@/app/lib/capabilities/resources/actions';
import { findCapabilityResourceRecord, withAuthorizedCapabilityPackageResource } from '@/app/lib/capabilities/resources/store';
import type { CapabilityResourceActor, CapabilityResourceDescriptor } from '@/app/lib/capabilities/resources/contracts';
import { withPublishedPackage } from '@/app/lib/capabilities/packages/actions';
import { validateCompleteCapabilityPackage } from '@/app/lib/capabilities/packages/artifacts';
import { getCapabilityPackagePublishedRevision } from '@/app/lib/capabilities/packages/store';
import { normalizeCapabilityPackageRelativePath, verifyCapabilityPackageSnapshot } from '@/app/lib/capabilities/packages/io';
import type { WorkflowDeclaration } from '@/app/lib/capabilities/workflow-contracts';
import type { CanvasPluginManifest } from '@/app/lib/plugins/canvas-plugin-manifest';
import { parsePluginSkillsFromManifest } from '@/app/lib/plugins/canvas-plugin-registry';
import type { CanvasSkill } from '@/app/lib/skills/canvas-skill-manifest';
import { AgentWorkflowError } from './workflow-contracts';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const requestSchema = z.object({
  resourceRef: z.string().regex(new RegExp(`^canvas-resource:${uuid}$`, 'u')),
  publishedRevisionRef: z.string().regex(new RegExp(`^canvas-package-revision:${uuid}$`, 'u')),
  checksum: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict();

export type AgentExtensionPackageVersionRequest = z.infer<typeof requestSchema>;
export type AgentExtensionPackageSkillOption = { name: string; title: string; description: string; relativeRoot: string };
export type AgentExtensionPackageVersionMetadata = {
  resourceRef: string; publishedRevisionRef: string; checksum: string; kind: 'plugin' | 'skill';
  name: string; version: string; title: string; description: string; defaultPrompts: string[];
  skillRoots: AgentExtensionPackageSkillOption[]; declarations: WorkflowDeclaration[];
};

/** Private source material for a server-side configuration preview, never runtime authority. */
export type AgentExtensionPackageVersionSource = {
  metadata: AgentExtensionPackageVersionMetadata;
  source: { rootPath: string; manifest?: CanvasPluginManifest; skills: Array<{ skill: CanvasSkill; relativeRoot: string }> };
};

function fail(code: string, message: string, status = 409): never { throw new AgentWorkflowError(code, message, status); }

async function usableDescriptor(actor: CapabilityResourceActor, reference: string,
  allowPersonalPackages: boolean): Promise<CapabilityResourceDescriptor> {
  const resource = await inspectCapabilityResource(actor, reference);
  if (resource.metadata.status !== 'active' || !resource.access.canRead || !resource.access.canUse
    || resource.artifact.sourceType === 'plugin' || resource.activation?.effectivePolicy === 'blocked'
    || resource.activation?.readiness === 'conflict' || !allowPersonalPackages && resource.artifact.scopeType === 'user') {
    fail('AGENT_WORKFLOW_PACKAGE_DENIED', 'The selected package is unavailable for this agent.', 403);
  }
  return resource;
}

async function verifiedPin(actor: CapabilityResourceActor, request: AgentExtensionPackageVersionRequest,
  allowPersonalPackages: boolean) {
  await usableDescriptor(actor, request.resourceRef, allowPersonalPackages);
  const record = await findCapabilityResourceRecord(request.resourceRef);
  if (!record) fail('AGENT_WORKFLOW_PACKAGE_UNAVAILABLE', 'The selected published package version is unavailable.');
  const selected = await withAuthorizedCapabilityPackageResource(actor, record.storage, 'use', undefined,
    async (authorization, database) => getCapabilityPackagePublishedRevision(authorization.record.metadata.resourceRef,
      request.publishedRevisionRef, database));
  if (!selected || request.checksum !== undefined && selected.checksum !== request.checksum) {
    fail('AGENT_WORKFLOW_PACKAGE_CHANGED', 'The selected published package version is unavailable.');
  }
  return selected;
}

/**
 * Reads an exact immutable package for either a prospective or an existing
 * Agent. No Agent/session is invented, and returned paths confer no execution
 * permission. Save/runtime must obtain their own fresh authoritative proofs.
 */
export async function readAgentExtensionPackageVersion(actorInput: CapabilityResourceActor,
  requestInput: AgentExtensionPackageVersionRequest,
  options: { allowPersonalPackages: boolean }): Promise<AgentExtensionPackageVersionSource> {
  const actor = structuredClone(actorInput), parsed = requestSchema.safeParse(structuredClone(requestInput));
  if (!parsed.success || typeof options?.allowPersonalPackages !== 'boolean') {
    fail('AGENT_WORKFLOW_PACKAGE_INVALID', 'Choose an exact published package version.', 400);
  }
  const request = parsed.data, allowPersonalPackages = options.allowPersonalPackages;
  const pin = await verifiedPin(actor, request, allowPersonalPackages);
  const result = await withPublishedPackage(actor, request.resourceRef, request.publishedRevisionRef, async (location, authorization) => {
    if (!authorization.access.canUse || !('revisionRef' in location) || location.revisionRef !== request.publishedRevisionRef
      || location.checksum !== pin.checksum || !allowPersonalPackages && authorization.record.storage.scopeType === 'user') {
      fail('AGENT_WORKFLOW_PACKAGE_DENIED', 'The selected package version is unavailable for this agent.', 403);
    }
    const validated = await validateCompleteCapabilityPackage(location.kind, location.rootPath, { name: location.name, version: location.version });
    if (validated.checksum !== location.checksum) fail('AGENT_WORKFLOW_PACKAGE_CHANGED', 'The selected published package version changed.');
    const parsedSkills = validated.manifest
      ? await parsePluginSkillsFromManifest(validated.manifest, location.rootPath, path.join(location.rootPath, validated.manifest.skills || 'skills'))
      : { skills: validated.skill ? [validated.skill] : [], errors: [] };
    if (parsedSkills.errors.length || !parsedSkills.skills.length) fail('AGENT_WORKFLOW_PACKAGE_INVALID', 'The published skill inventory is invalid.');
    const skills = parsedSkills.skills.map(skill => {
      const relativeRoot = path.relative(location.rootPath, skill.directory).split(path.sep).join('/');
      if (relativeRoot) normalizeCapabilityPackageRelativePath(relativeRoot);
      if (path.resolve(skill.directory) !== path.resolve(location.rootPath, ...relativeRoot.split('/').filter(Boolean))) {
        fail('AGENT_WORKFLOW_PACKAGE_INVALID', 'A published skill escapes its package.');
      }
      return { skill, relativeRoot };
    });
    const metadata: AgentExtensionPackageVersionMetadata = {
      resourceRef: request.resourceRef, publishedRevisionRef: location.revisionRef, checksum: validated.checksum,
      kind: location.kind, name: validated.name, version: validated.version,
      title: validated.manifest?.interface?.displayName || validated.skill?.title || validated.name,
      description: validated.manifest?.interface?.shortDescription || validated.description,
      defaultPrompts: validated.manifest ? [...(validated.manifest.interface?.defaultPrompt ?? [])]
        : validated.skill?.interface?.defaultPrompt ? [validated.skill.interface.defaultPrompt] : [],
      skillRoots: skills.map(({ skill, relativeRoot }) => ({ name: skill.name, title: skill.title, description: skill.description, relativeRoot })),
      declarations: structuredClone(validated.workflowDeclarations ?? []),
    };
    await verifyCapabilityPackageSnapshot(location);
    return { metadata, source: { rootPath: location.rootPath, ...(validated.manifest ? { manifest: validated.manifest } : {}), skills } };
  });
  await verifiedPin(actor, { ...request, checksum: result.metadata.checksum }, allowPersonalPackages);
  // Recheck activation after the final SQL Use check as well; this is metadata,
  // not a retained or reusable runtime authorization receipt.
  await usableDescriptor(actor, request.resourceRef, allowPersonalPackages);
  return result;
}
