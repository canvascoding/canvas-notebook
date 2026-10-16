import 'server-only';

import path from 'node:path';
import { extensionPackagePinSchema, type ExtensionPackagePin } from '@/app/lib/capabilities/extensions/contracts';
import type { CapabilityResourceActor } from '@/app/lib/capabilities/resources/contracts';
import { normalizeCapabilityPackageRelativePath } from '@/app/lib/capabilities/packages/io';
import { readFirstDeclaredCapabilityPackageImage, type CapabilityPackageDeclaredIcon } from '@/app/lib/capabilities/packages/package-icon-image';
import { readAgentExtensionPackageVersion } from './extension-package-options';
import { AgentWorkflowError } from './workflow-contracts';

/** Exact published-image read only. A child root is a selector into the held inventory, never a client path. */
export async function readAgentExtensionPackageIcon(actorInput: CapabilityResourceActor, pinInput: ExtensionPackagePin,
  options: { childRelativeRoot?: string } = {}): Promise<CapabilityPackageDeclaredIcon | null> {
  const actor = { userId: actorInput.userId, workspaceId: actorInput.workspaceId ?? null };
  const pin = extensionPackagePinSchema.parse(structuredClone(pinInput));
  if (Object.keys(options).some(key => key !== 'childRelativeRoot')
    || options.childRelativeRoot !== undefined && (typeof options.childRelativeRoot !== 'string'
      || options.childRelativeRoot.length > 1024 || /[\p{Cc}\p{Cf}]/u.test(options.childRelativeRoot))) {
    throw new AgentWorkflowError('AGENT_EXTENSION_OPTIONS_INVALID', 'Choose an exact declared skill image.', 400);
  }
  const childRelativeRoot = options.childRelativeRoot;
  if (childRelativeRoot) normalizeCapabilityPackageRelativePath(childRelativeRoot);
  const held = await readAgentExtensionPackageVersion(actor, pin, { allowPersonalPackages: true });
  let root = held.source.rootPath, declarations: readonly unknown[];
  if (childRelativeRoot !== undefined || held.metadata.kind === 'skill') {
    const selectedRoot = childRelativeRoot ?? '';
    const children = held.source.skills.filter(child => child.relativeRoot === selectedRoot);
    if (children.length !== 1 || !held.metadata.skillRoots.some(child => child.relativeRoot === selectedRoot)) {
      throw new AgentWorkflowError('AGENT_EXTENSION_OPTIONS_INVALID', 'Choose an exact declared skill image.', 400);
    }
    const child = children[0];
    if (path.resolve(child.skill.directory) !== path.resolve(held.source.rootPath, ...selectedRoot.split('/').filter(Boolean))) {
      throw new AgentWorkflowError('AGENT_WORKFLOW_PACKAGE_CHANGED', 'The selected skill source changed.', 409);
    }
    root = child.skill.directory;
    declarations = [child.skill.interface?.iconSmall, child.skill.interface?.iconLarge];
  } else {
    declarations = [held.source.manifest?.interface?.logo, held.source.manifest?.interface?.icon];
  }
  const image = await readFirstDeclaredCapabilityPackageImage(root, declarations);
  const current = await readAgentExtensionPackageVersion(actor, pin, { allowPersonalPackages: true });
  if (current.metadata.checksum !== held.metadata.checksum || current.source.rootPath !== held.source.rootPath
    || childRelativeRoot !== undefined && !current.metadata.skillRoots.some(child => child.relativeRoot === childRelativeRoot)) {
    throw new AgentWorkflowError('AGENT_WORKFLOW_PACKAGE_CHANGED', 'The selected package image changed.', 409);
  }
  return image;
}
