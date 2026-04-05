import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import mammoth from 'mammoth';
import { auth } from '@/app/lib/auth';

const MAX_FILE_SIZE_MB = 10;
const MAX_IMAGE_DIMENSION = 1024;
const OUTPUT_QUALITY = 85;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/svg+xml']);

const TEXT_TYPES = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/html',
  'text/xml',
  'application/json',
  'application/xml',
  'application/yaml',
  'text/yaml',
]);

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_TYPE = 'application/pdf';

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm']);

function resolveContentType(file: File): string {
  // Some browsers send generic types for certain extensions — fix up
  const ext = path.extname(file.name).toLowerCase();
  if (file.type === 'application/octet-stream' || !file.type) {
    if (ext === '.md') return 'text/markdown';
    if (ext === '.yaml' || ext === '.yml') return 'application/yaml';
    if (ext === '.csv') return 'text/csv';
    if (ext === '.docx') return DOCX_TYPE;
  }
  return file.type;
}

async function processImage(buffer: Buffer): Promise<{ buffer: Buffer; width: number; height: number }> {
  let img = sharp(buffer);
  const meta = await img.metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;

  if (w > MAX_IMAGE_DIMENSION || h > MAX_IMAGE_DIMENSION) {
    img = img.resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, { fit: 'inside', withoutEnlargement: true });
  }

  img = img.webp({ quality: OUTPUT_QUALITY, effort: 4 });
  const out = await img.toBuffer();
  const outMeta = await sharp(out).metadata();
  return { buffer: out, width: outMeta.width ?? w, height: outMeta.height ?? h };
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(buffer);
  return data.text ?? '';
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value ?? '';
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ success: false, error: 'No file provided' }, { status: 400 });
    }

    const maxBytes = MAX_FILE_SIZE_MB * 1024 * 1024;
    if (file.size > maxBytes) {
      return NextResponse.json(
        { success: false, error: `File too large. Maximum size: ${MAX_FILE_SIZE_MB} MB` },
        { status: 400 },
      );
    }

    const contentType = resolveContentType(file);
    const ext = path.extname(file.name).toLowerCase();
    const buffer = Buffer.from(await file.arrayBuffer());

    // --- Images ---
    if (IMAGE_TYPES.has(contentType) || contentType.startsWith('image/')) {
      const DATA = process.env.DATA ?? path.join(process.cwd(), 'data');
      const tempDir = path.join(DATA, 'temp', 'screenshots');
      await fs.mkdir(tempDir, { recursive: true });

      const { buffer: processed, width, height } = await processImage(buffer);
      const baseName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_').replace(/\.[^.]+$/, '');
      const fileName = `${Date.now()}_${baseName}.webp`;
      const filePath = path.join(tempDir, fileName);
      await fs.writeFile(filePath, processed);

      return NextResponse.json({
        success: true,
        name: file.name,
        contentKind: 'image',
        path: filePath,
        mimeType: 'image/webp',
        dimensions: { width, height },
      });
    }

    // --- PDF ---
    if (contentType === PDF_TYPE || ext === '.pdf') {
      const text = await extractPdfText(buffer);
      if (!text.trim()) {
        return NextResponse.json(
          { success: false, error: 'PDF enthält keinen extrahierbaren Text (möglicherweise gescannt/nur Bilder).' },
          { status: 422 },
        );
      }
      return NextResponse.json({
        success: true,
        name: file.name,
        contentKind: 'document',
        text,
        originalMimeType: PDF_TYPE,
      });
    }

    // --- Word (.docx) ---
    if (contentType === DOCX_TYPE || ext === '.docx') {
      const text = await extractDocxText(buffer);
      return NextResponse.json({
        success: true,
        name: file.name,
        contentKind: 'document',
        text,
        originalMimeType: DOCX_TYPE,
      });
    }

    // --- Plain text / CSV / JSON / YAML / XML / HTML / Markdown ---
    if (TEXT_TYPES.has(contentType) || TEXT_EXTENSIONS.has(ext)) {
      const text = buffer.toString('utf-8');
      return NextResponse.json({
        success: true,
        name: file.name,
        contentKind: 'document',
        text,
        originalMimeType: contentType || 'text/plain',
      });
    }

    return NextResponse.json(
      {
        success: false,
        error: `Dateityp nicht unterstützt: ${contentType || ext}. Unterstützt: Bilder, PDF, DOCX, TXT, MD, CSV, JSON, YAML, XML, HTML`,
      },
      { status: 415 },
    );
  } catch (error) {
    console.error('[API] Attachment upload error:', error);
    return NextResponse.json({ success: false, error: 'Fehler beim Verarbeiten der Datei.' }, { status: 500 });
  }
}
