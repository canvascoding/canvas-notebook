import 'server-only';

import type { Stats } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  CapabilityCandidate,
  CapabilityScopeType,
  CapabilitySourceType,
} from '@/app/lib/capabilities/types';
import { buildSkillTree, type SkillFileNode } from './skill-tree';

export type CapabilitySkillTreeNode = Omit<SkillFileNode, 'children'> & {
  resourceId: string;
  skillName: string;
  scopeType: CapabilityScopeType;
  sourceType: CapabilitySourceType;
  relativePath: string;
  children?: CapabilitySkillTreeNode[];
};

export class CapabilitySkillFileError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message);
    this.name = 'CapabilitySkillFileError';
  }
}

export function findCapabilitySkillCandidate(
  candidates: CapabilityCandidate[],
  reference: { resourceId: string; name?: string },
): CapabilityCandidate | null {
  return candidates.find((candidate) => (
    candidate.ref.resourceType === 'skill'
    && candidate.ref.resourceId === reference.resourceId
    && (!reference.name || candidate.ref.name === reference.name)
    && Boolean(candidate.runtimePath)
  )) || null;
}

export function selectBrowsableSkillCandidates(
  candidates: CapabilityCandidate[],
  managementScope: 'user' | 'organization',
): CapabilityCandidate[] {
  return candidates.filter((candidate) => (
    candidate.ref.resourceType === 'skill'
    && Boolean(candidate.runtimePath)
    && (managementScope !== 'organization' || candidate.ref.scopeType === 'organization')
  ));
}

function toBrowserPath(value: string): string {
  return value.split(path.sep).join('/');
}

function decorateTreeNode(
  node: SkillFileNode,
  rootPath: string,
  candidate: CapabilityCandidate,
): CapabilitySkillTreeNode {
  const relativePath = node.path === rootPath
    ? ''
    : toBrowserPath(path.relative(rootPath, node.path));
  const browserPath = relativePath
    ? `${candidate.ref.resourceId}/${relativePath}`
    : candidate.ref.resourceId;

  return {
    ...node,
    name: relativePath ? node.name : candidate.ref.name,
    path: browserPath,
    resourceId: candidate.ref.resourceId,
    skillName: candidate.ref.name,
    scopeType: candidate.ref.scopeType,
    sourceType: candidate.ref.sourceType,
    relativePath,
    children: node.children?.map((child) => decorateTreeNode(child, rootPath, candidate)),
  };
}

async function buildCandidateTree(
  candidate: CapabilityCandidate,
  maxDepth: number,
): Promise<CapabilitySkillTreeNode | null> {
  if (!candidate.runtimePath) return null;

  const skillDirectory = path.dirname(path.resolve(candidate.runtimePath));
  const rootName = path.basename(skillDirectory);
  const roots = await buildSkillTree(path.dirname(skillDirectory), {
    maxDepth,
    includeRootNames: [rootName],
  });
  const root = roots.find((node) => node.name === rootName);
  return root ? decorateTreeNode(root, root.path, candidate) : null;
}

export async function buildCapabilitySkillTree(
  candidates: CapabilityCandidate[],
  options: { maxDepth?: number } = {},
): Promise<CapabilitySkillTreeNode[]> {
  const trees = await Promise.all(candidates.map((candidate) => (
    buildCandidateTree(candidate, options.maxDepth ?? 4)
  )));

  return trees
    .filter((tree): tree is CapabilitySkillTreeNode => Boolean(tree))
    .sort((left, right) => (
      left.name.localeCompare(right.name) || left.resourceId.localeCompare(right.resourceId)
    ));
}

function normalizeRelativeFilePath(value: string): string {
  const portablePath = value.replaceAll('\\', '/').trim();
  if (!portablePath || portablePath.includes('\0') || path.posix.isAbsolute(portablePath)) {
    throw new CapabilitySkillFileError('Invalid skill file path', 400);
  }

  const normalized = path.posix.normalize(portablePath);
  if (normalized === '..' || normalized.startsWith('../') || normalized === '.') {
    throw new CapabilitySkillFileError('Invalid skill file path', 400);
  }
  return normalized;
}

export async function resolveCapabilitySkillFile(
  candidates: CapabilityCandidate[],
  reference: { resourceId: string; relativePath: string },
): Promise<{ filePath: string; stat: Stats }> {
  const candidate = findCapabilitySkillCandidate(candidates, reference);
  if (!candidate?.runtimePath) {
    throw new CapabilitySkillFileError('Skill not found', 404);
  }

  const relativePath = normalizeRelativeFilePath(reference.relativePath);
  try {
    const skillRoot = await fs.realpath(path.dirname(path.resolve(candidate.runtimePath)));
    const requestedPath = await fs.realpath(path.join(skillRoot, ...relativePath.split('/')));
    if (requestedPath !== skillRoot && !requestedPath.startsWith(`${skillRoot}${path.sep}`)) {
      throw new CapabilitySkillFileError('Invalid skill file path', 400);
    }

    const stat = await fs.stat(requestedPath);
    if (stat.isDirectory()) {
      throw new CapabilitySkillFileError('Path is a directory, not a file', 400);
    }
    return { filePath: requestedPath, stat };
  } catch (error) {
    if (error instanceof CapabilitySkillFileError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CapabilitySkillFileError('File not found', 404);
    }
    throw error;
  }
}
