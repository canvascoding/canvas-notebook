import path from 'path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';

function stripStudioAssetsPrefix(relativePath: string): string {
  const prefix = 'studio/assets/';
  if (relativePath.startsWith(prefix)) {
    return relativePath.slice(prefix.length);
  }
  return relativePath;
}

export const STUDIO_ROOT_DIR = 'studio';
export const STUDIO_ASSETS_ROOT_DIR = path.posix.join(STUDIO_ROOT_DIR, 'assets');
export const STUDIO_OUTPUTS_ROOT_DIR = path.posix.join(STUDIO_ROOT_DIR, 'outputs');

export const STUDIO_PRODUCTS_DIR = path.posix.join(STUDIO_ASSETS_ROOT_DIR, 'products');
export const STUDIO_PERSONAS_DIR = path.posix.join(STUDIO_ASSETS_ROOT_DIR, 'personas');
export const STUDIO_STYLES_DIR = path.posix.join(STUDIO_ASSETS_ROOT_DIR, 'styles');
export const STUDIO_PRESETS_DIR = path.posix.join(STUDIO_ASSETS_ROOT_DIR, 'presets');
export const STUDIO_REFERENCES_DIR = path.posix.join(STUDIO_ASSETS_ROOT_DIR, 'references');

export function getStudioAssetsRoot(): string {
  return path.join(resolveCanvasDataRoot(), STUDIO_ASSETS_ROOT_DIR);
}

export function getStudioOutputsRoot(): string {
  return path.join(resolveCanvasDataRoot(), STUDIO_OUTPUTS_ROOT_DIR);
}

export async function ensureStudioAssetsWorkspace(): Promise<void> {
  const root = getStudioAssetsRoot();
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(root, 'products'), { recursive: true });
  await fs.mkdir(path.join(root, 'personas'), { recursive: true });
  await fs.mkdir(path.join(root, 'styles'), { recursive: true });
  await fs.mkdir(path.join(root, 'presets'), { recursive: true });
  await fs.mkdir(path.join(root, 'references'), { recursive: true });
}

export async function ensureStudioOutputsWorkspace(): Promise<void> {
  await fs.mkdir(getStudioOutputsRoot(), { recursive: true });
}

export function generateProductImagePath(productId: string, sortOrder: number, ext: string): string {
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
  const uuid = crypto.randomUUID().slice(0, 8);
  return path.posix.join('products', productId, `img-${sortOrder}-${uuid}.${safeExt}`);
}

export function generatePersonaImagePath(personaId: string, sortOrder: number, ext: string): string {
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
  const uuid = crypto.randomUUID().slice(0, 8);
  return path.posix.join('personas', personaId, `img-${sortOrder}-${uuid}.${safeExt}`);
}

export function generateStyleImagePath(styleId: string, sortOrder: number, ext: string): string {
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
  const uuid = crypto.randomUUID().slice(0, 8);
  return path.posix.join('styles', styleId, `img-${sortOrder}-${uuid}.${safeExt}`);
}

export function generatePresetPreviewPath(presetId: string, ext: string): string {
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
  const uuid = crypto.randomUUID().slice(0, 8);
  return path.posix.join('presets', presetId, `preview-${uuid}.${safeExt}`);
}

export function generateStudioReferencePath(userId: string, originalName: string): { id: string; relativePath: string } {
  const ext = path.posix.extname(originalName).replace(/[^a-z0-9.]/gi, '').toLowerCase() || '.png';
  const safeExt = ext.startsWith('.') ? ext.slice(1) : ext;
  const id = `ref-${crypto.randomUUID()}.${safeExt || 'png'}`;
  return {
    id,
    relativePath: path.posix.join('references', userId, id),
  };
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
  const safeSlug = toSlug(slug);
  return `studio-gen-${safeSlug}-${variationIndex}-${timestamp}-${random}.${safeExt}`;
}

export async function writeAssetFile(relativePath: string, buffer: Buffer): Promise<void> {
  const fullPath = path.join(getStudioAssetsRoot(), stripStudioAssetsPrefix(relativePath));
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, buffer);
}

export async function writeOutputFile(filePath: string, buffer: Buffer): Promise<void> {
  const fullPath = path.join(getStudioOutputsRoot(), filePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, buffer);
}

export async function readAssetFile(relativePath: string): Promise<Buffer> {
  const fullPath = path.join(getStudioAssetsRoot(), stripStudioAssetsPrefix(relativePath));
  return fs.readFile(fullPath);
}

export async function deleteAssetFile(relativePath: string): Promise<void> {
  const fullPath = path.join(getStudioAssetsRoot(), stripStudioAssetsPrefix(relativePath));
  await fs.rm(fullPath, { force: true });
}

export async function deleteAssetDir(relativePath: string): Promise<void> {
  const fullPath = path.join(getStudioAssetsRoot(), stripStudioAssetsPrefix(relativePath));
  await fs.rm(fullPath, { recursive: true, force: true });
}

export async function readOutputFile(filePath: string): Promise<Buffer> {
  const fullPath = path.join(getStudioOutputsRoot(), filePath);
  return fs.readFile(fullPath);
}

export async function writeStudioReferenceFile(userId: string, referenceId: string, buffer: Buffer): Promise<void> {
  const fullPath = path.join(getStudioAssetsRoot(), 'references', userId, referenceId);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, buffer);
}

export async function readStudioReferenceFile(userId: string, referenceId: string): Promise<Buffer> {
  const fullPath = path.join(getStudioAssetsRoot(), 'references', userId, referenceId);
  return fs.readFile(fullPath);
}

export async function getStudioOutputStats(filePath: string) {
  const fullPath = path.join(getStudioOutputsRoot(), filePath);
  const stat = await fs.stat(fullPath);
  return { size: stat.size, mtime: stat.mtime };
}
