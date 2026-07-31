import { NextRequest, NextResponse } from 'next/server';
import { createReadStream, findFilePath } from '@/app/lib/filesystem/upload-handler';
import { auth } from '@/app/lib/auth';
import { stat } from 'fs/promises';
import { getUploadResponsePolicy } from '@/app/lib/files/upload-response-policy';
import { canSessionReadUpload } from '@/app/lib/files/upload-access-authorization';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { id: fileId } = await context.params;
    
    if (!fileId) {
      return NextResponse.json({ success: false, error: 'File ID required' }, { status: 400 });
    }
    if (!(await canSessionReadUpload(session, fileId))) {
      return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
    }

    // Find the file path
    const filePath = await findFilePath(fileId);
    if (!filePath) {
      return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
    }

    // Get file stats
    const stats = await stat(filePath);
    const responsePolicy = getUploadResponsePolicy(fileId);
    
    // Create read stream
    const streamResult = await createReadStream(fileId);
    if (!streamResult) {
      return NextResponse.json({ success: false, error: 'Failed to read file' }, { status: 500 });
    }

    const { stream, cleanup } = streamResult;
    const fileSize = stats.size;

    // Handle range requests for video/audio streaming
    const range = request.headers.get('range');
    
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = end - start + 1;

      // Create a new stream for the range
      const { createReadStream: createLocalReadStream } = await import('fs');
      const rangeStream = createLocalReadStream(filePath, { start, end });
      
      cleanup(); // Clean up the original stream

      const headers = new Headers({
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize.toString(),
        'Content-Type': responsePolicy.contentType,
        'X-Content-Type-Options': 'nosniff',
      });
      if (responsePolicy.contentDisposition) {
        headers.set('Content-Disposition', responsePolicy.contentDisposition);
      }

      return new NextResponse(rangeStream as unknown as ReadableStream<Uint8Array>, { 
        status: 206, 
        headers 
      });
    } else {
      const headers = new Headers({
        'Content-Length': fileSize.toString(),
        'Content-Type': responsePolicy.contentType,
        'X-Content-Type-Options': 'nosniff',
      });
      if (responsePolicy.contentDisposition) {
        headers.set('Content-Disposition', responsePolicy.contentDisposition);
      }

      return new NextResponse(stream as unknown as ReadableStream<Uint8Array>, { 
        status: 200, 
        headers 
      });
    }
  } catch (error) {
    console.error('[API Files] Error serving file:', error);
    return NextResponse.json({ success: false, error: 'Failed to serve file' }, { status: 500 });
  }
}
