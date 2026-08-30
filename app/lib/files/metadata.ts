import type { FileNode } from './types';
import { getFileDisplayName } from './display-name';
import { getExtension } from './path-utils';

const FORMAT_LABELS: Record<string, string> = {
  csv: 'CSV',
  doc: 'Word document',
  docx: 'Word document',
  gif: 'GIF image',
  html: 'HTML document',
  jpg: 'JPEG image',
  jpeg: 'JPEG image',
  json: 'JSON file',
  md: 'Markdown document',
  mp3: 'MP3 audio',
  mp4: 'MP4 video',
  pdf: 'PDF document',
  png: 'PNG image',
  ppt: 'PowerPoint presentation',
  pptx: 'PowerPoint presentation',
  svg: 'SVG image',
  ts: 'TypeScript file',
  tsx: 'TypeScript React file',
  txt: 'Text document',
  webm: 'WebM video',
  webp: 'WebP image',
  xls: 'Excel spreadsheet',
  xlsx: 'Excel spreadsheet',
  yaml: 'YAML file',
  yml: 'YAML file',
};

export function getFileTitle(node: Pick<FileNode, 'name' | 'type' | 'title'>): string {
  return node.title?.trim() || getFileDisplayName(node);
}

export function getFileFormat(node: Pick<FileNode, 'name' | 'type'>): string {
  if (node.type === 'directory') return 'Folder';
  const extension = getExtension(node.name);
  if (!extension) return 'File';
  return `${FORMAT_LABELS[extension] || `${extension.toUpperCase()} file`} (.${extension})`;
}
