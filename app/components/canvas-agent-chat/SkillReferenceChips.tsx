'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { CanvasPluginIcon } from '@/app/lib/plugins/plugin-icons';
import { CanvasSkillIcon } from '@/app/lib/skills/skill-icons';
import type { CanvasSkillInterface } from '@/app/lib/skills/canvas-skill-manifest';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { cn } from '@/lib/utils';

export type SkillReferenceChipSkill = {
  name: string;
  title: string;
  description: string;
  enabled?: boolean;
  resourceId?: string;
  scopeType?: 'system' | 'organization' | 'user';
  workspaceId?: string;
  interface?: CanvasSkillInterface;
  plugin?: {
    name: string;
    skillAssetPath?: string;
  };
};

export type SkillReferenceChipPlugin = {
  name: string;
  version: string;
  description: string;
  enabled?: boolean;
  resourceId?: string;
  scopeType?: 'system' | 'organization' | 'user';
  workspaceId?: string;
  interface?: {
    displayName?: string;
    shortDescription?: string;
    brandColor?: string;
    icon?: string;
    logo?: string;
  };
};

export type CapabilityReferenceChipItem =
  | ({ kind: 'plugin' } & SkillReferenceChipPlugin)
  | ({ kind: 'skill' } & SkillReferenceChipSkill);

type SkillApiResponse = {
  success: boolean;
  skills?: SkillReferenceChipSkill[];
};

type PluginApiResponse = {
  success: boolean;
  plugins?: SkillReferenceChipPlugin[];
};

type WorkspaceReferenceCache = {
  workspaceId: string;
  references: CapabilityReferenceChipItem[] | null;
  pending: Promise<CapabilityReferenceChipItem[]> | null;
  consumers: number;
};

// Retain only the current workspace's entries. Returning to a previous
// workspace creates a fresh cache, including while its old JSON is pending.
let referenceCache: WorkspaceReferenceCache | null = null;
const EMPTY_REFERENCES: CapabilityReferenceChipItem[] = [];

const SKILL_REFERENCE_PATTERN = /(^|[\s([{"'`,;])\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=$|[\s)\]}",.;:!?])/g;

async function loadSkillReferences(workspaceId: string, cache: WorkspaceReferenceCache): Promise<CapabilityReferenceChipItem[]> {
  if (cache.references) {
    return cache.references;
  }
  if (cache.pending) return cache.pending;
  const query = new URLSearchParams({ workspaceId });

  const request: Promise<CapabilityReferenceChipItem[]> = Promise.all([
    fetch(`/api/plugins?${query}`)
      .then(async (response) => {
        if (!response.ok) return [];
        const data = (await response.json()) as PluginApiResponse;
        return (data.success && Array.isArray(data.plugins) ? data.plugins : [])
          .filter((plugin) => plugin.enabled !== false)
          .map((plugin) => ({ ...plugin, workspaceId, kind: 'plugin' as const }));
      })
      .catch(() => []),
    fetch(`/api/skills?${query}`)
      .then(async (response) => {
        if (!response.ok) return [];
        const data = (await response.json()) as SkillApiResponse;
        return (data.success && Array.isArray(data.skills) ? data.skills : [])
          .filter((skill) => skill.enabled !== false)
          .map((skill) => ({ ...skill, workspaceId, kind: 'skill' as const }));
      })
      .catch(() => []),
  ])
    .then(([plugins, skills]) => {
      const references = [...plugins, ...skills];
      if (referenceCache === cache && useWorkspaceStore.getState().activeWorkspaceId === workspaceId) {
        cache.references = references;
      }
      return references;
    })
    .catch(() => [])
    .finally(() => {
      if (cache.pending === request) cache.pending = null;
    });
  cache.pending = request;
  return request;
}

export function useSkillReferenceCatalog(): Map<string, CapabilityReferenceChipItem> {
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const workspaceIdentity = useMemo(() => Symbol(workspaceId ?? undefined), [workspaceId]);
  const workspaceIdentityRef = useRef(workspaceIdentity);
  useLayoutEffect(() => { workspaceIdentityRef.current = workspaceIdentity; }, [workspaceIdentity]);
  const [state, setState] = useState({ workspaceIdentity, references: EMPTY_REFERENCES });
  const references = state.workspaceIdentity === workspaceIdentity ? state.references : EMPTY_REFERENCES;

  useEffect(() => {
    if (!workspaceId) {
      referenceCache = null;
      return;
    }
    if (referenceCache?.workspaceId !== workspaceId) {
      referenceCache = { workspaceId, references: null, pending: null, consumers: 0 };
    }
    const cache = referenceCache;
    cache.consumers += 1;
    let cancelled = false;
    void loadSkillReferences(workspaceId, cache).then((nextReferences) => {
      if (!cancelled && workspaceIdentityRef.current === workspaceIdentity && referenceCache === cache) {
        setState({ workspaceIdentity, references: nextReferences });
      }
    });
    return () => {
      cancelled = true;
      cache.consumers -= 1;
      if (cache.consumers === 0 && referenceCache === cache) referenceCache = null;
    };
  }, [workspaceId, workspaceIdentity]);

  return useMemo(() => {
    const catalog = new Map<string, CapabilityReferenceChipItem>();
    for (const reference of references) {
      if (!catalog.has(reference.name)) {
        catalog.set(reference.name, reference);
      }
    }
    return catalog;
  }, [references]);
}

export function extractSkillReferenceNames(content: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(SKILL_REFERENCE_PATTERN)) {
    const name = match[2];
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

function getReferencedSkills(
  content: string,
  skillsByName: Map<string, CapabilityReferenceChipItem>,
): CapabilityReferenceChipItem[] {
  return extractSkillReferenceNames(content)
    .map((name) => skillsByName.get(name))
    .filter((reference): reference is CapabilityReferenceChipItem => Boolean(reference));
}

function SkillReferenceChip({
  reference,
  variant,
}: {
  reference: CapabilityReferenceChipItem;
  variant: 'composer' | 'message' | 'user';
}) {
  const description = reference.kind === 'plugin'
    ? reference.interface?.shortDescription || reference.description
    : reference.description;

  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium leading-none',
        variant === 'user'
          ? 'border-primary-foreground/25 bg-primary-foreground/15 text-primary-foreground'
          : 'border-border bg-background/80 text-foreground',
        variant === 'composer' ? 'bg-muted/50 text-muted-foreground' : null,
      )}
      title={description}
    >
      {reference.kind === 'plugin' ? (
        <CanvasPluginIcon plugin={reference} className="h-4 w-4 border-0 text-[7px]" />
      ) : (
        <CanvasSkillIcon skill={reference} className="h-4 w-4 border-0 text-[7px]" />
      )}
      <span className="min-w-0 truncate">/{reference.name}</span>
    </span>
  );
}

export function SkillReferenceChipRow({
  className,
  content,
  skillsByName,
  variant = 'message',
}: {
  className?: string;
  content: string;
  skillsByName?: Map<string, CapabilityReferenceChipItem>;
  variant?: 'composer' | 'message' | 'user';
}) {
  const catalog = useSkillReferenceCatalog();
  const resolvedSkillsByName = skillsByName || catalog;
  const referencedSkills = useMemo(
    () => getReferencedSkills(content, resolvedSkillsByName),
    [content, resolvedSkillsByName],
  );

  if (referencedSkills.length === 0) {
    return null;
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {referencedSkills.map((reference) => (
        <SkillReferenceChip key={`${reference.kind}:${reference.name}`} reference={reference} variant={variant} />
      ))}
    </div>
  );
}
