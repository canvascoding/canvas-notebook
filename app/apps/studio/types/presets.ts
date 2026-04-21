export interface StudioBlock {
  id: string;
  type: string;
  label: string;
  promptFragment: string;
  category: string;
  description?: string;
  thumbnailPath?: string | null;
}

export interface StudioPresetBlockDefinition {
  id: string;
  type: string;
  label: string;
  promptFragment: string;
  category: string;
  description: string;
  icon: string;
}

export interface StudioPreset {
  id: string;
  userId: string | null;
  name: string;
  description: string | null;
  category: string | null;
  blocks: StudioBlock[];
  previewImagePath: string | null;
  previewImageUrl: string | null;
  tags: string[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StudioPresetBlockGroup {
  type: string;
  label: string;
  blocks: StudioPresetBlockDefinition[];
}

export interface StudioPresetBlockCatalog {
  blockTypes: StudioPresetBlockGroup[];
  categories: readonly string[];
  blockOrder: string[];
}
