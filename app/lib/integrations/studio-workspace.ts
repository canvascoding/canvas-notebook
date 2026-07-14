import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { normalizeDataScopeId, resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';
import { resolvePathInside } from '@/app/lib/security/safe-paths';

export type StudioStorageScope = {
  organizationId: string;
  workspaceId: string;
};

export const STUDIO_ROOT_DIR = 'studio';
export const STUDIO_SYSTEM_ROOT_DIR = path.posix.join(STUDIO_ROOT_DIR, 'system');
export const STUDIO_SYSTEM_PRESETS_DIR = path.posix.join(STUDIO_SYSTEM_ROOT_DIR, 'assets', 'presets');

// Legacy roots stay readable during the one-time data migration.
export const STUDIO_ASSETS_ROOT_DIR = path.posix.join(STUDIO_ROOT_DIR, 'assets');
export const STUDIO_OUTPUTS_ROOT_DIR = path.posix.join(STUDIO_ROOT_DIR, 'outputs');
export const STUDIO_EDITS_ROOT_DIR = path.posix.join(STUDIO_ROOT_DIR, 'edits');

export const STUDIO_PRODUCTS_DIR = path.posix.join(STUDIO_ASSETS_ROOT_DIR, 'products');
export const STUDIO_PERSONAS_DIR = path.posix.join(STUDIO_ASSETS_ROOT_DIR, 'personas');
export const STUDIO_STYLES_DIR = path.posix.join(STUDIO_ASSETS_ROOT_DIR, 'styles');
export const STUDIO_PRESETS_DIR = path.posix.join(STUDIO_ASSETS_ROOT_DIR, 'presets');
export const STUDIO_REFERENCES_DIR = path.posix.join(STUDIO_ASSETS_ROOT_DIR, 'references');

function normalizeScope(scope: StudioStorageScope): StudioStorageScope {
  return {
    organizationId: normalizeDataScopeId(scope.organizationId, 'organizationId'),
    workspaceId: normalizeDataScopeId(scope.workspaceId, 'workspaceId'),
  };
}

export function getStudioRoot(): string {
  return path.join(resolveCanvasDataRoot(), STUDIO_ROOT_DIR);
}

export function getStudioWorkspaceVirtualRoot(scope: StudioStorageScope): string {
  const normalized = normalizeScope(scope);
  return path.posix.join(
    STUDIO_ROOT_DIR,
    'organizations',
    normalized.organizationId,
    'workspaces',
    normalized.workspaceId,
  );
}

export function getStudioWorkspaceRoot(scope: StudioStorageScope): string {
  return path.join(resolveCanvasDataRoot(), ...getStudioWorkspaceVirtualRoot(scope).split('/'));
}

export function getStudioAssetsRoot(scope?: StudioStorageScope): string {
  return scope
    ? path.join(getStudioWorkspaceRoot(scope), 'assets')
    : path.join(resolveCanvasDataRoot(), STUDIO_ASSETS_ROOT_DIR);
}

export function getStudioOutputsRoot(scope?: StudioStorageScope): string {
  return scope
    ? path.join(getStudioWorkspaceRoot(scope), 'outputs')
    : path.join(resolveCanvasDataRoot(), STUDIO_OUTPUTS_ROOT_DIR);
}

export function getStudioEditsRoot(scope?: StudioStorageScope): string {
  return scope
    ? path.join(getStudioWorkspaceRoot(scope), 'edits')
    : path.join(resolveCanvasDataRoot(), STUDIO_EDITS_ROOT_DIR);
}

export function resolveStudioFilePath(filePath: string, legacyRoot?: string): string | null {
  const normalized = filePath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return null;

  if (normalized === STUDIO_ROOT_DIR || normalized.startsWith(`${STUDIO_ROOT_DIR}/`)) {
    return resolvePathInside(resolveCanvasDataRoot(), path.normalize(normalized));
  }

  return legacyRoot ? resolvePathInside(legacyRoot, path.normalize(normalized)) : null;
}

function requireStudioFilePath(filePath: string, legacyRoot?: string): string {
  const resolved = resolveStudioFilePath(filePath, legacyRoot);
  if (!resolved) throw new Error('Invalid Studio storage path.');
  return resolved;
}

export async function ensureStudioAssetsWorkspace(scope?: StudioStorageScope): Promise<void> {
  const root = getStudioAssetsRoot(scope);
  await Promise.all([
    fs.mkdir(path.join(root, 'products'), { recursive: true }),
    fs.mkdir(path.join(root, 'personas'), { recursive: true }),
    fs.mkdir(path.join(root, 'styles'), { recursive: true }),
    fs.mkdir(path.join(root, 'presets'), { recursive: true }),
    fs.mkdir(path.join(root, 'references'), { recursive: true }),
  ]);
}

export async function ensureStudioOutputsWorkspace(scope?: StudioStorageScope): Promise<void> {
  await fs.mkdir(getStudioOutputsRoot(scope), { recursive: true });
}

export async function ensureStudioEditsWorkspace(scope?: StudioStorageScope): Promise<void> {
  await fs.mkdir(getStudioEditsRoot(scope), { recursive: true });
}

function workspaceAssetPath(scope: StudioStorageScope, ...segments: string[]): string {
  return path.posix.join(getStudioWorkspaceVirtualRoot(scope), 'assets', ...segments);
}

export function generateProductImagePath(
  productId: string,
  sortOrder: number,
  ext: string,
  scope?: StudioStorageScope,
): string {
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
  const filePath = path.posix.join('products', productId, `img-${sortOrder}-${crypto.randomUUID().slice(0, 8)}.${safeExt}`);
  return scope ? workspaceAssetPath(scope, filePath) : filePath;
}

export function generatePersonaImagePath(
  personaId: string,
  sortOrder: number,
  ext: string,
  scope?: StudioStorageScope,
): string {
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
  const filePath = path.posix.join('personas', personaId, `img-${sortOrder}-${crypto.randomUUID().slice(0, 8)}.${safeExt}`);
  return scope ? workspaceAssetPath(scope, filePath) : filePath;
}

export function generateStyleImagePath(
  styleId: string,
  sortOrder: number,
  ext: string,
  scope?: StudioStorageScope,
): string {
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
  const filePath = path.posix.join('styles', styleId, `img-${sortOrder}-${crypto.randomUUID().slice(0, 8)}.${safeExt}`);
  return scope ? workspaceAssetPath(scope, filePath) : filePath;
}

export function generatePresetPreviewPath(presetId: string, ext: string, scope?: StudioStorageScope): string {
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
  const filePath = path.posix.join('presets', presetId, `preview-${crypto.randomUUID().slice(0, 8)}.${safeExt}`);
  return scope ? workspaceAssetPath(scope, filePath) : filePath;
}

export function getSystemPresetPreviewPath(presetId: string, fileName: string): string {
  return path.posix.join(STUDIO_SYSTEM_PRESETS_DIR, presetId, fileName);
}

export function generateStudioReferencePath(
  scopeOrUserId: StudioStorageScope | string,
  originalName: string,
): { id: string; relativePath: string } {
  const ext = path.posix.extname(originalName).replace(/[^a-z0-9.]/gi, '').toLowerCase() || '.png';
  const safeExt = ext.startsWith('.') ? ext.slice(1) : ext;
  const id = `ref-${crypto.randomUUID()}.${safeExt || 'png'}`;
  const relativePath = typeof scopeOrUserId === 'string'
    ? path.posix.join('references', scopeOrUserId, id)
    : workspaceAssetPath(scopeOrUserId, 'references', id);
  return { id, relativePath };
}

function toSlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return slug || 'studio';
}

