import { NextRequest, NextResponse } from 'next/server';
import { Readable } from 'stream';
import ZipStream from 'zip-stream';
import { auth } from '@/app/lib/auth';
import { getStudioOutputForUser } from '@/app/lib/integrations/studio-generation-service';
import { readOutputFile } from '@/app/lib/integrations/studio-workspace';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function addZipEntry(
  archive: InstanceType<typeof ZipStream>,
  source: NodeJS.ReadableStream | Buffer | string | null,
  data: { name: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    archive.entry(source, data, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'studio-download' });
  if (!limited.ok) return limited.response;

  try {
    const body = await request.json();
    const { outputIds } = body;

    if (!Array.isArray(outputIds) || outputIds.length === 0) {
      return NextResponse.json({ success: false, error: 'outputIds is required' }, { status: 400 });
    }

    const outputs = [];
    for (const id of outputIds) {
      const output = await getStudioOutputForUser(id, session.user.id);
      if (!output) {
        return NextResponse.json({ success: false, error: `Output not found: ${id}` }, { status: 404 });
      }
      outputs.push(output);
    }

    if (outputs.length === 1) {
      const output = outputs[0];
      const buffer = await readOutputFile(output.filePath);
      const fileName = output.filePath.split('/').pop() || `studio-output`;
      const contentType = output.mimeType || 'application/octet-stream';

      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${fileName}"`,
          'Content-Length': buffer.length.toString(),
        },
      });
    }

    const archive = new ZipStream({ level: 1 });
    const webStream = Readable.toWeb(archive) as ReadableStream<Uint8Array>;

    const zipPromise = (async () => {
      const usedNames = new Set<string>();
      for (const output of outputs) {
        const buffer = await readOutputFile(output.filePath);
        const originalName = output.filePath.split('/').pop() || `studio-output-${output.id}`;
        let entryName = originalName;
        let counter = 1;
        while (usedNames.has(entryName)) {
          const parsed = originalName.lastIndexOf('.');
          if (parsed > 0) {
            entryName = `${originalName.slice(0, parsed)}-${counter}${originalName.slice(parsed)}`;
          } else {
            entryName = `${originalName}-${counter}`;
          }
          counter++;
        }
        usedNames.add(entryName);
        await addZipEntry(archive, buffer, { name: entryName });
      }
      archive.finish();
    })();

    void zipPromise.catch(() => {
      archive.destroy(new Error('ZIP creation failed'));
    });

    return new NextResponse(webStream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="studio-outputs.zip"',
      },
    });
  } catch (error) {
    console.error('[Studio Download] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to download outputs' }, { status: 500 });
  }
}