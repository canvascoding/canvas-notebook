import { NextResponse } from 'next/server';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';
import {
  importSkillPackage,
  SkillPackageImportError,
  type SkillPackageImportSource,
} from '@/app/lib/skills/skill-package-import';

function isFileLike(value: FormDataEntryValue | null): value is File {
  return Boolean(value && typeof value === 'object' && 'arrayBuffer' in value && 'name' in value);
}

async function fileToBuffer(file: File): Promise<Buffer> {
  return Buffer.from(await file.arrayBuffer());
}

function parseFolderPaths(value: FormDataEntryValue | null): string[] {
  if (typeof value !== 'string') {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

async function readMultipartSkillSource(request: Request): Promise<SkillPackageImportSource> {
  const formData = await request.formData();
  const mode = typeof formData.get('mode') === 'string' ? String(formData.get('mode')) : 'archive';

  if (mode === 'folder') {
    const files = formData.getAll('files').filter(isFileLike);
    const paths = parseFolderPaths(formData.get('paths'));

    if (files.length === 0) {
      throw new SkillPackageImportError('No folder files were provided.');
    }
    if (paths.length !== files.length) {
      throw new SkillPackageImportError('Folder upload paths did not match uploaded files.');
    }

    return {
      kind: 'folder',
      sourceName: typeof formData.get('sourceName') === 'string' ? String(formData.get('sourceName')) : undefined,
      files: await Promise.all(files.map(async (file, index) => ({
        relativePath: paths[index] || file.name,
        bytes: await fileToBuffer(file),
      }))),
    };
  }

  const file = formData.get('file');
  if (!isFileLike(file)) {
    throw new SkillPackageImportError('A ZIP or .skill archive file is required.');
  }

  return {
    kind: 'archive',
    sourceName: file.name,
    bytes: await fileToBuffer(file),
  };
}

export async function POST(request: Request) {
  const skillPermission = await requireOrganizationPermission(request, 'canSharePluginsAndSkills', {
    errorMessage: 'Forbidden: plugin and skill sharing permission required',
  });
  if (!skillPermission.ok) return skillPermission.response;

  try {
    const scope = { userId: skillPermission.session.user.id };
    const contentType = request.headers.get('content-type') || '';
    let source: SkillPackageImportSource;

    if (contentType.includes('multipart/form-data')) {
      source = await readMultipartSkillSource(request);
    } else {
      const body = await request.json();
      const { content } = body;

      if (typeof content !== 'string' || content.trim().length === 0) {
        return NextResponse.json(
          { success: false, error: 'SKILL.md content is required' },
          { status: 400 },
        );
      }

      source = {
        kind: 'text',
        content,
        sourceName: 'manual-upload:SKILL.md',
      };
    }

    const result = await importSkillPackage(source, {
      scope,
      updatedBy: skillPermission.session.user.email || skillPermission.session.user.id,
    });

    console.log(`[Skills Upload API] Created skill: ${result.path}`);
    return NextResponse.json(result);
  } catch (error) {
    console.error('[Skills Upload API] Error:', error);
    if (error instanceof SkillPackageImportError) {
      return NextResponse.json(
        { success: false, error: error.message, validation: error.validation },
        { status: error.statusCode },
      );
    }

    return NextResponse.json(
      { success: false, error: 'Failed to upload skill' },
      { status: 500 }
    );
  }
}