export function generateOutputFilename(slug: string, variationIndex: number, ext: string): string {
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const random = crypto.randomUUID().slice(0, 8);
  return `studio-gen-${toSlug(slug)}-${variationIndex}-${timestamp}-${random}.${safeExt}`;
}

export function generateOutputPath(scope: StudioStorageScope, generationId: string, fileName: string): string {
  return path.posix.join(getStudioWorkspaceVirtualRoot(scope), 'outputs', generationId, fileName);
}

export function generateEditPath(scope: StudioStorageScope, fileName: string): string {
  return path.posix.join(getStudioWorkspaceVirtualRoot(scope), 'edits', fileName);
}

export async function writeAssetFile(filePath: string, buffer: Buffer): Promise<void> {
  const fullPath = requireStudioFilePath(filePath, getStudioAssetsRoot());
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, buffer);
}

export async function writeOutputFile(filePath: string, buffer: Buffer): Promise<void> {
  const fullPath = requireStudioFilePath(filePath, getStudioOutputsRoot());
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, buffer);
}

export async function writeEditFile(filePath: string, buffer: Buffer): Promise<void> {
  const fullPath = requireStudioFilePath(filePath, getStudioEditsRoot());
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, buffer);
}

export async function readAssetFile(filePath: string): Promise<Buffer> {
  return fs.readFile(requireStudioFilePath(filePath, getStudioAssetsRoot()));
}

export async function deleteAssetFile(filePath: string): Promise<void> {
  await fs.rm(requireStudioFilePath(filePath, getStudioAssetsRoot()), { force: true });
}

export async function deleteAssetDir(filePath: string): Promise<void> {
  await fs.rm(requireStudioFilePath(filePath, getStudioAssetsRoot()), { recursive: true, force: true });
}

export async function deleteOutputFile(filePath: string): Promise<void> {
  await fs.rm(requireStudioFilePath(filePath, getStudioOutputsRoot()), { force: true });
}

export async function readOutputFile(filePath: string): Promise<Buffer> {
  return fs.readFile(requireStudioFilePath(filePath, getStudioOutputsRoot()));
}

export async function readEditFile(filePath: string): Promise<Buffer> {
  return fs.readFile(requireStudioFilePath(filePath, getStudioEditsRoot()));
}

export async function writeStudioReferenceFile(
  scopeOrUserId: StudioStorageScope | string,
  referenceId: string,
  buffer: Buffer,
): Promise<void> {
  const filePath = typeof scopeOrUserId === 'string'
    ? path.posix.join('references', scopeOrUserId, referenceId)
    : workspaceAssetPath(scopeOrUserId, 'references', referenceId);
  await writeAssetFile(filePath, buffer);
}

export async function readStudioReferenceFile(
  scopeOrUserId: StudioStorageScope | string,
  referenceId: string,
): Promise<Buffer> {
  const filePath = typeof scopeOrUserId === 'string'
    ? path.posix.join('references', scopeOrUserId, referenceId)
    : workspaceAssetPath(scopeOrUserId, 'references', referenceId);
  return readAssetFile(filePath);
}

export async function getStudioOutputStats(filePath: string) {
  const stat = await fs.stat(requireStudioFilePath(filePath, getStudioOutputsRoot()));
  return { size: stat.size, mtime: stat.mtime };
}
