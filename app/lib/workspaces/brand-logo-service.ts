import 'server-only';

import { promises as fs } from 'node:fs';

import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';

import {
  createDirectory,
  deleteFile,
  resolveExistingWorkspacePath,
  writeFile,
  type WorkspaceFileOperationOptions,
} from '@/app/lib/filesystem/workspace-files';
import type { WorkspaceBrandProfile, WorkspaceBrandProfileState } from './brand-profile';
import {
  readWorkspaceBrandProfile,
  updateWorkspaceBrandProfile,
} from './brand-profile-service';

export const WORKSPACE_BRAND_LOGO_DIRECTORY = '.canvas-brand';
export const WORKSPACE_BRAND_LOGO_PATH = `${WORKSPACE_BRAND_LOGO_DIRECTORY}/logo.webp`;
export const WORKSPACE_BRAND_LOGO_MAX_UPLOAD_BYTES = 1024 * 1024;

const WORKSPACE_BRAND_LOGO_MAX_STORED_BYTES = 768 * 1024;
const WORKSPACE_BRAND_LOGO_MAX_INPUT_PIXELS = 12_000_000;
const WORKSPACE_BRAND_LOGO_MAX_WIDTH_PX = 1_200;
const WORKSPACE_BRAND_LOGO_MAX_HEIGHT_PX = 480;
const ALLOWED_LOGO_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export class WorkspaceBrandLogoError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'WorkspaceBrandLogoError';
    this.status = status;
  }
}

export type WorkspaceBrandLogoAsset = {
  path: string;
  mimeType: 'image/webp';
  size: number;
  width: number;
  height: number;
};

export type ReadWorkspaceBrandLogoResult = {
  buffer: Buffer;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  size: number;
};

type NormalizedWorkspaceBrandLogo = Omit<WorkspaceBrandLogoAsset, 'path'> & {
  buffer: Buffer;
};

export type WorkspaceBrandLogoSaveResult = WorkspaceBrandProfileState & {
  asset: WorkspaceBrandLogoAsset;
};

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

async function normalizeLogoBuffer(buffer: Buffer): Promise<NormalizedWorkspaceBrandLogo> {
  if (buffer.length === 0) {
    throw new WorkspaceBrandLogoError('The logo file is empty.');
  }
  if (buffer.length > WORKSPACE_BRAND_LOGO_MAX_UPLOAD_BYTES) {
    throw new WorkspaceBrandLogoError('Logo file is too large. Maximum size is 1 MB.', 413);
  }

  const detected = await fileTypeFromBuffer(buffer).catch(() => undefined);
  if (!detected || !ALLOWED_LOGO_MIME_TYPES.has(detected.mime)) {
    throw new WorkspaceBrandLogoError('Unsupported logo format. Use PNG, JPG, or WebP.');
  }

  try {
    const image = sharp(buffer, {
      failOn: 'error',
      limitInputPixels: WORKSPACE_BRAND_LOGO_MAX_INPUT_PIXELS,
      pages: 1,
    });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height) {
      throw new WorkspaceBrandLogoError('The logo dimensions could not be determined.');
    }
    if ((metadata.pages ?? 1) > 1) {
      throw new WorkspaceBrandLogoError('Animated or multi-page logos are not supported.');
    }
    if (metadata.width * metadata.height > WORKSPACE_BRAND_LOGO_MAX_INPUT_PIXELS) {
      throw new WorkspaceBrandLogoError('Logo dimensions are too large.');
    }

    const output = await image
      .rotate()
      .resize({
        width: WORKSPACE_BRAND_LOGO_MAX_WIDTH_PX,
        height: WORKSPACE_BRAND_LOGO_MAX_HEIGHT_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 88, alphaQuality: 100, effort: 4 })
      .toBuffer({ resolveWithObject: true });

    if (output.data.length > WORKSPACE_BRAND_LOGO_MAX_STORED_BYTES) {
      throw new WorkspaceBrandLogoError('The processed logo is still too large. Try a simpler or smaller image.');
    }

    return {
      buffer: output.data,
      mimeType: 'image/webp',
      size: output.data.length,
      width: output.info.width,
      height: output.info.height,
    };
  } catch (error) {
    if (error instanceof WorkspaceBrandLogoError) throw error;
    throw new WorkspaceBrandLogoError('The uploaded file is not a valid PNG, JPG, or WebP image.');
  }
}

export async function saveWorkspaceBrandLogo(input: {
  buffer: Buffer;
  workspaceId: string;
  userId: string;
  fileOptions: WorkspaceFileOperationOptions;
}): Promise<WorkspaceBrandLogoSaveResult> {
  const normalized = await normalizeLogoBuffer(input.buffer);
  await createDirectory(WORKSPACE_BRAND_LOGO_DIRECTORY, input.fileOptions);
  await writeFile(WORKSPACE_BRAND_LOGO_PATH, normalized.buffer, input.fileOptions);

  const current = await readWorkspaceBrandProfile(input.workspaceId);
  const next = await updateWorkspaceBrandProfile({
    workspaceId: input.workspaceId,
    userId: input.userId,
    profile: {
      ...current.profile,
      logoPath: WORKSPACE_BRAND_LOGO_PATH,
    },
  });

  return {
    asset: {
      path: WORKSPACE_BRAND_LOGO_PATH,
      mimeType: normalized.mimeType,
      size: normalized.size,
      width: normalized.width,
      height: normalized.height,
    },
    profile: next.profile,
    revision: next.revision,
    configured: next.configured,
    updatedAt: next.updatedAt,
  };
}

export async function readWorkspaceBrandLogo(
  profile: WorkspaceBrandProfile,
  fileOptions: WorkspaceFileOperationOptions,
): Promise<ReadWorkspaceBrandLogoResult | null> {
  if (!profile.logoPath) return null;

  try {
    const fullPath = await resolveExistingWorkspacePath(profile.logoPath, fileOptions);
    const stats = await fs.stat(fullPath);
    if (!stats.isFile() || stats.size <= 0 || stats.size > WORKSPACE_BRAND_LOGO_MAX_UPLOAD_BYTES) {
      return null;
    }

    const buffer = await fs.readFile(fullPath);
    const detected = await fileTypeFromBuffer(buffer).catch(() => undefined);
    if (!detected || !ALLOWED_LOGO_MIME_TYPES.has(detected.mime)) return null;

    return {
      buffer,
      mimeType: detected.mime as ReadWorkspaceBrandLogoResult['mimeType'],
      size: buffer.length,
    };
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

export async function readWorkspaceBrandLogoDataUri(
  profile: WorkspaceBrandProfile,
  fileOptions: WorkspaceFileOperationOptions,
): Promise<string | null> {
  if (!profile.enabled) return null;
  const logo = await readWorkspaceBrandLogo(profile, fileOptions);
  return logo ? `data:${logo.mimeType};base64,${logo.buffer.toString('base64')}` : null;
}

export async function deleteManagedWorkspaceBrandLogoFile(
  fileOptions: WorkspaceFileOperationOptions,
): Promise<void> {
  try {
    await deleteFile(WORKSPACE_BRAND_LOGO_PATH, fileOptions);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

export async function removeWorkspaceBrandLogo(input: {
  workspaceId: string;
  userId: string;
  fileOptions: WorkspaceFileOperationOptions;
}) {
  await deleteManagedWorkspaceBrandLogoFile(input.fileOptions);
  const current = await readWorkspaceBrandProfile(input.workspaceId);
  return updateWorkspaceBrandProfile({
    workspaceId: input.workspaceId,
    userId: input.userId,
    profile: {
      ...current.profile,
      logoPath: '',
    },
  });
}
