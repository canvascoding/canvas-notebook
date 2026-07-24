import 'server-only';

import { listPresets, type StudioPresetBlockInput } from '@/app/lib/integrations/studio-preset-service';
import { toPreviewUrl } from '@/app/lib/utils/media-url';

import { MobileStudioError } from './studio';

export function serializeMobileStudioPreset(preset: Awaited<ReturnType<typeof listPresets>>[number], workspaceId: string) {
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description || '',
    category: preset.category || 'custom',
    tags: preset.tags,
    isDefault: preset.isDefault,
    editable: preset.workspaceId === workspaceId && !preset.isDefault,
    previewUrl: preset.previewImagePath
      ? toPreviewUrl(preset.previewImagePath, 320, { preset: 'mini', workspaceId })
      : null,
    blocks: preset.blocks.map((block) => ({
      id: block.id || '', type: block.type, label: block.label, promptFragment: block.promptFragment,
      category: block.category || '', description: block.description || '',
    })),
    updatedAt: preset.updatedAt.toISOString(),
  };
}

export function parseMobileStudioPresetInput(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MobileStudioError('Preset input is invalid.', 400, 'INVALID_PRESET');
  const body = value as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const category = typeof body.category === 'string' ? body.category.trim() : '';
  const blocks = Array.isArray(body.blocks) ? body.blocks.filter((block): block is StudioPresetBlockInput => Boolean(
    block && typeof block === 'object' && typeof (block as StudioPresetBlockInput).type === 'string'
      && typeof (block as StudioPresetBlockInput).label === 'string' && typeof (block as StudioPresetBlockInput).promptFragment === 'string',
  )).slice(0, 20) : [];
  if (!name || name.length > 240 || !category || !blocks.length) throw new MobileStudioError('Preset name, category, and at least one block are required.', 400, 'INVALID_PRESET');
  return {
    name,
    category,
    description: typeof body.description === 'string' ? body.description.trim().slice(0, 2_000) : undefined,
    tags: Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 20) : undefined,
    blocks,
  };
}
